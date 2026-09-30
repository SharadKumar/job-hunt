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
 * Dates are interpreted in the profile's locale timezone (`locale.timezone` in
 * profile.md, default Australia/Sydney). Read-only against state except
 * for the summary file.
 *
 * Exit codes: 0 clean; 1 when the brief cannot be trusted (a present but
 * unparseable screening-answers.yaml or submission-policy.yaml, a failed Sheet
 * push, or an unexpected throw); 2 on a bad argument. A *missing* policy or
 * screening file is a normal state and stays exit 0. A missing Sheet
 * credential, a Sheet switched off with `sheet.enabled: false`, or an
 * osascript failure, degrades to a note and stays exit 0; the switched-off
 * case reports `sheet.status: "disabled"` and never builds a Google client.
 */

import { readJsonIfExists as readJsonOrNull } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";
import { load as loadPipeline, type Opportunity } from "./pipeline.ts";
import { query as auditQuery, distinctSubmittedEvents, type AuditEvent } from "./audit.ts";
import { loadLocalEnv, authReady, sheetsClient, ensureTabs, applyHeadersAndFilters, sheetEnabled } from "./sheets-sync.ts";
import { loadLocale } from "./profile.ts";
import { laneFor } from "./ui/rows-ext-api.ts";
import { blockingDegradation, readDegradation } from "./jev/degradation.ts";

// Resolved once at load: every date in the brief is a calendar day in this zone.
const LOCALE = await loadLocale();
const TZ = LOCALE.timezone;
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
  /** State that could not be read (present but unparseable). Non-empty means exit 1. */
  errors: string[];
  automation?: { prepared: number; awaitingScreening?: number; blocker: string | null };
  priority?: { ok: boolean; ready: number; attempted: number; submitted: number; firstSendMs: number | null };
  operationalNotes?: string[];
  observations?: string[];
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
  /**
   * `failed` separates a real push failure (exit 1) from "not configured" or
   * "switched off" (exit 0). `status` is the one word to report: `disabled`
   * when `sheet.enabled: false` retires the mirror in favour of the local UI.
   */
  sheet: { pushed: boolean; failed: boolean; status: "pushed" | "disabled" | "not_configured" | "skipped" | "failed"; note: string };
};

// ---------- helpers ----------

/** Calendar date (YYYY-MM-DD) of an instant in the profile's timezone. */
function localDate(iso: string | Date): string {
  // en-CA is the ISO-shaped format, not a locale preference; it stays fixed.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE.language, { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).replace(/[\u00a0\u202f]/g, " ").toLowerCase();
}

/** UTC bounds of a local calendar day, used to filter ISO timestamps. */
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
  const out = { date: localDate(new Date()), notify: false, json: false, sheet: true };
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
  const meta = await readJsonIfExists<{ resume?: { docx?: string; ref?: string } }>(path.join(dir, "metadata.json"));
  if (meta?.resume?.ref || meta?.resume?.docx) return path.basename(meta.resume.ref ?? meta.resume.docx!);
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
    if (!r.submittedAt || localDate(r.submittedAt) !== date) continue;
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
  const h = [...r.history].reverse().find(entry => entry.reason && !/^field_update:/.test(entry.reason));
  const latestNote = (r.notes ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  return clean(latestNote) || clean(h?.reason) || "";
}

/**
 * Escalations keyed by (opportunity, kind) so the same row never appears twice
 * for the same problem. A row can carry a manual note *and* an unanswered
 * screening question; those are one escalation whose Next step says both.
 * Insertion order is preserved, so the section keeps its current ordering.
 */
class Escalations {
  private readonly order: string[] = [];
  private readonly byKey = new Map<string, Escalation>();

  add(e: Escalation): void {
    // Rows key on their id; id-less escalations (channel, cap, kill switch)
    // key on their reason, which is what distinguishes them from each other.
    const key = `${e.kind}::${e.id ?? e.reason}`;
    const existing = this.byKey.get(key);
    if (!existing) {
      this.byKey.set(key, { ...e });
      this.order.push(key);
      return;
    }
    existing.title ??= e.title;
    existing.company ??= e.company;
    // First reason wins (it is the row-specific one); every distinct next step is kept.
    if (!existing.action.includes(e.action)) existing.action = `${existing.action}; also ${e.action}`;
  }

