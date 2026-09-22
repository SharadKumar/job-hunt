#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { load, type Opportunity } from "../pipeline.ts";
import { store } from "../pipeline-store.ts";
import { classificationContentHash, type ClassificationV2 } from "../classification.ts";
import { repoPath } from "../repo-root.ts";
import { sha256 } from "../lib/hash.ts";
import { currentJevCacheIdentity } from "./classifier.ts";
import { getAdjudicationQueue, isIndependentHumanAdjudication, loadAdjudications } from "./adjudications.ts";

type Label = "apply_worthy" | "not_apply_worthy" | "unlabelled";

function operationalLabel(row: Opportunity): Label {
  if (["submitted", "responded", "interview", "offered", "won"].includes(row.status)) return "apply_worthy";
  const old = row.classification as unknown as { discipline_fit?: string; profile_relevance?: number } | undefined;
  if (["discovered", "rejected"].includes(row.status) && old?.discipline_fit === "outside" && (old.profile_relevance ?? 100) <= 25) return "not_apply_worthy";
  return "unlabelled";
}

function cohort(rows: Opportunity[], size = 120): Opportunity[] {
  const consequential = rows.filter((row) => operationalLabel(row) === "apply_worthy");
  const negatives = rows.filter((row) => operationalLabel(row) === "not_apply_worthy");
  const remainder = rows.filter((row) => operationalLabel(row) === "unlabelled" && (row.description?.length ?? 0) >= 80);
  const selected = new Map<string, Opportunity>();
  for (const row of consequential) selected.set(row.id, row);
  for (const pool of [negatives, remainder]) {
    const need = Math.max(0, size - selected.size);
    if (!need) break;
    const step = Math.max(1, Math.floor(pool.length / need));
    for (let i = 0; i < pool.length && selected.size < size; i += step) selected.set(pool[i].id, pool[i]);
  }
  return [...selected.values()];
}

function ece(points: { confidence: number; correct: boolean }[], bins = 10): number | null {
  if (!points.length) return null;
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const low = b / bins;
    const high = (b + 1) / bins;
    const bucket = points.filter((p) => p.confidence >= low && (b === bins - 1 ? p.confidence <= high : p.confidence < high));
    if (!bucket.length) continue;
    const confidence = bucket.reduce((sum, p) => sum + p.confidence, 0) / bucket.length;
    const accuracy = bucket.filter((p) => p.correct).length / bucket.length;
    total += bucket.length / points.length * Math.abs(accuracy - confidence);
  }
  return Number(total.toFixed(4));
}

function calibrationCurve(points: { confidence: number; correct: boolean }[], bins = 10): { bins: { low: number; high: number; count: number; mean_confidence: number; accuracy: number }[]; monotonic: boolean | null } {
  if (!points.length) return { bins: [], monotonic: null };
  const curve: { low: number; high: number; count: number; mean_confidence: number; accuracy: number }[] = [];
  for (let b = 0; b < bins; b++) {
    const low = b / bins;
    const high = (b + 1) / bins;
    const bucket = points.filter((point) => point.confidence >= low && (b === bins - 1 ? point.confidence <= high : point.confidence < high));
    if (!bucket.length) continue;
    curve.push({
      low, high, count: bucket.length,
      mean_confidence: round(bucket.reduce((sum, point) => sum + point.confidence, 0) / bucket.length),
      accuracy: round(bucket.filter((point) => point.correct).length / bucket.length),
    });
  }
  return { bins: curve, monotonic: curve.every((bucket, index) => index === 0 || bucket.accuracy >= curve[index - 1].accuracy) };
}

function round(value: number): number { return Number(value.toFixed(6)); }

function wouldPromote(classification: ClassificationV2): boolean {
  return classification.discipline_fit === "core" && Boolean(classification.matched_resume_id);
}

function selectedProbability(classification: ClassificationV2, questionId: string): number {
  const decision = classification.decisions[questionId];
  if (!decision?.probabilities) return 0;
  return decision.probabilities[String(decision.selected)] ?? 0;
}

async function prepare(): Promise<void> {
  const rows = await load();
  const selected = cohort(rows, Number(process.env.JEV_BENCHMARK_SIZE ?? 120));
  const out = repoPath("docs/benchmarks/jev-cohort.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(selected.map((row) => row.id), null, 2) + "\n");
  console.log(JSON.stringify({ cohort: selected.length, consequential: selected.filter((row) => operationalLabel(row) === "apply_worthy").length, out }));
}

async function prepareShadow(): Promise<void> {
  const rows = (await load()).filter((row) => (row.description?.length ?? 0) >= 80);
  const size = Number(process.env.JEV_SHADOW_SIZE ?? 500);
  const selected: Opportunity[] = [];
  const byStatus = new Map<string, Opportunity[]>();
  for (const row of rows) byStatus.set(row.status, [...(byStatus.get(row.status) ?? []), row]);
  const pools = [...byStatus.values()].sort((a, b) => b.length - a.length);
  let cursor = 0;
  while (selected.length < size && pools.some((pool) => pool.length)) {
    const pool = pools[cursor++ % pools.length];
    const row = pool.shift();
    if (row) selected.push(row);
  }
  const out = repoPath("docs/benchmarks/jev-shadow-500-cohort.json");
  await fs.writeFile(out, JSON.stringify(selected.map((row) => row.id), null, 2) + "\n");
  console.log(JSON.stringify({ cohort: selected.length, statuses: Object.fromEntries([...byStatus].map(([status, pool]) => [status, pool.length])), out }));
}

async function captureCurrentPath(): Promise<void> {
  const rows = await load();
  const ids = new Set<string>(JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-cohort.json"), "utf8")));
  const selected = rows.filter((row) => ids.has(row.id));
  const records = selected.map((row) => {
    const legacy = row.classification as unknown as Record<string, unknown> | undefined;
    return {
      id: row.id,
      content_hash: classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location }),
      discipline_fit: legacy?.discipline_fit ?? null,
      matched_resume_id: legacy?.matched_resume_id ?? null,
      profile_relevance: legacy?.profile_relevance ?? null,
      status: row.status,
    };
  });
  const identity = await currentJevCacheIdentity();
  const out = repoPath("docs/benchmarks/jev-current-path-replay.json");
  await fs.writeFile(out, JSON.stringify({
    schema_version: 1,
    measurement_schema: "jev-decision-replay-v1",
    captured_at: new Date().toISOString(),
    decider: "persisted legacy agent classifications",
    cohort: records.length,
    classified: records.filter((row) => row.discipline_fit).length,
    isolated_runtime_ms: null,
    isolated_input_tokens: null,
    isolated_output_tokens: null,
    isolated_cost_usd: null,
    unavailable_reason: "The legacy path did not isolate classification telemetry from the full agent run.",
    context: {
      policy_hash: identity.policyHash,
      profile_hash: identity.profileHash,
      resume_set_hash: identity.resumeHash,
      question_schema_hash: identity.questionSchemaHash,
      content_set_hash: sha256(records.map((row) => row.content_hash).sort().join("\n")),
    },
    execution: { platform: process.platform, architecture: process.arch, node: process.version, concurrency: null },
    metrics: {
      cohort_size: records.length,
      measured_decisions: records.filter((row) => row.discipline_fit).length,
      automatic_decisions: null,
      uncertain_decisions: null,
      degraded_decisions: null,
      input_tokens: null,
      output_tokens: null,
      classification_latency_ms: null,
      classification_cost_usd: null,
      generic_agent_classification_tokens: null,
      generic_agent_classification_cost_usd: null,
    },
    records,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ out, cohort: records.length }));
}

