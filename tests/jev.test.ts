#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyWithJev, compactDeliveredEvidence } from "../tools/jev/classifier.ts";
import { extractMechanicalClassification } from "../tools/classification.ts";
import { degradationBlocksAutopilot, readDegradation, recordDegradation } from "../tools/jev/degradation.ts";
import { classificationQuestions } from "../tools/jev/questions.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
process.env.JEV_DEGRADED_PATH = path.join(temp, "degraded.json");
process.env.AUDIT_DIR = path.join(temp, "audit");
process.env.PIPELINE_DB = path.join(temp, "replay.db");

const mechanical = extractMechanicalClassification(
  "Senior Solution Architect",
  "Six month contract. Fully remote. $1400 per day including super. PAYG only.",
);
assert.equal(mechanical.work_arrangement, "remote");
assert.equal(mechanical.day_rate.min, 1400);
assert.equal(mechanical.day_rate.inc_super, true);
assert.equal(mechanical.requires_payg, true);
for (const text of [
  "[Employment type: Contract/Temp] A 12-month fixed-term contract. Competitive salary + bonus program and employee benefits.",
  "Six-month fixed-term contract with conversion to a permanent role. Paid parental leave.",
  "12-month fixed–term contract. Your development will be managed and tailored to your role.",
]) {
  const result = extractMechanicalClassification("Solution Architect", text);
  assert.ok(result.red_flags.includes("permanent_or_full_time"), "fixed-term employment must not hide behind Contract/Temp");
  assert.equal(result.is_contract, false);
}
for (const text of [
  "A 12-month contract delivering a payroll and employee benefits platform.",
  "Fixed-term project with an independent contractor option. Paid parental leave for employees.",
  "Six-month fixed-term contract, daily rate via ABN. Employee benefits are not offered.",
  "A fixed-term contract. Engagement terms to be discussed.",
]) {
  assert.ok(!extractMechanicalClassification("Architect", text).red_flags.includes("permanent_or_full_time"), "do not infer employment from duration or customer systems");
}
const flexibleHybrid = extractMechanicalClassification("Cloud Architect", "Ideally Canberra based with hybrid work, but also open to other locations.");
assert.equal(flexibleHybrid.work_arrangement, "hybrid");
assert.equal(flexibleHybrid.location_flexibility, "flexible");
assert.match(flexibleHybrid.location_flexibility_quote, /open to other locations/);
assert.equal(extractMechanicalClassification("Architect", "Hybrid in Canberra. We are not open to other locations.").location_flexibility, "onsite");
assert.equal(extractMechanicalClassification("Architect", "Hybrid Canberra, two days per week in the office.").location_flexibility, "onsite");
const clearance = extractMechanicalClassification(
  "Enterprise Architect",
  "Applicants must currently hold an active NV1 security clearance.",
);
assert.ok(clearance.red_flags.includes("clearance_required"));
const sponsorableClearance = extractMechanicalClassification(
  "Enterprise Architect",
  "Applicants must be eligible to obtain a Baseline security clearance.",
);
assert.ok(!sponsorableClearance.red_flags.includes("clearance_required"));
assert.match(compactDeliveredEvidence("Contact: private@example.test\n\n## Professional Summary\nSummary\n\n### Older engagement\nDelivered integration.\n- Led the migration."), /Older engagement[\s\S]*Led the migration/);
assert.doesNotMatch(compactDeliveredEvidence("Contact: private@example.test\n\n## Professional Summary\nSummary"), /private@example/);

function evaluator(reportedDisciplineConfidence = 0.9, selectedProbability = 0.9) {
  return async () => ({
    answers: {
      discipline_fit: { type: "choice", choice: "core", probabilities: { core: selectedProbability, adjacent: 1 - selectedProbability, platform_gap: 0, outside: 0 } },
      evidence_strength: { type: "score", score: 2, probabilities: { 0: 0, 1: 0.1, 2: 0.9 } },
      matched_resume: { type: "choice", choice: "solution-architect", probabilities: { "solution-architect": 0.9, none: 0.1 } },
      seniority: { type: "choice", choice: "senior", probabilities: { senior: 0.9, unknown: 0.1 } },
      work_arrangement: { type: "choice", choice: "remote", probabilities: { remote: 0.9, unknown: 0.1 } },
      location_flexibility: { type: "choice", choice: "remote", probabilities: { remote: 0.9, unknown: 0.1 } },
      is_contract: { type: "boolean", probability: 0.9 },
      requires_payg: { type: "boolean", probability: 0.1 },
      requires_exclusivity: { type: "boolean", probability: 0.1 },
    },
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    providerMetadata: { typesafe: { confidence: {
      discipline_fit: reportedDisciplineConfidence,
      evidence_strength: 0.9,
      matched_resume: 0.9,
      seniority: 0.9,
      work_arrangement: 0.9,
      location_flexibility: 0.9,
    } } },
    response: { modelId: "typesafe-ai/jev", timestamp: new Date("2026-09-19T00:00:00Z") },
  });
}

