#!/usr/bin/env tsx
/**
 * ui-a.test.ts: the harness-health and screening-answers work package.
 *
 * Five contracts, each of which was a bug or a silence before:
 *
 *   1. a row detail finds its package in the archive when the row carries no
 *      `draftDir`, which most rows on a real machine do not,
 *   2. an approved CV whose hashes agree stays approved, whatever the artefact
 *      mtimes say (they were reset wholesale on this machine, and every CV then
 *      read as "stale, rebuilt after approval"),
 *   3. an answer banked from the browser lands in the person's own
 *      screening-answers.yaml with every comment intact, and is audited,
 *   4. GET /api/health reports the last run, the next one and a login that has
 *      gone stale,
 *   5. a parked row's reason reads as a sentence rather than a run stamp.
 *
 * Everything runs against a throwaway repo root (HARNESS_REPO_ROOT), pipeline
 * database (PIPELINE_DB) and audit dir (AUDIT_DIR), so the person's own state/
 * is never read or written.
 *
 * Run: npx tsx tests/ui-a.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "fixtures", "ui-a");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-a-"));
// All three are pinned at import time by repo-root, the pipeline store and
// audit.ts, so they must be set before the first dynamic import below.
process.env.HARNESS_REPO_ROOT = root;
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
delete process.env.HARNESS_PROFILE;
delete process.env.HARNESS_NOTIFY_URL;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${(error as Error).stack ?? (error as Error).message}`);
    process.exitCode = 1;
  }
}

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

console.log("ui work package a");

// ---------------------------------------------------------------------------
// 1. The package a row's detail reads
// ---------------------------------------------------------------------------

const { upsert, patch } = await import("../tools/pipeline.ts");
const { getRowDetail, packageDirOf } = await import("../tools/ui/api.ts");

const archived = await upsert({
  channel: "seek",
  url: "https://example.test/job/1",
  title: "Solution Architect",
  company: "Acme Federal",
  description: "JD for Solution Architect",
  status: "discovered",
});
write(`state/pipeline/archive/${archived.id}/cover-letter.md`, "Dear hiring manager,\n\nThis is the letter.\n");
write(`state/pipeline/archive/${archived.id}/jd.md`, "# The ad\n");

const withDraftDir = await upsert({
  channel: "seek",
  url: "https://example.test/job/2",
  title: "Delivery Lead",
  company: "Beta Group",
  description: "JD for Delivery Lead",
  status: "discovered",
});
write("elsewhere/packages/beta/cover-letter.md", "The letter that draftDir points at.\n");
await patch(withDraftDir.id, { draftDir: "elsewhere/packages/beta" }, "test");

const ghost = await upsert({
  channel: "seek",
  url: "https://example.test/job/3",
  title: "Programme Manager",
  company: "Gamma Pty",
  description: "JD for Programme Manager",
  status: "discovered",
});
await patch(ghost.id, { draftDir: "state/pipeline/archive/never-written" }, "test");

await test("a row with no draftDir finds its package in the archive", async () => {
  const detail = await getRowDetail(archived.id);
  assert.match(String(detail.package.cover_letter), /This is the letter/, "the archived letter must be read");
  assert.match(String(detail.package.jd), /The ad/, "and the archived JD with it");
});

await test("a stored draftDir still wins when it is on disk", async () => {
  const detail = await getRowDetail(withDraftDir.id);
  assert.match(String(detail.package.cover_letter), /draftDir points at/, "the row's own draftDir must be preferred");
});

await test("a draftDir that is not on disk falls back to the archive", async () => {
  // The row names a directory that was never written, and has no archive
  // either: the package is empty rather than an unhandled ENOENT.
  const detail = await getRowDetail(ghost.id);
  assert.equal(detail.package.cover_letter, null);
  assert.equal(await packageDirOf(ghost), null, "nothing on disk means no package directory");
});

// ---------------------------------------------------------------------------
// 2. The approval stamp
// ---------------------------------------------------------------------------

const { approvalStatus } = await import("../tools/resume/index/model.ts");

await test("hashes decide the stamp, not artefact mtimes", () => {
  const approved = {
    approval_status: "approved",
    approved_at: "2026-09-17T00:00:00.000Z",
    last_render_at: "2026-09-17T00:00:00.000Z",
    approved_hash: "abc123",
    content_hash: "abc123",
  };
  assert.deepEqual(approvalStatus(approved, true), { status: "approved", date: "2026-09-17" },
    "matching hashes plus an approved status is approved, whatever the files' mtimes are");

  assert.equal(approvalStatus({ ...approved, content_hash: "def456" }, true).status, "stale",
    "a content hash that moved on is the one thing that makes an approval stale");

  assert.equal(approvalStatus({ ...approved, approval_status: "stale" }, true).status, "stale",
    "a declared stale status is respected even when the hashes agree");

  assert.equal(approvalStatus({ approval_status: "rendered", last_render_at: "2026-09-17T00:00:00.000Z" }, true).status, "fresh",
    "a render nobody has approved is fresh");

  assert.deepEqual(approvalStatus(null, true), { status: "fresh", date: null }, "artefacts with no metadata are fresh");
  assert.deepEqual(approvalStatus(null, false), { status: "missing", date: null }, "nothing on disk is missing");
  assert.equal(approvalStatus({}, false).status, "missing", "empty metadata and no artefacts is missing");
});

// ---------------------------------------------------------------------------
// 3. Screening answers
// ---------------------------------------------------------------------------

const screeningFile = path.join(root, "state/profile/screening-answers.yaml");
fs.mkdirSync(path.dirname(screeningFile), { recursive: true });
fs.copyFileSync(path.join(REPO, "templates/profile/screening-answers.yaml"), screeningFile);
const originalScreening = fs.readFileSync(screeningFile, "utf8");

const screening = await import("../tools/ui/health-api.ts");

const auditLines = (): any[] => {
  const file = path.join(root, "audit", "audit-log.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

await test("a question the worker parked is offered with its shape", async () => {
  // Parked through the worker's own writer, so the shape under test is the
  // shape the daily run actually leaves behind, `unknown_questions: []` and all.
  const { appendUnknownQuestion } = await import("../tools/autopilot-submit.ts");
  await appendUnknownQuestion(
    { id: "seek-abc123", company: "Acme Federal", title: "Solution Architect" },
    { text: "How many years of work experience do you have with Microsoft Azure?", context: "" },
    screeningFile,
  );
  await appendUnknownQuestion(
    { id: "seek-def456", company: "Beta Group", title: "Delivery Lead" },
    { text: "Select an option Yes No", context: "" },
    screeningFile,
  );

  const snapshot = await screening.getScreening();
  assert.equal(snapshot.unknown.length, 2, "both parked questions come back");
  assert.equal(snapshot.unknown[0].kind, "numeric", "a years question wants a number");
  assert.equal(snapshot.unknown[0].opportunity_id, "seek-abc123");
  assert.equal(snapshot.unknown[0].answer, null, "and is still unanswered");
  assert.ok(snapshot.answers_count > 0, "the canonical answers are counted");
  assert.match(snapshot.path, /screening-answers\.yaml$/);
});

await test("banking an answer writes it into the parked row and keeps the comments", async () => {
  const before = auditLines().length;
  const result = await screening.postScreeningAnswer({
    question: "How many years of work experience do you have with Microsoft Azure?  Required",
    answer: "8",
    kind: "numeric",
  });
  assert.equal(result.matched, true, "the normalised question must match the parked row");

  const text = fs.readFileSync(screeningFile, "utf8");
  assert.match(text, /question: "How many years of work experience do you have with Microsoft Azure\?"\n    answer: 8/,
    "the answer lands on the row that asked, as a bare number");
  assert.ok(text.includes("# Canonical answers to common screening questions."),
    "the file's opening comment survives the write");
  assert.ok(text.includes("# Patterns are case-insensitive regex; use \\b for word boundaries."),
    "and so do the comments further down");
  assert.ok(text.includes("rate_set_in_profile"), "every hand-written line is still there");

  const events = auditLines().slice(before);
  const event = events.find((e) => e.event_type === "screening_answer");
  assert.ok(event, "the answer is audited");
  assert.equal(event.actor, "ui");
  assert.equal(event.details.matched, true);
  assert.equal(event.details.question, "how many years of work experience do you have with microsoft azure",
    "the audit records the canonical question");
});

await test("the banked answer is what the submission worker loads", async () => {
  const { loadScreeningAnswers } = await import("../tools/channels/seek-submit.ts");
  const answers = await loadScreeningAnswers(screeningFile);
  const entry = answers.entries.find((e) => e.id.startsWith("unknown:"));
  assert.ok(entry, "an answered unknown question becomes an exact-match entry");
  assert.equal(entry!.answer, "8");
});

await test("a question nobody parked is appended rather than lost", async () => {
  const result = await screening.postScreeningAnswer({
    question: "Do you have a current driver licence?",
    answer: "Yes",
  });
  assert.equal(result.matched, false);
  const snapshot = await screening.getScreening();
  const added = snapshot.unknown.find((u) => u.question === "Do you have a current driver licence?");
  assert.ok(added, "the new question is on file");
  assert.equal(added!.answer, "Yes");
});

await test("a bogus row can be dropped", async () => {
  const result = await screening.postScreeningRemove({ question: "Select an option Yes No" });
  assert.equal(result.removed, true);
  const snapshot = await screening.getScreening();
  assert.ok(!snapshot.unknown.some((u) => u.question === "Select an option Yes No"), "the row is gone");
  assert.ok(snapshot.unknown.some((u) => u.opportunity_id === "seek-abc123"), "and its neighbours are not");
  assert.equal((await screening.postScreeningRemove({ question: "never asked" })).removed, false,
    "removing something that was never there is not an error");
});

await test("years with a skill upsert into the map the worker reads", async () => {
  await screening.postSkillYears({ skill: "Azure", years: 8 });
  await screening.postSkillYears({ skill: "m365", years: 15, aliases: ["Microsoft 365", "office 365"] });
  const snapshot = await screening.getScreening();
  assert.deepEqual(snapshot.skills_years, { azure: 8, m365: 15 });

  const { loadScreeningAnswers } = await import("../tools/channels/seek-submit.ts");
  const answers = await loadScreeningAnswers(screeningFile);
  const m365 = answers.skillsYears.find((s) => s.key === "m365");
  assert.ok(m365, "the aliased entry parses back through the worker's own loader");
  assert.deepEqual(m365!.aliases, ["microsoft 365", "office 365"]);

  await screening.postSkillYears({ skill: "azure", years: 9 });
  assert.equal((await screening.getScreening()).skills_years.azure, 9, "a second answer replaces the first");
  assert.ok(fs.readFileSync(screeningFile, "utf8").includes("# Years of experience per skill."),
    "the map's own comment block survives every upsert");
});

await test("a bad body is a 400, not a half written file", async () => {
  const snapshot = fs.readFileSync(screeningFile, "utf8");
  await assert.rejects(() => screening.postScreeningAnswer({ question: "", answer: "yes" }), /question is required/);
  await assert.rejects(() => screening.postScreeningAnswer({ question: "q" }), /answer is required/);
  await assert.rejects(() => screening.postScreeningAnswer({ question: "q", answer: "a", kind: "shrug" }), /kind must be/);
  await assert.rejects(() => screening.postSkillYears({ skill: "azure", years: "lots" }), /years must be/);
  assert.equal(fs.readFileSync(screeningFile, "utf8"), snapshot, "a refused request changes nothing");
});

await test("the original template is unchanged apart from what was banked", () => {
  const text = fs.readFileSync(screeningFile, "utf8");
  for (const line of originalScreening.split("\n")) {
    if (!line.trim() || line.trim() === "unknown_questions: []" || line.trim() === "skills_years: {}") continue;
    assert.ok(text.includes(line), `the write dropped a line from the file: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Health
// ---------------------------------------------------------------------------

write("state/journal/launchd/2026-09-17.log", fs.readFileSync(path.join(FIXTURES, "daily-run.log"), "utf8"));
write("state/profile/channels.yaml", [
  "channels:",
  "  seek:",
  "    enabled: true",
  "  linkedin_jobs:",
  "    enabled: true",
  "  hn:",
  "    enabled: false",
  "",
].join("\n"));
write("state/profile/submission-policy.yaml", [
  "kill_switch: false   # the brake",
  "autopilot:",
  "  enabled: true",
  "  max_per_day: 30",
  "  channels: [seek, linkedin_jobs]",
  "sheet:",
  "  enabled: false",
  "",
].join("\n"));

// A SEEK session saved a month ago, and no LinkedIn session at all.
const sessionFile = write("state/channels/storage-state/seek.json", JSON.stringify({ cookies: [] }));
const monthAgo = new Date(Date.now() - 30 * 86_400_000);
fs.utimesSync(sessionFile, monthAgo, monthAgo);

await test("health reports the last run, the next one and the logins", async () => {
  const now = new Date("2026-09-17T12:00:00+10:00");
  const health = await screening.getHealth({ now, plistPath: path.join(FIXTURES, "daily.plist") });

  assert.equal(health.last_run?.date, "2026-09-17");
  assert.equal(health.last_run?.exit_code, 0);
  assert.equal(health.last_run?.running, false);
  assert.equal(health.last_run?.duration_seconds, 92 * 60 + 25, "the two stamps in the log give the duration");
  assert.equal(health.last_run?.log, "state/journal/launchd/2026-09-17.log", "the log is named relative to the repo");

  assert.ok(health.schedule.installed, "the fixture plist counts as installed");
  assert.equal(health.schedule.at, "07:00");
  const next = new Date(health.next_run!);
  assert.equal(next.getHours(), 7, "the next run is at 07:00");
  assert.ok(next.getTime() > now.getTime(), "and it is in the future");
  assert.ok(next.getDay() >= 1 && next.getDay() <= 5, "on a weekday, as the plist says");

  assert.equal(health.caps.max_per_day, 30);
  assert.equal(health.caps.autopilot_enabled, true);
  assert.equal(health.caps.kill_switch, false);
  assert.equal(health.caps.sent_today, 0, "nothing in the throwaway pipeline has been submitted");

  const seek = health.channels.find((c) => c.id === "seek");
  assert.equal(seek?.state, "stale");
  assert.equal(seek?.note, "older than 14 days, log in again");
  const linkedin = health.channels.find((c) => c.id === "linkedin_jobs");
  assert.equal(linkedin?.state, "missing");
  assert.equal(linkedin?.note, "session file missing");
  assert.ok(!health.channels.some((c) => c.id === "hn"), "a channel that is switched off is not probed");
  assert.equal(health.notify_url_set, false);
});

/**
 * A log with a start line and no finish line, whose start stamp is `minutes`
 * ago and whose mtime is `touchedMinutes` ago. The two are separate because
 * that is the whole test: the same bytes are a run in progress or a run that
 * was killed, and only the mtime says which.
 */
