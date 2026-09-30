import { promises as fs } from "node:fs";
import YAML from "yaml";
import { repoPath } from "../repo-root.ts";
import { sha256 } from "../lib/hash.ts";
import {
  classificationContentHash,
  extractMechanicalClassification,
  type ClassificationV2,
  type DecisionDistribution,
  type DisciplineFit,
} from "../classification.ts";
import { loadJevPolicy, type JevPolicy } from "./policy.ts";
import { evaluateWithJev, type JevEvaluationResult, type JevMode } from "./evaluate.ts";
import { classificationQuestions, classificationQuestionSchemaHash } from "./questions.ts";

export type JevInput = { id?: string; title: string; description: string; location?: string };
export type JevClassifyOptions = {
  evaluate?: (args: Record<string, unknown>) => Promise<JevEvaluationResult>;
  credential?: string | null;
  now?: string;
  mode?: JevMode;
  fixtureDir?: string;
  spentTodayUsd?: number;
};

const RELEVANCE: Record<DisciplineFit, [number, number, number]> = {
  outside: [5, 15, 25], adjacent: [30, 42, 54], platform_gap: [55, 64, 74], core: [75, 87, 100],
};

function distribution(answer: JevEvaluationResult["answers"][string], reportedConfidence?: number): DecisionDistribution {
  const probabilities = answer.probabilities ?? (answer.type === "boolean" && typeof answer.probability === "number"
    ? { false: 1 - answer.probability, true: answer.probability }
    : null);
  const sorted = probabilities ? Object.values(probabilities).sort((a, b) => b - a) : [];
  return {
    selected: answer.choice ?? answer.score ?? Boolean((answer.probability ?? 0) >= 0.5),
    probabilities,
    confidence: answer.type === "boolean" ? null : Number.isFinite(reportedConfidence) ? reportedConfidence! : null,
    margin: sorted.length > 1 ? sorted[0] - sorted[1] : sorted[0] ?? null,
  };
}

