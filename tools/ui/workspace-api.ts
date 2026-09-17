/**
 * tools/ui/workspace-api.ts: the workspace routes. The run history, the
 * editorial rules, and the one approval the Resumes screen is allowed to make.
 *
 * The dispatcher in api.ts calls `handle` before its own routes and takes the
 * first non-null result, so everything here returns null for a request it does
 * not own.
 *
 * Three groups, and none of them re-implements a decision another tool owns:
 *
 *   - `GET /api/runs` and `GET /api/runs/:date` read what the daily run already
 *     wrote: the summary markdown under `state/journal/summary/<date>.md` (the
 *     Numbers table is the run's own tally, not a re-count from the pipeline)
 *     and the launchd log under `state/journal/launchd/<date>.log`, whose first
 *     and last lines carry the start instant and the exit code. The logs run to
 *     hundreds of megabytes, so only the two ends are ever read.
 *   - `GET /api/rules` and the three `POST /api/rules/standing…` routes are the
 *     attended half of AGENTS.md section 5: a recurring critic theme becomes a
 *     standing rule when the person says so, at their own machine, and the
 *     change is audited. `never_named` and `editorial-bans.yaml` are read only;
 *     they are pattern machinery, and a regex typed into a browser is a way to
 *     silently stop blocking something.
 *   - `POST /api/resumes/:id/approve` runs the real `npm run resume:approve`
 *     as a child process rather than copying its rules. The critic gate lives
 *     in that tool; a second implementation of it here would be a second
 *     opinion about whether a CV may be approved, and there may only be one.
 *
 * Every YAML write goes through `YAML.parseDocument` and splices the source
 * text where it can, exactly as tools/ui/policy-api.ts does, so the comments
 * the person wrote into their own rules file survive the edit. When a splice
 * is impossible (an empty `standing_rules: []` has no item to splice after)
 * the document is re-serialised with `lineWidth: 0`, and the response says
 * which of the two happened.
 */

import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML, { isScalar, isSeq } from "yaml";

import { ApiError, type ApiContext, type ApiRequest, type ApiResult } from "./api.ts";
import { log, type AuditEventType } from "../audit.ts";
import { writeAtomic } from "../lib/fs.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoPath, repoRoot } from "../repo-root.ts";

/**
 * A promotion, an edit or a removal of a standing rule. `AuditEventType` is
 * owned by tools/audit.ts and the log itself is untyped JSONL, so the event is
 * named once here rather than widening another module's type; policy-api.ts
 * does the same for `policy_change`.
 */
const RULE_CHANGE = "rule_change" as AuditEventType;

/** Runs shown by default, which is about six weeks of daily runs. */
const DEFAULT_RUN_LIMIT = 30;
const MAX_RUN_LIMIT = 365;

/** How much of each end of a launchd log is read. The middle is a transcript. */
const LOG_EDGE_BYTES = 8192;

/**
 * How long a log with no finish line is still read as a run in progress.
 *
 * A run brackets its log with a start line and a finish line, so a log with
 * only the start line is either a run still going or a run that was killed
 * before it could write the second bracket. The file's own mtime separates
 * them: the run writes to it constantly, so a log touched in the last three
 * hours is live and an older one is a corpse. Three hours is comfortably more
 * than the wrapper's own timeout, so a slow run is never called dead.
 */
const RUN_LIVE_MS = 3 * 60 * 60 * 1000;

/** A standing rule is one or two sentences; anything longer is a paste error. */
const RULE_MAX = 1200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

/**
 * `ctx.journalDir` is the summary directory (api.ts owns that name), and the
 * journal root and the launchd directory are its siblings. Deriving them keeps
 * a test that redirects the summaries from having to redirect three paths.
 */
const summaryDirOf = (ctx: ApiContext): string => ctx.journalDir ?? repoPath("state/journal/summary");
const journalRootOf = (ctx: ApiContext): string => path.dirname(summaryDirOf(ctx));
const launchdDirOf = (ctx: ApiContext): string => path.join(journalRootOf(ctx), "launchd");