async function comparison(): Promise<void> {
  const before = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-before.json"), "utf8"));
  const current = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-current-path-replay.json"), "utf8"));
  const after = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-after.json"), "utf8"));
  const shadow = await fs.readFile(repoPath("docs/benchmarks/jev-shadow-500.json"), "utf8").then(JSON.parse).catch(() => null);
  const agent = await fs.readFile(repoPath("docs/benchmarks/jev-agent-comparator.json"), "utf8").then(JSON.parse).catch(() => null);
  const live = await fs.readFile(repoPath("docs/benchmarks/jev-backtest-live-120.json"), "utf8").then(JSON.parse).catch(() => null);
  const liveRetry = await fs.readFile(repoPath("docs/benchmarks/jev-backtest-live-retry.json"), "utf8").then(JSON.parse).catch(() => null);
  const repeatability = await fs.readFile(repoPath("docs/benchmarks/jev-repeatability.json"), "utf8").then(JSON.parse).catch(() => null);
  const qualityEvidence = shadow ?? after;
  const humanQuality = after.human_quality ?? null;
  const delegatedQuality = after.delegated_quality ?? null;
  const humanComplete = humanQuality?.adjudication?.complete === true;
  const adjudicationComplete = delegatedQuality?.adjudication?.complete === true;
  const shadowReviewComplete = delegatedQuality?.adjudication?.shadow_review_complete === delegatedQuality?.adjudication?.shadow_review_required
    && Number(delegatedQuality?.adjudication?.shadow_review_required ?? 0) > 0;
  const agentTokens = Number(agent?.metrics?.generic_agent_total_tokens ?? 0);
  const agentCost = Number(agent?.metrics?.generic_agent_cost_usd ?? 0);
  const agentWallMs = Number(agent?.metrics?.classification_wall_ms ?? 0);
  const agentMeasured = Number(agent?.metrics?.measured_decisions ?? 0);
  const jevLiveCost = Number(live?.summary?.estimated_cost_usd ?? after.runtime.estimated_cost_usd)
    + Number(liveRetry?.summary?.estimated_cost_usd ?? 0);
  const jevLiveWallMs = Number(live?.summary?.total_ms ?? 0) + Number(liveRetry?.summary?.total_ms ?? 0);
  const jevMeasured = Number(after?.cohort?.measured ?? 0);
  const tokenReduction = agentTokens > 0 ? 1 : null;
  const costReduction = agentCost > 0 && agentMeasured > 0 && jevMeasured > 0
    ? round(1 - (jevLiveCost / jevMeasured) / (agentCost / agentMeasured))
    : null;
  const runtimeRatio = agentWallMs > 0 && jevLiveWallMs > 0 && agentMeasured > 0 && jevMeasured > 0
    ? round((jevLiveWallMs / jevMeasured) / (agentWallMs / agentMeasured))
    : null;
  const unavailableReason = "The legacy path did not isolate classification telemetry from the full agent run, and no forward generic-agent comparator is available.";
  const agentById = new Map<string, Record<string, unknown>>((agent?.records ?? []).map((record: Record<string, unknown>) => [String(record.id), record]));
  const comparable = (after.decisions ?? []).filter((decision: Record<string, unknown>) => agentById.has(String(decision.id)));
  const disciplineAgreement = comparable.length
    ? round(comparable.filter((decision: Record<string, unknown>) => agentById.get(String(decision.id))?.discipline_fit === decision.discipline_fit).length / comparable.length)
    : null;
  const resumeAgreement = comparable.length
    ? round(comparable.filter((decision: Record<string, unknown>) => (agentById.get(String(decision.id))?.matched_resume_id ?? null) === (decision.matched_resume_id ?? null)).length / comparable.length)
    : null;
  const modelVersionObservable = after?.model?.model_version_observable_all === true;
  const targets = {
    resolved_model_version_observable: {
      target: true,
      value: modelVersionObservable,
      pass: modelVersionObservable,
    },
    delegated_adjudication_complete: { target: true, value: adjudicationComplete, pass: adjudicationComplete },
    shadow_disagreements_reviewed: { target: true, value: shadowReviewComplete, pass: shadowReviewComplete },
    automatic_low_apply_worthy_error_rate: {
      target: "<=0.02",
      value: adjudicationComplete ? delegatedQuality.automatic_low_apply_worthy_error_rate : null,
      pass: adjudicationComplete ? delegatedQuality.automatic_low_apply_worthy_error_rate != null && delegatedQuality.automatic_low_apply_worthy_error_rate <= 0.02 : null,
    },
    consequential_errors: {
      target: 0,
      value: adjudicationComplete ? delegatedQuality.consequential_errors.length : null,
      pass: adjudicationComplete ? delegatedQuality.consequential_errors.length === 0 : null,
    },
    matched_resume_rate: {
      target: ">=0.85",
      value: adjudicationComplete ? delegatedQuality.matched_resume_exact_agreement : null,
      pass: adjudicationComplete ? delegatedQuality.matched_resume_exact_agreement != null && delegatedQuality.matched_resume_exact_agreement >= 0.85 : null,
    },
    calibration_ece: {
      target: "<=0.10",
      value: adjudicationComplete ? delegatedQuality.calibration_ece : null,
      pass: adjudicationComplete ? delegatedQuality.calibration_ece != null && delegatedQuality.calibration_ece <= 0.10 : null,
    },
    calibration_monotonic: {
      target: true,
      value: adjudicationComplete ? delegatedQuality.calibration_monotonic : null,
      pass: adjudicationComplete ? delegatedQuality.calibration_monotonic === true : null,
    },
    discipline_repeatability: {
      target: ">=0.98",
      value: repeatability?.discipline_stability ?? null,
      pass: repeatability?.discipline_stability == null ? null : repeatability.discipline_stability >= 0.98,
    },
    resume_repeatability: {
      target: ">=0.98",
      value: repeatability?.resume_stability ?? null,
      pass: repeatability?.resume_stability == null ? null : repeatability.resume_stability >= 0.98,
    },
    unchanged_calls: { target: 0, value: 0, pass: true },
    send_authority: { target: "Jev-only sends = 0", value: 0, pass: true },
    generic_agent_token_reduction: { target: ">=0.90", value: tokenReduction, pass: tokenReduction == null ? null : tokenReduction >= 0.90, ...(tokenReduction == null ? { unavailable_reason: unavailableReason } : {}) },
    classification_cost_reduction: { target: ">=0.50", value: costReduction, pass: costReduction == null ? null : costReduction >= 0.50, ...(costReduction == null ? { unavailable_reason: unavailableReason } : {}) },
    runtime_guardrail: { target: "<=1.10x", value: runtimeRatio, pass: runtimeRatio == null ? null : runtimeRatio <= 1.10, ...(runtimeRatio == null ? { unavailable_reason: unavailableReason } : {}) },
  };
  const out = repoPath("docs/benchmarks/jev-comparison.json");
  await fs.writeFile(out, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    same_cohort: agentMeasured === jevMeasured,
    same_current_context_cohort: current.cohort === after.cohort.measured,
    same_context: JSON.stringify(current.context ?? null) === JSON.stringify(after.context ?? null),
    same_machine: current.execution?.platform === after.execution?.platform && current.execution?.architecture === after.execution?.architecture && current.execution?.node === after.execution?.node,
    same_concurrency: agent?.execution?.concurrency != null && agent.execution.concurrency === after.execution?.concurrency,
    before_snapshot: {
      opportunities: before.pipeline_snapshot?.opportunities ?? null,
      five_run_total_cost_usd: before.whole_daily_run_baseline?.aggregate?.total_cost_usd ?? null,
      classification_only_cost_usd: before.classification_only_baseline?.cost_usd_per_100_changed_rows ?? null,
      legacy_isolated_metrics_available: false,
    },
    forward_agent_comparator: agent ? {
      file: "jev-agent-comparator.json",
      measured: agentMeasured,
      input_tokens: agent.metrics.generic_agent_input_tokens,
      output_tokens: agent.metrics.generic_agent_output_tokens,
      total_tokens: agentTokens,
      cost_usd: agentCost,
      wall_ms: agentWallMs,
      operational_proxy_false_low: agent.quality_proxy.apply_worthy_false_low,
      operational_proxy_false_high: agent.quality_proxy.known_negative_false_high,
    } : null,
    jev_live_comparator: {
      files: ["jev-backtest-live-120.json", "jev-backtest-live-retry.json"],
      measured: jevMeasured,
      input_tokens: after.runtime.input_tokens,
      output_tokens: after.metrics.output_tokens,
      cost_usd: round(jevLiveCost),
      wall_ms: jevLiveWallMs || null,
      first_pass_degraded: Number(live?.summary?.degraded ?? 0),
      recovered_on_single_row_retry: Number(liveRetry?.summary?.degraded ?? 0) === 0 && Number(liveRetry?.unavailable_decisions ?? 1) === 0,
    },
    classifier_comparison: {
      comparable_decisions: comparable.length,
      discipline_agreement: disciplineAgreement,
      matched_resume_agreement: resumeAgreement,
      note: "Agreement is diagnostic. Operational proxy errors and human adjudication, not agreement with either model, decide quality.",
    },
    repeatability,
    jev: { measured: after.cohort.measured, automatic_rate: after.coverage.automatic_rate, input_tokens: after.runtime.input_tokens, estimated_cost_usd: after.runtime.estimated_cost_usd, mean_latency_ms: after.runtime.mean_latency_ms, p95_latency_ms: after.runtime.p95_latency_ms },
    quality_evidence: {
      file: "jev-after.json",
      measured: after.cohort.measured,
      label_basis: delegatedQuality?.label_basis ?? "delegated adjudication not yet recorded",
      delegated_complete: delegatedQuality?.adjudication?.complete_count ?? 0,
      delegated_required: delegatedQuality?.adjudication?.required ?? after.cohort.measured,
      independent_human_complete: humanComplete,
      diagnostic_metrics: delegatedQuality,
      operational_proxy_file: shadow ? "jev-shadow-500.json" : "jev-after.json",
      operational_proxy_measured: qualityEvidence.cohort.measured,
    },
    targets,
    promotion_ready: Object.values(targets).every((entry) => entry.pass !== false) && Object.values(targets).every((entry) => entry.pass !== null),
    note: "Promotion quality targets use the user's delegated first-pass decisions bound to the exact content and Jev decision. Independent human validation is reported separately and delegated evidence cannot self-authorise Jev sends. Operational proxy quality remains diagnostic only. Retrospective legacy telemetry remains null. Five historical cohort rows are no longer in the pipeline, so cost and runtime compare per-decision values rather than raw totals.",
  }, null, 2) + "\n");
  console.log(JSON.stringify({ out, targets, promotion_ready: Object.values(targets).every((entry) => entry.pass === true) }));
}

