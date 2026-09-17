/**
 * tools/ui/health-api.ts: is the harness actually running, and the screening
 * answers the person is the only one who can supply.
 *
 * Two jobs, one module, because both answer the same question from different
 * ends: why did nothing happen this morning?
 *
 *   GET  /api/health              the machine's own state: the last run, the
 *                                 next one, today's cap, and whether each
 *                                 channel still has a login that works.
 *   GET  /api/screening           the questions a portal asked that no answer
 *                                 in the profile covers, plus the years map.
 *   POST /api/screening/answer    bank an answer against one of them.
 *   POST /api/screening/skill-years   "I have N years with X".
 *   POST /api/screening/remove    drop a row that was never a real question.
 *
 * AGENTS.md section 2: nothing here submits, retries or contacts anything. It
 * reads state and it writes the person's own answers into their own
 * screening-answers.yaml, attended, from their own machine, audited. The next
 * unattended run picks the answer up through `loadScreeningAnswers`, which
 * already treats an answered `unknown_questions` row as an exact-match entry.
 *
 * Every write goes through `YAML.parseDocument` and splices the source rather
 * than re-serialising the document, for the same reason policy-api.ts does:
 * this file is full of hand-written comments, regex patterns and TODO markers,
 * and a round trip through the emitter would reflow all of it. The file the
 * person reads back is the file they wrote, one line different.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML, { isMap, isPair, isScalar, isSeq, type Document, type Node } from "yaml";

import { log, type AuditEventType } from "../audit.ts";
import { writeAtomic } from "../lib/fs.ts";
import { list as listOpportunities } from "../pipeline.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoPath, repoRoot } from "../repo-root.ts";
import { ApiError, type ApiContext, type ApiRequest, type ApiResult } from "./api.ts";
import { getPolicy } from "./policy-api.ts";

/**
 * The person answering a screening question is a policy-shaped act: it changes
 * what the unattended lane will send without asking again. `AuditEventType` is
 * owned by tools/audit.ts, so the name is asserted here rather than added to
 * another module's union; the log itself is untyped JSONL.
 */
const SCREENING_ANSWER = "screening_answer" as AuditEventType;

/** A login older than this is not trusted: portals expire sessions quietly. */
const SESSION_STALE_DAYS = 14;

/** Where install-launchd.sh puts the schedule. */
const PLIST_NAME = "com.job-hunt-harness.daily.plist";

const DAY_MS = 86_400_000;

/**
 * How long a log with no finish line is still read as a run in progress. The
 * wrapper writes to the log all the way through, so a log touched inside this
 * window belongs to a run that is still going, and an older one to a run that
 * was killed before it could write its finish line. Same window as the runs
 * API, for the same reason.
 */
const RUN_LIVE_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type LastRun = {
  /** The log's own date, which is the day the run started. */
  date: string;
  /** null when the log has no "finished" line: the run was killed or is still going. */
  exit_code: number | null;
  started_at: string | null;
  /** null while the run is still going, because it has not finished. */
  finished_at: string | null;
  /** The wall time of a finished run, or how long a running one has been going. */
  duration_seconds: number | null;
  /** Repo-relative, so the UI can name the file without leaking a home path. */
  log: string;
  /** Whether the log is still being written to, so nothing about it is final. */
  running: boolean;
};

export type ChannelHealth = {
  id: string;
  state: "ok" | "stale" | "missing";
  /** Repo-relative path of the session file or profile directory probed. */
  path: string;
  age_days: number | null;
  note: string;
};

export type HarnessHealth = {
  last_run: LastRun | null;
  /** ISO instant of the next scheduled run, or null when nothing is installed. */
  next_run: string | null;
  schedule: { installed: boolean; path: string; at: string | null };
  caps: {
    sent_today: number;
    max_per_day: number | null;
    autopilot_enabled: boolean;
    kill_switch: boolean;
  };
  channels: ChannelHealth[];
  /** Whether the daily wrapper has somewhere to post its one-line summary. */
  notify_url_set: boolean;
  generated_at: string;
};

