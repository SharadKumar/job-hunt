#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadResolvedResumes, loadResumes, keywordsForChannel } from "../tools/resumes.ts";
import type { MarketAlignment } from "../templates/resume/_interface.ts";

const root = mkdtempSync(path.join(tmpdir(), "resume-model-test-"));

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  writeFileSync(file, text);
  return file;
}

const legacyPath = write("legacy-resumes.yaml", `
resumes:
  - id: solution-architect
    label: Solution Architect
    active: true
    search_keywords: [Solution Architect]
    should: [architecture]
    could: [ServiceNow]
    flagged: [junior]
    cover_letter_angle: Led a large transformation.
    rate_band: { floor: 1000, target: 1200, ceiling: 1400, currency: AUD, billing_unit: day, gst_handling: + GST }
    preferred_channels: [seek]
`);

const orgPath = write("org-resume-types.yaml", `
resume_types:
  - id: ai-engineering-lead
    label: AI Engineering Lead
    active: true
    template: modern
    search_keywords: [AI Engineering Lead, Agent Platform Engineer]
    should: [agentic systems]
    could: [evals]
    flagged: [pure strategy]
    cover_letter_angle: Built production AI delivery systems.
    market_lens:
      must_signal: [agent orchestration, quality gates]
      keyword_aliases:
        harness engineering:
          acceptable_if_source_mentions: [agent workflows, delivery automation]
      proof_questions:
        - Were quality gates automated?
      forbidden_claims: [autonomous production agents]
    rate_band: { floor: 1200, target: 1500, ceiling: 1800, currency: AUD, billing_unit: day, gst_handling: + GST }
    preferred_channels: [linkedin_jobs]
  - id: delivery-lead
    label: Delivery Lead
    active: true
    search_keywords: [Delivery Lead]
    should: [delivery]
    could: []
    flagged: []
    cover_letter_angle: Led complex delivery.
    rate_band: { floor: 900, target: 1100, ceiling: 1300, currency: AUD, billing_unit: day, gst_handling: + GST }
    preferred_channels: [seek]
`);

const assignmentPath = write("assigned-resumes.yaml", `
resumes:
  - id: ai-engineering-lead
    active: false
    search_keywords: [Applied AI Lead]
    notes: Profile-specific assignment note.
`);

const unknownAssignmentPath = write("unknown-assignment.yaml", `
resumes:
  - id: does-not-exist
    active: true
`);

const marketAuditAssignmentPath = write("market-audit-assignment.yaml", `
resumes:
  - id: ai-engineering-lead
`);

const marketAuditCvSourcePath = write("market-audit-cv-source.md", `
# CV

Built multi-agent orchestration across Slack approval gates and GitHub branch flows.
`);

const marketAuditConfirmationPath = write("market-confirmations.yaml", `
confirmations:
  - resume_id: ai-engineering-lead
    signal: formal LLM evals
    question: Were formal LLM evals used?
    status: confirmed
    source_update_required: true
    updated_at: "2026-06-08"
  - resume_id: ai-engineering-lead
    signal: autonomous production agents
    question: Were autonomous production agents deployed?
    status: declined
    updated_at: "2026-06-08"
`);

