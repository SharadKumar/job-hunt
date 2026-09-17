#!/usr/bin/env tsx
/**
 * Smoke tests for tools/submission-gate.ts — the submission-safety chokepoint.
 *
 * Covers the policy-level decisions with fully injected state (roles, policy,
 * nowISO) so the tests touch neither disk nor the channel adapters. Artefact
 * checks (ATS-lint / slop / voice) are integration-tested via the live npm
 * tools elsewhere; here we prove the gate's routing logic.
 *
 * Run: npx tsx tests/submission-gate.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Opportunity } from "../tools/pipeline.ts";

// Isolate the audit log BEFORE importing the gate, so its audit writes
// (kill-switch, cap, gate-failed) land in a throwaway dir and never touch the
// real append-only trail. audit.ts reads AUDIT_DIR at module load, so the env
// must be set before the dynamic import below. (Type-only imports above are
// erased and don't trigger module execution.)
process.env.AUDIT_DIR = mkdtempSync(path.join(tmpdir(), "gate-test-audit-"));

const { evaluateSubmission } = await import("../tools/submission-gate.ts");
const { log: auditLogEvent } = await import("../tools/audit.ts");
type EvaluateOpts = Parameters<typeof evaluateSubmission>[0];

const NOW = "2026-05-29T10:00:00.000Z";

function opportunity(extra: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "seek-abc123", channel: "seek", title: "Solution Architect", company: "ACME Pty Ltd",
    url: "https://seek.com/job/1", status: "approved", history: [], ...extra,
  };
}

// A baseline policy with the kill switch off, seek opted in, no artefact/disk gates.
function policy(extra: Record<string, unknown> = {}) {
  return {
    kill_switch: false,
    max_auto_submits_per_day: 5,
    channels: { seek: { auto_submit: true }, hays: { auto_submit: false } },
    hard_gates: { no_red_flag_blocker: true }, // disk/exec gates left off for isolation
    ...extra,
  };
}

function opts(extra: Partial<EvaluateOpts> = {}): EvaluateOpts {
  return { opportunityId: "seek-abc123", approvedBy: "attended:test-session", nowISO: NOW, opportunities: [opportunity()], policy: policy(), ...extra };
}

// --- Autopilot fixtures -----------------------------------------------------
// An archive dir with a cover letter and, optionally, a letter-critic.json whose
// sha matches (or deliberately does not match) that letter.
const LETTER = "Dear Hiring Manager,\n\nAt NSW Department of Education I ran the Services Gateway stream.\n\nRegards,\nJane Citizen\n";
function archive(critic: "pass" | "block" | "stale" | "none"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-test-archive-"));
  writeFileSync(path.join(dir, "cover-letter.md"), LETTER);
  if (critic === "none") return dir;
  const sha = createHash("sha256").update(critic === "stale" ? LETTER + "edited" : LETTER, "utf8").digest("hex");
  writeFileSync(path.join(dir, "letter-critic.json"), JSON.stringify({
    verdict: critic === "block" ? "block" : "pass",
    findings: critic === "block" ? [{ severity: "fail", quote: "x", issue: "y", fix: "z" }] : [],
    letter_sha256: sha, letter_path: path.join(dir, "cover-letter.md"), jd_path: null, model: "test", checked_at: NOW, llm: null,
  }));
  return dir;
}
function autopilotPolicy(extra: Record<string, unknown> = {}, ap: Record<string, unknown> = {}) {
  return policy({
    autopilot: { enabled: true, channels: ["seek"], max_per_day: 15, require_letter_critic_pass: true, core_discipline_only: true, saved_jobs_bypass_fit_gates: true, ...ap },
    ...extra,
  });
}
function coreRow(extra: Partial<Opportunity> = {}): Opportunity {
  return opportunity({
    status: "approved", location: "Sydney NSW",
    classification: { _classifier: "agent", discipline_fit: "core", location_flexibility: "onsite", requires_tailoring: false } as any,
    ...extra,
  });
}
function apOpts(extra: Partial<EvaluateOpts> = {}): EvaluateOpts {
  return opts({ approvedBy: "autopilot:daily-test", policy: autopilotPolicy(), opportunities: [coreRow()], archiveDir: archive("pass"), homeCity: "Sydney", ...extra });
}

// --- Baseline-by-reference fixtures ----------------------------------------
// A baseline package records a reference to the approved baseline docx plus its
// sha256 instead of copying the file. The gate must re-hash the referenced file
// and refuse when it is not the artefact the package was prepared from.
function refArchive(kind: "match" | "docx_moved" | "reapproved" | "baseline_revoked"): string {
  const dir = archive("pass");
  const baselineDir = mkdtempSync(path.join(tmpdir(), "gate-test-baseline-"));
  const docxPath = path.join(baselineDir, "Fixture-Person_Architect.docx");
  writeFileSync(docxPath, "PK-fixture-docx: approved baseline body\n");
  const docxSha = createHash("sha256").update(readFileSync(docxPath)).digest("hex");
  const contentHash = createHash("sha256").update("fixture-baseline-content").digest("hex");
  writeFileSync(path.join(baselineDir, "metadata.json"), JSON.stringify({
    resume_id: "fixture-resume",
    content_hash: contentHash,
    approved_hash: kind === "baseline_revoked" ? null : contentHash,
    approved_at: "2026-09-01T00:00:00.000Z",
    approval_status: kind === "baseline_revoked" ? "fresh" : "approved",
    artefacts: { docx: docxPath },
  }));
  if (kind === "docx_moved") writeFileSync(docxPath, "PK-fixture-docx: re-rendered since the package was prepared\n");
  writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({
    opportunityId: "seek-abc123",
    resumeId: "fixture-resume",
    mode: "approved_baseline",
    resume: {
      mode: "baseline",
      resume_id: "fixture-resume",
      ref: docxPath,
      pdf_ref: null,
      sha256: docxSha,
      baseline_content_hash: kind === "reapproved" ? createHash("sha256").update("an-older-approval").digest("hex") : contentHash,
    },
  }));
  return dir;
}

const tests: [string, () => Promise<void>][] = [
  ["missing approval token → needs_approval", async () => {
    const d = await evaluateSubmission(opts({ approvedBy: undefined }));
    assert.equal(d.action, "needs_approval");
    assert.equal(d.allowed, false);
  }],

  ["Sheet approval alone → needs_approval", async () => {
    const d = await evaluateSubmission(opts({ approvedBy: "sheet:approve" }));
    assert.equal(d.action, "needs_approval");
    assert.equal(d.allowed, false);
  }],

  ["kill switch on → blocked", async () => {
    const d = await evaluateSubmission(opts({ policy: policy({ kill_switch: true }) }));
    assert.equal(d.action, "blocked");
    assert.equal(d.allowed, false);
  }],

  ["channel not opted in → manual", async () => {
    const d = await evaluateSubmission(opts({ channel: "hays", opportunities: [opportunity({ channel: "hays" })] }));
    assert.equal(d.action, "manual");
    assert.equal(d.allowed, false);
  }],

  ["forced-manual channel (recruiter_email) → manual even if flag set", async () => {
    const p = policy({ channels: { recruiter_email: { auto_submit: true } } });
    const d = await evaluateSubmission(opts({ channel: "recruiter_email", opportunities: [opportunity({ channel: "recruiter_email" })], policy: p }));
    assert.equal(d.action, "manual");
  }],

  ["linkedin opted in but ad is external apply → manual", async () => {
    const p = policy({ channels: { linkedin_jobs: { auto_submit: true } } });
    const d = await evaluateSubmission(opts({ channel: "linkedin_jobs", opportunities: [opportunity({ id: "linkedin_jobs-1", channel: "linkedin_jobs", applyMethod: "external" })], opportunityId: "linkedin_jobs-1", policy: p }));
    assert.equal(d.action, "manual");
    assert.ok(d.checks.find((c) => c.gate === "apply_method" && !c.ok));
  }],

  ["linkedin opted in and ad is Easy Apply → apply_method passes", async () => {
    const p = policy({ channels: { linkedin_jobs: { auto_submit: true } } });
    const d = await evaluateSubmission(opts({ channel: "linkedin_jobs", opportunities: [opportunity({ id: "linkedin_jobs-1", channel: "linkedin_jobs", applyMethod: "easy_apply" })], opportunityId: "linkedin_jobs-1", policy: p }));
    assert.ok(d.checks.find((c) => c.gate === "apply_method" && c.ok));
    assert.notEqual(d.reason.includes("not Easy Apply"), true);
  }],

  ["red flag blocker → gate_failed", async () => {
    const d = await evaluateSubmission(opts({ opportunities: [opportunity({ red_flag_blocker: true })] }));
    assert.equal(d.action, "gate_failed");
    assert.equal(d.allowed, false);
  }],

  ["tailored resume pending → gate_failed even with application approval", async () => {
    const tailored = opportunity({
      classification: { requires_tailoring: true } as any,
      tailoredResume: { approvalStatus: "pending" },
    });
    const p = policy({ tailored_resume_policy: { explicit_human_approval_required: true } });
    const d = await evaluateSubmission(opts({ opportunities: [tailored], policy: p }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /tailored_resume_approval/);
  }],

  ["tailored resume explicitly approved → gate passes", async () => {
    const tailored = opportunity({
      classification: { requires_tailoring: true } as any,
      tailoredResume: { approvalStatus: "approved", approvedBy: "interactive" },
    });
    const p = policy({ tailored_resume_policy: { explicit_human_approval_required: true } });
    const d = await evaluateSubmission(opts({ opportunities: [tailored], policy: p }));
    assert.equal(d.action, "submit");
  }],

  ["daily cap reached (cap 0) → capped", async () => {
    const d = await evaluateSubmission(opts({ policy: policy({ max_auto_submits_per_day: 0 }) }));
    assert.equal(d.action, "capped");
    assert.equal(d.allowed, false);
  }],

  ["unknown role → gate_failed", async () => {
    const d = await evaluateSubmission(opts({ opportunityId: "does-not-exist" }));
    assert.equal(d.action, "gate_failed");
  }],

  ["all policy gates pass → submit", async () => {
    const d = await evaluateSubmission(opts());
    assert.equal(d.action, "submit");
    assert.equal(d.allowed, true);
    assert.equal(d.provenance, "attended");
  }],

  // --- autopilot provenance (2026-09-15) -------------------------------------

  ["autopilot: policy disabled → needs_approval", async () => {
    const d = await evaluateSubmission(apOpts({ policy: autopilotPolicy({}, { enabled: false }) }));
    assert.equal(d.action, "needs_approval");
    assert.equal(d.allowed, false);
  }],

  ["autopilot: no autopilot block in policy → needs_approval", async () => {
    const d = await evaluateSubmission(apOpts({ policy: policy() }));
    assert.equal(d.action, "needs_approval");
  }],

  ["autopilot: kill switch on → blocked", async () => {
    const d = await evaluateSubmission(apOpts({ policy: autopilotPolicy({ kill_switch: true }) }));
    assert.equal(d.action, "blocked");
  }],

  ["autopilot: status not approved → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ opportunities: [coreRow({ status: "awaiting_approval" })] }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /autopilot_status_approved/);
  }],

  ["autopilot: regex classification → gate_failed", async () => {
    const row = coreRow({ classification: { _classifier: "regex", discipline_fit: "core" } as any });
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /autopilot_agent_classified/);
  }],

  ["autopilot: platform_gap and not saved → gate_failed", async () => {
    const row = coreRow({ classification: { _classifier: "agent", discipline_fit: "platform_gap" } as any });
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /autopilot_fit/);
  }],

  ["autopilot: interstate onsite core row → gate_failed (belongs in parked)", async () => {
    const row = coreRow({ location: "Brisbane QLD", classification: { _classifier: "agent", discipline_fit: "core", location_flexibility: "onsite" } as any });
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /interstate/);
  }],

  ["autopilot: interstate flexible core row → submit", async () => {
    const row = coreRow({ location: "Melbourne VIC", classification: { _classifier: "agent", discipline_fit: "core", location_flexibility: "flexible" } as any });
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "submit");
  }],

  ["autopilot: user-saved outside/interstate row bypasses fit gates → submit", async () => {
    const row = coreRow({ location: "Perth WA", userSaved: true, userSavedAt: NOW, classification: { _classifier: "agent", discipline_fit: "outside", location_flexibility: "onsite" } as any });
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "submit");
    assert.ok(d.checks.find((c) => c.gate === "autopilot_fit" && c.ok && /userSaved/.test(c.detail)));
  }],

  ["autopilot: user-saved row bypasses a scoring blocker (relevance / no positioning)", async () => {
    const row = coreRow({ userSaved: true, red_flag_blocker: true });
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "submit");
  }],

  ["autopilot: user-saved row is applied even when flagged permanent / fixed-term", async () => {
    const base = coreRow({ userSaved: true, red_flag_blocker: true });
    const row = { ...base, classification: { ...base.classification!, red_flags: ["permanent_or_full_time"] } } as typeof base;
    const d = await evaluateSubmission(apOpts({ opportunities: [row] }));
    assert.equal(d.action, "submit");
  }],

  ["autopilot: no letter-critic.json → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: archive("none") }));
    assert.equal(d.action, "gate_failed");
    assert.equal(d.allowed, false);
    assert.match(d.reason, /autopilot_letter_critic/);
  }],

  ["autopilot: letter-critic block → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: archive("block") }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /verdict is 'block'/);
  }],

  ["autopilot: letter-critic pass for a different letter sha → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: archive("stale") }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /different letter/);
  }],

  ["autopilot: channel not in autopilot.channels → manual", async () => {
    const p = autopilotPolicy({ channels: { seek: { auto_submit: true }, linkedin_easy: { auto_submit: true } } }, { channels: ["seek"] });
    const d = await evaluateSubmission(apOpts({ policy: p, channel: "linkedin_easy", opportunities: [coreRow({ channel: "linkedin_easy" })] }));
    assert.equal(d.action, "manual");
  }],

  ["autopilot: max_per_day 0 → capped, while attended cap still open", async () => {
    const d = await evaluateSubmission(apOpts({ policy: autopilotPolicy({}, { max_per_day: 0 }) }));
    assert.equal(d.action, "capped");
    assert.match(d.reason, /autopilot daily cap/);
  }],

  ["autopilot: cap counts only actor=autopilot submitted events", async () => {
    // Two attended sends and one autopilot send today; cap 2 → still one slot left? No: cap 2, autopilot count 1 → submit.
    const start = new Date(NOW); start.setHours(1, 0, 0, 0);
    await auditLogEvent({ ts: start.toISOString(), event_type: "submitted", role_id: "x1", actor: "submission-runner", details: {} });
    await auditLogEvent({ ts: start.toISOString(), event_type: "submitted", role_id: "x2", actor: "submission-runner", details: {} });
    await auditLogEvent({ ts: start.toISOString(), event_type: "submitted", role_id: "x3", actor: "autopilot", details: {} });
    const d1 = await evaluateSubmission(apOpts({ policy: autopilotPolicy({}, { max_per_day: 2 }) }));
    assert.equal(d1.action, "submit");
    const d2 = await evaluateSubmission(apOpts({ policy: autopilotPolicy({}, { max_per_day: 1 }) }));
    assert.equal(d2.action, "capped");
  }],

  ["autopilot: all gates pass → submit with provenance autopilot", async () => {
    const d = await evaluateSubmission(apOpts());
    assert.equal(d.action, "submit");
    assert.equal(d.allowed, true);
    assert.equal(d.provenance, "autopilot");
    for (const g of ["autopilot_enabled", "autopilot_status_approved", "autopilot_agent_classified", "autopilot_fit", "autopilot_letter_critic", "autopilot_channel", "autopilot_daily_cap"]) {
      assert.ok(d.checks.find((c) => c.gate === g && c.ok), `missing ok check ${g}`);
    }
  }],
  ["baseline ref: matching hashes → submit, with the ref check recorded", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: refArchive("match") }));
    assert.equal(d.action, "submit");
    const check = d.checks.find((c) => c.gate === "baseline_resume_ref");
    assert.ok(check?.ok, "the baseline_resume_ref check should be present and ok");
    assert.match(check!.detail, /verified/);
  }],

  ["baseline ref: the referenced docx changed since prepare → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: refArchive("docx_moved") }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /baseline_resume_ref/);
    assert.match(d.reason, /has changed since the package was prepared/);
  }],

  ["baseline ref: baseline re-approved since prepare → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: refArchive("reapproved") }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /baseline_resume_ref/);
    assert.match(d.reason, /re-approved since the package was prepared/);
  }],

  ["baseline ref: approval revoked on the baseline → gate_failed", async () => {
    const d = await evaluateSubmission(apOpts({ archiveDir: refArchive("baseline_revoked") }));
    assert.equal(d.action, "gate_failed");
    assert.match(d.reason, /baseline_resume_ref/);
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