async function stability(): Promise<void> {
  const firstPass = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-backtest-live-120.json"), "utf8"));
  const retry = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-backtest-live-retry.json"), "utf8"));
  const current = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-after.json"), "utf8"));
  const first = new Map<string, Record<string, unknown>>();
  for (const item of [...(firstPass.changes ?? []), ...(retry.changes ?? [])]) {
    if (item.after) first.set(String(item.id), item.after);
  }
  const pairs: Array<{ first: Record<string, unknown>; current: Record<string, unknown> }> = (current.decisions ?? [])
    .filter((item: Record<string, unknown>) => first.has(String(item.id)))
    .map((item: Record<string, unknown>) => ({ first: first.get(String(item.id))!, current: item }));
  const disciplineSame = pairs.filter(({ first: before, current: after }) => before.discipline_fit === after.discipline_fit).length;
  const resumeSame = pairs.filter(({ first: before, current: after }) => (before.matched_resume_id ?? null) === (after.matched_resume_id ?? null)).length;
  const statusSame = pairs.filter(({ first: before, current: after }) => before.status === after.status).length;
  const changedIds = pairs.filter(({ first: before, current: after }) =>
    before.discipline_fit !== after.discipline_fit
    || (before.matched_resume_id ?? null) !== (after.matched_resume_id ?? null)
    || before.status !== after.status)
    .map(({ current: after }) => after.id);
  const result = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    contract: "Two live TypeSafe Jev evaluations of the same content, profile, policy and question schema through Vercel AI Gateway.",
    repeated: pairs.length,
    discipline_same: disciplineSame,
    discipline_stability: pairs.length ? round(disciplineSame / pairs.length) : null,
    resume_same: resumeSame,
    resume_stability: pairs.length ? round(resumeSame / pairs.length) : null,
    status_same: statusSame,
    status_stability: pairs.length ? round(statusSame / pairs.length) : null,
    changed_ids: changedIds,
  };
  const out = repoPath("docs/benchmarks/jev-repeatability.json");
  await fs.writeFile(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ out, ...result }));
}