function compactProfile(profile: string): string {
  const targets = profile.match(/## Engagement targets[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
  const red = profile.match(/## Red flags[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
  return `${targets}\n${red}`.trim().slice(0, 5000);
}

/**
 * Keep evidence from every canonical engagement without sending contact
 * details or the entire source document. Headings, role context and a bounded
 * set of bullets give Jev delivered evidence across the career, not just the
 * professional summary.
 */
export function compactDeliveredEvidence(cv: string): string {
  const withoutHeader = cv.replace(/^([\s\S]*?)(?=^##\s+)/m, "");
  const sections = withoutHeader.split(/(?=^###\s+)/m);
  const kept = sections.map((section) => {
    const lines = section.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (!lines.length) return "";
    const heading = lines[0];
    const prose = lines.filter((line) => !line.startsWith("-") && line !== heading).slice(0, 2);
    const bullets = lines.filter((line) => line.startsWith("-")).slice(0, 6);
    return [heading, ...prose, ...bullets].join("\n");
  }).filter(Boolean);
  return kept.join("\n\n").slice(0, 24_000);
}

export type ClassificationContext = {
  profile: string;
  profileHash: string;
  resumes: { id: string; description: string }[];
  resumeHash: string;
};

let contextPromise: Promise<ClassificationContext> | null = null;

export async function currentClassificationContext(): Promise<ClassificationContext> {
  contextPromise ??= buildContext();
  return contextPromise;
}

async function buildContext(): Promise<{
  profile: string;
  profileHash: string;
  resumes: { id: string; description: string }[];
  resumeHash: string;
}> {
  const profileRaw = await fs.readFile(repoPath("state/profile/profile.md"), "utf8");
  const resumesRaw = await fs.readFile(repoPath("state/profile/resumes.yaml"), "utf8");
  const cvRaw = await fs.readFile(repoPath("state/profile/cv-source.md"), "utf8").catch(() => "");
  const taxonomyRaw = await fs.readFile(repoPath("state/profile/skills-taxonomy.yaml"), "utf8").catch(() => "");
  const deliveredEvidence = compactDeliveredEvidence(cvRaw);
  const parsed = YAML.parse(resumesRaw) as { resumes?: Record<string, unknown>[] };
  const resumes = (parsed.resumes ?? []).filter((r) => r.active === true).map((r) => ({
    id: String(r.id),
    description: [r.display_headline, r.notes, r.cover_letter_angle].filter(Boolean).join(". ").replace(/\s+/g, " ").slice(0, 900),
  }));
  const profile = [
    compactProfile(profileRaw),
    "Canonical delivered evidence:",
    deliveredEvidence,
    "Canonical skill domains:",
    taxonomyRaw.slice(0, 5000),
  ].join("\n\n");
  return { profile, profileHash: sha256(`${profileRaw}\n${cvRaw}\n${taxonomyRaw}`), resumes, resumeHash: sha256(JSON.stringify(resumes)) };
}

export async function currentJevCacheIdentity(): Promise<{
  policyHash: string;
  profileHash: string;
  resumeHash: string;
  requestedModel: string;
  expectedGatewayRouteFingerprint: string | null;
  classificationStateApplicationEnabled: boolean;
  gatewayDailySpendCapUsd: number;
  questionSchemaHash: string;
}> {
  const [{ policy, hash: policyHash }, context] = await Promise.all([loadJevPolicy(), currentClassificationContext()]);
  return {
    policyHash,
    profileHash: context.profileHash,
    resumeHash: context.resumeHash,
    requestedModel: policy.model,
    expectedGatewayRouteFingerprint: policy.expected_gateway_route_fingerprint ?? null,
    classificationStateApplicationEnabled: policy.classification_state_application_enabled,
    gatewayDailySpendCapUsd: policy.gateway_daily_spend_cap_usd,
    questionSchemaHash: classificationQuestionSchemaHash(context.resumes),
  };
}

function confidencePass(decisions: Record<string, DecisionDistribution>, policy: JevPolicy): boolean {
  const discipline = decisions.discipline_fit;
  const resume = decisions.matched_resume;
  const disciplinePass = (discipline.confidence ?? 0) >= policy.thresholds.discipline_confidence
    && (discipline.margin ?? 0) >= policy.thresholds.discipline_margin;
  // A confident outside decision has no resume to select. Requiring confidence
  // in the deliberately irrelevant resume question would turn a safe low-fit
  // decision into unnecessary agent work.
  const headlinePass = discipline.selected === "outside" ? disciplinePass : disciplinePass
    && (resume.confidence ?? 0) >= policy.thresholds.resume_confidence
    && (resume.margin ?? 0) >= policy.thresholds.resume_margin;
  if (!headlinePass) return false;
  return Object.entries(decisions)
    .filter(([id]) => id !== "discipline_fit" && id !== "matched_resume")
    .every(([, decision]) => (decision.margin ?? 0) >= policy.thresholds.operational_margin);
}

export async function classifyWithJev(input: JevInput, opts: JevClassifyOptions = {}): Promise<ClassificationV2> {
  const started = Date.now();
  const now = opts.now ?? new Date().toISOString();
  const { policy, hash: policyHash } = await loadJevPolicy();
  const context = await currentClassificationContext();
  const mechanical = extractMechanicalClassification(input.title, input.description, { location: input.location });
  const questionSet = classificationQuestions(context.resumes, mechanical);
  const questionSchemaHash = classificationQuestionSchemaHash(context.resumes);
  const contentHash = classificationContentHash(input);
  // Include the pipeline id so two channel rows with identical copied job text
  // cannot collide in the decision table's primary key.
  const requestIdentity = {
    roleId: input.id ?? null, contentHash, policyHash, profileHash: context.profileHash,
    resumeHash: context.resumeHash, questionSchemaHash,
  };
  const degraded = (reason: string, status: ClassificationV2["status"] = "degraded"): ClassificationV2 => ({
    schema_version: 2, source: "deterministic_only", status, ...mechanical,
    profile_relevance: 0, profile_relevance_reason: reason, detected_domain: "unclassified",
    discipline_fit: "outside", matched_resume_id: null, resume_match_explanation: reason,
    requires_tailoring: false, tailoring_rationale: "No semantic classification is available.", decisions: {},
    provenance: {
      decision_id: sha256(JSON.stringify({ ...requestIdentity, outcome: { status, reason } }), 24), content_hash: contentHash, policy_hash: policyHash, profile_hash: context.profileHash,
      resume_set_hash: context.resumeHash, requested_model: policy.model, effective_model: null,
      gateway_route_fingerprint: null, resolved_model_version: null, model_version_observable: false,
      created_at: now, latency_ms: Date.now() - started, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, cache_hit: false, zero_data_retention: true,
      question_set_hash: null, question_schema_hash: questionSchemaHash, question_ids: [], confidence_source: null,
      recorded_response_cost_usd: null, evaluation_mode: opts.mode ?? "live",
    },
  });
  if (input.description.trim().length < 80 && input.title.trim().length < 8) return degraded("Insufficient title and job-description evidence.", "insufficient_input");
  const evaluation = await evaluateWithJev({
    callSite: "classification", roleId: input.id ?? null,
    state: {
      job: { title: input.title, description: input.description, location: input.location ?? "" },
      candidate_profile: context.profile,
    },
    questions: questionSet, credential: opts.credential, evaluate: opts.evaluate,
    mode: opts.mode, fixtureDir: opts.fixtureDir, spentTodayUsd: opts.spentTodayUsd,
  });
  if (evaluation.status === "degraded") return degraded(evaluation.reason);
  const result = evaluation.result;
  const requiredAnswers = Object.keys(questionSet);
  const missingAnswers = requiredAnswers.filter((id) => !result.answers[id]);
  if (missingAnswers.length) {
    const reason = `Jev returned an incomplete classification answer set: ${missingAnswers.join(", ")}`;
    return degraded(reason);
  }
  const providerConfidence = ((result.providerMetadata?.typesafe as { confidence?: Record<string, number> } | undefined)?.confidence) ?? {};
  const decisions = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, distribution(answer, providerConfidence[id])]));
  const discipline = String(decisions.discipline_fit.selected) as DisciplineFit;
  const evidence = Math.max(0, Math.min(2, Math.round(Number(decisions.evidence_strength.selected))));
  const matched = String(decisions.matched_resume.selected);
  const routeFingerprint = evaluation.gateway_route_fingerprint;
  const identityMatches = evaluation.route_fingerprint_matches;
  const automatic = identityMatches && confidencePass(decisions, policy);
  const selectedArrangement = String(decisions.work_arrangement?.selected ?? mechanical.work_arrangement) as ClassificationV2["work_arrangement"];
  const selectedFlex = String(decisions.location_flexibility?.selected ?? mechanical.location_flexibility) as ClassificationV2["location_flexibility"];
  const selectedSeniority = String(decisions.seniority?.selected ?? mechanical.seniority) as ClassificationV2["seniority"];
  const validDiscipline = Object.hasOwn(RELEVANCE, discipline);
  const validResume = matched === "none" || context.resumes.some((resume) => resume.id === matched);
  const validArrangement = ["remote", "hybrid", "onsite", "unknown"].includes(selectedArrangement);
  const validFlexibility = ["remote", "flexible", "onsite", "unknown"].includes(selectedFlex);
  const validSeniority = ["junior", "mid", "senior", "lead", "principal", "director", "unknown"].includes(selectedSeniority);
  if (!validDiscipline || !validResume || !validArrangement || !validFlexibility || !validSeniority) {
    const reason = "Jev returned an out-of-contract classification value";
    return degraded(reason);
  }
  const isContract = Boolean(decisions.is_contract?.selected ?? false);
  const requiresPayg = Boolean(decisions.requires_payg?.selected ?? false);
  const requiresExclusivity = Boolean(decisions.requires_exclusivity?.selected ?? false);
  const redFlags = [...mechanical.red_flags];
  if (requiresPayg && !redFlags.includes("inside_ir35_equivalent")) redFlags.push("inside_ir35_equivalent");
  if (requiresExclusivity && !redFlags.includes("exclusive_engagement")) redFlags.push("exclusive_engagement");
  const decisionId = sha256(JSON.stringify({
    ...requestIdentity,
    outcome: { answers: result.answers, effectiveModel: result.response.modelId, routeFingerprint },
  }), 24);
  const inputTokens = result.usage.inputTokens ?? null;
  return {
    schema_version: 2,
    source: "jev",
    status: automatic ? "automatic" : "uncertain",
    ...mechanical,
    red_flags: redFlags,
    work_arrangement: mechanical.work_arrangement === "unknown" ? selectedArrangement : mechanical.work_arrangement,
    seniority: mechanical.seniority === "unknown" ? selectedSeniority : mechanical.seniority,
    is_contract: mechanical.is_contract || isContract,
    requires_payg: mechanical.requires_payg || requiresPayg,
    requires_exclusivity: mechanical.requires_exclusivity || requiresExclusivity,
    location_flexibility: mechanical.location_flexibility === "unknown" ? selectedFlex : mechanical.location_flexibility,
    profile_relevance: RELEVANCE[discipline][evidence],
    profile_relevance_reason: `${discipline} discipline with evidence level ${evidence + 1} of 3`,
    detected_domain: input.title.replace(/\s+/g, " ").trim().slice(0, 80),
    discipline_fit: discipline,
    matched_resume_id: matched === "none" || discipline === "outside" ? null : matched,
    resume_match_explanation: matched === "none" ? "No active positioning is credible." : `Jev selected ${matched} for the primary discipline.`,
    requires_tailoring: false,
    tailoring_rationale: "Baseline by default; tailoring remains an agent decision during package preparation.",
    decisions,
    provenance: {
      decision_id: decisionId, content_hash: contentHash, policy_hash: policyHash, profile_hash: context.profileHash,
      resume_set_hash: context.resumeHash, requested_model: policy.model, effective_model: result.response.modelId,
      gateway_route_fingerprint: routeFingerprint, resolved_model_version: evaluation.resolved_model_version,
      model_version_observable: evaluation.model_version_observable, created_at: now, latency_ms: evaluation.latency_ms,
      input_tokens: inputTokens, output_tokens: result.usage.outputTokens ?? null,
      estimated_cost_usd: evaluation.estimated_cost_usd,
      cache_hit: false, zero_data_retention: true,
      question_set_hash: evaluation.question_set_hash, question_schema_hash: questionSchemaHash,
      question_ids: evaluation.question_ids, confidence_source: "typesafe_provider_metadata",
      recorded_response_cost_usd: evaluation.response_cost_usd, evaluation_mode: evaluation.mode,
    },
  };
}