  list(): Escalation[] {
    return this.order.map((k) => this.byKey.get(k)!);
  }
}

/** Turn a manual_action_needed row into a reason plus the exact next step. */
export async function manualEscalation(r: Opportunity, answeredTexts: Set<string> = new Set()): Promise<Escalation | null> {
  const dir = path.join(ARCHIVE_DIR, r.id);
  const reason = lastReason(r);
  const base = { kind: "manual" as const, id: r.id, title: r.title, company: r.company };
  const critic = await readJsonIfExists<{ verdict?: string; findings?: { severity: string; quote?: string; issue?: string }[] }>(path.join(dir, "letter-critic.json"));

  const ats = reason.match(/external ATS[:\s]+(\S+)/i);
  if (ats) {
    return { ...base, reason: `External ATS redirect to ${ats[1]}`, action: `Open ${r.url} and apply on ${ats[1]} yourself; package is in ${path.relative(repoPath(), dir)}` };
  }
  if (r.channel === "seek" && /SEEK human verification required/i.test(reason)) {
    return { ...base, kind: "channel", reason: "SEEK blocked the harness browser before the application form opened; no send was confirmed", action: `Restore access to the harness SEEK profile, then retry this package through autopilot:submit. The challenge screenshot is in ${path.relative(repoPath(), dir)}. Do not discard the package` };
  }
  if (/external application portal/i.test(reason) && /package is not prepared yet/i.test(reason)) {
    return { ...base, reason: "LinkedIn advert uses an external portal; package not prepared", action: "Prepare the package with /manual-applications, then complete the portal together in an attended session" };
  }
  const q = reason.match(/unknown screening question:\s*"([^"]+)"/i);
  if (q) {
    // The row still records the stopped attempt, but a newly banked answer
    // makes this run-owned retry work, not another question for the person.
    if (answeredTexts.has(norm(q[1]))) return null;
    // Same problem as the screening-answers escalation below, so same kind and
    // wording: the two merge into one entry for this row.
    return { ...base, kind: "screening", reason: `Unanswered screening question: "${short(q[1], 110)}"`, action: "Answer it in state/profile/screening-answers.yaml unknown_questions, then rerun autopilot:submit for this id" };
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

type Read<T> = { value: T; status: "ok" | "missing" | "error"; error?: string };

/**
 * Fail closed: a file that is present but unparseable is an error the summary
 * shows and exits 1 on, never a silent "nothing to answer".
 */
async function unansweredQuestions(liveRowIds: Set<string>, rows: Opportunity[]): Promise<Read<UnknownQuestion[]> & { answeredTexts?: Set<string> }> {
  const txt = await readIfExists(SCREENING_PATH);
  if (txt == null) return { value: [], status: "missing" };
  let doc: { unknown_questions?: UnknownQuestion[] };
  try { doc = YAML.parse(txt) ?? {}; } catch (e: any) {
    return { value: [], status: "error", error: `screening-answers.yaml is unreadable: ${short(e?.message ?? String(e), 140)}` };
  }
  const all = doc.unknown_questions ?? [];
  // A question answered anywhere (same text, any row) is answered for the
  // submitter too: it matches on exact question text. Also drop questions
  // whose row is no longer live (submitted, rejected, withdrawn, parked).
  const answeredTexts = new Set(all.filter((q) => q.answer != null && String(q.answer).trim() !== "").map((q) => norm(q.question ?? "")));
  const seen = new Set<string>();
  const currentQuestions = new Map(rows.filter(r => r.status === "manual_action_needed").map(r => [
    r.id, lastReason(r).match(/unknown screening question:\s*"([^"]+)"/i)?.[1],
  ]));
  const out: UnknownQuestion[] = [];
  for (const q of all) {
    if (q.answer != null) continue;
    if (answeredTexts.has(norm(q.question ?? ""))) continue;
    if (q.opportunity_id && !liveRowIds.has(q.opportunity_id)) continue;
    // A later form attempt can pass an earlier question using a banked answer.
    // Keep the ledger for audit, but surface only the current recorded blocker.
    const current = q.opportunity_id ? currentQuestions.get(q.opportunity_id) : undefined;
    if (current && norm(q.question ?? "") !== norm(current)) continue;
    const key = `${q.opportunity_id ?? ""}::${q.question ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return { value: out, status: "ok", answeredTexts };
}
function norm(s: string): string { return s.replace(/\s+/g, " ").trim().toLowerCase(); }

type Policy = { killSwitch: boolean; autopilotEnabled: boolean; maxPerDay: number | null; channels: string[] };

async function policy(): Promise<Read<Policy>> {
  const off: Policy = { killSwitch: false, autopilotEnabled: false, maxPerDay: null, channels: [] };
  const txt = await readIfExists(POLICY_PATH);
  if (txt == null) return { value: off, status: "missing" };
  try {
    const p = YAML.parse(txt) ?? {};
    return {
      value: {
        killSwitch: p.kill_switch === true,
        autopilotEnabled: p.autopilot?.enabled === true,
        maxPerDay: typeof p.autopilot?.max_per_day === "number" ? p.autopilot.max_per_day : null,
        channels: Array.isArray(p.autopilot?.channels) ? p.autopilot.channels : [],
      },
      status: "ok",
    };
  } catch (e: any) {
    // Never report "kill switch off" off the back of a file we could not read.
    return { value: off, status: "error", error: `submission-policy.yaml is unreadable: ${short(e?.message ?? String(e), 140)}` };
  }
}

/** A verb that says something actually broke. The bare word "login" is not one. */
const FAILURE_VERB = /\b(failed|fails|failure|errors?|logged out|signed out|could not|couldn't|timed out|blocked)\b/i;
/** "expired" is only our problem when it is a session, not a job ad. */
const EXPIRED = /\bexpired\b/i;
const SESSION_WORD = /\b(session|login|log-in|sign-?in|signed|logged|cookie|token|auth)\b/i;
/** The subject has to be a channel or a hunt step, otherwise it is not our problem. */
const CHANNEL_WORD = /\b(seek(?!-)|linkedin(?!_)|channel|hunt|launchd|session|chrome|adapter)\b/i;
/**
 * Negations and status-report lines. "seek: healthy, no login issues" and
 * "No login/DOM errors" are the daily health line, not an incident; a line
 * about something fixed or passing is history, not today's problem.
 */
const NOT_A_PROBLEM = /healthy|\bno\b[\w/,\- ]*\b(issues|errors|problems|failures)\b|\b(0|zero|none)\b[\w ]*\b(failed|errors?)\b|all succeeded|no longer|\bfixed\b|\bpass(es|ed)?\b/i;

/** Channel login failures and hunt errors noted in the day's journal. */
async function journalProblems(date: string): Promise<string[]> {
  const txt = await readIfExists(path.join(JOURNAL_DIR, `${date}.md`));
  if (!txt) return [];
  const out: string[] = [];
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!FAILURE_VERB.test(line) && !(EXPIRED.test(line) && SESSION_WORD.test(line))) continue;
    if (!CHANNEL_WORD.test(line)) continue;
    if (NOT_A_PROBLEM.test(line)) continue;
    out.push(short(line.replace(/^[-*]\s*/, ""), 150));
  }
  return out.slice(0, 5);
}

// ---------- build ----------

/** Only the journal's explicit review section, never inferred from old failures. */
export function journalObservations(text: string): string[] {
  let inSection = false;
  const observations: string[] = [];
  for (const line of text.split("\n")) {
    if (/^##\s+/.test(line)) inSection = /^## Observations for the user\s*$/.test(line);
    else if (inSection && /^-\s+/.test(line)) observations.push(line.replace(/^-\s+/, "").trim());
  }
  return [...new Set(observations)].slice(0, 10);
}

export async function buildSummary(date: string): Promise<Omit<DailySummary, "markdown" | "sheet">> {
  const rows = await loadPipeline();
  const { start, end } = dayBounds(date);
  const dayEvents = (await auditQuery({ sinceISO: start })).filter((e) => e.ts < end);
  const submittedEvents = distinctSubmittedEvents(dayEvents);
  const policyRead = await policy();
  const pol = policyRead.value;
  const lanePolicy = { channels: pol.channels, autopilot_enabled: pol.autopilotEnabled, kill_switch: pol.killSwitch };
  const runOwned = (row: Opportunity) => laneFor(row, lanePolicy).lane === "autopilot";
  const incident = blockingDegradation(await readDegradation());
  const frontHalf = await readJsonIfExists<{ channel_health?: { seek?: { verification_required?: boolean } } }>(
    repoPath(`state/journal/front-half/${date}.json`));
  const priorityReport = await readJsonIfExists<{
    ok?: boolean; selected?: number; attempts?: { outcome?: string }[];
    telemetry?: { submitted?: number; time_to_first_send_ms?: number | null };
  }>(repoPath(`state/journal/priority/${date}.json`));
  const priority = priorityReport ? {
    ok: priorityReport.ok === true,
    ready: priorityReport.selected ?? 0,
    attempted: priorityReport.attempts?.length ?? 0,
    submitted: priorityReport.telemetry?.submitted ?? 0,
    firstSendMs: priorityReport.telemetry?.time_to_first_send_ms ?? null,
  } : undefined;
  const seekChallengeReported = frontHalf?.channel_health?.seek?.verification_required === true;
  const preparedRows = rows.filter(row => ["awaiting_approval", "approved"].includes(row.status) && runOwned(row));

  const sent = await gatherSent(rows, date, submittedEvents);
  const autopilotSends = distinctSubmittedEvents(dayEvents.filter((e) => e.actor === "autopilot")).length;

  const liveRowIds = new Set(rows.filter((x) => ["manual_action_needed", "submission_pending", "approved", "awaiting_approval", "drafted", "shortlisted"].includes(x.status)).map((x) => x.id));
  const screening = await unansweredQuestions(liveRowIds, rows);
  // Escalations
  const esc = new Escalations();
  for (const r of rows.filter((x) => x.status === "manual_action_needed")) {
    const item = await manualEscalation(r, screening.answeredTexts);
    if (item) esc.add(item);
  }
  const questions = screening.value;
  const screeningIds = new Set(questions.map(q => q.opportunity_id));
  const awaitingScreening = preparedRows.filter(row => screeningIds.has(row.id)).length;
  const seekChallengeToday = seekChallengeReported || rows.some(row => row.channel === "seek" && row.status === "manual_action_needed"
    && /SEEK human verification required/i.test(lastReason(row))
    && row.history.at(-1)?.at && localDate(row.history.at(-1)!.at) === date);
  const automation = { prepared: preparedRows.length - awaitingScreening, awaitingScreening,
    blocker: incident?.incident.reason ?? (seekChallengeToday && preparedRows.some(row => row.channel === "seek")
      ? "SEEK challenged the harness browser before an application form opened"
      : null) };
  const errors = [policyRead.error, screening.error].filter((e): e is string => Boolean(e));
  if (seekChallengeReported && !rows.some(row => row.channel === "seek" && row.status === "manual_action_needed"
    && /SEEK human verification required/i.test(lastReason(row)))) {
    esc.add({ kind: "channel", reason: "SEEK human verification stopped advert enrichment before the full job descriptions could be read",
      action: "Restore access to the harness SEEK profile; the deferred adverts remain queued for a later channel-safe run" });
  }
  for (const q of questions) {
    esc.add({
      kind: "screening", id: q.opportunity_id, title: q.title, company: q.company,
      reason: `Unanswered screening question: "${short(q.question ?? "", 120)}"`,
      action: "Record the answer in screening-answers.yaml (unknown_questions), then retry through autopilot:submit with all gates rechecked",
    });
  }
  for (const r of rows.filter((x) => x.status === "awaiting_approval")) {
    if (runOwned(r)) continue;
    esc.add({ kind: "awaiting_approval", id: r.id, title: r.title, company: r.company, reason: "Package waiting in the Tray", action: "Set Action to approve, hold or reject in the Sheet Tray, or review it with /review-drafts" });
  }
  for (const r of rows.filter((x) => x.status === "submission_pending")) {
    esc.add({ kind: "submission_pending", id: r.id, title: r.title, company: r.company, reason: `Stuck mid-submission: ${short(lastReason(r), 120)}`, action: "Finish or withdraw it in an attended session (/submit-approved or pipeline set-status)" });
  }
  for (const e of dayEvents.filter((x) => x.event_type === "policy_kill_switch_blocked" || x.event_type === "daily_cap_hit")) {
    const d = e.details ?? {};
    esc.add({
      kind: e.event_type === "daily_cap_hit" ? "cap" : "gate", id: e.role_id ?? undefined,
      title: d.title as string | undefined, company: d.company as string | undefined,
      reason: e.event_type === "daily_cap_hit" ? `Gate capped (${d.submitted_today ?? "?"}/${d.cap ?? "?"}, ${d.scope ?? "attended"})` : "Gate blocked by the kill switch",
      action: e.event_type === "daily_cap_hit" ? "Nothing to do today; the row waits at approved for the next run" : "Set kill_switch: false in submission-policy.yaml when you want sends to resume",
    });
  }
  for (const e of dayEvents.filter((x) => x.event_type === "channel_login_expired" || x.event_type === "channel_search_failed")) {
    esc.add({ kind: "channel", reason: `${e.channel ?? "channel"}: ${e.event_type.replace(/_/g, " ")}${e.details?.error ? ` (${short(String(e.details.error), 80)})` : ""}`, action: `Sign in to ${e.channel ?? "the channel"} again on the harness Chrome profile and rerun the hunt` });
  }
  // Free-text journal mentions are historical evidence, not proof that the
  // person needs to act. Structured incidents above retain explicit actions.
  const operationalNotes = await journalProblems(date);
  const observations = journalObservations(await readIfExists(path.join(JOURNAL_DIR, `${date}.md`)) ?? "");
  if (pol.killSwitch) esc.add({ kind: "kill_switch", reason: "Kill switch is ON; no submissions, attended or autopilot", action: "Set kill_switch: false in state/profile/submission-policy.yaml to resume" });
  if (pol.maxPerDay != null && autopilotSends >= pol.maxPerDay) {
    esc.add({ kind: "cap", reason: `Autopilot cap used up (${autopilotSends} of ${pol.maxPerDay})`, action: "Raise autopilot.max_per_day or let the rest go tomorrow" });
  }

  // Movement
  const discoveredToday = rows.filter((r) => r.history[0] && localDate(r.history[0].at) === date).length;
  const queue = rows.filter((r) => r.status === "shortlisted")
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((r) => ({ id: r.id, title: r.title, company: r.company, location: r.location ?? "", score: r.score ?? null }));
  const parkedRows = rows.filter((r) => r.status === "parked");
  const byReason: Record<string, number> = {};
  for (const r of parkedRows) {
    const prefix = clean(r.parkedReason).split(/[;(]/)[0].trim().toLowerCase() || "no reason";
    byReason[prefix] = (byReason[prefix] ?? 0) + 1;
  }
  // A row with no history is malformed but must not crash the brief.
  const exited = rows
    .filter((r) => (r.status === "rejected" || r.status === "withdrawn") && r.history.at(-1) && localDate(r.history.at(-1)!.at) === date)
    .map((r) => ({ id: r.id, title: r.title, company: r.company, status: r.status, reason: short(r.history.at(-1)?.reason ?? "", 110) }));

  // Responses
  const responses = rows
    .filter((r) => r.status === "responded" || r.status === "interview" || r.status === "offered")
    .map((r) => ({ id: r.id, title: r.title, company: r.company, status: r.status, at: localDate(r.responseAt ?? r.history.at(-1)?.at ?? r.submittedAt ?? new Date().toISOString()) }));

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
  const escalations = esc.list();
  const headline = `Sent ${sent.length}, escalations ${escalations.length}, queue ${queue.length}${errors.length ? `, state errors ${errors.length}` : ""}`;

  return {
    date, generatedAt: new Date().toISOString(), headline, sent, escalations,
    movement: { discovered: discoveredToday, queue, parked: { total: parkedRows.length, byReason }, exited },
    responses, errors, numbers, automation, priority, operationalNotes, observations,
  };
}

// ---------- render ----------

export function renderMarkdown(s: Omit<DailySummary, "markdown" | "sheet">): string {
  const L: string[] = [];
  L.push(`# Daily summary ${s.date}`, "", `${s.headline}.`, "");

  // Only rendered when something is wrong, so the daily shape is unchanged.
  if (s.errors.length) {
    L.push("## State errors", "");
    for (const e of s.errors) L.push(`- ${e}. This brief is incomplete until it is fixed.`);
    L.push("");
  }

  L.push("## Sent today", "");
  if (!s.sent.length) L.push("Nothing sent today.");
  for (const r of s.sent) {
    const bits = [`${r.actor}`, r.resume || "no resume file"];
    if (r.criticWarns != null) bits.push(`critic warns ${r.criticWarns}`);
    L.push(`- ${localTime(r.submittedAt)} ${r.title} at ${r.company}${r.location ? ` (${r.location})` : ""}. ${bits.join(", ")}.${r.confirmation ? ` ${r.confirmation}.` : ""}`);
  }
  L.push("");

  if (s.priority) {
    L.push("## Priority pass", "");
    L.push(`${s.priority.ready} ready, ${s.priority.attempted} attempted, ${s.priority.submitted} confirmed sent before discovery.`);
    if (s.priority.firstSendMs != null) L.push(`First confirmed send: ${Math.round(s.priority.firstSendMs / 1000)} seconds from pass start.`);
    else L.push("No time-to-first-send result yet; no priority send was confirmed.");
    if (!s.priority.ok) L.push("Priority pass did not complete cleanly; check its report before treating this run as healthy.");
    L.push("");
  }

  if (s.automation?.prepared || s.automation?.awaitingScreening || s.automation?.blocker) {
    L.push("## Autopilot work (no individual approval needed)", "");
    L.push(`${s.automation.prepared} prepared package${s.automation.prepared === 1 ? "" : "s"} awaiting run validation.`);
    if (s.automation.awaitingScreening) L.push(`${s.automation.awaitingScreening} prepared package${s.automation.awaitingScreening === 1 ? " needs" : "s need"} screening answers before retry. See the specific questions below; this is not a package-approval request.`);
    if (s.automation.blocker) L.push(`Submission paused: ${s.automation.blocker}. The next run must recheck channel access, provider health and all send gates.`);
    else if (s.automation.prepared) L.push("The next run will validate and submit eligible packages through the one-click adapters.");
    L.push("");
  }

  L.push("## Escalations (your action)", "");
  if (!s.escalations.length) L.push("Nothing needs you.");
  for (const e of s.escalations) {
    const who = e.title ? `${e.title} at ${e.company ?? "?"}${e.id ? ` [${e.id}]` : ""}: ` : "";
    L.push(`- ${who}${e.reason}. Next: ${e.action}.`);
  }
  L.push("");

  if (s.operationalNotes?.length) {
    L.push("## Historical run observations", "", "These journal entries may describe recovered failures. They are not current blockers; current actions are listed above.", "");
    for (const note of s.operationalNotes) L.push(`- Journal observation: ${note}`);
    L.push("");
  }
  if (s.observations?.length) {
    L.push("## Observations for the user", "");
    for (const note of s.observations) L.push(`- ${note}`);
    L.push("");
  }
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

type SheetOutcome = DailySummary["sheet"];

async function pushSheet(date: string, markdown: string): Promise<SheetOutcome> {
  // Switched off in the profile: the local UI is the surface, so there is
  // nothing to mirror and nothing to configure. Never build a client here.
  if (!(await sheetEnabled())) {
    return { pushed: false, failed: false, status: "disabled", note: "Sheet disabled (sheet.enabled: false); the local UI is the approval surface" };
  }
  await loadLocalEnv();
  // Not configured is a choice, not a failure; anything after this point is.
  if (!authReady()) return { pushed: false, failed: false, status: "not_configured", note: "Sheet not configured (GOOGLE_APPLICATION_CREDENTIALS / SHEETS_SPREADSHEET_ID missing); summary not mirrored" };
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
    if (got !== rows.length) return { pushed: false, failed: true, status: "failed", note: `Sheet Summary verification failed: ${got}/${rows.length} rows` };
    return { pushed: true, failed: false, status: "pushed", note: `Sheet Summary tab rewritten with ${rows.length - 1} lines` };
  } catch (e: any) {
    return { pushed: false, failed: true, status: "failed", note: `Sheet push failed: ${short(e?.message ?? String(e), 160)}` };
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
  const sheet: SheetOutcome = opts.sheet
    ? await pushSheet(opts.date, markdown)
    : { pushed: false, failed: false, status: "skipped", note: "Sheet push skipped (--no-sheet)" };
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
      // Fail closed: unreadable state or a failed mirror must be visible to
      // the caller (launchd, scripts/daily.sh), not buried in a note.
      for (const e of s.errors) console.error(`[daily-summary] ${e}`);
      if (s.sheet.failed) console.error(`[daily-summary] ${s.sheet.note}`);
      process.exit(s.errors.length || s.sheet.failed ? 1 : 0);
    } catch (e: any) {
      console.error(`[daily-summary] ${e?.stack ?? e}`);
      process.exit(1);
    }
  })();
}
