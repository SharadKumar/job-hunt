import type { ClassificationV2 } from "../../tools/classification.ts";

export function classificationV2(extra: Partial<ClassificationV2> = {}): ClassificationV2 {
  return {
    schema_version: 2,
    source: "jev",
    status: "automatic",
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
    decisions: {
      discipline_fit: { selected: "core", probabilities: { core: 0.9, adjacent: 0.05, platform_gap: 0.04, outside: 0.01 }, confidence: 0.9, margin: 0.85 },
      matched_resume: { selected: "solution-architect", probabilities: { "solution-architect": 0.9, none: 0.1 }, confidence: 0.9, margin: 0.8 },
    },
    provenance: {
      decision_id: "test-decision", content_hash: "test-content", policy_hash: "test-policy", profile_hash: "test-profile",
      resume_set_hash: "test-resumes", requested_model: "typesafe-ai/jev", effective_model: "typesafe-ai/jev",
      gateway_route_fingerprint: "test-fingerprint", resolved_model_version: "jev-1.13.0", model_version_observable: true,
      created_at: "2026-09-19T00:00:00.000Z", latency_ms: 10,
      input_tokens: 100, output_tokens: 0, estimated_cost_usd: 0.000004, cache_hit: false, zero_data_retention: true,
    },
    ...extra,
  };
}
