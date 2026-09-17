/**
 * Extension API module (rows-ext). Owned by one work package; the dispatcher in
 * api.ts calls `handle` before its own routes and takes the first non-null
 * result. Return null for any request this module does not own.
 *
 * What lives here is everything the applications board needs beyond the plain
 * list that api.ts already serves:
 *
 *   - `GET /api/rows` is wrapped rather than replaced: the rows come back from
 *     api.ts unchanged, with one derived field added. `actionFor` is the one
 *     place that decides which single button a row deserves, so the list, the
 *     row detail and the tests all read the same derivation instead of three
 *     copies of a regex in the browser.
 *   - `GET /api/rows/:id` is wrapped the same way, and fills in the package
 *     directory when the stored row has no `draftDir`: most rows on this
 *     machine were archived before that field was written, and a letter that
 *     is on disk must not read as a missing letter.
 *   - `GET /api/followups` is the read side of the /follow-up skill: submitted
 *     rows that have gone quiet, each with the nudge draft if one was written.
 *     Nothing here sends one (AGENTS.md section 2); it is a clipboard, not an
 *     outbox.
 *   - `POST /api/rows/:id/unpark` and `/outcome` are two status moves the Tray
 *     vocabulary has no word for. Both go through `setStatus`, so the state
 *     machine in tools/pipeline.ts refuses an illegal move and the row keeps
 *     its audit trail.
 *   - `POST /api/rows/:id/mark-sent` is the row the harness could not finish:
 *     the person lodged it themselves in the advertiser's portal and says so.
 *     It walks the row to `submitted` through the state machine and leaves the
 *     same `confirmation.txt` receipt an autopilot send leaves, so a manual
 *     send and an automatic one are read the same way afterwards.
 *   - `POST /api/rows/:id/redraft` asks for a new letter without moving the
 *     row. It records the request on the row; the /daily skill's letter loop
 *     reads it and treats the row like a saved job (two regenerations, then
 *     park), and clears it when a regeneration lands.
 *   - `POST /api/rows/:id/retry-now` runs `tools/autopilot-submit.ts` for one
 *     row, attended, and returns a job id to poll (`GET /api/jobs/:id`). That
 *     tool owns the letter-critic, the gate and the audit trail, so the button
 *     adds no authority: it refuses anything outside the autopilot lane, and
 *     refuses again when the kill switch is on or autopilot is off.
 *   - `POST /api/rows/:id/letter` writes the package's cover letter back and
 *     re-runs the deterministic pre-checks from tools/letter-critic.ts. The
 *     model critic is deliberately NOT run from a browser click: it is the
 *     cold fact-check that gates an unattended send, and it runs when the row
 *     is retried through autopilot, against the letter's sha.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import { ApiError, getRowDetail, getRows, type ApiContext, type ApiRequest, type ApiResult, type RowSummary } from "./api.ts";
import { get as getOpportunity, list as listOpportunities, patch as patchOpportunity, setStatus, type Opportunity, type PipelineStatus } from "../pipeline.ts";
import { deterministicFindings, loadProfileRules, requisitionCodesNotInJd, type CriticFinding } from "../letter-critic.ts";
import { log, type AuditEventType } from "../audit.ts";
import { writeAtomic } from "../lib/fs.ts";
import { repoPath } from "../repo-root.ts";
import * as keywordsExt from "./keywords-ext-api.ts";
import { getJob, listJobs, resolveAutopilotCommand, runningJobFor, startJob } from "./jobs.ts";
import { getPolicy } from "./policy-api.ts";

/**
 * A letter edited by hand at the person's own machine. `AuditEventType` is
 * owned by tools/audit.ts and the log itself is untyped JSONL; name the event
 * once here rather than widen another module's type, exactly as policy-api.ts
 * does for `policy_change`.
 */
const LETTER_EDITED = "letter_edited" as AuditEventType;

/** A letter the person sent back for a rewrite. Same reasoning as above. */
const REDRAFT_REQUESTED = "redraft_requested" as AuditEventType;

/** Default age for a follow-up, matching the /follow-up skill's own default. */
const DEFAULT_FOLLOWUP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The statuses `POST /api/rows/:id/outcome` will move a row to. */
export const OUTCOME_STATUSES = ["responded", "interview", "offered", "won", "rejected", "withdrawn"] as const;