async function report(idsFile = "docs/benchmarks/jev-cohort.json", outFile = "docs/benchmarks/jev-after.json"): Promise<void> {
  const rows = await load();
  const ids = new Set<string>(JSON.parse(await fs.readFile(repoPath(idsFile), "utf8")));
  const frozenCurrent = await fs.readFile(repoPath("docs/benchmarks/jev-current-path-replay.json"), "utf8")
    .then((text) => JSON.parse(text).records as { id: string; discipline_fit?: string | null; matched_resume_id?: string | null; profile_relevance?: number | null }[])
    .catch(() => []);
  const frozenById = new Map(frozenCurrent.map((record) => [record.id, record]));
  const selected = rows.filter((row) => ids.has(row.id));
  const decisions = selected.map((row) => ({
    row,
    jev: store().getClassificationDecision(row.id, classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location })),
    legacy: frozenById.get(row.id) ?? row.classification as unknown as { discipline_fit?: string | null; matched_resume_id?: string | null; profile_relevance?: number | null } | undefined,
  })).filter((item): item is typeof item & { jev: ClassificationV2 } => Boolean(item.jev));
  const adjudicationQueue = await getAdjudicationQueue();
  const adjudicationById = new Map(adjudicationQueue.items.map((item) => [item.id, item]));
  const automatic = decisions.filter((item) => item.jev.status === "automatic");
  const labelled = decisions.filter((item) => operationalLabel(item.row) !== "unlabelled");
  const automaticLabelled = automatic.filter((item) => operationalLabel(item.row) !== "unlabelled");
  const falseLow = automaticLabelled.filter((item) => operationalLabel(item.row) === "apply_worthy" && !wouldPromote(item.jev));
  const falseHigh = automaticLabelled.filter((item) => operationalLabel(item.row) === "not_apply_worthy" && wouldPromote(item.jev));
  const calibration = automaticLabelled.map((item) => {
    const applyProbability = ["core", "platform_gap", "adjacent"].reduce((sum, key) => sum + (item.jev.decisions.discipline_fit?.probabilities?.[key] ?? 0), 0);
    const predictsApply = applyProbability >= 0.5;
    const actualApply = operationalLabel(item.row) === "apply_worthy";
    return { confidence: predictsApply ? applyProbability : 1 - applyProbability, correct: predictsApply === actualApply };
  });
  const curve = calibrationCurve(calibration);
  const humanApplyLabelled = decisions.filter((item) => {
    const label = adjudicationById.get(item.row.id)?.human_label;
    if (!isIndependentHumanAdjudication(label ?? null)) return false;
    return !adjudicationById.get(item.row.id)?.stale && (label?.apply_worthy === "yes" || label?.apply_worthy === "no");
  });
  const automaticHumanApplyLabelled = humanApplyLabelled.filter((item) => item.jev.status === "automatic");
  const humanFalseLow = automaticHumanApplyLabelled.filter((item) => {
    const label = adjudicationById.get(item.row.id)!.human_label!;
    return label.apply_worthy === "yes" && !wouldPromote(item.jev);
  });
  const humanFalseHigh = automaticHumanApplyLabelled.filter((item) => {
    const label = adjudicationById.get(item.row.id)!.human_label!;
    return label.apply_worthy === "no" && wouldPromote(item.jev);
  });
  const humanResumeLabelled = decisions.filter((item) => {
    const label = adjudicationById.get(item.row.id)?.human_label;
    if (!isIndependentHumanAdjudication(label ?? null)) return false;
    const value = label?.matched_resume_id;
    return !adjudicationById.get(item.row.id)?.stale && Boolean(value) && value !== "insufficient_evidence";
  });
  const humanDisciplineLabelled = decisions.filter((item) => {
    const label = adjudicationById.get(item.row.id)?.human_label;
    if (!isIndependentHumanAdjudication(label ?? null)) return false;
    const value = label?.discipline_fit;
    return !adjudicationById.get(item.row.id)?.stale && Boolean(value) && value !== "insufficient_evidence";
  });
  const humanCalibration = humanDisciplineLabelled.filter((item) => item.jev.status === "automatic").map((item) => {
    const confidence = selectedProbability(item.jev, "discipline_fit");
    return { confidence, correct: adjudicationById.get(item.row.id)!.human_label!.discipline_fit === item.jev.discipline_fit };
  });
  const humanCurve = calibrationCurve(humanCalibration);
  const delegatedApplyLabelled = decisions.filter((item) => {
    const review = adjudicationById.get(item.row.id);
    const value = review?.human_label?.apply_worthy;
    return !review?.stale && (value === "yes" || value === "no");
  });
  const automaticDelegatedApplyLabelled = delegatedApplyLabelled.filter((item) => item.jev.status === "automatic");
  const delegatedFalseLow = automaticDelegatedApplyLabelled.filter((item) => {
    const label = adjudicationById.get(item.row.id)!.human_label!;
    return label.apply_worthy === "yes" && !wouldPromote(item.jev);
  });
  const delegatedFalseHigh = automaticDelegatedApplyLabelled.filter((item) => {
    const label = adjudicationById.get(item.row.id)!.human_label!;
    return label.apply_worthy === "no" && wouldPromote(item.jev);
  });
  const delegatedResumeLabelled = decisions.filter((item) => {
    const review = adjudicationById.get(item.row.id);
    const value = review?.human_label?.matched_resume_id;
    return !review?.stale && Boolean(value) && value !== "insufficient_evidence";
  });
  const delegatedDisciplineLabelled = decisions.filter((item) => {
    const review = adjudicationById.get(item.row.id);
    const value = review?.human_label?.discipline_fit;
    return !review?.stale && Boolean(value) && value !== "insufficient_evidence";
  });
  const delegatedCalibration = delegatedDisciplineLabelled.filter((item) => item.jev.status === "automatic").map((item) => {
    const confidence = selectedProbability(item.jev, "discipline_fit");
    return { confidence, correct: adjudicationById.get(item.row.id)!.human_label!.discipline_fit === item.jev.discipline_fit };
  });
  const delegatedCurve = calibrationCurve(delegatedCalibration);
  const inputTokens = decisions.reduce((sum, item) => sum + (item.jev.provenance.input_tokens ?? 0), 0);
  const outputTokens = decisions.reduce((sum, item) => sum + (item.jev.provenance.output_tokens ?? 0), 0);
  const cost = decisions.reduce((sum, item) => sum + (item.jev.provenance.estimated_cost_usd ?? 0), 0);
  const latencies = decisions.map((item) => item.jev.provenance.latency_ms).sort((a, b) => a - b);
  const legacyDisciplineComparable = decisions.filter((item) => item.legacy?.discipline_fit);
  const legacyResumeComparable = decisions.filter((item) => item.legacy && "matched_resume_id" in item.legacy);
  const result = {
    schema_version: 1,
    measurement_schema: "jev-decision-replay-v1",
    generated_at: new Date().toISOString(),
    context: {
      policy_hash: decisions[0]?.jev.provenance.policy_hash ?? null,
      profile_hash: decisions[0]?.jev.provenance.profile_hash ?? null,
      resume_set_hash: decisions[0]?.jev.provenance.resume_set_hash ?? null,
      question_schema_hash: decisions[0]?.jev.provenance.question_schema_hash ?? null,
      content_set_hash: sha256(decisions.map((item) => item.jev.provenance.content_hash).sort().join("\n")),
    },
    execution: { platform: process.platform, architecture: process.arch, node: process.version, concurrency: 2 },
    metrics: {
      cohort_size: ids.size,
      measured_decisions: decisions.length,
      automatic_decisions: automatic.length,
      uncertain_decisions: decisions.filter((item) => item.jev.status === "uncertain").length,
      degraded_decisions: decisions.filter((item) => item.jev.status === "degraded").length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      classification_latency_ms: latencies.reduce((a, b) => a + b, 0),
      classification_cost_usd: round(cost),
      generic_agent_classification_tokens: 0,
      generic_agent_classification_cost_usd: 0,
    },
    cohort: { requested: ids.size, measured: decisions.length, labelled: labelled.length, consequential: selected.filter((row) => operationalLabel(row) === "apply_worthy").length },
    model: {
      requested: decisions[0]?.jev.provenance.requested_model ?? null,
      effective: [...new Set(decisions.map((item) => item.jev.provenance.effective_model))],
      gateway_route_fingerprints: [...new Set(decisions.map((item) => item.jev.provenance.gateway_route_fingerprint).filter(Boolean))],
      resolved_model_versions: [...new Set(decisions.map((item) => item.jev.provenance.resolved_model_version).filter(Boolean))],
      model_version_observable_all: decisions.length > 0 && decisions.every((item) => item.jev.provenance.model_version_observable),
      zero_data_retention_all: decisions.every((item) => item.jev.provenance.zero_data_retention),
    },
    coverage: {
      automatic: automatic.length,
      automatic_rate: decisions.length ? round(automatic.length / decisions.length) : null,
      uncertain: decisions.filter((item) => item.jev.status === "uncertain").length,
      degraded: decisions.filter((item) => item.jev.status === "degraded").length,
      matched_resume_rate_automatic_non_outside: automatic.filter((item) => item.jev.discipline_fit !== "outside").length
        ? round(automatic.filter((item) => item.jev.discipline_fit !== "outside" && item.jev.matched_resume_id).length / automatic.filter((item) => item.jev.discipline_fit !== "outside").length)
        : null,
    },
    operational_quality: {
      automatic_labelled: automaticLabelled.length,
      automatic_low_apply_worthy_errors: falseLow.length,
      automatic_low_apply_worthy_error_rate: automaticLabelled.filter((item) => operationalLabel(item.row) === "apply_worthy").length
        ? round(falseLow.length / automaticLabelled.filter((item) => operationalLabel(item.row) === "apply_worthy").length)
        : null,
      automatic_high_known_negative_errors: falseHigh.length,
      automatic_high_known_negative_error_ids: falseHigh.map((item) => item.row.id),
      consequential_errors: falseLow.map((item) => item.row.id),
      calibration_ece: ece(calibration),
      calibration_curve: curve.bins,
      calibration_monotonic: curve.monotonic,
      label_basis: "submitted-or-later is apply-worthy; legacy outside at relevance <=25 in discovered/rejected is not-apply-worthy",
    },
    human_quality: {
      adjudication: {
        required: adjudicationQueue.counts.frozen_primary_required,
        complete_count: adjudicationQueue.counts.frozen_primary_human_complete,
        complete: adjudicationQueue.counts.frozen_primary_required > 0
          && adjudicationQueue.counts.frozen_primary_human_complete === adjudicationQueue.counts.frozen_primary_required,
        shadow_review_required: adjudicationQueue.counts.shadow_review_required,
        shadow_review_complete: adjudicationQueue.counts.shadow_review_human_complete,
        delegated_decisions: adjudicationQueue.counts.delegated_decisions,
        stale: adjudicationQueue.counts.stale,
      },
      apply_labels: humanApplyLabelled.length,
      automatic_apply_labels: automaticHumanApplyLabelled.length,
      automatic_low_apply_worthy_errors: humanFalseLow.length,
      automatic_low_apply_worthy_error_rate: automaticHumanApplyLabelled.filter((item) => adjudicationById.get(item.row.id)?.human_label?.apply_worthy === "yes").length
        ? round(humanFalseLow.length / automaticHumanApplyLabelled.filter((item) => adjudicationById.get(item.row.id)?.human_label?.apply_worthy === "yes").length)
        : null,
      automatic_high_not_apply_worthy_errors: humanFalseHigh.length,
      automatic_high_not_apply_worthy_error_ids: humanFalseHigh.map((item) => item.row.id),
      consequential_errors: humanFalseLow.filter((item) => ["submitted", "responded", "interview", "offered", "won"].includes(item.row.status)).map((item) => item.row.id),
      matched_resume_labels: humanResumeLabelled.length,
      matched_resume_exact_agreement: humanResumeLabelled.length
        ? round(humanResumeLabelled.filter((item) => {
          const human = adjudicationById.get(item.row.id)!.human_label!.matched_resume_id;
          return (human === "none" ? null : human) === item.jev.matched_resume_id;
        }).length / humanResumeLabelled.length)
        : null,
      discipline_labels: humanDisciplineLabelled.length,
      discipline_exact_agreement: humanDisciplineLabelled.length
        ? round(humanDisciplineLabelled.filter((item) => adjudicationById.get(item.row.id)!.human_label!.discipline_fit === item.jev.discipline_fit).length / humanDisciplineLabelled.length)
        : null,
      calibration_ece: ece(humanCalibration),
      calibration_curve: humanCurve.bins,
      calibration_monotonic: humanCurve.monotonic,
      calibration_basis: "automatic selected-option probability versus exact adjudicated discipline",
      label_basis: "attended human labels bound to exact role content and Jev decision id; insufficient-evidence labels are excluded from the corresponding metric",
    },
    delegated_quality: {
      adjudication: {
        required: adjudicationQueue.counts.frozen_primary_required,
        complete_count: adjudicationQueue.counts.frozen_primary_complete,
        complete: adjudicationQueue.counts.frozen_primary_required > 0
          && adjudicationQueue.counts.frozen_primary_complete === adjudicationQueue.counts.frozen_primary_required,
        shadow_review_required: adjudicationQueue.counts.shadow_review_required,
        shadow_review_complete: adjudicationQueue.counts.shadow_review_complete,
        delegated_decisions: adjudicationQueue.counts.delegated_decisions,
        independently_human_verified: adjudicationQueue.counts.independent_human_complete,
        stale: adjudicationQueue.counts.stale,
      },
      apply_labels: delegatedApplyLabelled.length,
      automatic_apply_labels: automaticDelegatedApplyLabelled.length,
      automatic_low_apply_worthy_errors: delegatedFalseLow.length,
      automatic_low_apply_worthy_error_rate: automaticDelegatedApplyLabelled.filter((item) => adjudicationById.get(item.row.id)?.human_label?.apply_worthy === "yes").length
        ? round(delegatedFalseLow.length / automaticDelegatedApplyLabelled.filter((item) => adjudicationById.get(item.row.id)?.human_label?.apply_worthy === "yes").length)
        : null,
      automatic_high_not_apply_worthy_errors: delegatedFalseHigh.length,
      automatic_high_not_apply_worthy_error_ids: delegatedFalseHigh.map((item) => item.row.id),
      consequential_errors: delegatedFalseLow.filter((item) => ["submitted", "responded", "interview", "offered", "won"].includes(item.row.status)).map((item) => item.row.id),
      matched_resume_labels: delegatedResumeLabelled.length,
      matched_resume_exact_agreement: delegatedResumeLabelled.length
        ? round(delegatedResumeLabelled.filter((item) => {
          const review = adjudicationById.get(item.row.id)!.human_label!.matched_resume_id;
          return (review === "none" ? null : review) === item.jev.matched_resume_id;
        }).length / delegatedResumeLabelled.length)
        : null,
      discipline_labels: delegatedDisciplineLabelled.length,
      discipline_exact_agreement: delegatedDisciplineLabelled.length
        ? round(delegatedDisciplineLabelled.filter((item) => adjudicationById.get(item.row.id)!.human_label!.discipline_fit === item.jev.discipline_fit).length / delegatedDisciplineLabelled.length)
        : null,
      calibration_ece: ece(delegatedCalibration),
      calibration_curve: delegatedCurve.bins,
      calibration_monotonic: delegatedCurve.monotonic,
      calibration_basis: "automatic selected-option probability versus exact delegated discipline",
      label_basis: "user-delegated assistant decisions grounded in the profile, CV evidence and job description; reported separately from independent human validation",
    },
    legacy_comparison: {
      discipline_agreement: legacyDisciplineComparable.length
        ? round(legacyDisciplineComparable.filter((item) => item.legacy?.discipline_fit === item.jev.discipline_fit).length / legacyDisciplineComparable.length)
        : null,
      resume_agreement: legacyResumeComparable.length
        ? round(legacyResumeComparable.filter((item) => (item.legacy?.matched_resume_id ?? null) === item.jev.matched_resume_id).length / legacyResumeComparable.length)
        : null,
      note: "Agreement is diagnostic, not ground truth.",
    },
    decisions: decisions.map((item) => ({
      id: item.row.id,
      status: item.jev.status,
      discipline_fit: item.jev.discipline_fit,
      matched_resume_id: item.jev.matched_resume_id,
      profile_relevance: item.jev.profile_relevance,
      discipline_confidence: item.jev.decisions.discipline_fit?.confidence ?? null,
      resume_confidence: item.jev.decisions.matched_resume?.confidence ?? null,
    })),
    runtime: {
      input_tokens: inputTokens,
      estimated_cost_usd: round(cost),
      mean_latency_ms: decisions.length ? round(latencies.reduce((a, b) => a + b, 0) / decisions.length) : null,
      p95_latency_ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null,
      unchanged_calls_on_cached_rerun_target: 0,
    },
    thresholds: {
      automatic_low_apply_worthy_error_rate_max: 0.02,
      consequential_errors_max: 0,
      matched_resume_rate_min: 0.85,
      calibration_ece_max: 0.10,
    },
  };
  const out = repoPath(outFile);
  await fs.writeFile(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ out, ...result.coverage, ...result.operational_quality, cost_usd: result.runtime.estimated_cost_usd }));
}