function runningLog(dir: string, minutes: number, touchedMinutes: number): string {
  const startedAt = new Date(Date.now() - minutes * 60_000);
  const file = path.join(dir, "2026-09-18.log");
  fs.writeFileSync(file, fs.readFileSync(path.join(FIXTURES, "running-run.log"), "utf8")
    .replace("{{STARTED_AT}}", startedAt.toISOString()));
  const touched = new Date(Date.now() - touchedMinutes * 60_000);
  fs.utimesSync(file, touched, touched);
  return file;
}

await test("a log still being written to is a run in progress, not a run that failed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-a-log-"));
  runningLog(dir, 24, 0);
  const last = await screening.readLastRun(dir);
  assert.equal(last?.running, true, "a fresh log with no finish line is the run that is going now");
  assert.equal(last?.exit_code, null, "a run still going has no exit code to report");
  assert.equal(last?.finished_at, null, "and no finish time, whatever the file mtime says");
  assert.equal(last?.date, "2026-09-18");
  assert.ok(
    last!.duration_seconds! >= 24 * 60 && last!.duration_seconds! < 25 * 60,
    `the duration is how long it has been going so far, got ${last?.duration_seconds}`,
  );
  assert.equal(await screening.readLastRun(path.join(dir, "nothing-here")), null, "no log dir is no last run");
});