export type HealthOptions = {
  profileId?: string | null;
  now?: Date;
  /** Overridable so a test can point at a fixture log dir and a fake plist. */
  logDir?: string;
  plistPath?: string;
  channelsDir?: string;
};

const nowOf = (opts: HealthOptions): Date => opts.now ?? new Date();

/** A path under the repo root reads better than an absolute one in the UI. */
function relativeToRepo(file: string): string {
  const rel = path.relative(repoRoot(), file);
  return rel.startsWith("..") ? file : rel;
}

/**
 * The first and last few KB of a file.
 *
 * A launchd log is 5 to 6 MB of stream-json, and the only two lines that
 * matter are the first and the last. Reading the whole thing to find them
 * would make opening Home cost more than the run it reports on.
 */
async function headAndTail(file: string, bytes = 8192): Promise<{ head: string; tail: string } | null> {
  const handle = await fsp.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const headBuf = Buffer.alloc(Math.min(bytes, size));
    if (headBuf.length) await handle.read(headBuf, 0, headBuf.length, 0);
    const tailLen = Math.min(bytes, size);
    const tailBuf = Buffer.alloc(tailLen);
    if (tailLen) await handle.read(tailBuf, 0, tailLen, size - tailLen);
    return { head: headBuf.toString("utf8"), tail: tailBuf.toString("utf8") };
  } finally {
    await handle.close();
  }
}

const isoOrNull = (value: string | undefined): string | null => {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/**
 * The newest `YYYY-MM-DD.log` in the launchd log dir, and what it says.
 *
 * A log with a start line and no finish line is two different runs depending on
 * when it was last written to: one still going, one killed. The mtime is what
 * tells them apart, and getting that wrong is what had Home calling the 07:00
 * run a failure at 07:24 while it was still working.
 */
export async function readLastRun(logDir: string, now: Date = new Date()): Promise<LastRun | null> {
  const names = (await fsp.readdir(logDir).catch(() => []))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort();
  const name = names[names.length - 1];
  if (!name) return null;
  const file = path.join(logDir, name);
  const [text, stat] = await Promise.all([headAndTail(file), fsp.stat(file).catch(() => null)]);
  const head = text?.head ?? "";
  const tail = text?.tail ?? "";

  const started = /^=== (\S+) starting daily run/m.exec(head);
  const finishes = [...tail.matchAll(/=== (\S+) finished daily run \(exit (\d+)\)/g)];
  const finished = finishes[finishes.length - 1];

  // The wrapper writes both stamps itself, so they are the truth. File times
  // are the fallback for a run that was killed before it could write one.
  const nowMs = now.getTime();
  const touched = stat ? stat.mtime.getTime() : nowMs;
  const running = !finished && Boolean(started) && nowMs - touched <= RUN_LIVE_MS;

  const startedAt = isoOrNull(started?.[1]) ?? (stat ? stat.birthtime.toISOString() : null);
  const finishedAt = finished ? isoOrNull(finished[1]) : running ? null : stat ? stat.mtime.toISOString() : null;
  // A run in progress has no end, so the clock it is measured against is now:
  // what the card says is how long it has been going, not how long it took.
  const endMs = running ? nowMs : finishedAt ? Date.parse(finishedAt) : Number.NaN;
  const durationMs = startedAt ? endMs - Date.parse(startedAt) : Number.NaN;

  return {
    date: name.replace(/\.log$/, ""),
    exit_code: finished ? Number(finished[2]) : null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_seconds: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs / 1000) : null,
    log: relativeToRepo(file),
    running,
  };
}

/** One `StartCalendarInterval` entry: when launchd will fire. */
type Interval = { hour: number; minute: number; weekday: number | null };