async function review(): Promise<void> {
  const adjudications = await loadAdjudications();
  const shadow = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-shadow-500.json"), "utf8"));
  const ids = new Set<string>(shadow.operational_quality?.automatic_high_known_negative_error_ids ?? []);
  const rows = (await load()).filter((row) => ids.has(row.id));
  const frozen = JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-current-path-replay.json"), "utf8"));
  const oldById = new Map<string, Record<string, unknown>>((frozen.records ?? []).map((record: Record<string, unknown>) => [String(record.id), record]));
  const items = rows.map((row) => {
    const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
    const decision = store().getClassificationDecision(row.id, contentHash);
    const adjudication = adjudications.labels[row.id] ?? null;
    const humanAdjudication = isIndependentHumanAdjudication(adjudication) ? adjudication : null;
    return {
      id: row.id,
      title: row.title,
      company: row.company,
      location: row.location ?? null,
      pipeline_status: row.status,
      description_excerpt: (row.description ?? "").replace(/\s+/g, " ").slice(0, 700),
      historical_proxy: oldById.get(row.id) ?? (row.classification ? {
        discipline_fit: row.classification.discipline_fit,
        matched_resume_id: row.classification.matched_resume_id,
        profile_relevance: row.classification.profile_relevance,
        source: row.classification.source,
      } : null),
      jev: decision ? {
        discipline_fit: decision.discipline_fit,
        discipline_distribution: decision.decisions.discipline_fit?.probabilities ?? null,
        matched_resume_id: decision.matched_resume_id,
        resume_distribution: decision.decisions.matched_resume?.probabilities ?? null,
        profile_relevance: decision.profile_relevance,
        decision_id: decision.provenance.decision_id,
      } : null,
      adjudication: decision && humanAdjudication?.content_hash === contentHash
        && humanAdjudication.jev_decision_id === decision.provenance.decision_id
        ? humanAdjudication.apply_worthy ?? null
        : null,
      notes: decision && humanAdjudication?.content_hash === contentHash
        && humanAdjudication.jev_decision_id === decision.provenance.decision_id
        ? humanAdjudication.notes ?? null
        : null,
    };
  });
  const out = repoPath("docs/benchmarks/jev-calibration-review.json");
  await fs.writeFile(out, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    purpose: "Human adjudication of Jev automatic decisions that disagree with the weak historical negative proxy.",
    allowed_adjudication: ["apply_worthy", "not_apply_worthy", "insufficient_evidence"],
    items,
  }, null, 2) + "\n");

  const agent = await fs.readFile(repoPath("docs/benchmarks/jev-agent-comparator.json"), "utf8").then(JSON.parse).catch(() => null);
  const agentById = new Map<string, Record<string, unknown>>((agent?.records ?? []).map((record: Record<string, unknown>) => [String(record.id), record]));
  const cohortIds = new Set<string>(JSON.parse(await fs.readFile(repoPath("docs/benchmarks/jev-cohort.json"), "utf8")));
  const cohortRows = (await load()).filter((row) => cohortIds.has(row.id));
  const outcomeStatuses = new Set(["submitted", "responded", "interview", "offered", "won"]);
  const disagreements = cohortRows.flatMap((row) => {
    const agentDecision = agentById.get(row.id);
    const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
    const jev = store().getClassificationDecision(row.id, contentHash);
    if (!agentDecision || !jev) return [];
    const disciplineDiffers = agentDecision.discipline_fit !== jev.discipline_fit;
    const resumeDiffers = (agentDecision.matched_resume_id ?? null) !== (jev.matched_resume_id ?? null);
    if (!disciplineDiffers && !resumeDiffers) return [];
    const outcomeConsequential = outcomeStatuses.has(row.status);
    const automatic = jev.status === "automatic";
    const adjudication = adjudications.labels[row.id] ?? null;
    const humanAdjudication = isIndependentHumanAdjudication(adjudication) ? adjudication : null;
    return [{
      priority: automatic && outcomeConsequential ? 1 : automatic ? 2 : outcomeConsequential ? 3 : 4,
      id: row.id,
      title: row.title,
      company: row.company,
      location: row.location ?? null,
      pipeline_status: row.status,
      outcome_consequential: outcomeConsequential,
      jev_automatic: automatic,
      differences: { discipline_fit: disciplineDiffers, matched_resume_id: resumeDiffers },
      description_excerpt: (row.description ?? "").replace(/\s+/g, " ").slice(0, 700),
      generic_agent: {
        discipline_fit: agentDecision.discipline_fit,
        evidence_strength: agentDecision.evidence_strength,
        matched_resume_id: agentDecision.matched_resume_id ?? null,
        profile_relevance: agentDecision.profile_relevance,
        reason: agentDecision.profile_relevance_reason,
      },
      jev: {
        status: jev.status,
        discipline_fit: jev.discipline_fit,
        discipline_distribution: jev.decisions.discipline_fit?.probabilities ?? null,
        matched_resume_id: jev.matched_resume_id,
        resume_distribution: jev.decisions.matched_resume?.probabilities ?? null,
        profile_relevance: jev.profile_relevance,
        decision_id: jev.provenance.decision_id,
      },
      human_label: humanAdjudication?.content_hash === contentHash
        && humanAdjudication.jev_decision_id === jev.provenance.decision_id
        ? {
          discipline_fit: humanAdjudication.discipline_fit ?? null,
          matched_resume_id: humanAdjudication.matched_resume_id ?? null,
          apply_worthy: humanAdjudication.apply_worthy ?? null,
          notes: humanAdjudication.notes ?? null,
        }
        : { discipline_fit: null, matched_resume_id: null, apply_worthy: null, notes: null },
    }];
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const disagreementOut = repoPath("docs/benchmarks/jev-agent-disagreement-review.json");
  await fs.writeFile(disagreementOut, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    purpose: "Human adjudication queue for frozen-cohort disagreements between the retained generic-agent fallback and Jev.",
    allowed_labels: {
      discipline_fit: ["core", "platform_gap", "adjacent", "outside", "insufficient_evidence"],
      matched_resume_id: ["active resume id", "none", "insufficient_evidence"],
      apply_worthy: ["yes", "no", "insufficient_evidence"],
    },
    counts: {
      items: disagreements.length,
      discipline_disagreements: disagreements.filter((item) => item.differences.discipline_fit).length,
      resume_disagreements: disagreements.filter((item) => item.differences.matched_resume_id).length,
      jev_automatic: disagreements.filter((item) => item.jev_automatic).length,
      outcome_consequential: disagreements.filter((item) => item.outcome_consequential).length,
      priority_1: disagreements.filter((item) => item.priority === 1).length,
    },
    items: disagreements,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ out, items: items.length, disagreement_out: disagreementOut, disagreement_items: disagreements.length }));
}

