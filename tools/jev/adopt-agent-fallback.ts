#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import {
  classificationContentHash,
  extractMechanicalClassification,
  type ClassificationV2,
  type DisciplineFit,
} from "../classification.ts";
import { get, patch } from "../pipeline.ts";
import { store } from "../pipeline-store.ts";
import { sha256 } from "../lib/hash.ts";
import { currentJevCacheIdentity } from "./classifier.ts";
import { currentClassificationContext } from "./classifier.ts";

export type AgentDecision = {
  discipline_fit: DisciplineFit;
  evidence_strength: 0 | 1 | 2;
  matched_resume_id: string | null;
  resume_match_explanation: string;
  profile_relevance_reason: string;
  detected_domain: string;
  seniority?: ClassificationV2["seniority"];
  work_arrangement?: ClassificationV2["work_arrangement"];
  location_flexibility?: ClassificationV2["location_flexibility"];
  location_flexibility_quote?: string;
};

const MATRIX: Record<DisciplineFit, [number, number, number]> = {
  outside: [5, 15, 25], adjacent: [30, 42, 54], platform_gap: [55, 64, 74], core: [75, 87, 100],
};

export function verifiedOperationalValue<T>(mechanical: T, verified: T | undefined, prior: T | undefined, unknown: T): T {
  return mechanical !== unknown ? mechanical : verified ?? prior ?? unknown;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const id = required(value("--id"), "--id");
  const jsonInput = required(value("--json"), "--json");
  const model = value("--model") ?? "agent-cli";
  const runningModel = process.env.HARNESS_DAILY_MODEL;
  if (runningModel && model !== runningModel) {
    throw new Error(`agent-fallback model ${model} does not match running model ${runningModel}`);
  }
  const decision = JSON.parse(jsonInput.trim().startsWith("{") ? jsonInput : await fs.readFile(jsonInput, "utf8")) as AgentDecision;
  if (!MATRIX[decision.discipline_fit] || ![0, 1, 2].includes(decision.evidence_strength)) throw new Error("invalid discipline_fit or evidence_strength");
  const row = await get(id);
  if (!row) throw new Error(`opportunity not found: ${id}`);
  const [identity, context] = await Promise.all([currentJevCacheIdentity(), currentClassificationContext()]);
  const activeResumeIds = new Set(context.resumes.map((resume) => resume.id));
  if (decision.discipline_fit === "outside" && !row.userSaved) decision.matched_resume_id = null;
  if (!decision.matched_resume_id && (decision.discipline_fit !== "outside" || row.userSaved)) {
    throw new Error(row.userSaved
      ? "matched_resume_id is required for a saved job, including an outside-discipline job; choose the closest honest packaging resume"
      : "matched_resume_id is required outside the outside band");
  }
  if (decision.matched_resume_id && !activeResumeIds.has(decision.matched_resume_id)) throw new Error(`matched_resume_id is not active: ${decision.matched_resume_id}`);
  const mechanical = extractMechanicalClassification(row.title, row.description ?? "", { location: row.location });
  const now = new Date().toISOString();
  const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
  const superseded = store().getClassificationDecision(row.id, contentHash);
  const operational = superseded ?? row.classification;
  const operationalRedFlags = operational?.red_flags.filter((flag) => flag === "inside_ir35_equivalent" || flag === "exclusive_engagement") ?? [];
  const redFlags = [...new Set([...mechanical.red_flags, ...operationalRedFlags])];
  const classification: ClassificationV2 = {
    schema_version: 2,
    source: "agent_fallback",
    status: "automatic",
    ...mechanical,
    red_flags: redFlags,
    seniority: mechanical.seniority === "unknown" ? decision.seniority ?? "unknown" : mechanical.seniority,
    work_arrangement: verifiedOperationalValue(mechanical.work_arrangement, decision.work_arrangement, operational?.work_arrangement, "unknown"),
    location_flexibility: verifiedOperationalValue(mechanical.location_flexibility, decision.location_flexibility, operational?.location_flexibility, "unknown"),
    location_flexibility_quote: mechanical.location_flexibility_quote || decision.location_flexibility_quote || operational?.location_flexibility_quote || "",
    is_contract: mechanical.is_contract || operational?.is_contract === true,
    requires_payg: mechanical.requires_payg || operational?.requires_payg === true,
    requires_exclusivity: mechanical.requires_exclusivity || operational?.requires_exclusivity === true,
    profile_relevance: MATRIX[decision.discipline_fit][decision.evidence_strength],
    profile_relevance_reason: decision.profile_relevance_reason,
    detected_domain: decision.detected_domain,
    discipline_fit: decision.discipline_fit,
    matched_resume_id: decision.matched_resume_id,
    resume_match_explanation: decision.resume_match_explanation,
    requires_tailoring: false,
    tailoring_rationale: "Baseline by default; package preparation makes any tailoring decision.",
    decisions: {
      discipline_fit: { selected: decision.discipline_fit, probabilities: null, confidence: null, margin: null },
      evidence_strength: { selected: decision.evidence_strength, probabilities: null, confidence: null, margin: null },
      matched_resume: { selected: decision.matched_resume_id ?? "none", probabilities: null, confidence: null, margin: null },
    },
    provenance: {
      decision_id: sha256(JSON.stringify({ roleId: row.id, contentHash, decision, model, identity }), 24),
      content_hash: contentHash,
      policy_hash: identity.policyHash,
      profile_hash: identity.profileHash,
      resume_set_hash: identity.resumeHash,
      requested_model: model,
      effective_model: model,
      gateway_route_fingerprint: null,
      resolved_model_version: model,
      model_version_observable: true,
      created_at: now,
      latency_ms: 0,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
      cache_hit: false,
      zero_data_retention: true,
      question_schema_hash: identity.questionSchemaHash,
      confidence_source: "agent",
      supersedes_decision_id: superseded?.source === "jev" ? superseded.provenance.decision_id : null,
    },
  };
  store().putClassificationDecision(id, classification);
  await patch(id, { classification }, "agent-fallback", "Bounded agent verification adopted through ClassificationV2");
  console.log(JSON.stringify({
    id,
    source: classification.source,
    status: classification.status,
    classification_gate_eligible: true,
    jev_authority_not_applicable: true,
    decision_id: classification.provenance.decision_id,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(JSON.stringify({ error: (error as Error).message })); process.exit(1); });
}
