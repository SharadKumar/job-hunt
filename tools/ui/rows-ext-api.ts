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
 *   - `POST /api/rows/:id/letter` writes the package's cover letter back and
 *     re-runs the deterministic pre-checks from tools/letter-critic.ts. The
 *     model critic is deliberately NOT run from a browser click: it is the
 *     cold fact-check that gates an unattended send, and it runs when the row
 *     is retried through autopilot, against the letter's sha.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import { ApiError, getRowDetail, getRows, type ApiContext, type ApiRequest, type ApiResult, type RowSummary } from "./api.ts";
import { get as getOpportunity, list as listOpportunities, setStatus, type Opportunity, type PipelineStatus } from "../pipeline.ts";
import { deterministicFindings, loadProfileRules, requisitionCodesNotInJd, type CriticFinding } from "../letter-critic.ts";
import { log, type AuditEventType } from "../audit.ts";
import { writeAtomic } from "../lib/fs.ts";
import { repoPath } from "../repo-root.ts";

/**
 * A letter edited by hand at the person's own machine. `AuditEventType` is
 * owned by tools/audit.ts and the log itself is untyped JSONL; name the event
 * once here rather than widen another module's type, exactly as policy-api.ts
 * does for `policy_change`.
 */
const LETTER_EDITED = "letter_edited" as AuditEventType;

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
  kind: "answer" | "portal" | "retry" | "reject" | "approve" | "unpark" | "outcome" | "none";
  label: string;
  /** A Tray action for POST /api/rows/:id/action, when that is the move. */
  post: string | null;
  /** The status for POST /api/rows/:id/outcome, when that is the move. */
  outcome: string | null;
  /** An external address to open, for a row that has to be finished in a portal. */
  href: string | null;
  primary: boolean;
  danger: boolean;
};

const NONE: RowAction = { kind: "none", label: "", post: null, outcome: null, href: null, primary: false, danger: false };

const action = (patch: Partial<RowAction>): RowAction => ({ ...NONE, ...patch });

/** Rows that are finished, or in flight in a way a button cannot help. */
const NO_ACTION = new Set(["submitted", "won", "rejected", "withdrawn", "submission_pending"]);

/** The reason patterns the daily run writes when it parks a row on a human. */
const UNANSWERED_QUESTION = /screening question|unanswered question|question is not in/i;
const EXTERNAL_PORTAL = /external ats|external portal|external application|apply on (the )?company|not quick apply|non-quick-apply|redirect(ed)? to/i;
const LETTER_BLOCKED = /letter[-\s]?critic|letter critic/i;
const DUPLICATE = /duplicate/i;

export type ActionRow = { id: string; status: string; url?: string | null };

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
  if (UNANSWERED_QUESTION.test(text)) return action({ kind: "answer", label: "Answer", primary: true });
  if (EXTERNAL_PORTAL.test(text)) return action({ kind: "portal", label: "Open portal", href: row.url ?? null });
  if (LETTER_BLOCKED.test(text)) return action({ kind: "retry", label: "Retry", post: "retry" });
  if (DUPLICATE.test(text)) return action({ kind: "reject", label: "Reject", post: "reject", danger: true });
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
    package: pkg,
    package_dir: dir,
    package_files: await filesPresent(dir),
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
// Routing
// ---------------------------------------------------------------------------

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResult | null> {
  const method = req.method.toUpperCase();
  const pathname = req.pathname.replace(/\/+$/, "") || "/";
  const query = req.query ?? new URLSearchParams();

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