await test("a log nobody has written to for hours is a run that was killed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-a-stale-"));
  runningLog(dir, 260, 240);
  const last = await screening.readLastRun(dir);
  assert.equal(last?.running, false, "four hours untouched is not a run in progress");
  assert.equal(last?.exit_code, null, "it never wrote an exit code");
});

await test("no plist installed is said out loud rather than guessed at", async () => {
  const health = await screening.getHealth({
    now: new Date("2026-09-17T12:00:00+10:00"),
    plistPath: path.join(root, "no-such.plist"),
  });
  assert.equal(health.schedule.installed, false);
  assert.equal(health.next_run, null);
});

await test("the launchd weekday numbering is read the way launchd means it", () => {
  const intervals = screening.parseIntervals(fs.readFileSync(path.join(FIXTURES, "daily.plist"), "utf8"));
  assert.equal(intervals.length, 5, "five weekdays");
  assert.deepEqual(intervals[0], { hour: 7, minute: 0, weekday: 1 });
  // Friday afternoon: the next run is Monday, not Saturday.
  const friday = new Date(2026, 8, 18, 12, 0, 0);
  const next = screening.nextRunAt(intervals, friday)!;
  assert.equal(next.getDay(), 1, "Monday");
  assert.equal(next.getDate(), 21);
  assert.equal(next.getHours(), 7);
  // Sunday, where launchd's 0 and 7 both mean Sunday, and the daily shape.
  const sunday = new Date(2026, 8, 20, 12, 0, 0);
  assert.equal(screening.nextRunAt([{ hour: 7, minute: 30, weekday: null }], sunday)!.getDate(), 21);
  assert.equal(screening.nextRunAt([{ hour: 7, minute: 0, weekday: 7 }], sunday)!.getDate(), 27, "7 is Sunday");
  assert.equal(screening.nextRunAt([], sunday), null, "no interval, no next run");
});

