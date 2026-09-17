#!/usr/bin/env tsx
/**
 * daily-summary.ts — one-screen morning brief for a given day.
 *
 * Reads the pipeline, the audit log, the day's journal, the screening-answer
 * escalations and the submission policy, then writes a short markdown summary
 * so the user knows what was sent, what needs their hands, and how the queue
 * moved, without reading the journal.
 *
 * Outputs:
 *   - state/journal/summary/<date>.md          (markdown, under ~60 lines)
 *   - Sheet tab "Summary"                       (cleared and rewritten; latest date first;
 *                                                columns: date, section, line)
 *   - stdout                                    (the markdown, or --json)
 *   - macOS notification with --notify          (one-line headline; failure tolerated)
 *
 * Usage:
 *   tsx tools/daily-summary.ts [--date YYYY-MM-DD] [--notify] [--json] [--no-sheet]
 *
 * Dates are interpreted in Australia/Sydney. Read-only against state except
 * for the summary file. Always exits 0 (a missing Sheet credential or an
 * osascript failure degrades to a stderr note).
 */

import { readJsonIfExists as readJsonOrNull } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";
import { load as loadPipeline, type Opportunity } from "./pipeline.ts";
import { query as auditQuery, type AuditEvent } from "./audit.ts";
import { loadLocalEnv, authReady, sheetsClient, ensureTabs, applyHeadersAndFilters } from "./sheets-sync.ts";

const TZ = "Australia/Sydney";
const SUMMARY_DIR = repoPath("state/journal/summary");
const JOURNAL_DIR = repoPath("state/journal");
const ARCHIVE_DIR = repoPath("state/pipeline/archive");
const SCREENING_PATH = repoPath("state/profile/screening-answers.yaml");
const POLICY_PATH = repoPath("state/profile/submission-policy.yaml");

// ---------- types ----------

export type SentRow = {
  id: string;
  title: string;
  company: string;
  location: string;
  resume: string;
  actor: "autopilot" | "attended";
  confirmation: string;
  criticWarns: number | null;
  submittedAt: string;
};

export type Escalation = {
  kind: "manual" | "screening" | "awaiting_approval" | "submission_pending" | "gate" | "channel" | "cap" | "kill_switch";
  id?: string;
  title?: string;
  company?: string;
  reason: string;
  action: string;
};

export type DailySummary = {
  date: string;
  generatedAt: string;
  headline: string;
  sent: SentRow[];
  escalations: Escalation[];
  movement: {
    discovered: number;
    queue: { id: string; title: string; company: string; location: string; score: number | null }[];
    parked: { total: number; byReason: Record<string, number> };
    exited: { id: string; title: string; company: string; status: string; reason: string }[];
  };
  responses: { id: string; title: string; company: string; status: string; at: string }[];
  numbers: {
    sentToday: number;
    autopilotSends: number;
    autopilotCap: number | null;
    totalSubmitted: number;
    queue: number;
    parked: number;
    manual: number;
    unansweredQuestions: number;
    killSwitch: boolean;
  };
  markdown: string;
  sheet: { pushed: boolean; note: string };
};

// ---------- helpers ----------

function sydneyDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

function sydneyTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}

/** UTC bounds of a Sydney calendar day, used to filter ISO timestamps. */
function dayBounds(date: string): { start: string; end: string } {
  // Probe: build a UTC guess and adjust by the zone offset at that instant.
  const guess = new Date(`${date}T00:00:00Z`);
  const offsetMin = (() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return (asUTC - guess.getTime()) / 60_000;
  })();
  const start = new Date(guess.getTime() - offsetMin * 60_000);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function clean(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").replace(/[—–]/g, ",").trim();
}