/** Package file names a nudge draft may have been written under. */
const NUDGE_FILES = ["follow-up.md", "nudge.md", "follow-up-dm.md", "follow-up-email.md"];

// ---------------------------------------------------------------------------
// The one contextual action a row deserves
// ---------------------------------------------------------------------------

export type RowAction = {
  /** What the button does, so the front end does not re-read the label. */
  kind: "answer" | "portal" | "retry" | "reject" | "approve" | "unpark" | "outcome" | "decide" | "mark_sent" | "none";
  label: string;
  /** A Tray action for POST /api/rows/:id/action, when that is the move. */
  post: string | null;
  /** The status for POST /api/rows/:id/outcome, when that is the move. */
  outcome: string | null;
  /** An external address to open, for a row that has to be finished in a portal. */
  href: string | null;
  primary: boolean;
  danger: boolean;
  /**
   * The secondary buttons beside the primary one, already decided here. A row
   * that needs a choice rather than an action (a duplicate: drop it, or send it
   * anyway) has no primary at all and carries both options in this list, so the
   * browser renders what the server decided instead of re-deriving it from the
   * reason text in a second place.
   */
  also: RowAction[];
};

const NONE: RowAction = { kind: "none", label: "", post: null, outcome: null, href: null, primary: false, danger: false, also: [] };

const action = (patch: Partial<RowAction>): RowAction => ({ ...NONE, also: [], ...patch });

/** Rows that are finished, or in flight in a way a button cannot help. */
const NO_ACTION = new Set(["submitted", "won", "rejected", "withdrawn", "submission_pending"]);

/** The reason patterns the daily run writes when it parks a row on a human. */
const UNANSWERED_QUESTION = /screening question|unanswered question|question is not in/i;
const EXTERNAL_PORTAL = /external ats|external portal|external application|external\/unknown|external or unknown|apply on (the )?company|not quick apply|non-quick-apply|redirect(ed)? to/i;
const LETTER_BLOCKED = /letter[-\s]?critic|letter critic/i;
const DUPLICATE = /duplicate|already submitted .{0,60}within \d+ days|needs a user decision/i;

export type ActionRow = { id: string; status: string; url?: string | null; applyMethod?: string | null };

/**
 * A row the harness cannot lodge itself: the advertiser runs its own portal.
 * `applyMethod` is the fact, the reason text is the same fact as the run
 * recorded it, and either is enough. Retry would hand this to an adapter with
 * nothing to drive, so an external row always opens the advert instead.
 */
const isExternal = (row: ActionRow, reason: string): boolean =>
  String(row.applyMethod ?? "") === "external" || EXTERNAL_PORTAL.test(reason);

/** "I applied myself", the only way an external row ever reaches `submitted`. */
const markSentButton = (): RowAction => action({ kind: "mark_sent", label: "I applied myself" });

/** A duplicate is a decision, not an action: drop this one, or send it anyway. */
const decideButtons = (): RowAction[] => [
  action({ kind: "reject", label: "Reject", post: "reject", danger: true }),
  action({ kind: "retry", label: "Retry", post: "retry" }),
];

/**
 * One row, one button. The reason is what the run actually recorded, so it
 * decides first: a row blocked on a screening question wants an answer whatever
 * status it happens to sit in. Status decides the rest, and a row in flight or
 * finished gets nothing rather than a button that would be refused.
 */
export function actionFor(row: ActionRow, reason: string | null): RowAction {
  const status = String(row.status ?? "");
  const text = String(reason ?? "");
  // A response is a ladder: the only useful button is the next rung.
  if (status === "responded") return action({ kind: "outcome", label: "Interview", outcome: "interview", primary: true });
  if (status === "interview") return action({ kind: "outcome", label: "Offered", outcome: "offered", primary: true });
  if (status === "offered") return action({ kind: "outcome", label: "Won", outcome: "won", primary: true });
  if (NO_ACTION.has(status)) return NONE;
  // External first, and whatever the reason says afterwards: there is no button
  // on this machine that can finish someone else's portal.
  if (isExternal(row, text)) {
    return action({ kind: "portal", label: "Open portal", href: row.url ?? null, also: [markSentButton()] });
  }
  if (UNANSWERED_QUESTION.test(text)) return action({ kind: "answer", label: "Answer", primary: true });
  if (DUPLICATE.test(text)) return action({ kind: "decide", label: "", also: decideButtons() });
  if (LETTER_BLOCKED.test(text)) return action({ kind: "retry", label: "Retry", post: "retry" });
  if (status === "awaiting_approval") return action({ kind: "approve", label: "Approve", post: "approve", primary: true });
  if (status === "parked") return action({ kind: "unpark", label: "Unpark" });
  if (status === "manual_action_needed") return action({ kind: "retry", label: "Retry", post: "retry" });
  return NONE;
}