const rulesPathOf = (ctx: ApiContext): string =>
  path.join(resolveProfileContext(ctx.profileId ?? null).profileDir, "letter-critic-rules.yaml");
const bansPathOf = (ctx: ApiContext): string =>
  path.join(resolveProfileContext(ctx.profileId ?? null).profileDir, "editorial-bans.yaml");

function relativeToRepo(file: string): string {
  const rel = path.relative(repoRoot(), file);
  return rel.startsWith("..") ? file : rel;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// GET /api/runs
// ---------------------------------------------------------------------------

export type RunSummary = {
  date: string;
  /** From the summary's Numbers table; null when there is no summary to read. */
  sent: number | null;
  /** The manual backlog the run left behind, same table. */
  blocked: number | null;
  /** null while a run is in progress, and null for a run that was killed. */
  exit_code: number | null;
  /** The wall time of a finished run, or how long a running one has been going. */
  duration_s: number | null;
  summary_path: string | null;
  has_summary: boolean;
  /** Whether the launchd log exists at all, which is not the same as a summary. */
  has_log: boolean;
  /** A run whose log is still being written to, so nothing about it is final. */
  running: boolean;
  /** Why there is no exit code, when the reason is worth saying. */
  note: string | null;
};

export type RunDetail = {
  date: string;
  markdown: string | null;
  letters_sent: { title: string; letter: string }[];
};

/**
 * The Numbers table the daily summary ends with, as a map of column to cell.
 * The table is the run's own arithmetic; re-deriving `sent` from the pipeline
 * would answer a different question (what is true now, not what that run did).
 */
export function parseNumbersTable(markdown: string): Record<string, string> {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => /^##\s+Numbers\s*$/.test(line.trim()));
  if (at < 0) return {};
  const rows: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const text = line.trim();
    if (!text) continue;
    if (!text.startsWith("|")) break;
    if (/^\|[-:|\s]+\|$/.test(text)) continue;
    rows.push(text);
  }
  if (rows.length < 2) return {};
  const cells = (row: string) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = cells(rows[0]);
  const values = cells(rows[1]);
  const out: Record<string, string> = {};
  header.forEach((name, i) => { if (name) out[name] = values[i] ?? ""; });
  return out;
}

/** The leading whole number of a cell like `1 of 30`, or null. */
function leadingNumber(value: string | undefined): number | null {
  const hit = /(-?\d+)/.exec(String(value ?? ""));
  return hit ? Number(hit[1]) : null;
}

/**
 * What the run sent and what it left blocked.
 *
 * The Numbers table is preferred. A run that died before `daily-summary` could
 * write one leaves the fallback summary, which has no table, so the headline
 * line (`Sent 1, escalations 41, queue 0.`) answers instead.
 */
export function runTally(markdown: string): { sent: number | null; blocked: number | null } {
  const numbers = parseNumbersTable(markdown);
  const sent = leadingNumber(numbers["Sent today"]);
  const blocked = leadingNumber(numbers["Manual"]);
  if (sent !== null || blocked !== null) return { sent, blocked };
  const headline = /Sent\s+(\d+),\s*escalations\s+(\d+)/i.exec(markdown);
  return headline ? { sent: Number(headline[1]), blocked: Number(headline[2]) } : { sent: null, blocked: null };
}

