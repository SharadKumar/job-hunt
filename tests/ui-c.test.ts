#!/usr/bin/env tsx
/**
 * ui-c.test.ts: the workspace half of the local UI's API. The run history, the
 * editorial rules and the one approval the Resumes screen offers.
 *
 * The handlers in tools/ui/workspace-api.ts are called through the dispatcher
 * in tools/ui/api.ts, because that is how the browser reaches them and because
 * the dispatcher's "extensions get first refusal" ordering is part of the
 * contract. Everything runs against a fixture repo root (HARNESS_REPO_ROOT), a
 * throwaway pipeline database and a throwaway audit dir, so the person's own
 * state/ is never read or written.
 *
 * What is pinned here:
 *   - the run list parses the summary's Numbers table and the launchd log's two
 *     bracket lines, and the detail pulls the letters out of the journal's
 *     "Sent unattended" section;
 *   - a promotion, an edit and a removal of a standing rule each leave every
 *     comment in the rules file exactly where the person put it, and each one
 *     writes an audit event;
 *   - approval refuses when the critic reviewed a different composition, in the
 *     tool's own words, and nothing on disk moves.
 *
 * Run: npx tsx tests/ui-c.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-c-"));
// Set before the tools are evaluated: repo-root and audit.ts both pin their
// paths at import time.
process.env.HARNESS_REPO_ROOT = root;
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
delete process.env.HARNESS_PROFILE;

const api = await import("../tools/ui/api.ts");

const FIXTURES = path.join(import.meta.dirname, "fixtures", "ui-c");
const ctx = { journalDir: path.join(root, "state", "journal", "summary") };
const RULES = path.join(root, "state", "profile", "letter-critic-rules.yaml");
const AUDIT_LOG = path.join(root, "audit", "audit-log.jsonl");

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

function place(fixture: string, rel: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), target);
}

const call = (method: string, pathname: string, body?: unknown, query?: string) =>
  api.handleApi({ method, pathname, body, query: new URLSearchParams(query ?? "") }, ctx);

/** The audit events written so far, newest last. */
function auditEvents(): any[] {
  if (!fs.existsSync(AUDIT_LOG)) return [];
  return fs.readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ---------- fixtures on disk ----------

place("summary-2026-09-17.md", "state/journal/summary/2026-09-17.md");
place("summary-2026-09-16.md", "state/journal/summary/2026-09-16.md");
place("launchd-2026-09-17.log", "state/journal/launchd/2026-09-17.log");
place("launchd-2026-09-16.log", "state/journal/launchd/2026-09-16.log");
place("journal-2026-09-17.md", "state/journal/2026-09-17.md");
place("letter-critic-rules.yaml", "state/profile/letter-critic-rules.yaml");
place("editorial-bans.yaml", "state/profile/editorial-bans.yaml");

console.log("ui workspace api");

// ---------- runs ----------

await test("the run list reads the Numbers table and the log's two bracket lines", async () => {
  const res = await call("GET", "/api/runs", undefined, "limit=30");
  assert.equal(res.status, 200);
  const body = res.body as any;
  assert.equal(body.runs.length, 2, "one entry per summary or log date");
  assert.deepEqual(body.runs.map((r: any) => r.date), ["2026-09-17", "2026-09-16"], "newest first");

  const latest = body.runs[0];
  assert.equal(latest.sent, 2, "sent comes from the Sent today column");
  assert.equal(latest.blocked, 7, "blocked comes from the Manual column");
  assert.equal(latest.exit_code, 0);
  // 07:00:05 to 08:13:26 is 1 h 13 m 21 s.
  assert.equal(latest.duration_s, 4401, "the duration is the gap between the two bracket lines");
  assert.equal(latest.has_summary, true);
  assert.equal(latest.summary_path, "state/journal/summary/2026-09-17.md", "the path is repo relative");
});

await test("a run that died before the summary falls back to the headline", async () => {
  const res = await call("GET", "/api/runs");
  const failed = (res.body as any).runs.find((r: any) => r.date === "2026-09-16");
  assert.equal(failed.exit_code, 124, "a watchdog kill is reported, not swallowed");
  assert.equal(failed.duration_s, 7200);
  // The fallback summary has no Numbers table and no headline tally either.
  assert.equal(failed.sent, null);
  assert.equal(failed.blocked, null);
  assert.equal(failed.has_summary, true);
});

await test("a date with a log and no summary is still a run", async () => {
  fs.copyFileSync(path.join(FIXTURES, "launchd-2026-09-16.log"), path.join(root, "state/journal/launchd/2026-09-15.log"));
  const res = await call("GET", "/api/runs");
  const orphan = (res.body as any).runs.find((r: any) => r.date === "2026-09-15");
  assert.ok(orphan, "a log with no summary must still appear");
  assert.equal(orphan.has_summary, false);
  assert.equal(orphan.summary_path, null);
  fs.rmSync(path.join(root, "state/journal/launchd/2026-09-15.log"));
});

await test("the run detail carries the summary and the letters sent unattended", async () => {
  const res = await call("GET", "/api/runs/2026-09-17");
  assert.equal(res.status, 200);
  const body = res.body as any;
  assert.match(body.markdown, /## Numbers/, "the detail is the summary markdown");
  assert.equal(body.letters_sent.length, 2, "two sends in the journal section");
  assert.match(body.letters_sent[0].title, /Solution Architect \| Example Pty Ltd/, "the title reads without markdown");
  assert.ok(!body.letters_sent[0].title.includes("**"), "emphasis must be stripped from the title");
  assert.match(body.letters_sent[0].letter, /^Dear Hiring Manager,/, "the letter is the blockquote, unquoted");
  assert.match(body.letters_sent[0].letter, /Example Person$/);
  assert.match(body.letters_sent[1].letter, /The second letter, shorter than the first\./);
  assert.ok(
    !body.letters_sent.some((entry: any) => /not a send/i.test(entry.title)),
    "the parser must stop at the next heading of the same level",
  );
});

await test("a run detail for a day with nothing is empty, not an error", async () => {
  const res = await call("GET", "/api/runs/2026-01-01");
  assert.equal(res.status, 200);
  assert.equal((res.body as any).markdown, null);
  assert.deepEqual((res.body as any).letters_sent, []);
});

/**
 * The running fixture on disk for one date: a start line whose stamp is
 * `minutes` ago, no finish line, and an mtime `touchedMinutes` ago. The same
 * bytes are a run in progress or a run that was killed, and the mtime is the
 * only thing that says which, so the test sets it rather than inheriting it.
 */
function placeRunningLog(date: string, minutes: number, touchedMinutes: number): string {
  const file = path.join(root, "state/journal/launchd", `${date}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = new Date(Date.now() - minutes * 60_000);
  fs.writeFileSync(file, fs.readFileSync(path.join(FIXTURES, "launchd-running.log"), "utf8")
    .replace("{{STARTED_AT}}", startedAt.toISOString()));
  const touched = new Date(Date.now() - touchedMinutes * 60_000);
  fs.utimesSync(file, touched, touched);
  return file;
}

await test("a log still being written to is a run in progress, with the time so far", async () => {
  const file = placeRunningLog("2026-09-18", 24, 0);
  const res = await call("GET", "/api/runs");
  const live = (res.body as any).runs.find((r: any) => r.date === "2026-09-18");
  assert.equal(live.running, true, "a fresh log with no finish line is the run going right now");
  assert.equal(live.exit_code, null, "a run still going has no exit code");
  assert.equal(live.note, null, "and nothing has gone wrong to note");
  assert.equal(live.has_log, true, "the log is there, so has_log is true whatever the summary says");
  assert.equal(live.has_summary, false, "the summary is written at the end, so it is not there yet");
  assert.ok(
    live.duration_s >= 24 * 60 && live.duration_s < 25 * 60,
    `the duration is the time so far, not a final time, got ${live.duration_s}`,
  );
  fs.rmSync(file);
});

await test("a log nobody has written to for hours is a run that was killed", async () => {
  const file = placeRunningLog("2026-09-18", 260, 240);
  const res = await call("GET", "/api/runs");
  const dead = (res.body as any).runs.find((r: any) => r.date === "2026-09-18");
  assert.equal(dead.running, false, "four hours untouched is not a run in progress");
  assert.equal(dead.exit_code, null);
  assert.equal(dead.note, "no finish line", "the reason there is no exit code is said out loud");
  assert.equal(dead.duration_s, null, "a killed run has no wall time to claim");
  assert.equal(dead.has_log, true);
  fs.rmSync(file);
});

await test("a finished run is never mistaken for a running one", async () => {
  const res = await call("GET", "/api/runs");
  for (const run of (res.body as any).runs) {
    assert.equal(run.running, false, `${run.date} finished, so it must not read as running`);
    assert.equal(run.has_log, true, "both fixture days have a launchd log");
    assert.equal(run.note, null);
  }
});

await test("a bad date and a bad limit are refused", async () => {
  const badDate = await call("GET", "/api/runs/17-09-2026");
  assert.equal(badDate.status, 400);
  const badLimit = await call("GET", "/api/runs", undefined, "limit=-4");
  assert.equal(badLimit.status, 400);
  const badMethod = await call("DELETE", "/api/runs");
  assert.equal(badMethod.status, 405, "a path this module owns answers 405, not 404");
});

// ---------- rules, read ----------

await test("GET /api/rules returns the standing rules, the patterns and the bans", async () => {
  const res = await call("GET", "/api/rules");
  assert.equal(res.status, 200);
  const body = res.body as any;
  assert.equal(body.exists, true);
  assert.equal(body.path, "state/profile/letter-critic-rules.yaml");
  assert.equal(body.standing_rules.length, 2);
  assert.match(body.standing_rules[1], /the client's name is never used/, "a doubled quote comes back as one");
  assert.equal(body.never_named.length, 1);
  assert.match(body.never_named[0].pattern, /Example\\s\*Holdings/);
  assert.match(body.never_named[0].fix, /a large Australian retailer/);
  assert.equal(body.profile_facts.length, 1);
  assert.equal(body.editorial_bans.version, 1);
  assert.equal(body.editorial_bans.rules.length, 1);
  assert.equal(body.editorial_bans.rules[0].id, "venture-title");
  assert.match(body.editorial_bans.rules[0].scope, /Example Venture/);
  assert.deepEqual(body.editorial_bans.rules[0].forbidden, ["founder", "incorporat"]);
});

// ---------- rules, write ----------

const COMMENTS = [
  "# Profile-owned rules for tools/letter-critic.ts. Personal: never leaves state/.",
  "# never_named: deterministic regex pre-checks. Any match on a letter line is a fail.",
  "# A comment between the rules and the sections. It must still be here afterwards.",
];

function assertCommentsSurvive(): void {
  const text = fs.readFileSync(RULES, "utf8");
  for (const comment of COMMENTS) {
    assert.ok(text.includes(comment), `the write lost a comment: ${comment}`);
  }
  assert.match(text, /never_named:\n {2}- pattern: "\\\\bExample\\\\s\*Holdings\\\\b"/, "the never_named block must be byte for byte the same");
}

await test("promoting a theme appends a standing rule and keeps every comment", async () => {
  const before = auditEvents().length;
  const text = "Example client: blocked 3 letters on inflation. Say only what cv-source.md supports about it.";
  const res = await call("POST", "/api/rules/standing", { text, source_theme: "example client:inflate" });
  assert.equal(res.status, 200);
  const body = res.body as any;
  assert.equal(body.index, 2, "the new rule lands at the end");
  assert.equal(body.method, "splice", "an existing block sequence is spliced, not re-serialised");
  assert.equal(body.standing_rules.length, 3);

  const onDisk = fs.readFileSync(RULES, "utf8");
  assert.ok(onDisk.includes(`  - 'Example client: blocked 3 letters on inflation.`), "the rule is written at the sequence indent");
  assertCommentsSurvive();

  const events = auditEvents();
  assert.equal(events.length, before + 1, "one audit event per write");
  const last = events[events.length - 1];
  assert.equal(last.event_type, "rule_change");
  assert.equal(last.actor, "ui");
  assert.equal(last.details.action, "append");
  assert.equal(last.details.source_theme, "example client:inflate");
});

await test("an edit replaces one rule in place and quotes it correctly", async () => {
  const res = await call("POST", "/api/rules/standing/0", { text: "The first rule, rewritten with the client's own wording." });
  assert.equal(res.status, 200);
  assert.equal((res.body as any).method, "splice");
  const read = await call("GET", "/api/rules");
  assert.equal((read.body as any).standing_rules[0], "The first rule, rewritten with the client's own wording.");
  assert.equal((read.body as any).standing_rules.length, 3, "an edit must not add or drop a rule");
  assert.ok(
    fs.readFileSync(RULES, "utf8").includes("the client''s own wording"),
    "an apostrophe must be doubled in a single-quoted scalar",
  );
  assertCommentsSurvive();
  assert.equal(auditEvents()[auditEvents().length - 1].details.action, "edit");
});

await test("a removal takes the whole line and nothing else", async () => {
  const res = await call("POST", "/api/rules/standing/1/remove");
  assert.equal(res.status, 200);
  assert.equal((res.body as any).method, "splice");
  const read = await call("GET", "/api/rules");
  const rules = (read.body as any).standing_rules;
  assert.equal(rules.length, 2);
  assert.ok(!rules.some((rule: string) => /the client's name is never used/.test(rule)), "the removed rule is gone");
  assert.match(rules[0], /^The first rule, rewritten/);
  assert.match(rules[1], /^Example client: blocked 3 letters/);
  assertCommentsSurvive();
  assert.equal(auditEvents()[auditEvents().length - 1].details.action, "remove");
});

await test("removing the last rule leaves an empty list, not a dangling key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-c-solo-"));
  const file = path.join(dir, "letter-critic-rules.yaml");
  fs.writeFileSync(file, "# keep me\nstanding_rules:\n  - 'the only rule'\n\n# and me\nprofile_facts: []\n");
  // The handler resolves the profile through the repo root, so point a second
  // profile dir at this file rather than reaching into the module's internals.
  const profile = path.join(root, "state", "profiles", "solo");
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(file, path.join(profile, "letter-critic-rules.yaml"));

  const res = await api.handleApi(
    { method: "POST", pathname: "/api/rules/standing/0/remove", query: new URLSearchParams() },
    { ...ctx, profileId: "solo" },
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as any).method, "document", "a sequence with one item cannot be spliced empty");
  const text = fs.readFileSync(path.join(profile, "letter-critic-rules.yaml"), "utf8");
  assert.match(text, /standing_rules: \[\]/, "the key must read back as an empty list");
  assert.ok(text.includes("# keep me") && text.includes("# and me"), "a re-serialised document still keeps its comments");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("an empty or absent rule text is refused, and so is a missing index", async () => {
  const empty = await call("POST", "/api/rules/standing", { text: "   " });
  assert.equal(empty.status, 400);
  const wrongType = await call("POST", "/api/rules/standing", { text: 42 });
  assert.equal(wrongType.status, 400);
  const missing = await call("POST", "/api/rules/standing/99", { text: "nowhere" });
  assert.equal(missing.status, 404);
  const gone = await call("POST", "/api/rules/standing/99/remove");
  assert.equal(gone.status, 404);
});

await test("a profile with no rules file is told to run setup, not handed an empty one", async () => {
  const res = await api.handleApi(
    { method: "POST", pathname: "/api/rules/standing", body: { text: "a rule" }, query: new URLSearchParams() },
    { ...ctx, profileId: "never-set-up" },
  );
  assert.equal(res.status, 409);
  assert.match(String((res.body as any).error), /run the setup skill/);
  const read = await api.handleApi(
    { method: "GET", pathname: "/api/rules", query: new URLSearchParams() },
    { ...ctx, profileId: "never-set-up" },
  );
  assert.equal(read.status, 200, "reading a profile that does not exist yet is not an error");
  assert.equal((read.body as any).exists, false);
});

// ---------- resume approval ----------

await test("approval refuses when the critic reviewed a different composition", async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "ui-resumes", "example-resume");
  const resumeDir = path.join(root, "state", "profile", "resumes", "example-resume");
  fs.cpSync(fixture, resumeDir, { recursive: true });
  // A composition on disk, and a critic verdict recorded against a different
  // one: exactly the state resume-approve exists to refuse.
  fs.writeFileSync(
    path.join(resumeDir, "Fixture-Person_Example-Consultant.composition.json"),
    JSON.stringify({ headline: "Example Consultant", summary: "One line." }, null, 2),
  );
  const metadata = {
    resume_id: "example-resume",
    content_hash: "abc123",
    approved_at: null,
    approved_hash: null,
    approval_status: "fresh",
    critic: { verdict: "pass", round: 2, at: "2026-09-01T09:00:00.000Z", composition_hash: "0".repeat(64) },
  };
  fs.writeFileSync(path.join(resumeDir, "metadata.json"), JSON.stringify(metadata, null, 2));

  const res = await call("POST", "/api/resumes/example-resume/approve");
  assert.equal(res.status, 409, "a refusal is a refusal, not a 200 with a warning");
  assert.match(String((res.body as any).error), /critic reviewed a different composition/,
    "the tool's own words come back, not a paraphrase");

  const after = JSON.parse(fs.readFileSync(path.join(resumeDir, "metadata.json"), "utf8"));
  assert.equal(after.approval_status, "fresh", "nothing on disk may move when approval is refused");
  assert.equal(after.approved_at, null);
});