// ---------------------------------------------------------------------------
// Where a row's package lives
// ---------------------------------------------------------------------------

const archiveDirOf = (ctx: ApiContext): string => ctx.archiveDir ?? repoPath("state/pipeline/archive");

/** The outreach tray the /follow-up skill writes LinkedIn nudges into. */
const outreachDirOf = (ctx: ApiContext): string => path.join(path.dirname(archiveDirOf(ctx)), "outreach");

async function isDir(dir: string): Promise<boolean> {
  try { return (await fsp.stat(dir)).isDirectory(); } catch { return false; }
}

/**
 * The package directory for a row. `draftDir` is authoritative when the row
 * carries one (it may be repo-relative), and the archive folder named after the
 * row is the fallback: rows archived before `draftDir` was recorded still have
 * their letter, JD and critic verdict on disk under their own id.
 */
export async function packageDirFor(row: Opportunity, ctx: ApiContext = {}): Promise<string | null> {
  if (row.draftDir) return path.isAbsolute(row.draftDir) ? row.draftDir : repoPath(row.draftDir);
  const guess = path.join(archiveDirOf(ctx), row.id);
  return (await isDir(guess)) ? guess : null;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, "utf8"); } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
    throw error;
  }
}

async function readJsonIfPresent(file: string): Promise<unknown | null> {
  const text = await readTextIfExists(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The files a person can see in the Package card, so an absent one is named. */
async function filesPresent(dir: string | null): Promise<string[]> {
  if (!dir) return [];
  try { return (await fsp.readdir(dir)).sort(); } catch { return []; }
}

// ---------------------------------------------------------------------------
// GET /api/rows  (the list, with one derived action per row)
// ---------------------------------------------------------------------------

export type RowSummaryWithAction = RowSummary & { action: RowAction };

export async function getRowsWithActions(
  query: { status?: string | null; limit?: string | null; q?: string | null; channel?: string | null },
  ctx: ApiContext = {},
): Promise<{ rows: RowSummaryWithAction[] }> {
  const { rows } = await getRows(query, ctx);
  return { rows: rows.map((row) => ({ ...row, action: actionFor(row, row.reason) })) };
}

// ---------------------------------------------------------------------------
// GET /api/rows/:id  (the detail, with the package found either way)
// ---------------------------------------------------------------------------

/** The five fields the current letter-critic writes for every finding. */
export type NormalisedFinding = { severity: string; quote: string; issue: string; fix: string; source: string };

/** The first of these that is a non-empty string, trimmed. */
function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

/**
 * One shape for the findings the browser renders.
 *
 * `tools/letter-critic.ts` writes `{severity, quote, issue, fix, source}`, but
 * verdicts on this machine were written over months and older ones carry the
 * issue as `why` or `reason` and the quote as `sentence`. Rendering those keys
 * blindly showed three empty rows where three blocking findings were, so the
 * legacy names are mapped onto the current ones here, once, rather than in the
 * browser. An unlabelled severity reads as `fail`: the stronger reading is the
 * safe one when the file does not say (AGENTS.md section 8).
 */
export function normaliseCritic(critic: unknown): unknown {
  if (!critic || typeof critic !== "object") return critic;
  const findings = (critic as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return critic;
  const normalised: NormalisedFinding[] = findings.map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    return {
      severity: firstString(f.severity, f.level) || "fail",
      quote: firstString(f.quote, f.sentence, f.text),
      issue: firstString(f.issue, f.why, f.reason, f.problem),
      fix: firstString(f.fix, f.suggestion, f.rewrite),
      source: firstString(f.source, f.origin) || "llm",
    };
  });
  return { ...(critic as Record<string, unknown>), findings: normalised };
}

export async function getRowDetailPlus(id: string, ctx: ApiContext = {}) {
  const detail = await getRowDetail(id, ctx);
  const dir = await packageDirFor(detail.row, ctx);
  // api.ts already read the package when the row carries a draftDir. Only the
  // fallback path has more to find.
  const pkg = detail.row.draftDir || !dir ? detail.package : {
    jd: await readTextIfExists(path.join(dir, "jd.md")),
    cover_letter: await readTextIfExists(path.join(dir, "cover-letter.md")),
    metadata: await readJsonIfPresent(path.join(dir, "metadata.json")),
    letter_critic: await readJsonIfPresent(path.join(dir, "letter-critic.json")),
    confirmation: await readTextIfExists(path.join(dir, "confirmation.txt")),
  };
  return {
    ...detail,
    package: { ...pkg, letter_critic: normaliseCritic(pkg.letter_critic) },
    package_dir: dir,
    package_files: await filesPresent(dir),
    // A redraft the person asked for is pending work on this row, so it belongs
    // beside the letter it is about rather than only in the row's history.
    redraft_requested: (detail.row as { redraftRequested?: unknown }).redraftRequested ?? null,
    action: actionFor(detail.row, detail.reason),
  };
}

// ---------------------------------------------------------------------------
// GET /api/followups
// ---------------------------------------------------------------------------

export type FollowUpRow = {
  id: string;
  title: string;
  company: string;
  channel: string;
  url: string;
  submitted_at: string | null;
  days_since: number;
  nudge: string | null;
  nudge_file: string | null;
};

/** The nudge draft for a row, from the package directory or the outreach tray. */
async function nudgeFor(row: Opportunity, ctx: ApiContext): Promise<{ text: string | null; file: string | null }> {
  const dirs = [await packageDirFor(row, ctx), path.join(outreachDirOf(ctx), row.id)].filter(Boolean) as string[];
  for (const dir of dirs) {
    for (const name of NUDGE_FILES) {
      const text = await readTextIfExists(path.join(dir, name));
      if (text !== null && text.trim()) return { text: text.trim(), file: path.join(dir, name) };
    }
  }
  return { text: null, file: null };
}

function parseDays(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return DEFAULT_FOLLOWUP_DAYS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `days must be zero or a positive number, got '${String(value)}'`);
  return Math.floor(n);
}

