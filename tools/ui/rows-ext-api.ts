/**
 * Extension API module (rows-ext). Owned by one work package; the dispatcher in
 * api.ts calls `handle` before its own routes and takes the first non-null
 * result. Return null for any request this module does not own.
 *
 * What lives here is everything the applications board needs beyond the plain
 * list that api.ts already serves:
 *
 *   - `GET /api/rows` is wrapped rather than replaced: the rows come back from
 *     api.ts unchanged, with the derived fields added. `actionFor` is the one
 *     place that decides which single button a row deserves, so the list, the
 *     row detail and the tests all read the same derivation instead of three
 *     copies of a regex in the browser.
 *   - Every row also carries its lane (`laneFor`, and `GET /api/lanes` for the
 *     same view per channel). AGENTS.md section 2 has two of them and the
 *     channel decides which: a SEEK row in the queue is drafted, checked and
 *     sent by the daily run, so offering the person an Approve button on it
 *     asks for a yes that authorises nothing. The lane is what keeps the board
 *     honest about which rows are actually waiting on them (`needs_you`).
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
import { HUNT_SCRIPTS } from "../channels/_interface.ts";
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
  kind:
    | "answer" | "portal" | "retry" | "reject" | "approve" | "unpark" | "outcome" | "decide" | "mark_sent"
    /** The run owns this row: nothing to click, and the note says who is doing what. */
    | "in_flight"
    /** The submission gate refused it on policy; a retry would hit the same gate. */
    | "gate_refused"
    /** Keep the run off this row until the person says otherwise (Tray `hold`). */
    | "hold"
    /** Prepared, but only a person may send it: the attended lane's terminus. */
    | "attended_send"
    | "none";
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
  /**
   * One sentence of why there is nothing to click, on the rows a run owns.
   * Null on a row whose button already says everything.
   */
  note: string | null;
};

const NONE: RowAction = { kind: "none", label: "", post: null, outcome: null, href: null, primary: false, danger: false, also: [], note: null };

const action = (patch: Partial<RowAction>): RowAction => ({ ...NONE, also: [], ...patch });

/** Rows that are finished, or in flight in a way a button cannot help. */
const NO_ACTION = new Set(["submitted", "won", "rejected", "withdrawn", "submission_pending"]);

/** The reason patterns the daily run writes when it parks a row on a human. */
const UNANSWERED_QUESTION = /screening question|unanswered question|question is not in/i;
const EXTERNAL_PORTAL = /external ats|external portal|external application|external\/unknown|external or unknown|apply on (the )?company|not quick apply|non-quick-apply|redirect(ed)? to/i;
const LETTER_BLOCKED = /letter[-\s]?critic|letter critic/i;
const DUPLICATE = /duplicate|already submitted .{0,60}within \d+ days|needs a user decision/i;

export type ActionRow = {
  id: string; status: string; url?: string | null; applyMethod?: string | null; channel?: string | null;
  /** A job the person saved on the channel: an order to apply (AGENTS.md section 2). */
  userSaved?: boolean | null;
};

// ---------------------------------------------------------------------------
// Which lane a row is in
// ---------------------------------------------------------------------------

/**
 * AGENTS.md section 2: there are two lanes and the channel decides, never the
 * person who asked. A row on the autopilot lane is drafted, checked and sent by
 * the daily run with nobody present; a row on the attended lane is prepared by
 * the run and sent by the person. The UI has to be able to tell them apart, or
 * it asks for an approval that authorises nothing (a `shortlisted` SEEK row
 * showing an Approve button was exactly that).
 *
 * The order of the checks is the order the facts are stable in. Channel and
 * apply method belong to the row and do not change when a switch is flipped, so
 * they are read first: a recruiter row is attended whatever the kill switch
 * says, and saying "kill switch on" about it would be a lie the moment the
 * switch goes off. The two switches come last, because they are the answer to
 * "why is this row attended today" only once the row could otherwise qualify.
 */
export type Lane = "autopilot" | "attended";

export type LaneVerdict = { lane: Lane; lane_reason: string };

/** The policy fields the lane depends on; `getPolicy` in policy-api.ts is the reader. */
export type LanePolicy = { autopilot_enabled: boolean; kill_switch: boolean; channels: string[] };

/** LinkedIn is the one channel where the apply method decides the lane. */
const LINKEDIN = "linkedin_jobs";

/**
 * Apply methods that leave a LinkedIn row on the autopilot lane. `unknown` (or
 * an unrecorded method) counts: the run reads the ad and resolves it, and a row
 * parked as attended before anyone has looked would be the wrong default for a
 * channel whose ads are mostly Easy Apply.
 */