function short(s: string, n = 120): string {
  const t = clean(s);
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}...` : t;
}

async function readIfExists(p: string): Promise<string | null> {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

/** Tolerant on purpose: a half-written artefact must not break the summary. */
async function readJsonIfExists<T>(p: string): Promise<T | null> {
  return readJsonOrNull<T>(p).catch(() => null);
}

function parseArgs(argv: string[]): { date: string; notify: boolean; json: boolean; sheet: boolean } {
  const out = { date: sydneyDate(new Date()), notify: false, json: false, sheet: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date" && argv[i + 1]) out.date = argv[++i];
    else if (a.startsWith("--date=")) out.date = a.slice("--date=".length);
    else if (a === "--notify") out.notify = true;
    else if (a === "--json") out.json = true;
    else if (a === "--no-sheet") out.sheet = false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error(`--date must be YYYY-MM-DD, got ${out.date}`);
  return out;
}

// ---------- gathering ----------

function confirmationLine(txt: string | null): string {
  if (!txt) return "";
  const m = txt.match(/^Confirmation text:\s*(.+)$/m);
  if (m) return clean(m[1]).replace(/\s*You might also like.*$/i, "");
  const first = txt.split("\n").map((l) => l.trim()).find(Boolean);
  return short(first ?? "", 90);
}

/** Name of the resume file sent, from metadata.json or the archive listing. */
async function resumeFilename(row: Opportunity, dir: string): Promise<string> {
  const meta = await readJsonIfExists<{ resume?: { docx?: string } }>(path.join(dir, "metadata.json"));
  if (meta?.resume?.docx) return path.basename(meta.resume.docx);
  if (row.tailoredResume?.docxPath) return path.basename(row.tailoredResume.docxPath);
  const conf = await readIfExists(path.join(dir, "confirmation.txt"));
  const fromConf = conf?.match(/^Resume:\s*(\S+\.(?:docx|pdf))/m)?.[1];
  if (fromConf) return fromConf;
  try {
    const files = await fs.readdir(dir);
    const docx = files.find((f) => f.endsWith(".docx"));
    if (docx) return docx;
  } catch {}
  return row.resumeId ?? "";
}

async function gatherSent(rows: Opportunity[], date: string, submittedEvents: AuditEvent[]): Promise<SentRow[]> {
  const actorById = new Map<string, string>();
  for (const e of submittedEvents) if (e.role_id) actorById.set(e.role_id, e.actor);
  const out: SentRow[] = [];
  for (const r of rows) {
    if (!r.submittedAt || sydneyDate(r.submittedAt) !== date) continue;
    const dir = path.join(ARCHIVE_DIR, r.id);
    const critic = await readJsonIfExists<{ findings?: { severity: string }[] }>(path.join(dir, "letter-critic.json"));
    out.push({
      id: r.id,
      title: r.title,
      company: r.company,
      location: r.location ?? "",
      resume: await resumeFilename(r, dir),
      actor: actorById.get(r.id) === "autopilot" ? "autopilot" : "attended",
      confirmation: confirmationLine(await readIfExists(path.join(dir, "confirmation.txt"))),
      criticWarns: critic ? (critic.findings ?? []).filter((f) => f.severity === "warn").length : null,
      submittedAt: r.submittedAt,
    });
  }
  return out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

function lastReason(r: Opportunity): string {
  const h = r.history[r.history.length - 1];
  return clean(r.notes) || clean(h?.reason) || "";
}

/** Turn a manual_action_needed row into a reason plus the exact next step. */
async function manualEscalation(r: Opportunity): Promise<Escalation> {
  const dir = path.join(ARCHIVE_DIR, r.id);
  const reason = lastReason(r);
  const base = { kind: "manual" as const, id: r.id, title: r.title, company: r.company };
  const critic = await readJsonIfExists<{ verdict?: string; findings?: { severity: string; quote?: string; issue?: string }[] }>(path.join(dir, "letter-critic.json"));

  const ats = reason.match(/external ATS[:\s]+(\S+)/i);
  if (ats) {
    return { ...base, reason: `External ATS redirect to ${ats[1]}`, action: `Open ${r.url} and apply on ${ats[1]} yourself; package is in ${path.relative(repoPath(), dir)}` };
  }
  const q = reason.match(/unknown screening question:\s*"([^"]+)"/i);
  if (q) {
    return { ...base, reason: `Unknown screening question: "${short(q[1], 110)}"`, action: "Answer it in state/profile/screening-answers.yaml unknown_questions, then rerun autopilot:submit for this id" };
  }
  if (/letter-critic block/i.test(reason) || critic?.verdict === "block") {
    const fail = (critic?.findings ?? []).find((f) => f.severity === "fail");
    const first = fail ? `"${short(fail.quote ?? "", 70)}": ${short(fail.issue ?? "", 110)}` : short(reason, 160);
    return { ...base, reason: `Letter-critic block. First fail: ${first}`, action: `Fix ${path.relative(repoPath(), path.join(dir, "cover-letter.md"))}, then rerun autopilot:submit for this id` };
  }
  if (/gate (blocked|capped)|kill switch|daily cap/i.test(reason)) {
    return { ...base, reason: short(reason, 160), action: "Clear the gate (kill switch or cap) and rerun autopilot:submit for this id" };
  }
  if (/portal|sign-in|registration|account/i.test(reason)) {
    const checklist = await readIfExists(path.join(dir, "manual-checklist.md"));
    return { ...base, reason: short(reason, 160), action: checklist ? `Follow ${path.relative(repoPath(), path.join(dir, "manual-checklist.md"))} in your browser, then set-status submitted` : `Finish it in your browser at ${r.url}, then set-status submitted` };
  }
  return { ...base, reason: short(reason || "no reason recorded", 160), action: `Read ${path.relative(repoPath(), dir)} and decide: submit yourself, or set-status rejected/withdrawn` };
}

type UnknownQuestion = { opportunity_id?: string; company?: string; title?: string; question?: string; answer?: unknown };

async function unansweredQuestions(): Promise<UnknownQuestion[]> {
  const txt = await readIfExists(SCREENING_PATH);
  if (!txt) return [];
  let doc: { unknown_questions?: UnknownQuestion[] };
  try { doc = YAML.parse(txt) ?? {}; } catch { return []; }
  const all = doc.unknown_questions ?? [];
  // A question answered anywhere (same text, any row) is answered for the
  // submitter too: it matches on exact question text. Also drop questions
  // whose row is no longer live (submitted, rejected, withdrawn, parked).
  const answeredTexts = new Set(all.filter((q) => q.answer != null && String(q.answer).trim() !== "").map((q) => norm(q.question ?? "")));
  const seen = new Set<string>();
  const out: UnknownQuestion[] = [];
  for (const q of all) {
    if (q.answer != null) continue;
    if (answeredTexts.has(norm(q.question ?? ""))) continue;
    if (q.opportunity_id && liveRowIds && !liveRowIds.has(q.opportunity_id)) continue;
    const key = `${q.opportunity_id ?? ""}::${q.question ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}