/**
 * Submitted rows that have gone quiet. `responseAt` or a status past
 * `submitted` both count as a reply, so a row the person has already moved on
 * never comes back asking to be chased.
 */
export async function getFollowUps(
  query: { days?: string | number | null } = {},
  ctx: ApiContext = {},
): Promise<{ days: number; cutoff: string; rows: FollowUpRow[] }> {
  const days = parseDays(query.days);
  const now = ctx.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows: FollowUpRow[] = [];
  for (const row of await listOpportunities({ status: "submitted" })) {
    if (row.responseAt) continue;
    if (!row.submittedAt) continue;
    const sent = new Date(row.submittedAt);
    if (Number.isNaN(sent.getTime()) || sent > cutoff) continue;
    const nudge = await nudgeFor(row, ctx);
    rows.push({
      id: row.id,
      title: row.title,
      company: row.company,
      channel: row.channel,
      url: row.url,
      submitted_at: row.submittedAt,
      days_since: Math.floor((now.getTime() - sent.getTime()) / DAY_MS),
      nudge: nudge.text,
      nudge_file: nudge.file,
    });
  }
  rows.sort((a, b) => b.days_since - a.days_since || a.company.localeCompare(b.company));
  return { days, cutoff: cutoff.toISOString(), rows };
}

// ---------------------------------------------------------------------------
// POST /api/rows/:id/unpark and /outcome
// ---------------------------------------------------------------------------

