#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-adjudications-"));
process.env.HARNESS_REPO_ROOT = root;
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
process.env.JEV_ADJUDICATIONS_PATH = path.join(root, "state/jev/adjudications.json");

function write(rel: string, value: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

write("state/profile/resumes.yaml", `resumes:
  - id: solution-architect
    label: Solution Architect
    active: true
    search_keywords: [architect]
    should: []
    could: []
    flagged: []
    cover_letter_angle: Architecture delivery
    rate_band: { floor: 1000, target: 1200, ceiling: 1400, currency: AUD, billing_unit: day, gst_handling: '+ GST' }
    preferred_channels: [seek]
`);

const { upsert, patch } = await import("../tools/pipeline.ts");
const { store } = await import("../tools/pipeline-store.ts");
const { classificationContentHash } = await import("../tools/classification.ts");
const { getAdjudicationQueue, loadAdjudications, recordAdjudication } = await import("../tools/jev/adjudications.ts");
const { handleApi } = await import("../tools/ui/api.ts");

const row = await upsert({
  id: "test-role",
  channel: "seek",
  url: "https://example.invalid/test-role",
  title: "Senior Solution Architect",
  company: "Example Company",
  location: "Sydney NSW",
  description: "A detailed architecture role delivering enterprise integration and technical leadership.",
  status: "submitted",
});
const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
const decision: any = {
  schema_version: 2,
  source: "jev",
  status: "automatic",
  red_flags: [], bonuses: [], work_arrangement: "hybrid",
  day_rate: { min: null, max: null, currency: "AUD", inc_super: null, stated_explicitly: false },
  seniority: "senior", contract_length_months: null, is_contract: true,
  requires_exclusivity: false, requires_payg: false, industry: null,
  short_summary: "Architecture role", profile_relevance: 87,
  profile_relevance_reason: "core strong", detected_domain: "architecture",
  discipline_fit: "core", location_flexibility: "flexible", location_flexibility_quote: "",
  matched_resume_id: "solution-architect", resume_match_explanation: "best fit",
  requires_tailoring: false, tailoring_rationale: "",
  decisions: {
    discipline_fit: { selected: "core", probabilities: { core: 0.9, platform_gap: 0.05, adjacent: 0.04, outside: 0.01 }, confidence: 0.9, margin: 0.85 },
    matched_resume: { selected: "solution-architect", probabilities: { "solution-architect": 0.95, none: 0.05 }, confidence: 0.95, margin: 0.9 },
  },
  provenance: {
    decision_id: "decision-one", content_hash: contentHash,
    policy_hash: "policy", profile_hash: "profile", resume_set_hash: "resumes",
    requested_model: "typesafe-ai/jev", effective_model: "typesafe-ai/jev",
    gateway_route_fingerprint: "fingerprint", resolved_model_version: null, model_version_observable: false,
    created_at: "2026-09-19T00:00:00.000Z", latency_ms: 100,
    input_tokens: 100, output_tokens: 10, estimated_cost_usd: 0.001,
    cache_hit: false, zero_data_retention: true,
  },
};
store().putClassificationDecision(row.id, decision);

write("docs/benchmarks/jev-cohort.json", JSON.stringify([row.id]));
write("docs/benchmarks/jev-agent-disagreement-review.json", JSON.stringify({ items: [{
  id: row.id, priority: 1, outcome_consequential: true,
  differences: { discipline_fit: true, matched_resume_id: false },
  generic_agent: { discipline_fit: "platform_gap", matched_resume_id: "solution-architect", profile_relevance: 64 },
}] }));
write("docs/benchmarks/jev-calibration-review.json", JSON.stringify({ items: [{ id: row.id }] }));

const queue = await getAdjudicationQueue({ now: new Date("2026-09-19T01:00:00.000Z") });
assert.equal(queue.counts.items, 1, "overlapping sources are one review item");
assert.equal(queue.counts.frozen_primary_required, 1);
assert.equal(queue.counts.shadow_review_required, 1);
assert.equal(queue.counts.priority_1_pending, 1);
assert.deepEqual(queue.items[0].sources, ["frozen_cohort", "agent_disagreement", "shadow_proxy_disagreement"]);
assert.equal(queue.items[0].complete, false);
assert.equal(queue.items[0].delegated_decision, false);
assert.equal(queue.items[0].description, row.description);

await assert.rejects(() => recordAdjudication({
  role_id: row.id, content_hash: "wrong", jev_decision_id: "decision-one", apply_worthy: "yes",
}), /content changed/);
await assert.rejects(() => recordAdjudication({
  role_id: row.id, content_hash: contentHash, jev_decision_id: "decision-one",
  discipline_fit: "core", matched_resume_id: "invented-resume", apply_worthy: "yes",
}), /active resume id/);

await recordAdjudication({
  role_id: row.id,
  content_hash: contentHash,
  jev_decision_id: "decision-one",
  discipline_fit: "core",
  matched_resume_id: "solution-architect",
  apply_worthy: "yes",
  notes: "Assistant recommendation awaiting confirmation.",
  actor: "assistant-delegated",
}, { now: new Date("2026-09-19T01:30:00.000Z") });
const recommended = await getAdjudicationQueue();
assert.equal(recommended.counts.complete, 1, "a user-delegated decision completes the review item");
assert.equal(recommended.counts.delegated_decisions, 1);
assert.equal(recommended.counts.independent_human_complete, 0, "delegation cannot masquerade as independent human calibration");
assert.equal(recommended.counts.frozen_primary_human_complete, 0);
assert.equal(recommended.items[0].delegated_decision, true);
assert.equal(recommended.items[0].human_label?.discipline_fit, "core", "the delegated decision remains editable in the attended form");

const recorded = await recordAdjudication({
  role_id: row.id,
  content_hash: contentHash,
  jev_decision_id: "decision-one",
  discipline_fit: "core",
  matched_resume_id: "solution-architect",
  apply_worthy: "yes",
  notes: "Human review complete.",
  actor: "user",
}, { now: new Date("2026-09-19T02:00:00.000Z") });
assert.equal(recorded.apply_worthy, "yes");
const saved = await loadAdjudications();
assert.equal(saved.labels[row.id].jev_decision_id, "decision-one");
const complete = await getAdjudicationQueue();
assert.equal(complete.counts.complete, 1);
assert.equal(complete.counts.frozen_primary_complete, 1);
assert.equal(complete.counts.shadow_review_complete, 1);
assert.equal(complete.counts.delegated_decisions, 0);
assert.equal(complete.counts.independent_human_complete, 1);
const audit = fs.readFileSync(path.join(root, "audit/audit-log.jsonl"), "utf8");
assert.match(audit, /"event_type":"jev_adjudication_recorded"/);

const getResult = await handleApi({ method: "GET", pathname: "/api/jev/adjudications" }, { adjudicationsPath: process.env.JEV_ADJUDICATIONS_PATH });
assert.equal(getResult.status, 200);
assert.equal((getResult.body as any).counts.complete, 1);
const postResult = await handleApi({ method: "POST", pathname: "/api/jev/adjudications/record", body: {
  role_id: row.id, content_hash: contentHash, jev_decision_id: "decision-one",
  discipline_fit: "platform_gap", matched_resume_id: "solution-architect", apply_worthy: "yes",
} }, { adjudicationsPath: process.env.JEV_ADJUDICATIONS_PATH, now: new Date("2026-09-19T03:00:00.000Z") });
assert.equal(postResult.status, 200);
assert.equal((postResult.body as any).label.discipline_fit, "platform_gap");

await patch(row.id, { description: `${row.description} Changed after review.` }, "test", "changed content");
const stale = await getAdjudicationQueue();
assert.equal(stale.items[0].stale, true);
assert.equal(stale.items[0].complete, false, "a label cannot survive changed role content");
assert.equal(stale.counts.pending, 0, "superseded evidence is archived, not pending work");
assert.equal(stale.counts.priority_1_pending, 0, "a stale priority label cannot inflate the live queue");
assert.match(stale.items[0].stale_reason ?? "", /No current Jev decision|content changed/);

console.log("jev adjudication tests passed");