/**
 * The schedule out of the plist, without an XML parser.
 *
 * The file is written by scripts/install-launchd.sh, so its shape is known:
 * an array of dicts, each carrying Hour, Minute and Weekday integers. A plist
 * someone hand-edited into another shape simply yields no intervals, and the
 * UI then says the schedule is installed without claiming a time.
 */
export function parseIntervals(plist: string): Interval[] {
  const block = /<key>StartCalendarInterval<\/key>\s*([\s\S]*?)<\/array>/.exec(plist);
  const source = block ? block[1] : plist;
  const out: Interval[] = [];
  for (const dict of source.matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
    const pick = (key: string): number | null => {
      const m = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(dict[1]);
      return m ? Number(m[1]) : null;
    };
    const hour = pick("Hour");
    if (hour === null) continue;
    out.push({ hour, minute: pick("Minute") ?? 0, weekday: pick("Weekday") });
  }
  return out;
}

/**
 * The next instant any of those intervals fires, local time.
 *
 * launchd counts weekdays from Sunday, and accepts 7 for Sunday as well, which
 * is why the comparison is modulo 7. An interval with no Weekday fires daily.
 */
export function nextRunAt(intervals: Interval[], now: Date): Date | null {
  let best: Date | null = null;
  for (let ahead = 0; ahead <= 14; ahead += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    for (const interval of intervals) {
      if (interval.weekday !== null && interval.weekday % 7 !== day.getDay()) continue;
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), interval.hour, interval.minute, 0, 0);
      if (at.getTime() <= now.getTime()) continue;
      if (!best || at < best) best = at;
    }
    if (best) return best;
  }
  return best;
}

/** The session file (or browser profile) a channel signs in through. */
async function channelHealth(id: string, channelsDir: string, now: Date): Promise<ChannelHealth> {
  // linkedin_jobs and linkedin_posts are two channels on one login.
  const base = id.replace(/_(jobs|posts)$/, "");
  const candidates = [
    path.join(channelsDir, "storage-state", `${base}.json`),
    path.join(channelsDir, "chrome-profile", base),
  ];
  let found: { file: string; mtime: Date } | null = null;
  for (const file of candidates) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) continue;
    if (!found || stat.mtime > found.mtime) found = { file, mtime: stat.mtime };
  }
  if (!found) {
    return {
      id,
      state: "missing",
      path: relativeToRepo(candidates[0]),
      age_days: null,
      note: "session file missing",
    };
  }
  const ageDays = Math.max(0, Math.floor((now.getTime() - found.mtime.getTime()) / DAY_MS));
  const stale = ageDays >= SESSION_STALE_DAYS;
  return {
    id,
    state: stale ? "stale" : "ok",
    path: relativeToRepo(found.file),
    age_days: ageDays,
    note: stale
      ? `older than ${SESSION_STALE_DAYS} days, log in again`
      : ageDays === 0 ? "signed in today" : `signed in ${ageDays} day${ageDays === 1 ? "" : "s"} ago`,
  };
}

/** The channels the profile has switched on, in the order channels.yaml lists them. */
async function enabledChannels(profileId: string | null | undefined): Promise<string[]> {
  const file = path.join(resolveProfileContext(profileId ?? null).profileDir, "channels.yaml");
  const text = await fsp.readFile(file, "utf8").catch(() => null);
  if (text === null) return [];
  const parsed = (YAML.parse(text) ?? {}) as any;
  const channels = parsed?.channels;
  if (!channels || typeof channels !== "object") return [];
  return Object.entries(channels).filter(([, v]: [string, any]) => v?.enabled === true).map(([k]) => k);
}