async function move(id: string, next: PipelineStatus, reason: string): Promise<{ ok: true; id: string; status_after: PipelineStatus }> {
  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);
  try {
    const moved = await setStatus(id, next, reason, { actor: "ui" });
    return { ok: true, id, status_after: moved.status };
  } catch (error: any) {
    const message = String(error?.message ?? error);
    throw new ApiError(/invalid transition/.test(message) ? 409 : 500, message);
  }
}

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A parked row the person has ruled back into the apply queue. */
export async function postUnpark(id: string, body: { reason?: unknown } = {}) {
  const reason = trimmed(body.reason);
  return move(id, "shortlisted", reason ? `ui: unpark (${reason})` : "ui: unpark");
}

/** What happened after a submission, recorded by the person who heard it. */
export async function postOutcome(id: string, body: { status?: unknown; note?: unknown } = {}) {
  const wanted = trimmed(body.status).toLowerCase();
  if (!(OUTCOME_STATUSES as readonly string[]).includes(wanted)) {
    throw new ApiError(400, `status must be one of ${OUTCOME_STATUSES.join(", ")}, got '${wanted || "nothing"}'`);
  }
  const note = trimmed(body.note);
  return move(id, wanted as PipelineStatus, note ? `ui: ${wanted} (${note})` : `ui: ${wanted}`);
}

// ---------------------------------------------------------------------------
// POST /api/rows/:id/letter
// ---------------------------------------------------------------------------

/** Only a row the person is still allowed to change carries an editable letter. */
const LETTER_EDITABLE = new Set(["manual_action_needed", "awaiting_approval"]);

export type LetterSaveResult = {
  ok: true;
  id: string;
  file: string;
  words: number;
  /** The deterministic pre-checks only. The model critic runs on retry. */
  findings: CriticFinding[];
  checks: string[];
  critic_stale: boolean;
};

/**
 * Save an edited cover letter back into the package and report the mechanical
 * findings: em and en dashes, never-named entities, requisition codes that are
 * not in this advertiser's JD. The full letter-critic is not run here. It is a
 * cold model fact-check that gates an unattended send and it is keyed to the
 * letter's sha, so it runs when the row is retried, against the bytes that
 * would actually go out.
 */
export async function postLetter(id: string, body: { text?: unknown } = {}, ctx: ApiContext = {}): Promise<LetterSaveResult> {
  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);
  if (!LETTER_EDITABLE.has(row.status)) {
    throw new ApiError(409, `the letter on a ${row.status} row is not editable; only ${[...LETTER_EDITABLE].join(" or ")} rows are`);
  }
  if (typeof body.text !== "string" || !body.text.trim()) throw new ApiError(400, "text is required and must not be empty");
  const text = body.text.replace(/\r\n/g, "\n").trim() + "\n";

  const dir = (await packageDirFor(row, ctx)) ?? path.join(archiveDirOf(ctx), row.id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "cover-letter.md");
  await writeAtomic(file, text);

  const jd = (await readTextIfExists(path.join(dir, "jd.md"))) ?? row.description ?? "";
  const rules = await loadProfileRules(ctx.profileId ?? null);
  const findings = [...deterministicFindings(text, rules.neverNamed), ...requisitionCodesNotInJd(text, jd)];

  await log({
    event_type: LETTER_EDITED,
    role_id: id,
    actor: "ui",
    channel: row.channel,
    details: { file, words: text.split(/\s+/).filter(Boolean).length, findings: findings.length, status: row.status },
  });

  return {
    ok: true,
    id,
    file,
    words: text.split(/\s+/).filter(Boolean).length,
    findings,
    checks: ["dashes", "never_named", "clearance", "requisition_codes"],
    // The stored verdict was for the old bytes. Say so rather than let the row
    // read as critic-approved (AGENTS.md section 8).
    critic_stale: true,
  };
}

// ---------------------------------------------------------------------------
// POST /api/rows/:id/mark-sent
// ---------------------------------------------------------------------------

/** The advertiser's own portal, named the way a person would name it. */
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the advertiser's portal"; }
}

export type MarkSentResult = {
  ok: true;
  id: string;
  status_after: PipelineStatus;
  submitted_at: string;
  confirmation_ref: string | null;
  file: string;
};

/**
 * "I applied myself." An external portal, a recruiter's own form or an ATS the
 * harness has no adapter for all end the same way: the person finishes it in
 * their browser and the row has to catch up. The move goes through `setStatus`,
 * so an illegal one is refused here exactly as it would be anywhere else, and
 * the receipt is written into the package under the same name an autopilot send
 * uses, so nothing downstream has to know which lane sent it.
 */