const tests: [string, () => Promise<void>][] = [
  ["legacy resumes load without org config", async () => {
    const resumes = await loadResumes({ profileResumesPath: legacyPath, orgResumeTypesPath: path.join(root, "missing-org.yaml") });
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].id, "solution-architect");
    assert.equal(resumes[0].market_lens, undefined);
  }],

  ["org resume type merges with profile assignment override", async () => {
    const resumes = await loadResumes({ profileResumesPath: assignmentPath, orgResumeTypesPath: orgPath });
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].id, "ai-engineering-lead");
    assert.equal(resumes[0].label, "AI Engineering Lead");
    assert.equal(resumes[0].active, false);
    assert.deepEqual(resumes[0].search_keywords, ["Applied AI Lead"]);
    assert.equal(resumes[0].market_lens?.must_signal?.[0], "agent orchestration");
    assert.equal(resumes[0].notes, "Profile-specific assignment note.");
  }],

  ["unassigned org types are not active by default", async () => {
    const keywords = await keywordsForChannel("seek", { profileResumesPath: assignmentPath, orgResumeTypesPath: orgPath });
    assert.deepEqual(keywords, []);
  }],

  ["complete individual resume can coexist with org pool", async () => {
    const resolved = await loadResolvedResumes({ profileResumesPath: legacyPath, orgResumeTypesPath: orgPath });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].source, "profile");
    assert.equal(resolved[0].resume.id, "solution-architect");
  }],

  ["unknown profile assignment fails clearly", async () => {
    await assert.rejects(
      () => loadResumes({ profileResumesPath: unknownAssignmentPath, orgResumeTypesPath: orgPath }),
      /not defined in/,
    );
  }],

  ["market alignment metadata is type-compatible and non-rendered", async () => {
    const audit: MarketAlignment = {
      applied_terms: ["harness engineering"],
      implicit_terms_used: [{ term: "harness engineering", source_signal: "agent workflows" }],
      confirmation_needed: [{ signal: "quality gates", question: "Were quality gates automated?" }],
      missing_signals: ["evals"],
    };
    assert.equal(audit.implicit_terms_used?.[0].term, "harness engineering");
  }],

  ["extra slop banlist warns on org-style phrases", async () => {
    const banlist = write("org-slop.md", "## Forbidden\n- proprietary magic phrase\n");
    const run = spawnSync("npx", ["tsx", "tools/slop-killer.ts", "--text", "This contains a proprietary magic phrase.", "--extra-banlist", banlist], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.verdict, "warn");
    assert.equal(result.hits.some((hit: any) => hit.phrase === "proprietary magic phrase"), true);
  }],

  ["market audit classifies source-supported lens signals", async () => {
    const marketAuditOrgPath = write("market-audit-org.yaml", `
resume_types:
  - id: ai-engineering-lead
    label: AI Engineering Lead
    active: true
    search_keywords: [AI Engineering Lead]
    should: [agentic systems]
    could: []
    flagged: []
    cover_letter_angle: Built AI delivery systems.
    market_lens:
      must_signal: [agent orchestration, formal LLM evals]
      keyword_aliases:
        agent orchestration:
          acceptable_if_source_mentions: [multi-agent orchestration, Slack approval gates]
      proof_questions:
        - Were formal LLM evals used?
    rate_band: { floor: 1200, target: 1500, ceiling: 1800, currency: AUD, billing_unit: day, gst_handling: + GST }
    preferred_channels: [linkedin_jobs]
`);
    const run = spawnSync("npx", [
      "tsx",
      "tools/resume/market-lens-audit.ts",
      "--resume",
      "ai-engineering-lead",
      "--profile-resumes",
      marketAuditAssignmentPath,
      "--org-resume-types",
      marketAuditOrgPath,
      "--cv-source",
      marketAuditCvSourcePath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.signals.find((s: any) => s.signal === "agent orchestration").status, "explicit");
    assert.equal(result.signals.find((s: any) => s.signal === "formal LLM evals").status, "needs_confirmation");
  }],

  ["market audit suppresses repeated confirmations", async () => {
    const marketAuditOrgPath = write("market-audit-org-with-confirmations.yaml", `
resume_types:
  - id: ai-engineering-lead
    label: AI Engineering Lead
    active: true
    search_keywords: [AI Engineering Lead]
    should: [agentic systems]
    could: []
    flagged: []
    cover_letter_angle: Built AI delivery systems.
    market_lens:
      must_signal: [formal LLM evals, autonomous production agents]
      proof_questions:
        - Were formal LLM evals used?
        - Were autonomous production agents deployed?
    rate_band: { floor: 1200, target: 1500, ceiling: 1800, currency: AUD, billing_unit: day, gst_handling: + GST }
    preferred_channels: [linkedin_jobs]
`);
    const run = spawnSync("npx", [
      "tsx",
      "tools/resume/market-lens-audit.ts",
      "--resume",
      "ai-engineering-lead",
      "--profile-resumes",
      marketAuditAssignmentPath,
      "--org-resume-types",
      marketAuditOrgPath,
      "--cv-source",
      marketAuditCvSourcePath,
      "--confirmations",
      marketAuditConfirmationPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Exit 1, not 0: a non-empty source_update_required means the positioning
    // may not be rendered until cv-source.md carries the confirmed fact, and a
    // fail-shaped report on a zero exit is a fail a caller can miss.
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.verdict, "fail");
    assert.equal(result.confirmation_needed.length, 0);
    assert.equal(result.open_questions.length, 0);
    assert.equal(result.source_update_required[0].signal, "formal LLM evals");
    assert.equal(result.suppressed_confirmations[0].signal, "autonomous production agents");
  }],

  ["market audit surfaces pending proof questions beyond missing must signals", async () => {
    const marketAuditOrgPath = write("market-audit-org-with-open-questions.yaml", `
resume_types:
  - id: ai-engineering-lead
    label: AI Engineering Lead
    active: true
    search_keywords: [AI Engineering Lead]
    should: [agentic systems]
    could: []
    flagged: []
    cover_letter_angle: Built AI delivery systems.
    market_lens:
      must_signal: [agent orchestration]
      keyword_aliases:
        agent orchestration:
          acceptable_if_source_mentions: [multi-agent orchestration, Slack approval gates]
      proof_questions:
        - "MCP integration: did agent workflows use MCP servers?"
        - "AI safety/security: did workflows include prompt-injection controls?"
    rate_band: { floor: 1200, target: 1500, ceiling: 1800, currency: AUD, billing_unit: day, gst_handling: + GST }
    preferred_channels: [linkedin_jobs]
`);
    const pendingPath = write("market-open-confirmations.yaml", `
confirmations:
  - resume_id: ai-engineering-lead
    signal: MCP integration
    question: "MCP integration: did agent workflows use MCP servers?"
    status: pending
`);
    const run = spawnSync("npx", [
      "tsx",
      "tools/resume/market-lens-audit.ts",
      "--resume",
      "ai-engineering-lead",
      "--profile-resumes",
      marketAuditAssignmentPath,
      "--org-resume-types",
      marketAuditOrgPath,
      "--cv-source",
      marketAuditCvSourcePath,
      "--confirmations",
      pendingPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.confirmation_needed.length, 0);
    assert.equal(result.open_questions.length, 2);
    assert.equal(result.open_questions.some((q: any) => q.signal === "MCP integration"), true);
    assert.equal(result.open_questions.some((q: any) => q.signal === "AI safety/security"), true);
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