function norm(s: string): string { return s.replace(/\s+/g, " ").trim().toLowerCase(); }
let liveRowIds: Set<string> | null = null;

async function policy(): Promise<{ killSwitch: boolean; autopilotEnabled: boolean; maxPerDay: number | null }> {
  const txt = await readIfExists(POLICY_PATH);
  if (!txt) return { killSwitch: false, autopilotEnabled: false, maxPerDay: null };
  try {
    const p = YAML.parse(txt) ?? {};
    return {
      killSwitch: p.kill_switch === true,
      autopilotEnabled: p.autopilot?.enabled === true,
      maxPerDay: typeof p.autopilot?.max_per_day === "number" ? p.autopilot.max_per_day : null,
    };
  } catch { return { killSwitch: false, autopilotEnabled: false, maxPerDay: null }; }
}

/** Channel login failures and hunt errors noted in the day's journal. */
async function journalProblems(date: string): Promise<string[]> {
  const txt = await readIfExists(path.join(JOURNAL_DIR, `${date}.md`));
  if (!txt) return [];
  const out: string[] = [];
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Only channel or hunt trouble: a login/session problem, or a failed/errored hunt step.
    if (!/\b(login|log-in|logged out|session expired|signed out|failed|error)\b/i.test(line)) continue;
    if (!/\b(seek|linkedin|channel|hunt|launchd|session|chrome|adapter)\b/i.test(line)) continue;
    // Skip lines that describe a fix, a passing test, or a historical bug note.
    if (/\b(fixed|tests? pass|passes|no longer|pre-existing|not verified)\b/i.test(line) && !/\b(login|expired|signed out)\b/i.test(line)) continue;
    out.push(short(line.replace(/^[-*]\s*/, ""), 150));
  }
  return out.slice(0, 5);
}

// ---------- build ----------