export async function postMarkSent(
  id: string,
  body: { confirmation?: unknown; note?: unknown } = {},
  ctx: ApiContext = {},
): Promise<MarkSentResult> {
  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);
  const confirmation = trimmed(body.confirmation);
  const note = trimmed(body.note);
  const host = hostOf(row.url);

  const moved = await move(id, "submitted", `applied manually via ${host}`);
  const now = new Date().toISOString();
  await patchOpportunity(
    id,
    { submittedAt: now, ...(confirmation ? { confirmationRef: confirmation } : {}) } as Partial<Opportunity>,
    "ui",
    "applied manually",
  );

  const dir = (await packageDirFor(row, ctx)) ?? path.join(archiveDirOf(ctx), row.id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "confirmation.txt");
  await writeAtomic(file, [
    `Applied by hand via ${host}.`,
    "",
    `Opportunity: ${id}`,
    `Role: ${row.title}`,
    `Advertiser: ${row.company}`,
    `Channel: ${row.channel}`,
    `Ad URL: ${row.url}`,
    `Submitted at: ${now}`,
    `Confirmation: ${confirmation || "(none recorded)"}`,
    "Recorded: by the person, in the local UI",
    ...(note ? ["", note] : []),
  ].join("\n") + "\n");

  await log({
    event_type: "manual_action_completed",
    role_id: id,
    actor: "ui",
    channel: row.channel,
    details: { company: row.company, title: row.title, host, confirmation_ref: confirmation || null, file, note: note || null },
    provenance: { url: row.url, channel: row.channel },
  });

  return { ok: true, id, status_after: moved.status_after, submitted_at: now, confirmation_ref: confirmation || null, file };
}

// ---------------------------------------------------------------------------
// POST /api/rows/:id/redraft
// ---------------------------------------------------------------------------

export type RedraftResult = { ok: true; id: string; redraft_requested: { at: string; reason: string | null } };

/**
 * "Write this letter again." No status move: the row is wherever it was, and
 * the request is a field on it. The /daily letter loop reads that field and
 * treats the row like a saved job (up to two `cover-letter-writer` passes with
 * the critic findings, then park), and clears it when a regeneration lands.
 */
export async function postRedraft(id: string, body: { reason?: unknown } = {}): Promise<RedraftResult> {
  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);
  const reason = trimmed(body.reason) || null;
  const request = { at: new Date().toISOString(), reason };
  await patchOpportunity(id, { redraftRequested: request } as Partial<Opportunity>, "ui", "redraft requested");
  await log({
    event_type: REDRAFT_REQUESTED,
    role_id: id,
    actor: "ui",
    channel: row.channel,
    details: { company: row.company, title: row.title, status: row.status, reason },
    provenance: { url: row.url, channel: row.channel },
  });
  return { ok: true, id, redraft_requested: request };
}

// ---------------------------------------------------------------------------
// POST /api/rows/:id/retry-now, and the jobs it starts
// ---------------------------------------------------------------------------

/** The two statuses a retry may start from. */
const RETRY_FROM = ["manual_action_needed", "approved"] as const;
/** The one-click apply methods `autopilot-submit` has an adapter for. */
const ONE_CLICK = ["quick_apply", "easy_apply"] as const;

export type RetryNowResult = { ok: true; id: string; job_id: string; command: string; status_before: PipelineStatus };

/**
 * Run the autopilot tool for one row, now, with the person present.
 *
 * This adds no authority. `tools/autopilot-submit.ts` runs the letter-critic
 * and the submission gate itself and refuses anything they refuse; the button
 * only decides that a run is worth starting. So the refusals here are about the
 * lane, not the package: a row outside the one-click channels has no adapter to
 * drive, and a kill switch or a disabled autopilot means no send happens today
 * whoever asks (AGENTS.md section 2).
 */