/** The first and last `LOG_EDGE_BYTES` of a file, without reading the middle. */
async function readEnds(file: string): Promise<{ head: string; tail: string; mtime_ms: number } | null> {
  let handle;
  try {
    handle = await fsp.open(file, "r");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size, mtimeMs } = await handle.stat();
    const headLength = Math.min(size, LOG_EDGE_BYTES);
    const headBuffer = Buffer.alloc(headLength);
    await handle.read(headBuffer, 0, headLength, 0);
    const tailLength = Math.min(size, LOG_EDGE_BYTES);
    const tailBuffer = Buffer.alloc(tailLength);
    await handle.read(tailBuffer, 0, tailLength, Math.max(0, size - tailLength));
    return { head: headBuffer.toString("utf8"), tail: tailBuffer.toString("utf8"), mtime_ms: mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * What one run did, from the two lines scripts/daily.sh brackets the log with:
 *
 *   === 2026-09-16T07:00:05+10:00 starting daily run via claude ===
 *   === 2026-09-16T08:13:26+10:00 finished daily run (exit 0) ===
 *
 * Both lines present is a finished run: the exit code is its own, and the wall
 * time is the gap. Only the start line is ambiguous, and `mtime_ms` resolves
 * it. A log still being written to is a run in progress, and its duration is
 * how long it has been going so far, not a final time. An older one is a run
 * that was killed, and it has no duration to report, only the note that it
 * never wrote a finish line. Reporting the second as the first is what put
 * "did not finish" on Home at 07:24 while the 07:00 run was still working.
 */
export function parseRunLog(
  head: string,
  tail: string,
  opts: { mtime_ms?: number; now?: number } = {},
): { exit_code: number | null; duration_s: number | null; running: boolean; note: string | null } {
  const started = /===\s*(\S+)\s+starting daily run/.exec(head);
  const finishes = [...tail.matchAll(/===\s*(\S+)\s+finished daily run \(exit (-?\d+)\)/g)];
  const last = finishes.length ? finishes[finishes.length - 1] : null;
  const from = started ? new Date(started[1]).getTime() : Number.NaN;

  if (last) {
    const to = new Date(last[1]).getTime();
    const measured = Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / 1000) : null;
    return { exit_code: Number(last[2]), duration_s: measured, running: false, note: null };
  }

  const now = opts.now ?? Date.now();
  const touched = opts.mtime_ms ?? now;
  if (started && now - touched <= RUN_LIVE_MS) {
    const soFar = Number.isFinite(from) ? Math.max(0, Math.round((now - from) / 1000)) : null;
    return { exit_code: null, duration_s: soFar, running: true, note: null };
  }
  return { exit_code: null, duration_s: null, running: false, note: "no finish line" };
}

function parseLimit(value: string | number | null | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, `limit must be a positive number, got '${String(value)}'`);
  return Math.min(Math.floor(n), MAX_RUN_LIMIT);
}

export async function getRuns(
  query: { limit?: string | number | null } = {},
  ctx: ApiContext = {},
): Promise<{ runs: RunSummary[]; total: number }> {
  const limit = parseLimit(query.limit, DEFAULT_RUN_LIMIT);
  const summaryDir = summaryDirOf(ctx);
  const launchdDir = launchdDirOf(ctx);

  const dates = new Set<string>();
  for (const name of await listNames(summaryDir)) {
    const hit = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    if (hit) dates.add(hit[1]);
  }
  for (const name of await listNames(launchdDir)) {
    const hit = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (hit) dates.add(hit[1]);
  }

  const ordered = [...dates].sort().reverse();
  const runs: RunSummary[] = [];
  for (const date of ordered.slice(0, limit)) {
    const summaryFile = path.join(summaryDir, `${date}.md`);
    const markdown = await readTextIfExists(summaryFile);
    const tally = markdown ? runTally(markdown) : { sent: null, blocked: null };
    const ends = await readEnds(path.join(launchdDir, `${date}.log`));
    const fromLog = ends
      ? parseRunLog(ends.head, ends.tail, { mtime_ms: ends.mtime_ms })
      : { exit_code: null, duration_s: null, running: false, note: null };
    runs.push({
      date,
      sent: tally.sent,
      blocked: tally.blocked,
      exit_code: fromLog.exit_code,
      duration_s: fromLog.duration_s,
      summary_path: markdown === null ? null : relativeToRepo(summaryFile),
      has_summary: markdown !== null,
      has_log: ends !== null,
      running: fromLog.running,
      note: fromLog.note,
    });
  }
  return { runs, total: ordered.length };
}

