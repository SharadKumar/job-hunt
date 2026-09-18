/**
 * tools/ui/api.ts - the local web UI's JSON API, as pure handlers.
 *
 * Every endpoint is a plain async function over plain data: no sockets, no
 * `http.IncomingMessage`, no framework. tools/ui/server.ts is the only place
 * that knows about HTTP, so the whole contract is testable by calling the
 * handlers directly (tests/ui-api.test.ts does exactly that).
 *
 * Nothing here re-implements a decision another tool already owns:
 *   - row ordering follows the Sheet mirror's status rank,
 *   - a Tray action is applied by `applyTrayAction` in tools/sheets-sync.ts,
 *     so the UI and the Sheet pull move rows the same way and queue the same
 *     approval-queue.json entries,
 *   - keyword answers land through the same ledger writer as
 *     `keyword-confirm record --file`,
 *   - the critic digest is `letter-critic --digest`.
 *
 * Errors are `ApiError`s carrying the HTTP status the caller should send. A
 * handler never returns a success shape for a failed operation.
 */

import * as healthExt from "./health-api.ts";
import * as rowsExt from "./rows-ext-api.ts";
import * as workspaceExt from "./workspace-api.ts";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { get as getOpportunity, list as listOpportunities, type Opportunity, type PipelineStatus } from "../pipeline.ts";
import { store } from "../pipeline-store.ts";
import { applyTrayAction, TRAY_ACTIONS } from "../sheets-sync.ts";
import { buildDigest } from "../letter-critic.ts";
import {
  answerToStatus,
  applyAnswerEntries,
  groupContext,
  groupPending,
  readLedger,
  recordNextStep,
  type AnswerEntry,
  type AppliedAnswers,
} from "../resume/keyword-confirm.ts";
import { getResumes, resolveResumeFile } from "./resumes-api.ts";
import { getPolicy, postAutopilot, postKillSwitch, type PolicyToggleBody } from "./policy-api.ts";
import { readJsonIfExists } from "../lib/fs.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoPath } from "../repo-root.ts";

/** Dates in the person's own day, not the machine's. */
const DEFAULT_TIME_ZONE = "Australia/Sydney";
const DEFAULT_ROW_LIMIT = 200;
const DEFAULT_KEYWORD_LIMIT = 20;
const MAX_ROW_LIMIT = 2000;

/**
 * Same order the Sheet's Pipeline tab uses: what the person can act on now,
 * then what is in flight, then the archive. Kept here rather than imported so
 * the Sheet layout and the UI layout can diverge without one breaking the
 * other; if they drift far apart, hoist one copy into a shared module.
 */
