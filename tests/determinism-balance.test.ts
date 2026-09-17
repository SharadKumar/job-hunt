#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Classification } from "../tools/classify-jd.ts";
import { assertAgentClassificationForApplication, matchedResumeId } from "../tools/classification-policy.ts";
import type { Opportunity } from "../tools/pipeline.ts";
import { opportunityWithScoreResult } from "../tools/rescore-pipeline.ts";

function opportunity(extra: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "seek-agent-test",
    channel: "seek",
    title: "Solution Architect",
    company: "Example Co",
    url: "https://example.com/job",
    description: "Architecture role.",
    status: "discovered",
    history: [],
    ...extra,
  };
}

function classification(extra: Partial<Classification> = {}): Classification {
  return {
    red_flags: [],
    bonuses: [],
    work_arrangement: "remote",
    day_rate: { min: null, max: null, currency: "AUD", inc_super: null, stated_explicitly: false },
    seniority: "senior",
    contract_length_months: 6,
    is_contract: true,
    requires_exclusivity: false,
    requires_payg: false,
    industry: "technology",
    short_summary: "Senior architecture contract.",
    profile_relevance: 90,
    profile_relevance_reason: "Strong architecture fit.",
    detected_domain: "enterprise architecture",
    discipline_fit: "core",
    location_flexibility: "remote",
    location_flexibility_quote: "fully remote",
    matched_resume_id: "solution-architect",
    resume_match_explanation: "Best match.",
    requires_tailoring: false,
    tailoring_rationale: "Baseline is sufficient.",
    _classifier: "agent",
    ...extra,
  };
}

function scoreResult(c: Classification, score = 80, red = false) {
  return {
    score,
    reasons: [`classifier: ${c._classifier}`],
    red_flag_blocker: red,
    breakdown: {},
    classification: c,
  };
}

const tests: [string, () => void][] = [
  ["agent classification is persisted and can promote", () => {
    const resultOpportunity = opportunityWithScoreResult(opportunity({ workArrangement: "unknown" }), scoreResult(classification({
      work_arrangement: "hybrid",
      day_rate: { min: 1200, max: 1400, currency: "AUD", inc_super: false, stated_explicitly: true },
    })), 55);
    assert.equal(resultOpportunity.status, "shortlisted");
    assert.equal(resultOpportunity.classificationSource, "agent");
    assert.equal(resultOpportunity.classification?.matched_resume_id, "solution-architect");
    assert.equal(resultOpportunity.workArrangement, "hybrid");
    assert.equal(resultOpportunity.dayRate?.min, 1200);
  }],

  ["regex classification cannot promote", () => {
    const resultOpportunity = opportunityWithScoreResult(opportunity(), scoreResult(classification({
      _classifier: "regex",
      profile_relevance: 50,
      profile_relevance_reason: "regex diagnostic default",
      matched_resume_id: null,
    })), 55);
    assert.equal(resultOpportunity.status, "discovered");
    assert.equal(resultOpportunity.classificationSource, "regex");
  }],

  ["application helper rejects non-agent classifications", () => {
    assert.throws(
      () => assertAgentClassificationForApplication(opportunity({
        classification: classification({ _classifier: "regex" }),
        classificationSource: "regex",
      })),
      /requires persisted agent classification/,
    );
  }],

  ["matched resume helper returns the classified resume id", () => {
    const classified = opportunity({ classification: classification({ matched_resume_id: "applied-ai" }) });
    assert.equal(matchedResumeId(classified), "applied-ai");
  }],

  ["channel scripts do not import scoreRole or shortlist", () => {
    for (const file of ["tools/channels/seek.ts", "tools/channels/linkedin-jobs.ts", "tools/channels/hn-who-is-hiring.ts"]) {
      const text = readFileSync(file, "utf8");
      assert.equal(/scoreRole/.test(text), false, `${file} should not call scoreRole`);
      assert.equal(/status\s*=\s*"shortlisted"|status:\s*"shortlisted"/.test(text), false, `${file} should not promote`);
      assert.equal(/--score/.test(text), false, `${file} should not expose --score`);
    }
  }],

  ["slop banlist phrases warn, forced fatal phrases fail", () => {
    const warn = spawnSync("npx", ["tsx", "tools/slop-killer.ts", "--text", "I can bring cutting-edge delivery experience."], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(warn.status, 1, warn.stderr);
    assert.equal(JSON.parse(warn.stdout).verdict, "warn");

    const fail = spawnSync("npx", ["tsx", "tools/slop-killer.ts", "--text", "As an AI language model, I cannot apply."], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(fail.status, 2, fail.stderr);
    assert.equal(JSON.parse(fail.stdout).verdict, "fail");
  }],

  ["voice length is warn but US spelling remains fail", () => {
    const longSentence = "This sentence intentionally runs well beyond the previous hard maximum sentence length because the policy now treats cadence as a warning for writer judgement rather than an automatic block.";
    const warn = spawnSync("npx", ["tsx", "tools/voice-check.ts", "--kind", "cover_letter", "--text", longSentence], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(warn.status, 1, warn.stderr);
    assert.equal(JSON.parse(warn.stdout).verdict, "warn");

    const fail = spawnSync("npx", ["tsx", "tools/voice-check.ts", "--kind", "cover_letter", "--text", "I helped an organization improve delivery."], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(fail.status, 2, fail.stderr);
    assert.equal(JSON.parse(fail.stdout).verdict, "fail");
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