const LINKEDIN_AUTOPILOT_METHODS = new Set(["easy_apply", "unknown", ""]);

/** How the person would name the thing that sends a row on this channel. */
const ADAPTERS: Record<string, string> = {
  seek: "the SEEK Quick Apply adapter",
  [LINKEDIN]: "the LinkedIn Easy Apply adapter",
};

const adapterFor = (channel: string): string => ADAPTERS[channel] ?? (channel ? `the ${channel} adapter` : "the autopilot adapter");

export function laneFor(row: { channel?: string | null; applyMethod?: string | null }, policy: LanePolicy): LaneVerdict {
  const channel = String(row.channel ?? "");
  const method = String(row.applyMethod ?? "");
  const attended = (lane_reason: string): LaneVerdict => ({ lane: "attended", lane_reason });

  if (!policy.channels.includes(channel)) return attended(`channel ${channel || "unknown"} is attended`);
  // An advertiser's own ATS has no one-click adapter behind it, whatever the
  // channel the ad was found on.
  if (method === "external") return attended("applyMethod external needs a person");
  if (channel === LINKEDIN && !LINKEDIN_AUTOPILOT_METHODS.has(method)) {
    return attended(`linkedin_jobs applyMethod ${method} is not Easy Apply`);
  }
  if (policy.kill_switch) return attended("kill switch on");
  if (!policy.autopilot_enabled) return attended("autopilot is off");

  if (channel === LINKEDIN) {
    return {
      lane: "autopilot",
      lane_reason: method === "easy_apply" ? "linkedin_jobs Easy Apply" : "linkedin_jobs, apply method resolved by the run",
    };
  }
  return { lane: "autopilot", lane_reason: `${channel} is an autopilot channel` };
}

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
 * The statuses a row passes through while a run is carrying it. On the
 * autopilot lane these need nothing from the person: the daily run drafts, runs
 * the letter-critic and the submission gate, and sends. `manual_action_needed`
 * is deliberately not here; that is the run saying it could not finish, and the
 * derivations below (answer, portal, retry, decide) are what it needs.
 */
const AUTOPILOT_IN_FLIGHT = new Set(["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending"]);

/** The same, on the attended lane: the run prepares, and stops. */
const ATTENDED_IN_FLIGHT = new Set(["shortlisted", "drafted"]);

/**
 * The two things a person may still do to a row the run owns: stop it, or drop
 * it. Neither is an approval; there is no approval to give on this lane.
 */
const holdOrReject = (): RowAction[] => [
  action({ kind: "hold", label: "Hold", post: "hold" }),
  action({ kind: "reject", label: "Reject", post: "reject", danger: true }),
];

// ---------------------------------------------------------------------------
// A gate refusal is not a retry
// ---------------------------------------------------------------------------

/**
 * The gate refused this row on policy, not on something a rerun could fix
 * (tools/submission-gate.ts writes the reason, and tools/autopilot-submit.ts
 * stamps it onto the row). Offering "Retry now" here is a lie: the next run
 * reads the same policy, refuses again, and the row comes back unchanged. So
 * these reasons earn their own derivation, which says in plain words what
 * stopped it and what would actually move it.
 *
 * A policy refusal is not a letter block or a missing answer: those are the run
 * failing at something, and a retry is exactly right for them.
 */
const POLICY_REFUSAL = /validation gate failed|is not on autopilot|not in autopilot|daily cap reached/i;

/** A channel key as the person would say it, for the sentences below. The same
 * two special cases the board's `channelLabel` has, and title case for the rest. */
const CHANNEL_NAMES: Record<string, string> = { seek: "SEEK", [LINKEDIN]: "LinkedIn" };
const channelName = (channel: string): string => CHANNEL_NAMES[channel]
  ?? (channel
    ? channel.split(/[_\s-]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
    : "the channel");

/**
 * Which policy refused it, and what the person can do about that one. The order
 * is the order the gate applies them in, so a reason that names two keys reads
 * as the first gate that stopped it.
 */
const REFUSALS: { test: RegExp; note: (row: ActionRow, text: string) => string }[] = [
  {
    // autopilot_fit: the discipline band, or an interstate row that belongs in parked.
    test: /autopilot_fit|discipline_fit|not user-saved/i,
    note: (row, text) => {
      const where = channelName(String(row.channel ?? ""));
      const fit = /discipline_fit is '([^']+)'/i.exec(text)?.[1];
      const what = fit
        ? `Discipline is ${fit} and the row is not saved on ${where}.`
        : `It is outside the autopilot discipline band and is not saved on ${where}.`;
      return `${what} Save it on ${where} to force it through, or send it in an attended session.`;
    },
  },
  { test: /red_flag_blocker/i, note: () => "A red flag blocks it; review the classification." },
  { test: /baseline/i, note: () => "The baseline CV is not approved; approve it on Resumes." },
  { test: /max_per_day|daily cap reached/i, note: () => "Daily cap reached; it runs tomorrow." },
  {
    test: /autopilot_channel|(is )?not (on|in) autopilot/i,
    note: (row) => `${channelName(String(row.channel ?? ""))} is not on the autopilot list; send it in an attended session.`,
  },
];