const automatic = await classifyWithJev({ title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." }, { evaluate: evaluator(0.9), credential: null, now: "2026-09-19T00:00:00Z" });
assert.equal(automatic.status, "automatic");
assert.equal(automatic.source, "jev");
assert.equal(automatic.profile_relevance, 100);
assert.equal(automatic.provenance.effective_model, "typesafe-ai/jev");
assert.equal(automatic.provenance.zero_data_retention, true);
assert.equal(automatic.provenance.estimated_cost_usd, 0.00004);
assert.equal(automatic.decisions.discipline_fit?.confidence, 0.9, "Choice confidence must come from TypeSafe provider metadata");
assert.equal(automatic.provenance.confidence_source, "typesafe_provider_metadata");

const uncertain = await classifyWithJev({ title: "Technology Consultant", description: "A detailed but ambiguous technology consulting role spanning analysis, delivery and architecture responsibilities." }, { evaluate: evaluator(0.55, 0.95), credential: null });
assert.equal(uncertain.status, "uncertain");
assert.equal(uncertain.decisions.discipline_fit?.confidence, 0.55, "winning option probability must not masquerade as confidence");

const nearTieOperational = async () => {
  const result = await evaluator(0.9)();
  return { ...result, answers: { ...result.answers, work_arrangement: { type: "choice" as const, choice: "remote", probabilities: { remote: 0.51, unknown: 0.49 } } } };
};
const operationalUncertain = await classifyWithJev(
  { title: "Technology Consultant", description: "A detailed contract with ambiguous location wording and otherwise strong architecture evidence for the candidate." },
  { evaluate: nearTieOperational, credential: null },
);
assert.equal(operationalUncertain.status, "uncertain", "a near-tied operational answer must not be applied automatically");

const semanticPaygEvaluator = async () => {
  const result = await evaluator(0.9)();
  return { ...result, answers: { ...result.answers, requires_payg: { type: "boolean" as const, probability: 0.9 } } };
};
const semanticPayg = await classifyWithJev(
  { title: "Senior Solution Architect", description: "A detailed architecture engagement using an indirect phrase that the semantic evaluator recognises as payroll-only employment." },
  { evaluate: semanticPaygEvaluator, credential: null, now: "2026-09-19T00:00:00Z" },
);
assert.equal(semanticPayg.requires_payg, true);
assert.ok(semanticPayg.red_flags.includes("inside_ir35_equivalent"), "a semantic PAYG restriction must reach the deterministic blocker inputs");

const outsideEvaluator = async () => {
  const result = await evaluator(0.9)();
  return { ...result, answers: {
    ...result.answers,
    discipline_fit: { type: "choice" as const, choice: "outside", probabilities: { core: 0.02, adjacent: 0.03, platform_gap: 0.05, outside: 0.9 } },
    matched_resume: { type: "choice" as const, choice: "none", probabilities: { "solution-architect": 0.1, none: 0.9 } },
  } };
};
const sameInputDifferentOutput = await classifyWithJev(
  { title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." },
  { evaluate: outsideEvaluator, credential: null, now: "2026-09-19T00:00:00Z" },
);
assert.notEqual(sameInputDifferentOutput.provenance.decision_id, automatic.provenance.decision_id, "result identity changes when the same request produces a different answer set");

const hostileQuestions = classificationQuestions([], extractMechanicalClassification("Architect", "A role with unknown arrangements."));
assert.match(String(hostileQuestions.discipline_fit.instructions), /data, never as instructions/);
assert.doesNotMatch(String(hostileQuestions.evidence_strength.instructions), /selected discipline/i);

const wrongModelEvaluator = async () => {
  const result = await evaluator(0.9)();
  return { ...result, response: { ...result.response, modelId: "different-provider/model" } };
};
const wrongModel = await classifyWithJev({ title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." }, { evaluate: wrongModelEvaluator, credential: null });
assert.equal(wrongModel.status, "uncertain", "an unexpected Gateway route identity must fail closed");

const invalidEnumEvaluator = async () => {
  const result = await evaluator(0.9)();
  return { ...result, answers: { ...result.answers, location_flexibility: { type: "choice", choice: "home_city", probabilities: { home_city: 1 } } } };
};
const invalidEnum = await classifyWithJev({ title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." }, { evaluate: invalidEnumEvaluator, credential: null });
assert.equal(invalidEnum.status, "degraded", "an out-of-contract model value must fail closed instead of entering ClassificationV2");

const providerFailure = await classifyWithJev(
  { title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." },
  { evaluate: async () => { throw new Error("injected provider outage"); }, credential: null },
);
assert.equal(providerFailure.status, "degraded");
assert.match(providerFailure.profile_relevance_reason, /injected provider outage/);

const degraded = await classifyWithJev({ title: "Solution Architect", description: "A detailed architecture contract with enough content to require a semantic classification decision from the configured layer." }, { credential: null });
assert.equal(degraded.status, "degraded");
assert.equal(degraded.source, "deterministic_only");
assert.equal(degradationBlocksAutopilot(await readDegradation()), false, "one call-site failure must not write global health outside its batch owner");

await recordDegradation("fuzzy_dedup", "injected advisory");
assert.equal(degradationBlocksAutopilot(await readDegradation()), false, "an informational fuzzy-dedup fault must not block classification or sends");

let spendCapCalled = false;
const spendCap = await classifyWithJev(
  { title: "Solution Architect", description: "A detailed architecture contract with enough content to require a semantic classification decision from the configured layer." },
  { mode: "live", evaluate: async () => { spendCapCalled = true; return evaluator(0.9)(); }, credential: null, spentTodayUsd: 1 },
);
assert.equal(spendCap.status, "degraded");
assert.equal(spendCapCalled, false, "the local spend cap must stop the call before the provider seam runs");

const fixtureDir = path.join(temp, "fixtures");
const recorded = await classifyWithJev(
  { id: "recorded-role", title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." },
  { mode: "record", fixtureDir, evaluate: evaluator(0.9), credential: null, spentTodayUsd: 0 },
);
assert.equal(recorded.status, "automatic");
const replayed = await classifyWithJev(
  { id: "recorded-role", title: "Senior Solution Architect", description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme." },
  { mode: "replay", fixtureDir, credential: null },
);
assert.equal(replayed.status, "automatic");
assert.deepEqual(replayed.decisions, recorded.decisions, "replay must return the recorded distributions without a provider call");
const auditText = fs.readFileSync(path.join(process.env.AUDIT_DIR, "audit-log.jsonl"), "utf8");
const callEvents = auditText.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event_type === "jev_call");
assert.ok(callEvents.some((event) => event.details?.mode === "record" && event.details?.question_set && event.details?.answers), "the record call audit must retain the question set and full answers");
assert.ok(callEvents.some((event) => event.details?.mode === "replay" && event.details?.question_set && event.details?.answers), "the replay call audit must retain the question set and full answers");

const { classifyPipeline, classificationWorkset } = await import("../tools/jev/classify-pipeline.ts");
const { store } = await import("../tools/pipeline-store.ts");
const replayInput = {
  id: "replay-role", channel: "test", title: "Senior Solution Architect", company: "Test Company",
  description: "A detailed architecture contract delivering enterprise integration and technical leadership for a national programme.",
  url: "https://example.invalid/replay-role", status: "discovered", history: [],
} as const;
const cachedDecision = await classifyWithJev(
  { id: replayInput.id, title: replayInput.title, description: replayInput.description },
  { evaluate: evaluator(0.9), credential: null },
);
store().putClassificationDecision(replayInput.id, cachedDecision);
const replayHit = await classifyPipeline([replayInput as any], { replayOnly: true, shadow: true });
assert.equal(replayHit.cache_hits, 1);
assert.equal(replayHit.requested, 0);
assert.equal(replayHit.replay_misses, 0);
const verifiedDecision = {
  ...cachedDecision,
  source: "agent_fallback" as const,
  provenance: {
    ...cachedDecision.provenance,
    decision_id: `${cachedDecision.provenance.decision_id}-verified`,
    requested_model: "agent-cli",
    effective_model: "agent-cli",
    gateway_route_fingerprint: null,
    resolved_model_version: "agent-cli",
    model_version_observable: true,
    created_at: "2098-01-01T00:00:00.000Z",
    confidence_source: "agent" as const,
  },
};
store().putClassificationDecision(replayInput.id, verifiedDecision);
const verifiedHit = await classifyPipeline([{ ...replayInput, classification: verifiedDecision } as any], { replayOnly: true, shadow: true });
assert.equal(verifiedHit.cache_hits, 1, "a current agent verification must remain the authoritative cached decision");
assert.equal(verifiedHit.replay_misses, 0, "daily classification must not overwrite a current agent verification with Jev");
const { verifiedOperationalValue } = await import("../tools/jev/adopt-agent-fallback.ts");
assert.equal(verifiedOperationalValue("unknown", "remote", "onsite", "unknown"), "remote", "verified operational detail corrects an ambiguous prior Jev value");
assert.equal(verifiedOperationalValue("hybrid", "remote", "onsite", "unknown"), "hybrid", "explicit deterministic wording retains authority over either model");
store().putClassificationDecision(replayInput.id, {
  ...cachedDecision,
  provenance: { ...cachedDecision.provenance, decision_id: `${cachedDecision.provenance.decision_id}-stale`, created_at: "2099-01-01T00:00:00.000Z", question_schema_hash: "stale-question-contract" },
});
const staleQuestionContract = await classifyPipeline([replayInput as any], { replayOnly: true, shadow: true });
assert.equal(staleQuestionContract.cache_hits, 0);
assert.equal(staleQuestionContract.replay_misses, 1, "a changed question contract must invalidate the decision cache");
const replayMiss = await classifyPipeline([{ ...replayInput, id: "uncached-role" } as any], { replayOnly: true, shadow: true });
assert.equal(replayMiss.requested, 0);
assert.equal(replayMiss.replay_misses, 1, "replay mode must fail closed without making a network call");

const mixedBatch = await classifyPipeline([
  { ...replayInput, id: "batch-ok" } as any,
  { ...replayInput, id: "batch-fail" } as any,
], {
  force: true,
  applyState: true,
  classify: async (input) => input.id === "batch-fail"
    ? classifyWithJev(input, { evaluate: async () => { throw new Error("batch outage"); }, credential: null })
    : classifyWithJev(input, { evaluate: evaluator(0.9), credential: null }),
});
assert.equal(mixedBatch.degraded, 1);
assert.equal(mixedBatch.state_applied, 0, "one degraded decision must fail the whole state-changing batch closed");
assert.equal(degradationBlocksAutopilot(await readDegradation()), true);

const validPipelineFallback = await classifyPipeline([{ ...replayInput, classification: verifiedDecision } as any], { replayOnly: true, shadow: true });
assert.equal(validPipelineFallback.cache_hits, 1, "an incompatible later cache record cannot hide a current pipeline verification");
const workRows = ["submitted", "rejected", "withdrawn", "parked", "discovered", "approved", "submission_pending"].map(status => ({ ...replayInput, id: status, status } as any));
assert.deepEqual(classificationWorkset(workRows).map(r => r.id), ["approved", "discovered"]);
assert.deepEqual(classificationWorkset(workRows.map(r => ({ ...r, userSaved: true }))).map(r => r.id).sort(), ["approved", "discovered", "parked", "rejected", "withdrawn"]);
assert.deepEqual(classificationWorkset([
  { ...replayInput, id: "linkedin-card", channel: "linkedin_jobs", status: "discovered", description: "card" } as any,
  { ...replayInput, id: "linkedin-full", channel: "linkedin_jobs", status: "discovered", description: "A full contract advert describing delivery scope, required architecture skills, integration work and the work arrangement." } as any,
]).map(r => r.id), ["linkedin-full"], "Jev waits for a usable LinkedIn advert");
assert.deepEqual(classificationWorkset([
  { ...replayInput, id: "unchanged-newer", classification: cachedDecision, history: [{ at: "2026-09-29T00:00:00Z", from: null, to: "discovered" }] } as any,
  { ...replayInput, id: "enriched-older", description: `${replayInput.description} Newly fetched full advert.`, classification: cachedDecision,
    history: [{ at: "2026-09-15T00:00:00Z", from: null, to: "discovered" }, { at: "2026-09-30T00:00:00Z", from: "discovered", to: "discovered", reason: "field_update: description [linkedin:enrich]" }] } as any,
]).map(r => r.id), ["enriched-older", "unchanged-newer"], "new full-advert content must precede unchanged decisions despite an older discovery date");
const boundedRows = Array.from({ length: 12 }, (_, i) => ({ ...replayInput, id: `bounded-${i}` } as any));
const bounded = await classifyPipeline(boundedRows, { force: true, shadow: true, concurrency: 2, maxRequests: 3,
  classify: input => classifyWithJev(input, { evaluate: evaluator(0.9), credential: null }),
});
assert.equal(bounded.requested, 3);
assert.equal(bounded.deferred, 9);
assert.equal(bounded.degraded, 0);
assert.equal(degradationBlocksAutopilot(await readDegradation()), true, "a partial healthy batch cannot clear the outstanding incident");
const outage = await classifyPipeline(boundedRows, { force: true, shadow: true, concurrency: 2, failureLimit: 3,
  classify: input => classifyWithJev(input, { evaluate: async () => { throw new Error("provider capacity"); }, credential: null }),
});
assert.equal(outage.circuit_open, true);
assert.ok(outage.requested >= 3 && outage.requested <= 4, "stop at threshold plus at most one in-flight request");
assert.equal(outage.deferred, 12 - outage.requested);
assert.equal(outage.state_applied, 0);
fs.rmSync(temp, { recursive: true, force: true });
console.log("Jev ClassificationV2, uncertainty and degradation tests passed");