await test("approval goes through once the critic is current", async () => {
  const resumeDir = path.join(root, "state", "profile", "resumes", "example-resume");
  const { compositionContentHash } = await import("../tools/resume/lib/composition-io.ts");
  const hash = await compositionContentHash(path.join(resumeDir, "Fixture-Person_Example-Consultant.composition.json"));
  const metadata = JSON.parse(fs.readFileSync(path.join(resumeDir, "metadata.json"), "utf8"));
  metadata.critic.composition_hash = hash;
  fs.writeFileSync(path.join(resumeDir, "metadata.json"), JSON.stringify(metadata, null, 2));

  const res = await call("POST", "/api/resumes/example-resume/approve");
  assert.equal(res.status, 200);
  assert.equal((res.body as any).result.approval_status, "approved", "the tool's own JSON comes back");
  const after = JSON.parse(fs.readFileSync(path.join(resumeDir, "metadata.json"), "utf8"));
  assert.equal(after.approval_status, "approved");
  assert.equal(after.approved_hash, "abc123");
});

await test("a resume id that is a path or a flag never reaches the tool", async () => {
  for (const id of ["..%2F..%2Fetc", "-%2Dskip-critic"]) {
    const res = await call("POST", `/api/resumes/${id}/approve`);
    assert.equal(res.status, 400, `a refused id must not be run: ${id}`);
  }
  // A resume with nothing on disk trips the critic gate before the "no
  // baseline" check, which is the right order: the gate is the outer one.
  const absent = await call("POST", "/api/resumes/no-such-resume/approve");
  assert.equal(absent.status, 409);
  assert.match(String((absent.body as any).error), /no critic review on record/);
});

// ---------- cleanup ----------

fs.rmSync(root, { recursive: true, force: true });

if (process.exitCode) {
  console.error("ui-c: FAILURES");
} else {
  console.log(`ui-c: ${passed} passed`);
}