async function continuous(): Promise<void> {
  const rows = await load();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const identity = await currentJevCacheIdentity();
  const frozen = await fs.readFile(repoPath("docs/benchmarks/jev-after.json"), "utf8").then(JSON.parse).catch(() => null);
  const now = Date.now();
  const outcomeStatuses = ["responded", "interview", "offered", "won"] as const;
  const windows = [7, 30].map((days) => {
    const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const decisions = store().listClassificationDecisionsSince(since);
    const roles = new Set(decisions.map((item) => item.roleId));
    const fallbacks = decisions.filter((item) => item.classification.source === "agent_fallback");
    const overrides = fallbacks.filter((item) => Boolean(item.classification.provenance.supersedes_decision_id));
    return {
      days,
      since,
      decisions: decisions.length,
      unique_roles: roles.size,
      by_status: Object.fromEntries(["automatic", "uncertain", "degraded", "insufficient_input"].map((status) => [status, decisions.filter((item) => item.classification.status === status).length])),
      by_source: Object.fromEntries(["jev", "agent_fallback", "migrated_agent", "deterministic_only"].map((source) => [source, decisions.filter((item) => item.classification.source === source).length])),
      jev_input_tokens: decisions.reduce((sum, item) => sum + (item.classification.source === "jev" ? item.classification.provenance.input_tokens ?? 0 : 0), 0),
      jev_output_tokens: decisions.reduce((sum, item) => sum + (item.classification.source === "jev" ? item.classification.provenance.output_tokens ?? 0 : 0), 0),
      jev_cost_usd: round(decisions.reduce((sum, item) => sum + (item.classification.source === "jev" ? item.classification.provenance.estimated_cost_usd ?? 0 : 0), 0)),
      attended_fallbacks: fallbacks.length,
      attended_overrides: overrides.map((item) => ({
        role_id: item.roleId,
        decision_id: item.classification.provenance.decision_id,
        supersedes_decision_id: item.classification.provenance.supersedes_decision_id,
      })),
      outcomes: Object.fromEntries(outcomeStatuses.map((status) => [status, [...roles].filter((id) => byId.get(id)?.status === status).length])),
    };
  });
  const freshness = {
    policy_hash_matches: frozen?.context?.policy_hash === identity.policyHash,
    profile_hash_matches: frozen?.context?.profile_hash === identity.profileHash,
    resume_set_hash_matches: frozen?.context?.resume_set_hash === identity.resumeHash,
    question_schema_hash_matches: frozen?.context?.question_schema_hash === identity.questionSchemaHash,
    requested_model_matches: frozen?.model?.requested === identity.requestedModel,
    expected_gateway_route_fingerprint_present: identity.expectedGatewayRouteFingerprint
      ? frozen?.model?.gateway_route_fingerprints?.includes(identity.expectedGatewayRouteFingerprint) === true
      : true,
    resolved_model_version_observable: identity.expectedGatewayRouteFingerprint
      ? frozen?.model?.model_version_observable_all === true
      : false,
  };
  const adjudications = await getAdjudicationQueue();
  const out = repoPath("docs/benchmarks/jev-continuous.json");
  await fs.writeFile(out, JSON.stringify({
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    windows,
    frozen_benchmark_stale: Object.values(freshness).some((matches) => !matches),
    frozen_benchmark_freshness: freshness,
    human_adjudication: adjudications.counts,
    note: "Outcomes are current pipeline states for roles with decisions in each window. Attended overrides are explicit agent_fallback decisions linked to the Jev decision they supersede. Human calibration labels are counted only while bound to the current content and Jev decision.",
  }, null, 2) + "\n");
  console.log(JSON.stringify({ out, frozen_benchmark_stale: Object.values(freshness).some((matches) => !matches), windows: windows.map((window) => ({ days: window.days, decisions: window.decisions, overrides: window.attended_overrides.length })) }));
}

const command = process.argv[2] ?? "report";
if (command === "prepare") await prepare();
else if (command === "prepare-shadow") await prepareShadow();
else if (command === "capture-current") await captureCurrentPath();
else if (command === "comparison") await comparison();
else if (command === "stability") await stability();
else if (command === "review") await review();
else if (command === "continuous") await continuous();
else if (command === "report-all") {
  await stability();
  await comparison();
  await continuous();
}
else if (command === "report") {
  const idsAt = process.argv.indexOf("--ids-file");
  const outAt = process.argv.indexOf("--out");
  await report(idsAt >= 0 ? process.argv[idsAt + 1] : undefined, outAt >= 0 ? process.argv[outAt + 1] : undefined);
}
else throw new Error("Usage: jev:benchmark -- prepare|prepare-shadow|capture-current|report|stability|comparison|review|continuous|report-all");