/** GET /api/health */
export async function getHealth(opts: HealthOptions = {}): Promise<HarnessHealth> {
  const now = nowOf(opts);
  const logDir = opts.logDir ?? repoPath("state/journal/launchd");
  const channelsDir = opts.channelsDir ?? repoPath("state/channels");
  const plistPath = opts.plistPath ?? path.join(os.homedir(), "Library", "LaunchAgents", PLIST_NAME);

  const [lastRun, policy, rows, plist, ids] = await Promise.all([
    readLastRun(logDir, now),
    getPolicy({ profileId: opts.profileId ?? null }),
    listOpportunities({}),
    fsp.readFile(plistPath, "utf8").catch(() => null),
    enabledChannels(opts.profileId),
  ]);

  const today = now.toLocaleDateString("en-CA");
  const sentToday = rows.filter((r) => r.submittedAt && new Date(r.submittedAt).toLocaleDateString("en-CA") === today).length;

  const intervals = plist === null ? [] : parseIntervals(plist);
  const next = intervals.length ? nextRunAt(intervals, now) : null;
  const first = intervals[0];

  const channels: ChannelHealth[] = [];
  for (const id of ids) channels.push(await channelHealth(id, channelsDir, now));

  return {
    last_run: lastRun,
    next_run: next ? next.toISOString() : null,
    schedule: {
      installed: plist !== null,
      path: plistPath,
      at: first ? `${String(first.hour).padStart(2, "0")}:${String(first.minute).padStart(2, "0")}` : null,
    },
    caps: {
      sent_today: sentToday,
      max_per_day: policy.max_per_day,
      autopilot_enabled: policy.autopilot_enabled,
      kill_switch: policy.kill_switch,
    },
    channels,
    notify_url_set: Boolean(process.env.HARNESS_NOTIFY_URL),
    generated_at: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Screening answers
// ---------------------------------------------------------------------------

export type ScreeningKind = "text" | "option" | "numeric";

export type UnknownQuestion = {
  question: string;
  /** The same canonical form the submission worker matches on. */
  normalised: string;
  opportunity_id: string | null;
  company: string | null;
  title: string | null;
  /** The option labels a dropdown offered, when the worker captured them. */
  context: string | null;
  answer: string | null;
  kind: ScreeningKind;
};

export type ScreeningSnapshot = {
  unknown: UnknownQuestion[];
  skills_years: Record<string, number>;
  answers_count: number;
  /** Repo-relative, so the UI can name the file the person is editing. */
  path: string;
};

function screeningPath(profileId: string | null | undefined): string {
  return path.join(resolveProfileContext(profileId ?? null).profileDir, "screening-answers.yaml");
}

/**
 * `normaliseQuestion` belongs to the SEEK adapter, and matching must be the
 * same function the worker uses or a banked answer will not be found again.
 * The import is lazy because that module pulls playwright in, and a local UI
 * that nobody has opened the screening panel on should not pay for a browser
 * driver it will never start.
 */
let normaliser: ((text: string | null | undefined) => string) | null = null;
async function normalise(text: string | null | undefined): Promise<string> {
  if (!normaliser) normaliser = (await import("../channels/seek-submit.ts")).normaliseQuestion;
  return normaliser(text);
}

async function readScreeningText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** What sort of field this question was, so the panel offers the right input. */
function kindOf(row: any, question: string): ScreeningKind {
  const declared = typeof row?.kind === "string" ? row.kind.toLowerCase() : "";
  if (declared === "text" || declared === "option" || declared === "numeric") return declared;
  if (Array.isArray(row?.select) || (typeof row?.context === "string" && row.context.includes("|"))) return "option";
  if (/how many years|years of (work )?experience/i.test(question)) return "numeric";
  return "text";
}

/** Both accepted shapes of a `skills_years:` row, flattened to one number. */
function flattenSkillYears(raw: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (value && typeof value === "object" && Number.isFinite(Number((value as any).years))) {
      out[key] = Number((value as any).years);
    }
  }
  return out;
}

/** GET /api/screening */
export async function getScreening(opts: { profileId?: string | null } = {}): Promise<ScreeningSnapshot> {
  const file = screeningPath(opts.profileId);
  const text = await readScreeningText(file);
  if (text === null) {
    return { unknown: [], skills_years: {}, answers_count: 0, path: relativeToRepo(file) };
  }
  const parsed = (YAML.parse(text) ?? {}) as any;
  const rows = Array.isArray(parsed?.unknown_questions) ? parsed.unknown_questions : [];
  const unknown: UnknownQuestion[] = [];
  for (const row of rows) {
    if (!row || typeof row.question !== "string" || !row.question.trim()) continue;
    const question = row.question;
    const answer = row.answer == null || String(row.answer).trim() === "" ? null : String(row.answer);
    unknown.push({
      question,
      normalised: await normalise(question),
      opportunity_id: row.opportunity_id == null ? null : String(row.opportunity_id),
      company: row.company == null ? null : String(row.company),
      title: row.title == null ? null : String(row.title),
      context: row.context == null ? null : String(row.context),
      answer,
      kind: kindOf(row, question),
    });
  }
  return {
    unknown,
    skills_years: flattenSkillYears(parsed?.skills_years),
    answers_count: Array.isArray(parsed?.answers) ? parsed.answers.length : 0,
    path: relativeToRepo(file),
  };
}

// --- the source splices ----------------------------------------------------

/** Start of the line `index` sits on. */
function lineStart(text: string, index: number): number {
  const at = text.lastIndexOf("\n", Math.max(0, index - 1));
  return at === -1 ? 0 : at + 1;
}

/** Just past the newline that ends the line `index` sits on. */
function lineEnd(text: string, index: number): number {
  const at = text.indexOf("\n", index);
  return at === -1 ? text.length : at + 1;
}

/** The leading spaces of the line `index` sits on. */
function indentAt(text: string, index: number): string {
  const start = lineStart(text, index);
  return /^[ ]*/.exec(text.slice(start, index))?.[0] ?? "";
}

/** A YAML double-quoted scalar. JSON's escapes are a subset of YAML's. */
const quoted = (value: string): string => JSON.stringify(value);

/** Replace a node's own source text, leaving every other byte alone. */
function spliceNode(text: string, node: Node | null | undefined, source: string): string | null {
  if (!node || !(node as any).range) return null;
  const [start, end] = (node as any).range as [number, number, number];
  return text.slice(0, start) + source + text.slice(end);
}

function unknownSeq(doc: Document) {
  const node = doc.get("unknown_questions", true);
  return isSeq(node) ? node : null;
}

/** The sequence item whose question matches, and its index. */
async function findUnknown(doc: Document, question: string): Promise<{ item: any; index: number } | null> {
  const seq = unknownSeq(doc);
  if (!seq) return null;
  const target = await normalise(question);
  for (let i = 0; i < seq.items.length; i += 1) {
    const item = seq.items[i];
    if (!isMap(item)) continue;
    const asked = item.get("question");
    if (typeof asked === "string" && (await normalise(asked)) === target) return { item, index: i };
  }
  return null;
}

/**
 * Write `answer:` into an existing row. The common case is a splice of the
 * `null` the worker parked there; a row hand-written without the key at all
 * gets one inserted under its last line, at the row's own indentation.
 */
function setAnswerInRow(text: string, item: any, source: string): string {
  const pair = item.items.find((p: unknown) => isPair(p) && isScalar(p.key) && p.key.value === "answer");
  if (pair && isScalar(pair.value)) {
    const next = spliceNode(text, pair.value as Node, source);
    if (next !== null) return next;
  }
  const last = item.items[item.items.length - 1];
  const end = (last?.value as any)?.range?.[1] ?? (item as any).range?.[1] ?? text.length;
  const indent = indentAt(text, (item as any).range?.[0] ?? end);
  const at = lineEnd(text, end);
  return `${text.slice(0, at)}${indent}answer: ${source}\n${text.slice(at)}`;
}

/** Append a brand new `unknown_questions` row, creating the key if need be. */
function appendUnknownRow(text: string, question: string, source: string): string {
  let out = text;
  if (!/^unknown_questions:\s*$/m.test(out)) {
    if (/^unknown_questions:\s*\[\s*\]\s*$/m.test(out)) {
      out = out.replace(/^unknown_questions:\s*\[\s*\]\s*$/m, "unknown_questions:");
    } else {
      out = `${out.trimEnd()}\n\nunknown_questions:\n`;
    }
  }
  if (!out.endsWith("\n")) out += "\n";
  return `${out}  - question: ${quoted(question)}\n    answer: ${source}\n`;
}

/**
 * How the answer is written into the file. A numeric field wants the bare
 * number so the portal's own input accepts it; everything else is a quoted
 * string, which is also what a years answer becomes when it is a sentence.
 */
function answerSource(answer: string, kind: ScreeningKind): string {
  if (kind === "numeric" && /^\d+(\.\d+)?$/.test(answer.trim())) return answer.trim();
  return quoted(answer);
}

function readString(body: any, field: string): string {
  const value = typeof body?.[field] === "string" ? body[field].trim() : "";
  if (!value) throw new ApiError(400, `${field} is required`);
  return value;
}

function readKind(body: any): ScreeningKind {
  const kind = typeof body?.kind === "string" ? body.kind.toLowerCase() : "";
  if (!kind) return "text";
  if (kind === "text" || kind === "option" || kind === "numeric") return kind;
  throw new ApiError(400, `kind must be text, option or numeric, got '${String(body.kind)}'`);
}

/** The file, parsed, or the 409 that says this profile was never set up. */
async function openScreening(profileId: string | null | undefined): Promise<{ file: string; text: string; doc: Document }> {
  const file = screeningPath(profileId);
  const text = await readScreeningText(file);
  if (text === null) {
    throw new ApiError(409, `no screening answers at ${relativeToRepo(file)}; run the setup skill before banking one`);
  }
  return { file, text, doc: YAML.parseDocument(text) };
}

async function record(details: Record<string, unknown>): Promise<void> {
  await log({ event_type: SCREENING_ANSWER, role_id: null, actor: "ui", details });
}

/** POST /api/screening/answer */
export async function postScreeningAnswer(
  body: { question?: unknown; answer?: unknown; kind?: unknown } = {},
  opts: { profileId?: string | null } = {},
): Promise<{ ok: true; question: string; matched: boolean; kind: ScreeningKind }> {
  const question = readString(body, "question");
  const answer = readString(body, "answer");
  const kind = readKind(body);
  const { file, text, doc } = await openScreening(opts.profileId);

  const hit = await findUnknown(doc, question);
  const source = answerSource(answer, kind);
  const next = hit ? setAnswerInRow(text, hit.item, source) : appendUnknownRow(text, question, source);
  await writeAtomic(file, next);

  await record({ action: "answer", question: await normalise(question), matched: Boolean(hit), kind });
  return { ok: true, question, matched: Boolean(hit), kind };
}

/** The `skills_years:` pair, written out at `indent`. */
function skillSource(skill: string, years: number, aliases: string[], indent: string): string {
  if (!aliases.length) return `${indent}${skill}: ${years}`;
  const list = aliases.map((a) => quoted(a)).join(", ");
  return `${indent}${skill}:\n${indent}  years: ${years}\n${indent}  aliases: [${list}]`;
}

/** POST /api/screening/skill-years */
export async function postSkillYears(
  body: { skill?: unknown; years?: unknown; aliases?: unknown } = {},
  opts: { profileId?: string | null } = {},
): Promise<{ ok: true; skill: string; years: number }> {
  const skill = readString(body, "skill").toLowerCase();
  const years = Number(body?.years);
  if (!Number.isFinite(years) || years < 0) throw new ApiError(400, `years must be a number of years, got '${String(body?.years)}'`);
  const aliases = Array.isArray(body?.aliases)
    ? (body.aliases as unknown[]).map((a) => String(a).trim().toLowerCase()).filter(Boolean)
    : [];

  const { file, text, doc } = await openScreening(opts.profileId);
  const map = doc.get("skills_years", true);
  let next: string | null = null;

  if (isMap(map) && map.items.length) {
    const indent = indentAt(text, ((map.items[0] as any).key?.range?.[0] ?? 0));
    const pair = map.items.find((p: unknown) => isPair(p) && isScalar(p.key) && String(p.key.value).toLowerCase() === skill) as any;
    if (pair) {
      // Replace the whole pair: an aliased entry is a block, not a scalar.
      const start = pair.key.range[0];
      const end = (pair.value?.range?.[1] ?? pair.key.range[1]) as number;
      next = text.slice(0, start) + skillSource(skill, years, aliases, "").replace(/\n/g, `\n${indent}`) + text.slice(end);
    } else {
      const last = map.items[map.items.length - 1] as any;
      const at = lineEnd(text, last.value?.range?.[1] ?? last.key.range[1]);
      next = `${text.slice(0, at)}${skillSource(skill, years, aliases, indent)}\n${text.slice(at)}`;
    }
  } else if (isMap(map) && (map as any).range) {
    // `skills_years: {}` from the template: the flow map becomes a block. The
    // space between the colon and the `{}` goes with it, or the key is left
    // with a trailing space on it.
    const [start, end] = (map as any).range as [number, number, number];
    let from = start;
    while (from > 0 && text[from - 1] === " ") from -= 1;
    next = `${text.slice(0, from)}\n${skillSource(skill, years, aliases, "  ")}${text.slice(end)}`;
  }

  if (next === null) {
    // No key at all. Put it above unknown_questions, which is always last.
    const block = `skills_years:\n${skillSource(skill, years, aliases, "  ")}\n`;
    const anchor = /^unknown_questions:/m.exec(text);
    next = anchor
      ? `${text.slice(0, anchor.index)}${block}\n${text.slice(anchor.index)}`
      : `${text.trimEnd()}\n\n${block}`;
  }

  await writeAtomic(file, next);
  await record({ action: "skill_years", skill, years, aliases });
  return { ok: true, skill, years };
}

/** POST /api/screening/remove */
export async function postScreeningRemove(
  body: { question?: unknown } = {},
  opts: { profileId?: string | null } = {},
): Promise<{ ok: true; removed: boolean }> {
  const question = readString(body, "question");
  const { file, text, doc } = await openScreening(opts.profileId);
  const hit = await findUnknown(doc, question);
  if (!hit) return { ok: true, removed: false };

  const seq = unknownSeq(doc)!;
  const from = lineStart(text, (hit.item as any).range[0]);
  const nextItem = seq.items[hit.index + 1] as any;
  // Up to the next row, or to the end of this row's last line when it is last.
  const to = nextItem ? lineStart(text, nextItem.range[0]) : lineEnd(text, (hit.item as any).range[1]);
  await writeAtomic(file, text.slice(0, from) + text.slice(to));

  await record({ action: "remove", question: await normalise(question) });
  return { ok: true, removed: true };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const ROUTES: Record<string, "GET" | "POST"> = {
  "/api/health": "GET",
  "/api/screening": "GET",
  "/api/screening/answer": "POST",
  "/api/screening/skill-years": "POST",
  "/api/screening/remove": "POST",
};

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResult | null> {
  const pathname = req.pathname.replace(/\/+$/, "") || "/";
  const wanted = ROUTES[pathname];
  if (!wanted) return null;
  const method = req.method.toUpperCase();
  if (method !== wanted) return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };

  const profileId = ctx.profileId ?? null;
  const body = (req.body ?? {}) as any;
  if (pathname === "/api/health") return { status: 200, body: await getHealth({ profileId, now: ctx.now }) };
  if (pathname === "/api/screening") return { status: 200, body: await getScreening({ profileId }) };
  if (pathname === "/api/screening/answer") return { status: 200, body: await postScreeningAnswer(body, { profileId }) };
  if (pathname === "/api/screening/skill-years") return { status: 200, body: await postSkillYears(body, { profileId }) };
  return { status: 200, body: await postScreeningRemove(body, { profileId }) };
}