// ---------------------------------------------------------------------------
// GET /api/runs/:date
// ---------------------------------------------------------------------------

/** The heading level of a markdown heading line, or 0 when it is not one. */
function headingLevel(line: string): number {
  const hit = /^(#{1,6})\s+/.exec(line);
  return hit ? hit[1].length : 0;
}

/** Markdown emphasis and code ticks off a heading line, so a title reads plainly. */
function plainTitle(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The letters an unattended run sent, out of the journal's "Sent unattended"
 * section (AGENTS.md section 3.9 puts the full text there). Each bullet is one
 * send; the blockquote under it is the letter as it went out.
 */
export function parseSentUnattended(journal: string): { title: string; letter: string }[] {
  const lines = journal.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((line) => headingLevel(line) > 0 && /^sent unattended\b/i.test(plainTitle(line.replace(/^#{1,6}\s+/, ""))));
  if (at < 0) return [];
  const level = headingLevel(lines[at]);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const next = headingLevel(line);
    if (next > 0 && next <= level) break;
    body.push(line);
  }

  const out: { title: string; letter: string }[] = [];
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const title = plainTitle(block[0]).slice(0, 200);
    const letter = block
      .map((line) => /^\s*>\s?(.*)$/.exec(line))
      .filter((hit): hit is RegExpExecArray => hit !== null)
      .map((hit) => hit[1].replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (title) out.push({ title, letter });
    block = [];
  };
  // A send is a top-level bullet. Indented bullets and blockquote lines belong
  // to the send above them, so only a marker in column one opens a new block.
  for (const line of body) {
    if (/^[-*+]\s+\S/.test(line)) flush();
    block.push(line);
  }
  flush();
  return out;
}

export async function getRun(date: string, ctx: ApiContext = {}): Promise<RunDetail> {
  if (!DATE_RE.test(date)) throw new ApiError(400, `date must be YYYY-MM-DD, got '${date}'`);
  const markdown = await readTextIfExists(path.join(summaryDirOf(ctx), `${date}.md`));
  const journal = await readTextIfExists(path.join(journalRootOf(ctx), `${date}.md`));
  return { date, markdown, letters_sent: journal ? parseSentUnattended(journal) : [] };
}

// ---------------------------------------------------------------------------
// GET /api/rules
// ---------------------------------------------------------------------------

export type NeverNamed = { pattern: string; issue: string; fix: string };
export type EditorialBan = {
  id: string;
  note: string | null;
  severity: string;
  scope: string | null;
  forbidden: string[];
  title_must_equal: string | null;
};

export type RulesResponse = {
  path: string;
  exists: boolean;
  standing_rules: string[];
  never_named: NeverNamed[];
  profile_facts: string[];
  editorial_bans: { path: string; exists: boolean; version: number | null; rules: EditorialBan[] };
};

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];

/** How a ban's scope reads in one phrase: the company, or the fields it covers. */
function scopeOf(scope: any): string | null {
  if (!scope || typeof scope !== "object") return null;
  if (scope.company) return `company matching ${String(scope.company)}`;
  const field = scope.field;
  if (Array.isArray(field)) return field.map((f: unknown) => String(f)).join(", ");
  return field ? String(field) : null;
}

export async function getRules(ctx: ApiContext = {}): Promise<RulesResponse> {
  const file = rulesPathOf(ctx);
  const text = await readTextIfExists(file);
  const parsed = (text === null ? {} : YAML.parse(text) ?? {}) as any;
  const bansFile = bansPathOf(ctx);
  const bansText = await readTextIfExists(bansFile);
  const bans = (bansText === null ? {} : YAML.parse(bansText) ?? {}) as any;

  return {
    path: relativeToRepo(file),
    exists: text !== null,
    standing_rules: asStrings(parsed.standing_rules),
    never_named: (Array.isArray(parsed.never_named) ? parsed.never_named : [])
      .filter((entry: any) => entry && typeof entry === "object")
      .map((entry: any) => ({
        pattern: String(entry.pattern ?? ""),
        issue: String(entry.issue ?? ""),
        fix: String(entry.fix ?? ""),
      })),
    profile_facts: asStrings(parsed.profile_facts),
    editorial_bans: {
      path: relativeToRepo(bansFile),
      exists: bansText !== null,
      version: typeof bans.version === "number" ? bans.version : null,
      rules: (Array.isArray(bans.rules) ? bans.rules : [])
        .filter((entry: any) => entry && typeof entry === "object")
        .map((entry: any) => ({
          id: String(entry.id ?? "unnamed rule"),
          note: entry.note ? String(entry.note) : null,
          severity: String(entry.severity ?? "fail"),
          scope: scopeOf(entry.scope),
          forbidden: [...asStrings(entry.forbidden_phrases), ...asStrings(entry.forbidden_regex)],
          title_must_equal: entry.title_must_equal ? String(entry.title_must_equal) : null,
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// The three standing-rule writes
// ---------------------------------------------------------------------------

/** A single-quoted YAML scalar, which needs no escaping beyond doubling quotes. */
const yamlScalar = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** One line, trimmed, and refused when it is empty or absurdly long. */
function readRuleText(body: unknown): string {
  const raw = (body as any)?.text;
  if (typeof raw !== "string") throw new ApiError(400, "text is required and must be a string");
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) throw new ApiError(400, "text is empty; a standing rule has to say something");
  if (text.length > RULE_MAX) throw new ApiError(400, `text is ${text.length} characters; the budget is ${RULE_MAX}`);
  return text;
}

type RulesDocument = { file: string; text: string; doc: YAML.Document.Parsed; seq: YAML.YAMLSeq | null };

async function openRules(ctx: ApiContext): Promise<RulesDocument> {
  const file = rulesPathOf(ctx);
  const text = await readTextIfExists(file);
  if (text === null) {
    throw new ApiError(409, `no letter-critic rules at ${relativeToRepo(file)}; run the setup skill before editing them`);
  }
  const doc = YAML.parseDocument(text);
  const node = doc.getIn(["standing_rules"], true);
  return { file, text, doc, seq: isSeq(node) ? (node as YAML.YAMLSeq) : null };
}

/** The `<indent>- ` marker in front of a block-sequence item, or null. */
function markerBefore(text: string, start: number): string | null {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const marker = text.slice(lineStart, start);
  return /^\s*-\s+$/.test(marker) ? marker : null;
}

const rangeOf = (item: unknown): [number, number, number] | null =>
  (isScalar(item) && item.range ? (item.range as [number, number, number]) : null);

/** The end of the line an offset sits on, so an insert lands after it. */
function endOfLine(text: string, at: number): number {
  const next = text.indexOf("\n", at);
  return next < 0 ? text.length : next;
}

async function saveRules(
  file: string,
  next: string,
  details: Record<string, unknown>,
): Promise<void> {
  await writeAtomic(file, next);
  await log({
    event_type: RULE_CHANGE,
    role_id: null,
    actor: "ui",
    details: { file: relativeToRepo(file), ...details },
  });
}

export type RuleWriteResponse = {
  ok: true;
  index: number;
  /** `splice` kept every byte around the edit; `document` re-serialised the file. */
  method: "splice" | "document";
  standing_rules: string[];
};

/** POST /api/rules/standing */
export async function postStandingRule(body: unknown, ctx: ApiContext = {}): Promise<RuleWriteResponse> {
  const text = readRuleText(body);
  const sourceTheme = typeof (body as any)?.source_theme === "string" ? (body as any).source_theme : null;
  const { file, text: source, doc, seq } = await openRules(ctx);
  const before = asStrings(doc.toJS()?.standing_rules);

  let next: string | null = null;
  let method: RuleWriteResponse["method"] = "document";
  const last = seq && !seq.flow && seq.items.length ? seq.items[seq.items.length - 1] : null;
  const range = rangeOf(last);
  const marker = range ? markerBefore(source, range[0]) : null;
  if (range && marker) {
    const at = endOfLine(source, range[1]);
    next = `${source.slice(0, at)}\n${marker}${yamlScalar(text)}${source.slice(at)}`;
    method = "splice";
  }
  if (next === null) {
    // No item to splice after (an empty `standing_rules: []`, a flow sequence,
    // or no key at all). Re-serialise instead, and keep the long scalars in the
    // rest of the file from being re-wrapped on the way out.
    doc.setIn(["standing_rules"], [...before, text]);
    next = doc.toString({ lineWidth: 0 });
  }

  await saveRules(file, next, { action: "append", index: before.length, text, source_theme: sourceTheme, method });
  return { ok: true, index: before.length, method, standing_rules: [...before, text] };
}

function itemAt(seq: YAML.YAMLSeq | null, index: number): unknown {
  if (!seq || !Number.isInteger(index) || index < 0 || index >= seq.items.length) {
    throw new ApiError(404, `no standing rule at index ${index}`);
  }
  return seq.items[index];
}

/** POST /api/rules/standing/:index */
export async function editStandingRule(index: number, body: unknown, ctx: ApiContext = {}): Promise<RuleWriteResponse> {
  const text = readRuleText(body);
  const { file, text: source, doc, seq } = await openRules(ctx);
  const before = asStrings(doc.toJS()?.standing_rules);
  const item = itemAt(seq, index);
  const range = rangeOf(item);

  let next: string;
  let method: RuleWriteResponse["method"];
  if (range) {
    next = `${source.slice(0, range[0])}${yamlScalar(text)}${source.slice(range[1])}`;
    method = "splice";
  } else {
    doc.setIn(["standing_rules", index], text);
    next = doc.toString({ lineWidth: 0 });
    method = "document";
  }

  const after = [...before];
  after[index] = text;
  await saveRules(file, next, { action: "edit", index, from: before[index] ?? null, to: text, method });
  return { ok: true, index, method, standing_rules: after };
}

/** POST /api/rules/standing/:index/remove */
export async function removeStandingRule(index: number, ctx: ApiContext = {}): Promise<RuleWriteResponse> {
  const { file, text: source, doc, seq } = await openRules(ctx);
  const before = asStrings(doc.toJS()?.standing_rules);
  const item = itemAt(seq, index);
  const range = rangeOf(item);
  const marker = range ? markerBefore(source, range[0]) : null;
  const after = before.filter((_, i) => i !== index);

  let next: string;
  let method: RuleWriteResponse["method"];
  // Removing the only item would leave a dangling `standing_rules:` key that
  // reads back as null rather than as an empty list, so that case goes through
  // the document and comes out as `standing_rules: []`.
  if (range && marker && before.length > 1) {
    const lineStart = source.lastIndexOf("\n", range[0] - 1) + 1;
    const lineEnd = endOfLine(source, range[1]);
    next = source.slice(0, lineStart) + source.slice(Math.min(lineEnd + 1, source.length));
    method = "splice";
  } else {
    doc.setIn(["standing_rules"], after);
    next = doc.toString({ lineWidth: 0 });
    method = "document";
  }

  await saveRules(file, next, { action: "remove", index, text: before[index] ?? null, method });
  return { ok: true, index, method, standing_rules: after };
}

// ---------------------------------------------------------------------------
// POST /api/resumes/:id/approve
// ---------------------------------------------------------------------------

export type ApproveResponse = { ok: true; resume: string; result: unknown; stdout: string };

/**
 * Where the harness's own code is, which is not always where its state is: a
 * test points `HARNESS_REPO_ROOT` at a temp directory holding a fixture
 * profile, and the tool to run still has to come from the checkout this module
 * was loaded out of.
 */
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** `npx tsx`, or the local binary when node_modules is installed. */
function tsxRunner(root: string): { command: string; prefix: string[] } {
  const local = path.join(root, "node_modules", ".bin", "tsx");
  return existsSync(local) ? { command: local, prefix: [] } : { command: "npx", prefix: ["tsx"] };
}

function runApprove(stateRoot: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { command, prefix } = tsxRunner(CODE_ROOT);
  return new Promise((resolve) => {
    execFile(
      command,
      [...prefix, path.join(CODE_ROOT, "tools/resume/resume-approve.ts"), ...args],
      {
        cwd: CODE_ROOT,
        env: { ...process.env, HARNESS_REPO_ROOT: stateRoot },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error: any, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/**
 * Approve a rendered baseline, by running the tool that owns approval.
 *
 * AGENTS.md section 5: `npm run resume:approve` refuses without a current
 * critic verdict, and that refusal is the point. It is reported here as a 409
 * with the tool's own words rather than being softened into a warning, so a
 * green reply can never sit over a red exit code.
 */
export async function approveResume(resumeId: string, ctx: ApiContext = {}): Promise<ApproveResponse> {
  const id = String(resumeId ?? "");
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.startsWith("-") || id.startsWith(".")) {
    throw new ApiError(400, "a resume id is a name, never a path or a flag");
  }
  const args = ["--resume", id];
  if (ctx.profileId) args.push("--profile", String(ctx.profileId));
  const { code, stdout, stderr } = await runApprove(repoRoot(), args);
  if (code !== 0) {
    const message = (stderr.trim() || stdout.trim() || `resume:approve exited ${code}`).slice(0, 800);
    // 2 is "no baseline for this resume", 1 is a refusal it explains itself.
    throw new ApiError(code === 2 ? 404 : 409, message);
  }
  let result: unknown = null;
  try { result = JSON.parse(stdout); } catch { result = null; }
  return { ok: true, resume: id, result, stdout: stdout.trim() };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const ok = (body: unknown): ApiResult => ({ status: 200, body });

/** Paths this module owns, so a wrong method is a 405 and not a puzzling 404. */
const OWNED = /^\/api\/(runs(\/.*)?|rules(\/.*)?|resumes\/[^/]+\/approve)$/;

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResult | null> {
  const method = req.method.toUpperCase();
  const pathname = req.pathname.replace(/\/+$/, "") || "/";
  const query = req.query ?? new URLSearchParams();
  if (!OWNED.test(pathname)) return null;

  if (method === "GET" && pathname === "/api/runs") {
    return ok(await getRuns({ limit: query.get("limit") }, ctx));
  }
  const run = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (method === "GET" && run) {
    return ok(await getRun(decodeURIComponent(run[1]), ctx));
  }
  if (method === "GET" && pathname === "/api/rules") {
    return ok(await getRules(ctx));
  }
  if (method === "POST" && pathname === "/api/rules/standing") {
    return ok(await postStandingRule(req.body ?? {}, ctx));
  }
  const remove = /^\/api\/rules\/standing\/(\d+)\/remove$/.exec(pathname);
  if (method === "POST" && remove) {
    return ok(await removeStandingRule(Number(remove[1]), ctx));
  }
  const edit = /^\/api\/rules\/standing\/(\d+)$/.exec(pathname);
  if (method === "POST" && edit) {
    return ok(await editStandingRule(Number(edit[1]), req.body ?? {}, ctx));
  }
  const approve = /^\/api\/resumes\/([^/]+)\/approve$/.exec(pathname);
  if (method === "POST" && approve) {
    return ok(await approveResume(decodeURIComponent(approve[1]), ctx));
  }
  return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
}