const STATUS_RANK: Record<string, number> = {
  awaiting_approval: 0,
  approved: 1,
  submission_pending: 2,
  shortlisted: 3,
  parked: 4,
  awaiting_external: 4,
  drafted: 4,
  manual_action_needed: 5,
  submitted: 6,
  responded: 7,
  interview: 8,
  offered: 9,
  won: 10,
  discovered: 11,
  rejected: 12,
  withdrawn: 13,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Everything a handler is allowed to resolve differently in a test: the
 * profile whose policy and ledger are read, the archive the digest walks, the
 * approval queue an action appends to, the clock and the timezone.
 */
export type ApiContext = {
  profileId?: string | null;
  timeZone?: string;
  now?: Date;
  /** Defaults to state/pipeline/approval-queue.json under the repo root. */
  queuePath?: string;
  /** Defaults to state/pipeline/archive under the repo root. */
  archiveDir?: string;
  /** Defaults to state/journal/summary under the repo root. */
  journalDir?: string;
};

/**
 * The six segments the Pipeline screen is cut into
 * (docs/ui-redesign-2026-09-18.md, section 4). `discovered` and
 * `awaiting_external` belong to none of them on purpose: neither is a queue
 * the person works, and putting them in one would make a tab count disagree
 * with the list behind it.
 */
export const SEGMENTS = {
  needs: ["manual_action_needed"],
  queue: ["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending"],
  parked: ["parked"],
  sent: ["submitted"],
  replies: ["responded", "interview", "offered", "won"],
  closed: ["rejected", "withdrawn"],
} as const satisfies Record<string, readonly string[]>;

export type SegmentKey = keyof typeof SEGMENTS;

/**
 * The rows the person is actually working: what the run stopped on, and what
 * it is carrying. Needs you, the four group counts and the in-flight tally are
 * all counted over these and nothing else.
 */
const WORKED = new Set<string>([...SEGMENTS.needs, ...SEGMENTS.queue]);

/** The four kinds of work the Needs you list groups by, in the doc's order. */
export type NeedsYouGroups = {
  answer_question: number;
  decide: number;
  open_portal: number;
  waiting_redraft: number;
};

export type SummaryResponse = {
  /** One count per machine status, as the store holds them. */
  counts: Record<string, number>;
  /** One count per Pipeline segment; a segment tab shows exactly this number. */
  segments: Record<SegmentKey, number>;
  /** The Needs you groups on Today, counted the way the row API classifies them. */
  needs_you_groups: NeedsYouGroups;
  /** Rows waiting on the person, and rows a run is carrying. */
  needs_you: number;
  in_flight: number;
  total: number;
  sent_today: number;
  max_per_day: number | null;
  autopilot_enabled: boolean;
  kill_switch: boolean;
  generated_at: string;
};

export type RowSummary = {
  id: string;
  channel: string;
  title: string;
  company: string;
  location: string | null;
  status: PipelineStatus;
  score: number | null;
  resumeId: string | null;
  applyMethod: string | null;
  userSaved: boolean;
  workArrangement: string | null;
  reason: string | null;
  updated_at: string | null;
  first_seen_at: string | null;
  draftDir: string | null;
  url: string;
};

export type RowsQuery = {
  status?: string | string[] | null;
  limit?: number | string | null;
  q?: string | null;
  channel?: string | null;
};

export type PackageFiles = {
  jd: string | null;
  cover_letter: string | null;
  metadata: unknown | null;
  letter_critic: unknown | null;
  confirmation: string | null;
};

export type ActionBody = {
  action?: string;
  reason?: string | null;
  edits?: string | null;
};

export type ActionResponse = {
  ok: true;
  id: string;
  action: string;
  status_after: PipelineStatus | null;
  queued: boolean;
};

export type KeywordPendingTerm = {
  term: string;
  count: number;
  resumes: string[];
  context: string;
};

export type KeywordRecordResponse = {
  action: "record-file";
  ledger: string;
  file: string | null;
  dry_run: boolean;
  recorded: AppliedAnswers["recorded"];
  skipped_already_answered: AppliedAnswers["skipped_already_answered"];
  unmatched: string[];
  invalid: { term: string; answer: string }[];
  next_step: string | null;
};

export type JournalResponse = { date: string; markdown: string | null };

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const timeZoneOf = (ctx: ApiContext): string => ctx.timeZone ?? process.env.HARNESS_TZ ?? DEFAULT_TIME_ZONE;
const nowOf = (ctx: ApiContext): Date => ctx.now ?? new Date();

/** `YYYY-MM-DD` for an instant, in the person's timezone. */
export function zonedDay(value: string | Date, timeZone: string): string {
  return new Date(value).toLocaleDateString("en-CA", { timeZone });
}

const queuePathOf = (ctx: ApiContext): string => ctx.queuePath ?? repoPath("state/pipeline/approval-queue.json");
const archiveDirOf = (ctx: ApiContext): string => ctx.archiveDir ?? repoPath("state/pipeline/archive");
const journalDirOf = (ctx: ApiContext): string => ctx.journalDir ?? repoPath("state/journal/summary");

/** A draftDir may be stored repo-relative; resolve it either way. */
function resolveDraftDir(draftDir: string): string {
  return path.isAbsolute(draftDir) ? draftDir : repoPath(draftDir);
}

/**
 * The row's own timestamps. The store keeps `first_seen_at` / `updated_at` in
 * columns it does not hydrate onto the Opportunity, and they are exactly the
 * first and last history instants, so derive them rather than reach past the
 * pipeline API into SQL.
 */
function timestampsOf(row: Opportunity): { first_seen_at: string | null; updated_at: string | null } {
  const stamps = (row.history ?? []).map((h) => h?.at).filter((at): at is string => Boolean(at)).sort();
  return { first_seen_at: stamps[0] ?? null, updated_at: stamps[stamps.length - 1] ?? null };
}

/**
 * The last line of `notes`, which is where the run writes what stopped it.
 *
 * `notes` is appended to, not replaced: a row parked twice carries both stamps
 * on their own lines, and the one that explains where the row is now is the
 * last of them. An empty trailing line is skipped rather than shown as a row
 * with no reason.
 */
function lastNoteLine(notes: string | null | undefined): string {
  const lines = String(notes ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * When `notes` was last written, from the row's own history.
 *
 * `patch` records every field write as `field_update: <names> (<why>) [actor]`,
 * so a note appended by the daily run leaves a dated entry naming `notes`.
 * That is the only timestamp a note has, and without it a note written after
 * the last status move cannot be told from one written before it. Null means
 * the note arrived with the row (an insert writes no field_update), and then
 * the history reason is the newer of the two by definition.
 */
function lastNotesWrite(history: Opportunity["history"]): { at: string; index: number } | null {
  let found: { at: string; index: number } | null = null;
  (history ?? []).forEach((h, index) => {
    if (h?.at && /^field_update:[^(]*\bnotes\b/.test((h.reason ?? "").trim())) found = { at: h.at, index };
  });
  return found;
}

/**
 * The one line that says why a row is where it is: whichever of the two places
 * a reason is written was written last.
 *
 * A patch writes a history entry like `field_update: draftDir [seed]`, which is
 * machinery, not a reason: taking the last reason outright would show the
 * person plumbing instead of "letter-critic blocked: scope wording". So the
 * history candidate is the most recent entry that carries a reason, is not a
 * `field_update`, and actually moved the row; a row with a single history entry
 * (the insert) may still speak for itself.
 *
 * The other place is `notes`, which is where the daily run stamps a cap, a
 * block or a re-park, often without moving the row at all. Taking the history
 * reason whenever there was one hid every one of those: the row read "package
 * prepared unattended" while its note said the gate had refused it an hour
 * later. So the two are compared by time and the newer wins. Then the park
 * reason, then nothing.
 */
export function displayReason(row: Opportunity): string | null {
  const history = row.history ?? [];
  const candidates = history.filter((h) => (h?.reason ?? "").trim() && !/^field_update/.test(h.reason!.trim()));
  const moved = [...candidates].reverse().find((h) => h.from !== h.to);
  const only = history.length === 1 ? candidates[0] : undefined;
  const entry = moved ?? only;
  const note = lastNoteLine(row.notes);
  const wrote = lastNotesWrite(history);
  // Both are stamped to the millisecond and a run parks a row in one go, so a
  // move and the note explaining it routinely share a timestamp. The order
  // they were appended in breaks the tie, and the note is always appended
  // after the move it explains.
  const entryAt = history.indexOf(entry as never);
  const newerNote = Boolean(note) && Boolean(wrote)
    && (!entry?.at || wrote!.at > entry.at || (wrote!.at === entry.at && wrote!.index > entryAt));
  const picked = newerNote ? note : (entry?.reason ?? note ?? row.parkedReason ?? "");
  const text = String(picked ?? "").replace(/\s+/g, " ").trim();
  // In full. It used to be cut to 160 characters with an ellipsis, which
  // section 6 of the redesign bans outright: a reason the person cannot read
  // is a row they have to open for no good reason, and the gate's refusals are
  // the longest and the most worth reading. The screens wrap it.
  return text || null;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// GET /api/summary
// ---------------------------------------------------------------------------

/**
 * Every count the redesign needs, from one call.
 *
 * The screens used to derive their own: Home counted one way, the board's
 * header another and the filter column a third, so the same pipeline reported
 * three different figures on one screen. This is now the only place any of
 * them is worked out, and the rule is that a count and the list it names come
 * from the same derivation (the brief, section 3, principle 1).
 *
 * `needs_you`, `in_flight` and the four Needs you groups are the row API's own
 * classification, not a second copy of it: `laneFor`, `actionFor`, `needsYou`
 * and `needsYouGroup` all live in rows-ext-api.ts and are called here.
 */
export async function getSummary(ctx: ApiContext = {}): Promise<SummaryResponse> {
  const timeZone = timeZoneOf(ctx);
  const today = zonedDay(nowOf(ctx), timeZone);
  const s = store();
  const counts = s.countsByStatus();
  const total = s.count();

  const rows = await listOpportunities({});
  const sentToday = rows.filter((r) => r.submittedAt && zonedDay(r.submittedAt, timeZone) === today).length;

  // A fresh clone has no submission-policy.yaml; getPolicy reads that as
  // "nothing is switched on", which is the truth, not an error.
  const policy = await getPolicy({ profileId: ctx.profileId ?? null });

  const segments = Object.fromEntries(
    Object.entries(SEGMENTS).map(([key, statuses]) => [
      key,
      statuses.reduce((n, status) => n + (counts[status] ?? 0), 0),
    ]),
  ) as Record<SegmentKey, number>;

  const needs_you_groups: NeedsYouGroups = { answer_question: 0, decide: 0, open_portal: 0, waiting_redraft: 0 };
  let needsYouTotal = 0;
  let inFlight = 0;
  // Only the two segments the person actually works. A `discovered` row nobody
  // has looked at yet, and a `parked` one they already ruled out, both derive
  // an action (open the portal, unpark) but neither is waiting on them: taken
  // over the whole store the headline read 320 on a morning with 37 to do.
  for (const row of rows.filter((r) => WORKED.has(r.status))) {
    const { lane } = rowsExt.laneFor(row, policy);
    const derived = rowsExt.actionFor(row, displayReason(row), lane);
    if (rowsExt.needsYou(derived)) needsYouTotal += 1;
    if (derived.kind === "in_flight") inFlight += 1;
    const group = rowsExt.needsYouGroup(derived);
    if (group) needs_you_groups[group] += 1;
  }

  return {
    counts,
    segments,
    needs_you_groups,
    needs_you: needsYouTotal,
    in_flight: inFlight,
    total,
    sent_today: sentToday,
    max_per_day: policy.max_per_day,
    autopilot_enabled: policy.autopilot_enabled,
    kill_switch: policy.kill_switch,
    generated_at: nowOf(ctx).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/rows
// ---------------------------------------------------------------------------

function toRowSummary(row: Opportunity): RowSummary {
  const { first_seen_at, updated_at } = timestampsOf(row);
  return {
    id: row.id,
    channel: row.channel,
    title: row.title,
    company: row.company,
    location: row.location ?? null,
    status: row.status,
    score: row.score ?? null,
    resumeId: row.resumeId ?? row.classification?.matched_resume_id ?? null,
    applyMethod: row.applyMethod ?? null,
    userSaved: row.userSaved === true,
    workArrangement: row.classification?.work_arrangement ?? row.workArrangement ?? null,
    reason: displayReason(row),
    updated_at,
    first_seen_at,
    draftDir: row.draftDir ?? null,
    url: row.url,
  };
}

function wantedStatuses(status: RowsQuery["status"]): Set<string> | null {
  const raw = Array.isArray(status) ? status.join(",") : status ?? "";
  const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

function parseLimit(value: RowsQuery["limit"], fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, `limit must be a positive number, got '${String(value)}'`);
  return Math.min(Math.floor(n), MAX_ROW_LIMIT);
}

/** A page start. Absent is 0; anything that is not a whole number at or above 0 is a 400. */
function parseOffset(value: number | string | null | undefined): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `offset must be zero or a positive number, got '${String(value)}'`);
  return Math.floor(n);
}

/**
 * The rows a query matched, and how many matched before the limit cut them
 * down. The count is what lets a list header read "Showing 30 of 90" with a
 * way to see the rest, rather than printing 30 beside a tab that says 90 (the
 * redesign brief, section 6: a count and the list it names agree, or the
 * header says which one it is).
 */
export async function getRows(query: RowsQuery = {}, _ctx: ApiContext = {}): Promise<{ rows: RowSummary[]; total: number }> {
  const statuses = wantedStatuses(query.status);
  const limit = parseLimit(query.limit, DEFAULT_ROW_LIMIT);
  const needle = (query.q ?? "").trim().toLowerCase();

  const all = await listOpportunities(query.channel ? { channel: query.channel } : {});
  const filtered = all.filter((r) => {
    if (statuses && !statuses.has(r.status)) return false;
    if (!needle) return true;
    return [r.title, r.company, r.location, r.id, r.channel]
      .some((field) => String(field ?? "").toLowerCase().includes(needle));
  });

  filtered.sort((a, b) =>
    (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
    || (b.score ?? -1) - (a.score ?? -1)
    || a.company.localeCompare(b.company)
    || a.title.localeCompare(b.title),
  );

  return { rows: filtered.slice(0, limit).map(toRowSummary), total: filtered.length };
}

// ---------------------------------------------------------------------------
// GET /api/rows/:id
// ---------------------------------------------------------------------------

/** The four artefacts a prepared package leaves in the archive, plus the send receipt. */
export async function readPackage(draftDir: string | undefined | null): Promise<PackageFiles> {
  const empty: PackageFiles = { jd: null, cover_letter: null, metadata: null, letter_critic: null, confirmation: null };
  if (!draftDir) return empty;
  const dir = resolveDraftDir(draftDir);
  const [jd, coverLetter, metadata, letterCritic, confirmation] = await Promise.all([
    readTextIfExists(path.join(dir, "jd.md")),
    readTextIfExists(path.join(dir, "cover-letter.md")),
    readJsonIfExists<unknown>(path.join(dir, "metadata.json"), null),
    readJsonIfExists<unknown>(path.join(dir, "letter-critic.json"), null),
    readTextIfExists(path.join(dir, "confirmation.txt")),
  ]);
  return { jd, cover_letter: coverLetter, metadata, letter_critic: letterCritic, confirmation };
}

/** True when `dir` is a directory that is actually there. */
async function isDir(dir: string): Promise<boolean> {
  const stat = await fsp.stat(dir).catch(() => null);
  return stat ? stat.isDirectory() : false;
}

/**
 * Where a row's prepared package actually sits.
 *
 * `draftDir` is a column only some writers fill: most rows were moved by a
 * path that never set it, and the archive folder is still there under the
 * row's id. Trusting the column alone showed an empty package on a row whose
 * letter, JD and critic verdict were on disk all along. So the column is
 * preferred, then checked, and the archive folder by id is the fallback.
 */
export async function packageDirOf(row: Opportunity, ctx: ApiContext = {}): Promise<string | null> {
  if (row.draftDir && (await isDir(resolveDraftDir(row.draftDir)))) return row.draftDir;
  const byId = path.join(archiveDirOf(ctx), row.id);
  if (await isDir(byId)) return byId;
  return null;
}

export async function getRowDetail(
  id: string,
  ctx: ApiContext = {},
): Promise<{ row: Opportunity; reason: string | null; package: PackageFiles }> {
  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);
  // The same one line the queue shows, picked the same way: the stored row has
  // no `reason` column of its own.
  return { row, reason: displayReason(row), package: await readPackage(await packageDirOf(row, ctx)) };
}

// ---------------------------------------------------------------------------
// POST /api/rows/:id/action
// ---------------------------------------------------------------------------

/**
 * The Sheet pull replaces approval-queue.json wholesale because it reads the
 * whole Tray in one go. The UI acts one row at a time, so it merges by id:
 * the newest decision for a row wins and nothing else in the queue is lost.
 */
async function queueDecision(queuePath: string, entry: { id: string; action: string; edits: string }): Promise<void> {
  const existing = (await readJsonIfExists<{ id: string; action: string; edits: string }[]>(queuePath, [])) ?? [];
  const next = [...existing.filter((e) => e?.id !== entry.id), entry];
  await fsp.mkdir(path.dirname(queuePath), { recursive: true });
  await fsp.writeFile(queuePath, JSON.stringify(next, null, 2));
}

export async function postRowAction(id: string, body: ActionBody = {}, ctx: ApiContext = {}): Promise<ActionResponse> {
  const action = String(body.action ?? "").trim().toLowerCase();
  if (!action) throw new ApiError(400, `action is required; one of ${TRAY_ACTIONS.join(", ")}`);
  if (!TRAY_ACTIONS.includes(action)) throw new ApiError(400, `unknown action '${action}'; one of ${TRAY_ACTIONS.join(", ")}`);

  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);

  const reason = (body.reason ?? "").trim();
  const note = reason ? ` (${reason})` : "";
  // An approve says where it was given, because the person reading the history
  // later wants to know which surface they were holding. Every other action
  // keeps the `ui:` stamp the Sheet pull's wording mirrors.
  const said = action === "approve" ? `approved in the local UI${note}` : `ui: ${action}${note}`;
  const result = await applyTrayAction(id, action, { actor: "ui", reason: said });
  if (!result.ok) {
    // A refusal is a 409: the state machine, or the Tray's own rule about
    // which status an action means anything from, said no. Nothing broke.
    const message = result.error ?? `${action} failed`;
    throw new ApiError(result.refused || /invalid transition/.test(message) ? 409 : 500, message);
  }

  await queueDecision(queuePathOf(ctx), { id, action, edits: (body.edits ?? "").trim() });

  return { ok: true, id, action, status_after: result.status_after, queued: true };
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

function ledgerPathOf(ctx: ApiContext): string {
  return resolveProfileContext(ctx.profileId ?? null).marketConfirmationsPath;
}

/**
 * The pending questions, one entry per term, in the order `groupPending` fixes:
 * count descending, then term ascending. That order is stable across calls, so
 * `offset` means the same thing on the next page as it did on this one.
 *
 * `q` is a case-insensitive substring filter on the term and narrows `terms`
 * and `matched_total` only: `pending_total` and `term_total` stay the
 * unfiltered totals, because a search box must not make the backlog look
 * smaller than it is. `all=1` (or any truthy `all`) returns every term, which
 * is what the UI's left-hand list wants: a few hundred terms is a small page.
 */
export async function getKeywordsPending(
  query: {
    limit?: number | string | null;
    offset?: number | string | null;
    resume?: string | null;
    q?: string | null;
    all?: string | boolean | null;
  } = {},
  ctx: ApiContext = {},
): Promise<{
  terms: KeywordPendingTerm[];
  pending_total: number;
  term_total: number;
  matched_total: number;
  offset: number;
  limit: number;
}> {
  const groups = groupPending(await readLedger(ledgerPathOf(ctx)), query.resume ?? null);
  const needle = (query.q ?? "").trim().toLowerCase();
  const matched = needle ? groups.filter((g) => g.term.toLowerCase().includes(needle)) : groups;
  const wantsAll = query.all === true || (typeof query.all === "string" && query.all !== "" && query.all !== "0" && query.all !== "false");
  const limit = wantsAll ? Math.max(matched.length, 1) : parseLimit(query.limit, DEFAULT_KEYWORD_LIMIT);
  const offset = parseOffset(query.offset);
  return {
    terms: matched.slice(offset, offset + limit).map((g) => ({
      term: g.term,
      category: g.category ?? null,
      evidence_hint: g.evidence_hint ?? null,
      count: g.count,
      resumes: g.resumes,
      context: groupContext(g),
    })),
    pending_total: groups.reduce((n, g) => n + g.count, 0),
    term_total: groups.length,
    matched_total: matched.length,
    offset,
    limit,
  };
}

export async function postKeywordsRecord(
  body: { answers?: Record<string, string> } = {},
  ctx: ApiContext = {},
): Promise<KeywordRecordResponse> {
  const answers = body.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new ApiError(400, "body must be { answers: { <term>: confirm | na | familiarity | pending } }");
  }
  const entries: AnswerEntry[] = Object.entries(answers).map(([term, answer]) => ({
    term: String(term).trim(),
    answer: String(answer ?? "").trim(),
    status: answerToStatus(String(answer ?? "")),
    note: null,
  }));
  if (!entries.length) throw new ApiError(400, "answers is empty; nothing to record");

  const invalid = entries.filter((e) => !e.status).map((e) => ({ term: e.term, answer: e.answer }));
  if (invalid.length) {
    const named = invalid.map((i) => `${JSON.stringify(i.term)}: ${JSON.stringify(i.answer)}`).join("; ");
    throw new ApiError(400, `invalid answer for ${named}. Use confirm | na | familiarity | pending.`);
  }

  const ledger = ledgerPathOf(ctx);
  const applied = await applyAnswerEntries(entries, { ledger, origin: "attended" });
  return {
    action: "record-file",
    ledger,
    file: null,
    dry_run: false,
    recorded: applied.recorded,
    skipped_already_answered: applied.skipped_already_answered,
    unmatched: applied.unmatched,
    invalid: [],
    next_step: recordNextStep(applied.recorded),
  };
}

// ---------------------------------------------------------------------------
// Journal and critic digest
// ---------------------------------------------------------------------------

export async function getJournalToday(query: { date?: string | null } = {}, ctx: ApiContext = {}): Promise<JournalResponse> {
  const date = (query.date ?? "").trim() || zonedDay(nowOf(ctx), timeZoneOf(ctx));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, `date must be YYYY-MM-DD, got '${date}'`);
  return { date, markdown: await readTextIfExists(path.join(journalDirOf(ctx), `${date}.md`)) };
}

export async function getCriticDigest(query: { since?: string | null } = {}, ctx: ApiContext = {}): Promise<Awaited<ReturnType<typeof buildDigest>>> {
  const since = (query.since ?? "").trim() || "14d";
  const archiveDir = archiveDirOf(ctx);
  try {
    return await buildDigest({ archiveDir, since, now: nowOf(ctx) });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    // A missing archive is an empty digest, not a failure: nothing has been
    // critiqued yet. An unreadable `--since` is the caller's mistake.
    if (/^cannot read archive/.test(message)) {
      return { since: new Date(0).toISOString(), verdicts: 0, blocked: 0, themes: [] };
    }
    throw new ApiError(400, message);
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type ApiRequest = {
  method: string;
  /** Path only, no query string; the leading `/api` is expected. */
  pathname: string;
  query?: URLSearchParams;
  body?: unknown;
};

export type ApiResult = {
  status: number;
  body: unknown;
  /** Extra response headers, used by the routes that serve something other than JSON. */
  headers?: Record<string, string>;
  /**
   * An absolute path the server should stream instead of writing `body`. Only
   * the resume file route sets it; `body` then carries the content type so a
   * direct caller (a test) can still assert the result without a socket.
   */
  stream?: string;
};

/**
 * Route one API request. Never throws: an `ApiError` becomes its own status
 * and `{ error }`, anything unexpected becomes a 500 with the message. The
 * server layer only has to write the result out.
 */
export async function handleApi(req: ApiRequest, ctx: ApiContext = {}): Promise<ApiResult> {
  // Extension modules (one per work package) get first refusal; see *-api.ts.
  for (const ext of [healthExt, rowsExt, workspaceExt]) {
    const hit = await ext.handle(req, ctx).catch((e: unknown) => (e instanceof ApiError ? { status: e.status, body: { error: e.message } } : { status: 500, body: { error: String((e as Error)?.message ?? e) } }));
    if (hit) return hit;
  }
  const query = req.query ?? new URLSearchParams();
  const method = req.method.toUpperCase();
  const pathname = req.pathname.replace(/\/+$/, "") || "/";

  try {
    if (method === "GET" && pathname === "/api/summary") {
      return { status: 200, body: await getSummary(ctx) };
    }
    // `GET /api/rows`, `GET /api/rows/:id` and `GET /api/keywords/pending` are
    // not routed here. rows-ext-api.ts and keywords-ext-api.ts get first
    // refusal and answer all three with the derived fields the screens need,
    // so a copy in this table could only ever be dead code that looked live.
    // `getRows`, `getRowDetail` and `getKeywordsPending` stay exported: those
    // modules wrap them.
    if (method === "POST" && pathname === "/api/keywords/record") {
      return { status: 200, body: await postKeywordsRecord((req.body ?? {}) as { answers?: Record<string, string> }, ctx) };
    }
    if (method === "GET" && pathname === "/api/journal/today") {
      return { status: 200, body: await getJournalToday({ date: query.get("date") }, ctx) };
    }
    if (method === "GET" && pathname === "/api/critic/digest") {
      return { status: 200, body: await getCriticDigest({ since: query.get("since") }, ctx) };
    }

    // The two gates in submission-policy.yaml. Reading them is free; flipping
    // one is an attended act by the person at their own machine, audited in
    // tools/ui/policy-api.ts.
    if (method === "GET" && pathname === "/api/policy") {
      return { status: 200, body: await getPolicy({ profileId: ctx.profileId ?? null }) };
    }
    if (method === "POST" && pathname === "/api/policy/autopilot") {
      return { status: 200, body: await postAutopilot((req.body ?? {}) as PolicyToggleBody, { profileId: ctx.profileId ?? null }) };
    }
    if (method === "POST" && pathname === "/api/policy/kill-switch") {
      return { status: 200, body: await postKillSwitch((req.body ?? {}) as PolicyToggleBody, { profileId: ctx.profileId ?? null }) };
    }

    if (method === "GET" && pathname === "/api/resumes") {
      return { status: 200, body: await getResumes({ profileId: ctx.profileId ?? null, now: ctx.now }) };
    }

    // The artefact route: a page image, a PDF, a DOCX or the markdown, read
    // out of state/profile/resumes/<id>/. It sits behind the same token gate
    // as every other /api route, and it never leaves that folder.
    const artefact = pathname.match(/^\/api\/resumes\/([^/]+)\/file\/([^/]+)$/);
    if (artefact) {
      if (method !== "GET") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
      const resolved = await resolveResumeFile(
        decodeURIComponent(artefact[1]),
        decodeURIComponent(artefact[2]),
        { profileId: ctx.profileId ?? null },
      );
      if (resolved.status !== 200) return { status: resolved.status, body: { error: resolved.error } };
      return {
        status: 200,
        body: { file: resolved.file, content_type: resolved.contentType },
        headers: { "content-type": resolved.contentType, "cache-control": "no-store" },
        stream: resolved.file,
      };
    }

    const action = pathname.match(/^\/api\/rows\/([^/]+)\/action$/);
    if (action) {
      if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
      return { status: 200, body: await postRowAction(decodeURIComponent(action[1]), (req.body ?? {}) as ActionBody, ctx) };
    }

    return { status: 404, body: { error: `no such endpoint: ${method} ${pathname}` } };
  } catch (error: any) {
    if (error instanceof ApiError) return { status: error.status, body: { error: error.message } };
    return { status: 500, body: { error: String(error?.message ?? error) } };
  }
}