/**
 * The note for a refused row, or null when this is not a policy refusal.
 *
 * A job the person saved on the channel is never refused here: saving it is the
 * order to apply, the gate bypasses the fit, blocker and duplicate checks for
 * it, and every run retries it (AGENTS.md section 2). Telling them to save a
 * row they already saved would be nonsense.
 */
export function gateRefusal(row: ActionRow, reason: string): string | null {
  if (row.userSaved === true) return null;
  if (!POLICY_REFUSAL.test(reason)) return null;
  const hit = REFUSALS.find((r) => r.test.test(reason));
  return hit ? hit.note(row, reason) : null;
}

/**
 * One row, one button. The reason is what the run actually recorded, so it
 * decides first: a row blocked on a screening question wants an answer whatever
 * status it happens to sit in. Status decides the rest, and a row in flight or
 * finished gets nothing rather than a button that would be refused.
 */
export function actionFor(row: ActionRow, reason: string | null, lane: Lane = "attended"): RowAction {
  const status = String(row.status ?? "");
  const text = String(reason ?? "");
  // A response is a ladder: the only useful button is the next rung.
  if (status === "responded") return action({ kind: "outcome", label: "Interview", outcome: "interview", primary: true });
  if (status === "interview") return action({ kind: "outcome", label: "Offered", outcome: "offered", primary: true });
  if (status === "offered") return action({ kind: "outcome", label: "Won", outcome: "won", primary: true });
  // A row the run owns is not a row with a button. This sits above every
  // derivation below because a SEEK row in the queue is not waiting on a yes:
  // asking for one invents an authority the person never has to exercise
  // (AGENTS.md section 2).
  if (lane === "autopilot" && AUTOPILOT_IN_FLIGHT.has(status)) {
    return action({
      kind: "in_flight",
      label: "Autopilot handles this",
      also: holdOrReject(),
      note: `The daily run drafts, checks and sends this through ${adapterFor(String(row.channel ?? ""))}. Nothing needed from you.`,
    });
  }
  if (NO_ACTION.has(status)) return NONE;
  // External first, and whatever the reason says afterwards: there is no button
  // on this machine that can finish someone else's portal.
  if (isExternal(row, text)) {
    return action({ kind: "portal", label: "Open portal", href: row.url ?? null, also: [markSentButton()] });
  }
  // The gate refused it on policy. Nothing on this page changes a policy, so
  // there is no primary here and no retry at all: the row says what stopped it
  // and keeps the two moves that still mean something.
  const refused = gateRefusal(row, text);
  if (refused) {
    return action({
      kind: "gate_refused",
      label: "Outside the autopilot lane",
      note: refused,
      also: [
        action({ kind: "reject", label: "Reject", post: "reject", danger: true }),
        action({ kind: "hold", label: "Hold", post: "hold" }),
      ],
    });
  }
  if (UNANSWERED_QUESTION.test(text)) return action({ kind: "answer", label: "Answer", primary: true });
  if (DUPLICATE.test(text)) return action({ kind: "decide", label: "", also: decideButtons() });
  if (LETTER_BLOCKED.test(text)) return action({ kind: "retry", label: "Retry", post: "retry" });
  // Only here is an approval a real decision: on this lane nothing goes out
  // until the person is present and sends it themselves.
  if (status === "awaiting_approval") {
    return action({ kind: "approve", label: "Approve for the next attended session", post: "approve", primary: true });
  }
  if (status === "parked") return action({ kind: "unpark", label: "Unpark" });
  if (status === "manual_action_needed") return action({ kind: "retry", label: "Retry", post: "retry" });
  if (ATTENDED_IN_FLIGHT.has(status)) {
    return action({
      kind: "in_flight",
      label: "Being prepared",
      also: holdOrReject(),
      note: "The daily run prepares the package; you send it in an attended session.",
    });
  }
  // Approved on this lane means approved to be sent by a person. There is no
  // POST behind it: the send happens in an attended session (/submit-approved),
  // never from a browser click in an unattended-capable surface.
  if (status === "approved") {
    return action({
      kind: "attended_send",
      label: "Send in an attended session",
      also: holdOrReject(),
      note: "Approved, and waiting on you: this channel is never sent unattended.",
    });
  }
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

export type RowSummaryWithAction = RowSummary & {
  action: RowAction;
  lane: Lane;
  lane_reason: string;
  /** True when this row is waiting on the person rather than on a run. */
  needs_you: boolean;
};

export type RowsCounts = { needs_you: number; in_flight: number };

/**
 * A row is waiting on the person when the server decided there is something for
 * them to do: an answer, a portal, a decision, an approval, a send. A row a run
 * owns (`in_flight`) and a row that is finished (`none`) are not. That makes
 * `needs_you` false for every autopilot row in the approval queue, which is the
 * whole point of the lane: `GET /api/rows?status=awaiting_approval` on a SEEK
 * row counts as nothing to do.
 */
const needsYou = (action: RowAction): boolean => action.kind !== "in_flight" && action.kind !== "none";

export async function getRowsWithActions(
  query: { status?: string | null; limit?: string | null; q?: string | null; channel?: string | null },
  ctx: ApiContext = {},
): Promise<{ rows: RowSummaryWithAction[]; counts: RowsCounts }> {
  const { rows } = await getRows(query, ctx);
  // One policy read for the whole list: the lane is the same fact for every row
  // in the response, and re-reading the YAML per row would be a lie waiting to
  // happen if someone flipped a switch mid-request.
  const policy = await getPolicy({ profileId: ctx.profileId ?? null });
  const decorated = rows.map((row) => {
    const { lane, lane_reason } = laneFor(row, policy);
    const derived = actionFor(row, row.reason, lane);
    return { ...row, action: derived, lane, lane_reason, needs_you: needsYou(derived) };
  });
  return {
    rows: decorated,
    counts: {
      needs_you: decorated.filter((row) => row.needs_you).length,
      in_flight: decorated.filter((row) => row.action.kind === "in_flight").length,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/lanes  (the policy view the tabs and the Home count read)
// ---------------------------------------------------------------------------

/** Channels the harness knows about, so an attended one is named, not absent. */
const KNOWN_CHANNELS = [...Object.keys(HUNT_SCRIPTS), "recruiter"];

export type LanesResponse = {
  autopilot_enabled: boolean;
  kill_switch: boolean;
  channels: string[];
  lane_of: Record<string, Lane>;
  /** Why each channel is where it is, in the same words a row carries. */
  reason_of: Record<string, string>;
};

/**
 * The lane each channel is in right now. It is the row derivation with the row
 * left out, so a channel answers the same way its rows do: with the kill switch
 * on, every channel here reads `attended`, because that is what today is.
 */
export async function getLanes(ctx: ApiContext = {}): Promise<LanesResponse> {
  const policy = await getPolicy({ profileId: ctx.profileId ?? null });
  const channels = [...new Set([...KNOWN_CHANNELS, ...policy.channels])].sort();
  const lane_of: Record<string, Lane> = {};
  const reason_of: Record<string, string> = {};
  for (const channel of channels) {
    const verdict = laneFor({ channel, applyMethod: null }, policy);
    lane_of[channel] = verdict.lane;
    reason_of[channel] = verdict.lane_reason;
  }
  return {
    autopilot_enabled: policy.autopilot_enabled,
    kill_switch: policy.kill_switch,
    channels: policy.channels,
    lane_of,
    reason_of,
  };
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
  const policy = await getPolicy({ profileId: ctx.profileId ?? null });
  const { lane, lane_reason } = laneFor(detail.row, policy);
  const derived = actionFor(detail.row, detail.reason, lane);
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
    lane,
    lane_reason,
    needs_you: needsYou(derived),
    action: derived,
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
  // The same derivation the list and the detail show, so a row the board calls
  // attended can never be sent from this button either.
  const lane = laneFor(row, policy);
  if (lane.lane !== "autopilot") throw new ApiError(409, `retry runs the autopilot lane only: ${lane.lane_reason}`);

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

  if (method === "GET" && pathname === "/api/lanes") {
    return { status: 200, body: await getLanes(ctx) };
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