export async function buildSummary(date: string): Promise<Omit<DailySummary, "markdown" | "sheet">> {
  const rows = await loadPipeline();
  const { start, end } = dayBounds(date);
  const dayEvents = (await auditQuery({ sinceISO: start })).filter((e) => e.ts < end);
  const submittedEvents = dayEvents.filter((e) => e.event_type === "submitted");
  const pol = await policy();

  const sent = await gatherSent(rows, date, submittedEvents);
  const autopilotSends = submittedEvents.filter((e) => e.actor === "autopilot").length;

  // Escalations
  const escalations: Escalation[] = [];
  for (const r of rows.filter((x) => x.status === "manual_action_needed")) escalations.push(await manualEscalation(r));

  liveRowIds = new Set(rows.filter((x) => ["manual_action_needed", "submission_pending", "approved", "awaiting_approval", "drafted", "shortlisted"].includes(x.status)).map((x) => x.id));
  const questions = await unansweredQuestions();
  for (const q of questions) {
    escalations.push({
      kind: "screening", id: q.opportunity_id, title: q.title, company: q.company,
      reason: `Unanswered screening question: "${short(q.question ?? "", 120)}"`,
      action: "Write the answer in screening-answers.yaml (unknown_questions), then rerun autopilot:submit if the row is still manual",
    });
  }
  for (const r of rows.filter((x) => x.status === "awaiting_approval")) {
    escalations.push({ kind: "awaiting_approval", id: r.id, title: r.title, company: r.company, reason: "Package waiting in the Tray", action: "Set Action to approve, hold or reject in the Sheet Tray, or review it with /review-drafts" });
  }
  for (const r of rows.filter((x) => x.status === "submission_pending")) {
    escalations.push({ kind: "submission_pending", id: r.id, title: r.title, company: r.company, reason: `Stuck mid-submission: ${short(lastReason(r), 120)}`, action: "Finish or withdraw it in an attended session (/submit-approved or pipeline set-status)" });
  }
  for (const e of dayEvents.filter((x) => x.event_type === "policy_kill_switch_blocked" || x.event_type === "daily_cap_hit")) {
    const d = e.details ?? {};
    escalations.push({
      kind: e.event_type === "daily_cap_hit" ? "cap" : "gate", id: e.role_id ?? undefined,
      title: d.title as string | undefined, company: d.company as string | undefined,
      reason: e.event_type === "daily_cap_hit" ? `Gate capped (${d.submitted_today ?? "?"}/${d.cap ?? "?"}, ${d.scope ?? "attended"})` : "Gate blocked by the kill switch",
      action: e.event_type === "daily_cap_hit" ? "Nothing to do today; the row waits at approved for the next run" : "Set kill_switch: false in submission-policy.yaml when you want sends to resume",
    });
  }
  for (const e of dayEvents.filter((x) => x.event_type === "channel_login_expired" || x.event_type === "channel_search_failed")) {
    escalations.push({ kind: "channel", reason: `${e.channel ?? "channel"}: ${e.event_type.replace(/_/g, " ")}${e.details?.error ? ` (${short(String(e.details.error), 80)})` : ""}`, action: `Sign in to ${e.channel ?? "the channel"} again on the harness Chrome profile and rerun the hunt` });
  }
  for (const line of await journalProblems(date)) {
    escalations.push({ kind: "channel", reason: `Journal: ${line}`, action: "Check the line in the journal and fix the channel or rerun the step" });
  }
  if (pol.killSwitch) escalations.push({ kind: "kill_switch", reason: "Kill switch is ON; no submissions, attended or autopilot", action: "Set kill_switch: false in state/profile/submission-policy.yaml to resume" });
  if (pol.maxPerDay != null && autopilotSends >= pol.maxPerDay) {
    escalations.push({ kind: "cap", reason: `Autopilot cap used up (${autopilotSends} of ${pol.maxPerDay})`, action: "Raise autopilot.max_per_day or let the rest go tomorrow" });
  }

  // Movement
  const discoveredToday = rows.filter((r) => r.history[0] && sydneyDate(r.history[0].at) === date).length;
  const queue = rows.filter((r) => r.status === "shortlisted")
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((r) => ({ id: r.id, title: r.title, company: r.company, location: r.location ?? "", score: r.score ?? null }));
  const parkedRows = rows.filter((r) => r.status === "parked");
  const byReason: Record<string, number> = {};
  for (const r of parkedRows) {
    const prefix = clean(r.parkedReason).split(/[;(]/)[0].trim().toLowerCase() || "no reason";
    byReason[prefix] = (byReason[prefix] ?? 0) + 1;
  }
  const exited = rows
    .filter((r) => (r.status === "rejected" || r.status === "withdrawn") && sydneyDate(r.history[r.history.length - 1].at) === date)
    .map((r) => ({ id: r.id, title: r.title, company: r.company, status: r.status, reason: short(r.history[r.history.length - 1].reason ?? "", 110) }));

  // Responses
  const responses = rows
    .filter((r) => r.status === "responded" || r.status === "interview" || r.status === "offered")
    .map((r) => ({ id: r.id, title: r.title, company: r.company, status: r.status, at: sydneyDate(r.responseAt ?? r.history[r.history.length - 1].at) }));

  const numbers = {
    sentToday: sent.length,
    autopilotSends,
    autopilotCap: pol.autopilotEnabled ? pol.maxPerDay : null,
    totalSubmitted: rows.filter((r) => r.submittedAt || ["submitted", "responded", "interview", "offered", "won"].includes(r.status)).length,
    queue: queue.length,
    parked: parkedRows.length,
    manual: rows.filter((r) => r.status === "manual_action_needed").length,
    unansweredQuestions: questions.length,
    killSwitch: pol.killSwitch,
  };
  const headline = `Sent ${sent.length}, escalations ${escalations.length}, queue ${queue.length}`;

  return {
    date, generatedAt: new Date().toISOString(), headline, sent, escalations,
    movement: { discovered: discoveredToday, queue, parked: { total: parkedRows.length, byReason }, exited },
    responses, numbers,
  };
}

// ---------- render ----------

export function renderMarkdown(s: Omit<DailySummary, "markdown" | "sheet">): string {
  const L: string[] = [];
  L.push(`# Daily summary ${s.date}`, "", `${s.headline}.`, "");

  L.push("## Sent today", "");
  if (!s.sent.length) L.push("Nothing sent today.");
  for (const r of s.sent) {
    const bits = [`${r.actor}`, r.resume || "no resume file"];
    if (r.criticWarns != null) bits.push(`critic warns ${r.criticWarns}`);
    L.push(`- ${sydneyTime(r.submittedAt)} ${r.title} at ${r.company}${r.location ? ` (${r.location})` : ""}. ${bits.join(", ")}.${r.confirmation ? ` ${r.confirmation}.` : ""}`);
  }
  L.push("");

  L.push("## Escalations (your action)", "");
  if (!s.escalations.length) L.push("Nothing needs you.");
  for (const e of s.escalations) {
    const who = e.title ? `${e.title} at ${e.company ?? "?"}${e.id ? ` [${e.id}]` : ""}: ` : "";
    L.push(`- ${who}${e.reason}. Next: ${e.action}.`);
  }
  L.push("");

  L.push("## Queue and parked", "");
  L.push(`- Discovered today: ${s.movement.discovered}.`);
  if (!s.movement.queue.length) L.push("- Queue (shortlisted): empty.");
  else {
    const top = s.movement.queue.slice(0, 5).map((q) => `${q.title} at ${q.company}${q.location ? ` (${q.location})` : ""}${q.score != null ? ` ${q.score}` : ""}`);
    L.push(`- Queue (shortlisted): ${s.movement.queue.length}. Top: ${top.join("; ")}${s.movement.queue.length > 5 ? "; and more" : ""}.`);
  }
  const reasons = Object.entries(s.movement.parked.byReason).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`);
  L.push(`- Parked: ${s.movement.parked.total}${reasons.length ? ` (${reasons.join(", ")})` : ""}.`);
  if (s.movement.exited.length) {
    L.push(`- Rejected or withdrawn today: ${s.movement.exited.length}.`);
    for (const x of s.movement.exited.slice(0, 5)) L.push(`  - ${x.title} at ${x.company}: ${x.status}${x.reason ? `, ${x.reason}` : ""}.`);
    if (s.movement.exited.length > 5) L.push(`  - and ${s.movement.exited.length - 5} more.`);
  } else L.push("- Rejected or withdrawn today: none.");
  L.push("");

  L.push("## Responses", "");
  if (!s.responses.length) L.push("No responses, interviews or offers on the board.");
  for (const r of s.responses) L.push(`- ${r.title} at ${r.company}: ${r.status} (${r.at}).`);
  L.push("");

  const n = s.numbers;
  L.push("## Numbers", "");
  L.push("| Sent today | Autopilot sends | Total submitted | Queue | Parked | Manual | Unanswered questions |");
  L.push("|---|---|---|---|---|---|---|");
  L.push(`| ${n.sentToday} | ${n.autopilotSends}${n.autopilotCap != null ? ` of ${n.autopilotCap}` : ""} | ${n.totalSubmitted} | ${n.queue} | ${n.parked} | ${n.manual} | ${n.unansweredQuestions} |`);
  L.push("", `Kill switch ${n.killSwitch ? "ON" : "off"}. Generated ${s.generatedAt}.`);
  return L.join("\n").replace(/[—–]/g, ",") + "\n";
}

/** Rows for the Sheet: [date, section, line], latest date first. */
function sheetRows(date: string, markdown: string): (string | number)[][] {
  const rows: (string | number)[][] = [["date", "section", "line"]];
  let section = "Headline";
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) { section = line.slice(3).trim(); continue; }
    if (/^\|[-| ]+\|$/.test(line)) continue;
    rows.push([date, section, line.replace(/^\s*-\s*/, "")]);
  }
  return rows;
}

async function pushSheet(date: string, markdown: string): Promise<{ pushed: boolean; note: string }> {
  await loadLocalEnv();
  if (!authReady()) return { pushed: false, note: "Sheet not configured (GOOGLE_APPLICATION_CREDENTIALS / SHEETS_SPREADSHEET_ID missing); summary not mirrored" };
  try {
    const sheets = await sheetsClient();
    const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID!;
    await ensureTabs(sheets, spreadsheetId);
    const rows = sheetRows(date, markdown);
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Summary!A:Z" });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: "Summary!A1", valueInputOption: "RAW", requestBody: { values: rows } });
    await applyHeadersAndFilters(sheets, spreadsheetId, { Summary: { headerCols: 3, rowCount: rows.length, columnWidths: { 0: 100, 1: 180, 2: 900 } } });
    const check = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Summary!A1:C" });
    const got = check.data.values?.length ?? 0;
    if (got !== rows.length) return { pushed: false, note: `Sheet Summary verification failed: ${got}/${rows.length} rows` };
    return { pushed: true, note: `Sheet Summary tab rewritten with ${rows.length - 1} lines` };
  } catch (e: any) {
    return { pushed: false, note: `Sheet push failed: ${short(e?.message ?? String(e), 160)}` };
  }
}

function notify(headline: string, date: string): Promise<void> {
  return new Promise((resolve) => {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    execFile("osascript", ["-e", `display notification "${esc(headline)}" with title "Job hunt ${esc(date)}"`], { timeout: 10_000 }, (err) => {
      if (err) console.error(`[daily-summary] notification failed: ${short(err.message, 120)}`);
      resolve();
    });
  });
}

// ---------- main ----------

export async function run(opts: { date: string; notify: boolean; json: boolean; sheet: boolean }): Promise<DailySummary> {
  const core = await buildSummary(opts.date);
  const markdown = renderMarkdown(core);
  await fs.mkdir(SUMMARY_DIR, { recursive: true });
  const outPath = path.join(SUMMARY_DIR, `${opts.date}.md`);
  await fs.writeFile(outPath, markdown);
  const sheet = opts.sheet ? await pushSheet(opts.date, markdown) : { pushed: false, note: "Sheet push skipped (--no-sheet)" };
  console.error(`[daily-summary] wrote ${path.relative(repoPath(), outPath)}; ${sheet.note}`);
  if (opts.notify) await notify(core.headline, opts.date);
  return { ...core, markdown, sheet };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e: any) { console.error(e.message); process.exit(2); }
    try {
      const s = await run(opts);
      if (opts.json) console.log(JSON.stringify(s, null, 2));
      else process.stdout.write(s.markdown);
    } catch (e: any) {
      console.error(`[daily-summary] ${e?.stack ?? e}`);
    }
    process.exit(0);
  })();
}
