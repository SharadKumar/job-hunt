#!/usr/bin/env tsx
/**
 * daily-summary.test.ts — the morning brief's contract.
 *
 * Everything runs against a fixture repo in a temp dir (HARNESS_REPO_ROOT), a
 * throwaway pipeline database (PIPELINE_DB) and a throwaway audit dir, so the
 * real state/ is never read or written. The journal fixture carries the exact
 * lines from a real journal that the old channel-problem filter misflagged.
 *
 * Covers: one escalation per (row, kind); the manual note and the unanswered
 * screening question for the same row merging into one entry whose Next says
 * both; healthy channel lines staying out of the escalations; and failing
 * closed (exit 1) on a present but unparseable submission-policy.yaml.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures", "daily-summary");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-"));

// All three must be set before the tools are evaluated: repo-root, the pipeline
// store and audit.ts all pin their paths at import time.
process.env.HARNESS_REPO_ROOT = root;
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");

const { upsert, setStatus, patch } = await import("../tools/pipeline.ts");
const { buildSummary, renderMarkdown } = await import("../tools/daily-summary.ts");

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
const SCREENING = path.join(root, "state/profile/screening-answers.yaml");
const POLICY = path.join(root, "state/profile/submission-policy.yaml");

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), "utf8");
}

// ---------- seed the pipeline ----------

let n = 0;
async function seed(title: string, company: string, path_: string[], fields: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const row = await upsert({
    channel: "seek",
    url: `https://example.test/job/${n}`,
    title,
    company,
    description: `JD for ${title}`,
    status: "discovered",
  });
  if (Object.keys(fields).length) await patch(row.id, fields, "test");
  for (const status of path_) await setStatus(row.id, status as never, "test");
  return row.id;
}

const manualScreeningId = await seed("Solution Architect", "Acme Federal", ["manual_action_needed"], {
  notes: 'unknown screening question: "Do you hold a current NV1 clearance?"',
});
const manualAtsId = await seed("Enterprise Architect", "Dovetail Group", ["manual_action_needed"], {
  notes: "external ATS: workday.example.com",
});
const awaitingExternalId = await seed("Platform Lead", "Statewide Water", ["awaiting_external"]);
const submittedId = await seed("Principal Consultant", "Gone Pty", ["shortlisted", "drafted", "awaiting_approval", "approved", "submitted"]);
const parkedId = await seed("Delivery Manager", "Perth Metro", ["parked"], { parkedReason: "interstate onsite" });
const shortlistedId = await seed("Solution Architect", "Harbour Super", ["shortlisted"], { score: 78 });
const approvalId = await seed("Delivery Lead", "Borden Rail", ["shortlisted", "drafted", "awaiting_approval"]);
const pendingId = await seed("Integration Architect", "Ridgeline", ["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending"]);

assert.ok(pendingId && awaitingExternalId && parkedId && shortlistedId, "seeded eight rows");

write(
  "state/profile/screening-answers.yaml",
  fixture("screening-answers.yaml")
    .replaceAll("__MANUAL_ID__", manualScreeningId)
    .replaceAll("__APPROVAL_ID__", approvalId)
    .replaceAll("__SUBMITTED_ID__", submittedId),
);
write("state/profile/submission-policy.yaml", fixture("submission-policy.yaml"));
write(`state/journal/${today}.md`, fixture("journal.md"));

// ---------- escalations ----------

{
  const s = await buildSummary(today);
  const keys = s.escalations.map((e) => `${e.id ?? e.reason}::${e.kind}`);
  assert.equal(new Set(keys).size, keys.length, `no duplicate (id, kind) escalations: ${keys.join(" | ")}`);
  assert.deepEqual(s.errors, [], "readable state produces no errors");

  const forManual = s.escalations.filter((e) => e.id === manualScreeningId);
  assert.equal(forManual.length, 1, "the manual note and the screening question are one escalation");
  const merged = forManual[0];
  assert.equal(merged.kind, "screening");
  assert.match(merged.reason, /^Unanswered screening question: "Do you hold a current NV1 clearance\?"/);
  assert.match(merged.action, /unknown_questions/, "keeps the manual row's next step");
  assert.match(merged.action, /; also /, "and says the other one too");
  assert.match(merged.action, /rerun autopilot:submit/);

  assert.equal(s.escalations.filter((e) => e.id === manualAtsId).length, 1, "the ATS row keeps its own escalation");
  assert.equal(s.escalations.filter((e) => e.id === manualAtsId)[0].kind, "manual");
  // Different problems on one row stay separate: waiting in the Tray is not
  // the same ask as answering a screening question.
  assert.deepEqual(
    s.escalations.filter((e) => e.id === approvalId).map((e) => e.kind).sort(),
    ["awaiting_approval", "screening"],
    "one entry per kind for the Tray row",
  );
  assert.equal(s.escalations.filter((e) => e.id === pendingId)[0].kind, "submission_pending");
  assert.equal(s.numbers.unansweredQuestions, 2, "the duplicated question counts once, the answered one not at all");
  console.log("  ✓ escalations are keyed by (opportunity, kind) and merged");

  // ---------- journal problems ----------
  const journalLines = s.escalations.filter((e) => e.reason.startsWith("Journal:")).map((e) => e.reason);
  assert.equal(journalLines.length, 1, `exactly one journal problem, got: ${journalLines.join(" | ")}`);
  assert.match(journalLines[0], /session expired mid-hunt/, "the real failure is reported");
  for (const healthy of ["healthy", "No login/DOM errors", "no login issues", "all succeeded", "saved list"]) {
    assert.ok(!journalLines.some((l) => l.includes(healthy)), `healthy line must not escalate: ${healthy}`);
  }
  console.log("  ✓ healthy channel lines stay out, the real failure stays in");

  // ---------- markdown shape ----------
  const md = renderMarkdown(s);
  for (const heading of ["# Daily summary", "## Sent today", "## Escalations (your action)", "## Queue and parked", "## Responses", "## Numbers"]) {
    assert.ok(md.includes(heading), `markdown keeps the section "${heading}"`);
  }
  assert.ok(!md.includes("## State errors"), "no error section when state reads cleanly");
  assert.ok(!/[—–]/.test(md), "no em or en dashes");
  assert.equal(s.numbers.sentToday, 1);
  assert.equal(s.numbers.manual, 2);
  assert.equal(s.numbers.queue, 1);
  assert.equal(s.numbers.parked, 1);
  console.log("  ✓ markdown shape unchanged");
}

// ---------- missing files are allowed ----------

{
  fs.renameSync(SCREENING, `${SCREENING}.away`);
  fs.renameSync(POLICY, `${POLICY}.away`);
  const s = await buildSummary(today);
  assert.deepEqual(s.errors, [], "a missing policy or screening file is a normal state");
  assert.equal(s.numbers.unansweredQuestions, 0);
  assert.equal(s.numbers.killSwitch, false);
  fs.renameSync(`${SCREENING}.away`, SCREENING);
  fs.renameSync(`${POLICY}.away`, POLICY);
  console.log("  ✓ missing screening-answers.yaml / submission-policy.yaml stay allowed");
}

// ---------- the CLI fails closed on unreadable state ----------

const tsxBin = path.join(repo, "node_modules", ".bin", "tsx");
const script = path.join(repo, "tools", "daily-summary.ts");
const cli = (): ReturnType<typeof spawnSync> =>
  spawnSync(tsxBin, [script, "--no-sheet", "--date", today], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HARNESS_REPO_ROOT: root, PIPELINE_DB: process.env.PIPELINE_DB, AUDIT_DIR: process.env.AUDIT_DIR },
  });

{
  const ok = cli();
  assert.equal(ok.status, 0, `readable state exits 0:\n${ok.stderr}`);
  assert.ok(String(ok.stdout).includes("## Escalations (your action)"), "the CLI prints the markdown");
  assert.ok(fs.existsSync(path.join(root, "state/journal/summary", `${today}.md`)), "the summary file is written");

  write("state/profile/submission-policy.yaml", fixture("submission-policy.malformed.yaml"));
  const bad = cli();
  assert.equal(bad.status, 1, "an unparseable submission-policy.yaml exits 1");
  assert.match(String(bad.stdout), /## State errors/, "and says so in the summary");
  assert.match(String(bad.stdout), /submission-policy\.yaml is unreadable/);

  write("state/profile/submission-policy.yaml", fixture("submission-policy.yaml"));
  write("state/profile/screening-answers.yaml", "unknown_questions: [oops\n  - : :\n");
  const badScreening = cli();
  assert.equal(badScreening.status, 1, "an unparseable screening-answers.yaml exits 1");
  assert.match(String(badScreening.stdout), /screening-answers\.yaml is unreadable/);
  console.log("  ✓ unreadable policy or screening answers exit 1 with an error line");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("daily-summary.test.ts: all assertions passed");