// ---------------------------------------------------------------------------
// 5. Reasons in plain words
// ---------------------------------------------------------------------------

/**
 * home.js is a browser module, so it is imported here beside a stub of the
 * helpers it takes from app.js. Nothing in it runs at import time, and the two
 * functions under test are pure, so this exercises the real file rather than a
 * copy of its regexes.
 */
const browserDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-a-home-"));
fs.writeFileSync(path.join(browserDir, "app.js"), [
  "export const api = async () => ({});",
  "export const getPolicy = () => null;",
  "export const getSummary = () => null;",
  "export const h = () => ({});",
  "export const isPolicyAvailable = () => false;",
  "export const localDay = () => '';",
  "export const pageHeader = () => ({});",
  "export const render = () => {};",
  "export const richMarkdown = () => [];",
  "",
].join("\n"));
fs.copyFileSync(path.join(REPO, "tools/ui/static/home.js"), path.join(browserDir, "home.js"));
const home = await import(path.join(browserDir, "home.js"));

await test("plainReason says what is actually wrong", () => {
  const cases: [string, string][] = [
    [
      '[autopilot daily-2026-09-17] unknown screening question: "How many years of work experience do you have with TensorFlow?" (appended to screening-answers.yaml unknown_questions)',
      "Unanswered question: How many years of work experience do you have with TensorFlow?",
    ],
    ["[autopilot daily-2026-09-16] external ATS: rba.wd105.myworkdayjobs.com", "External portal: rba.wd105.myworkdayjobs.com"],
    ['[autopilot daily-2026-09-17] letter-critic block (2 fail): "I architected the thing": Standing Rule 4', "Letter blocked: 2 findings"],
    ["[autopilot daily-2026-09-17] letter-critic block (1 fail): something", "Letter blocked: 1 finding"],
    [
      "daily-2026-09-16: package drafted (slop+voice pass); letter-critic BLOCK, findings in archive/letter-critic.json",
      "Letter blocked",
    ],
    [
      "[autopilot daily-2026-09-16] already submitted to Peoplebank Australia NSW for this role-family within 60 days, needs a user decision",
      "Duplicate of a role sent within 60 days",
    ],
    ["daily 2026-09-17: LinkedIn 'Apply on company website', package prepared", "Portal needs a login"],
    ["daily-2026-09-16: not a quick apply", "Portal needs a login"],
    ["autopilot daily-2026-09-17: package prepared unattended", "package prepared unattended"],
    ["", ""],
  ];
  for (const [raw, want] of cases) assert.equal(home.plainReason(raw), want, `plainReason(${JSON.stringify(raw)})`);
  assert.equal(home.plainReason(null), "", "a row with no reason says nothing rather than 'null'");
});

await test("a critic theme key reads as words", () => {
  assert.equal(home.themeWords("standing-rule-4:other"), "Standing rule 4");
  assert.equal(home.themeWords("ba:inflate"), "BA: inflation");
  assert.equal(home.themeWords("jd-shaped:misattribut"), "JD-shaped: misattribution");
  assert.equal(home.themeWords("key vault:other"), "Key vault: unsupported claim");
  assert.equal(home.themeWords("genai:invent"), "Genai: invention");
  assert.equal(home.themeWords(""), "Unnamed theme");
});

await test("a duration reads as a person would say it", () => {
  assert.equal(home.duration(5545), "1h 32m");
  assert.equal(home.duration(260), "4m 20s");
  assert.equal(home.duration(9), "9s");
  assert.equal(home.duration(null), "");
});

console.log(`\n${passed} assertions groups passed`);
if (process.exitCode) console.error("ui-a: FAILURES above");