export async function postRetryNow(id: string, ctx: ApiContext = {}): Promise<RetryNowResult> {
  const row = await getOpportunity(id);
  if (!row) throw new ApiError(404, `no such opportunity: ${id}`);
  const method = String(row.applyMethod ?? "unknown");
  if (!(RETRY_FROM as readonly string[]).includes(row.status) || !(ONE_CLICK as readonly string[]).includes(method)) {
    throw new ApiError(409, `retry runs the autopilot lane only: this row is ${row.status} with applyMethod '${method}', and the lane is ${RETRY_FROM.join(" or ")} with ${ONE_CLICK.join(" or ")}`);
  }

  const policy = await getPolicy({ profileId: ctx.profileId ?? null });
  if (policy.kill_switch) throw new ApiError(409, `the kill switch is on in ${policy.path}; nothing sends until it is off`);
  if (!policy.autopilot_enabled) throw new ApiError(409, `autopilot is off in ${policy.path}; turn it on before retrying a send`);

  const running = runningJobFor(id);
  if (running) throw new ApiError(409, `a retry is already running for ${id} (job ${running.id}, started ${running.started_at})`);

  const statusBefore = row.status;
  if (row.status === "manual_action_needed") await move(id, "approved", "ui: retry now");

  const { command, args } = resolveAutopilotCommand(id);
  const job = startJob({ rowId: id, command, args });
  return { ok: true, id, job_id: job.id, command: [command, ...args].join(" "), status_before: statusBefore };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResult | null> {
  const method = req.method.toUpperCase();
  const pathname = req.pathname.replace(/\/+$/, "") || "/";
  const query = req.query ?? new URLSearchParams();

  // The keyword routes are their own module (api.ts is not editable from this
  // package, so one extension module hands on to the other).
  const keywords = await keywordsExt.handle(req, ctx);
  if (keywords) return keywords;

  // The jobs a "Retry now" started. Read-only: a job is started by the row it
  // belongs to, never from here.
  const job = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (job) {
    if (method !== "GET") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    const found = getJob(decodeURIComponent(job[1]));
    return found ? { status: 200, body: found } : { status: 404, body: { error: `no such job: ${decodeURIComponent(job[1])}` } };
  }
  if (pathname === "/api/jobs") {
    if (method !== "GET") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: { jobs: listJobs(20) } };
  }

  if (method === "GET" && pathname === "/api/rows") {
    return {
      status: 200,
      body: await getRowsWithActions(
        { status: query.get("status"), limit: query.get("limit"), q: query.get("q"), channel: query.get("channel") },
        ctx,
      ),
    };
  }

  if (method === "GET" && pathname === "/api/followups") {
    return { status: 200, body: await getFollowUps({ days: query.get("days") }, ctx) };
  }

  const unpark = pathname.match(/^\/api\/rows\/([^/]+)\/unpark$/);
  if (unpark) {
    if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await postUnpark(decodeURIComponent(unpark[1]), (req.body ?? {}) as { reason?: unknown }) };
  }

  const outcome = pathname.match(/^\/api\/rows\/([^/]+)\/outcome$/);
  if (outcome) {
    if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await postOutcome(decodeURIComponent(outcome[1]), (req.body ?? {}) as { status?: unknown; note?: unknown }) };
  }

  const markSent = pathname.match(/^\/api\/rows\/([^/]+)\/mark-sent$/);
  if (markSent) {
    if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await postMarkSent(decodeURIComponent(markSent[1]), (req.body ?? {}) as { confirmation?: unknown; note?: unknown }, ctx) };
  }

  const redraft = pathname.match(/^\/api\/rows\/([^/]+)\/redraft$/);
  if (redraft) {
    if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await postRedraft(decodeURIComponent(redraft[1]), (req.body ?? {}) as { reason?: unknown }) };
  }

  const retryNow = pathname.match(/^\/api\/rows\/([^/]+)\/retry-now$/);
  if (retryNow) {
    if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await postRetryNow(decodeURIComponent(retryNow[1]), ctx) };
  }

  const letter = pathname.match(/^\/api\/rows\/([^/]+)\/letter$/);
  if (letter) {
    if (method !== "POST") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await postLetter(decodeURIComponent(letter[1]), (req.body ?? {}) as { text?: unknown }, ctx) };
  }

  const detail = pathname.match(/^\/api\/rows\/([^/]+)$/);
  if (detail && method === "GET") {
    return { status: 200, body: await getRowDetailPlus(decodeURIComponent(detail[1]), ctx) };
  }

  return null;
}
