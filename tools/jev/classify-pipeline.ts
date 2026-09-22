#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import { classificationContentHash, extractMechanicalClassification } from "../classification.ts";
import { logMany as auditLogMany } from "../audit.ts";
import { load, patchMany, type Opportunity } from "../pipeline.ts";
import { store } from "../pipeline-store.ts";
import { scoreRole } from "../score.ts";
import { applyRescore } from "../rescore-pipeline.ts";
import { classifyWithJev, currentJevCacheIdentity } from "./classifier.ts";
import { clearDegradation, recordDegradation } from "./degradation.ts";
import YAML from "yaml";
import { repoPath } from "../repo-root.ts";
import { sha256 } from "../lib/hash.ts";

export type ClassifyBatchSummary = {
  considered: number;
  requested: number;
  cache_hits: number;
  automatic: number;
  uncertain: number;
  degraded: number;
  insufficient_input: number;
  input_tokens: number;
  estimated_cost_usd: number;
  deterministic_fields_resolved: number;
  deterministic_fields_ambiguous: number;
  extraction_ms: number;
  jev_ms: number;
  scoring_ms: number;
  changed: number;
  unchanged: number;
  decision_differs_from_pipeline: number;
  promoted: number;
  demoted: number;
  state_application_enabled: boolean;
  state_applied: number;
  replay_misses: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  total_ms: number;
  requested_models: string[];
  effective_models: string[];
  gateway_route_fingerprints: string[];
  policy_hashes: string[];
  profile_hashes: string[];
  resume_set_hashes: string[];
  content_set_hash: string;
  gateway_daily_spend_cap_usd: number;
};

type CacheIdentity = Awaited<ReturnType<typeof currentJevCacheIdentity>>;

export function validCachedDecision(
  classification: Opportunity["classification"] | null,
  cacheIdentity: CacheIdentity,
): classification is NonNullable<Opportunity["classification"]> {
  if (!classification || classification.status === "degraded") return false;
  const sharedIdentityMatches = classification.provenance.policy_hash === cacheIdentity.policyHash
    && classification.provenance.profile_hash === cacheIdentity.profileHash
    && classification.provenance.resume_set_hash === cacheIdentity.resumeHash
    && classification.provenance.question_schema_hash === cacheIdentity.questionSchemaHash;
  if (!sharedIdentityMatches) return false;
  if (classification.source === "agent_fallback") return classification.status === "automatic";
  return Boolean(classification.source === "jev"
    && classification.provenance.requested_model === cacheIdentity.requestedModel
    && (!cacheIdentity.expectedGatewayRouteFingerprint
      || classification.provenance.gateway_route_fingerprint === cacheIdentity.expectedGatewayRouteFingerprint));
}

export async function classifyPipeline(
  opportunities: Opportunity[],
  opts: {
    dryRun?: boolean;
    shadow?: boolean;
    force?: boolean;
    replayOnly?: boolean;
    concurrency?: number;
    applyState?: boolean;
    classify?: typeof classifyWithJev;
  } = {},
): Promise<ClassifyBatchSummary> {
  const started = Date.now();
  const summary: ClassifyBatchSummary = {
    considered: opportunities.length, requested: 0, cache_hits: 0, automatic: 0, uncertain: 0,
    degraded: 0, insufficient_input: 0, input_tokens: 0, estimated_cost_usd: 0,
    deterministic_fields_resolved: 0, deterministic_fields_ambiguous: 0, extraction_ms: 0, jev_ms: 0, scoring_ms: 0,
    changed: 0, unchanged: 0, decision_differs_from_pipeline: 0,
    promoted: 0, demoted: 0, state_application_enabled: false, state_applied: 0,
    replay_misses: 0, latency_p50_ms: null, latency_p95_ms: null, total_ms: 0,
    requested_models: [], effective_models: [], gateway_route_fingerprints: [], policy_hashes: [], profile_hashes: [], resume_set_hashes: [],
    content_set_hash: sha256(""), gateway_daily_spend_cap_usd: 0,
  };
  const results: { before: Opportunity; result: Awaited<ReturnType<typeof scoreRole>> }[] = [];
  const audit: Parameters<typeof auditLogMany>[0] = [];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, 10));
  const cacheIdentity = await currentJevCacheIdentity();
  const applyState = !opts.shadow && (opts.applyState ?? cacheIdentity.classificationStateApplicationEnabled);
  summary.state_application_enabled = applyState;
  summary.gateway_daily_spend_cap_usd = cacheIdentity.gatewayDailySpendCapUsd;
  const latencies: number[] = [];
  const identities = {
    requested: new Set<string>(), effective: new Set<string>(), routes: new Set<string>(),
    policy: new Set<string>(), profile: new Set<string>(), resumes: new Set<string>(),
  };
  const contentHashes: string[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= opportunities.length) return;
      const opportunity = opportunities[index];
      const extractionStarted = Date.now();
      const mechanical = extractMechanicalClassification(opportunity.title, opportunity.description ?? "", { location: opportunity.location });
      summary.extraction_ms += Date.now() - extractionStarted;
      const resolved = [
        mechanical.work_arrangement !== "unknown",
        mechanical.location_flexibility !== "unknown",
        mechanical.day_rate.stated_explicitly,
        mechanical.seniority !== "unknown",
        mechanical.contract_length_months != null,
      ].filter(Boolean).length;
      summary.deterministic_fields_resolved += resolved;
      summary.deterministic_fields_ambiguous += 5 - resolved;
      const contentHash = classificationContentHash({
        title: opportunity.title,
        description: opportunity.description ?? "",
        location: opportunity.location,
      });
      contentHashes.push(contentHash);
      let classification = !opts.force && opportunity.classification?.source === "agent_fallback"
        && opportunity.classification.provenance.content_hash === contentHash
        ? opportunity.classification
        : !opts.force ? store().getClassificationDecision(opportunity.id, contentHash) : null;
      if (!validCachedDecision(classification, cacheIdentity)) classification = null;
      if (classification) {
        summary.cache_hits++;
        summary.unchanged++;
        classification = { ...classification, provenance: { ...classification.provenance, cache_hit: true } };
      } else {
        summary.changed++;
        if (opts.replayOnly) {
          summary.replay_misses++;
          continue;
        }
        summary.requested++;
        classification = await (opts.classify ?? classifyWithJev)({
          id: opportunity.id,
          title: opportunity.title,
          description: opportunity.description ?? "",
          location: opportunity.location,
        });
        if (classification.status !== "degraded") store().putClassificationDecision(opportunity.id, classification);
      }
      summary[classification.status]++;
      if (!classification.provenance.cache_hit) {
        summary.input_tokens += classification.provenance.input_tokens ?? 0;
        summary.estimated_cost_usd += classification.provenance.estimated_cost_usd ?? 0;
        latencies.push(classification.provenance.latency_ms);
        summary.jev_ms += classification.provenance.latency_ms;
      }
      identities.requested.add(classification.provenance.requested_model);
      if (classification.provenance.effective_model) identities.effective.add(classification.provenance.effective_model);
      if (classification.provenance.gateway_route_fingerprint) identities.routes.add(classification.provenance.gateway_route_fingerprint);
      identities.policy.add(classification.provenance.policy_hash);
      identities.profile.add(classification.provenance.profile_hash);
      identities.resumes.add(classification.provenance.resume_set_hash);
      const previousDecision = opportunity.classification?.provenance?.decision_id;
      if (previousDecision !== classification.provenance.decision_id) summary.decision_differs_from_pipeline++;
      audit.push({
        event_type: classification.status === "degraded" ? "jev_degraded" : classification.status === "uncertain" ? "jev_uncertain" : "jev_decision",
        role_id: opportunity.id,
        actor: "jev-classifier",
        channel: opportunity.channel,
        details: {
          status: classification.status,
          source: classification.source,
          decision_id: classification.provenance.decision_id,
          content_hash: classification.provenance.content_hash,
          effective_model: classification.provenance.effective_model,
          gateway_route_fingerprint: classification.provenance.gateway_route_fingerprint,
          resolved_model_version: classification.provenance.resolved_model_version,
          model_version_observable: classification.provenance.model_version_observable,
          cache_hit: classification.provenance.cache_hit,
          question_set_hash: classification.provenance.question_set_hash ?? null,
          question_schema_hash: classification.provenance.question_schema_hash ?? null,
          question_ids: classification.provenance.question_ids ?? [],
          decisions: classification.decisions,
          latency_ms: classification.provenance.latency_ms,
          input_tokens: classification.provenance.input_tokens,
          output_tokens: classification.provenance.output_tokens,
          estimated_cost_usd: classification.provenance.estimated_cost_usd,
          state_application_enabled: applyState,
        },
      });
      try {
        const scoringStarted = Date.now();
        const scored = await scoreRole({
          id: opportunity.id, channel: opportunity.channel, title: opportunity.title, company: opportunity.company,
          description: opportunity.description ?? "", url: opportunity.url, workArrangement: opportunity.workArrangement,
          postedAt: opportunity.postedAt, location: opportunity.location, dayRate: opportunity.dayRate,
        }, classification);
        summary.scoring_ms += Date.now() - scoringStarted;
        if (applyState) results.push({ before: opportunity, result: scored });
      } catch {
        // A classification is still persisted in the decision table even when
        // profile scoring configuration is incomplete.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (summary.degraded > 0) await recordDegradation("classification", `Jev batch had ${summary.degraded} degraded decision${summary.degraded === 1 ? "" : "s"}`);
  else if (summary.requested > 0) await clearDegradation("classification");
  if (audit.length) await auditLogMany(audit);
  if (applyState && results.length && summary.degraded === 0) {
    const weights = YAML.parse(await fs.readFile(repoPath("state/profile/scoring-weights.yaml"), "utf8"));
    const counts = await applyRescore(results, weights.thresholds?.shortlist_min_score ?? 55, { dryRun: opts.dryRun });
    summary.promoted = counts.promoted;
    summary.demoted = counts.demoted;
    if (!opts.dryRun) {
      const patches = results.map(({ before, result }) => ({ id: before.id, fields: { classification: result.classification } }));
      if (patches.length) await patchMany(patches, "jev-classifier");
      summary.state_applied = patches.length;
    }
  }
  summary.estimated_cost_usd = Number(summary.estimated_cost_usd.toFixed(8));
  latencies.sort((a, b) => a - b);
  const percentile = (fraction: number): number | null => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] : null;
  summary.latency_p50_ms = percentile(0.5);
  summary.latency_p95_ms = percentile(0.95);
  summary.total_ms = Date.now() - started;
  summary.requested_models = [...identities.requested];
  summary.effective_models = [...identities.effective];
  summary.gateway_route_fingerprints = [...identities.routes];
  summary.policy_hashes = [...identities.policy];
  summary.profile_hashes = [...identities.profile];
  summary.resume_set_hashes = [...identities.resumes];
  summary.content_set_hash = sha256(contentHashes.sort().join("\n"));
  return summary;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const shadow = args.includes("--shadow");
  const force = args.includes("--force");
  const replayOnly = args.includes("--replay-only");
  const all = args.includes("--all");
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
  const idsAt = args.indexOf("--ids-file");
  const ids = idsAt >= 0 ? new Set<string>(JSON.parse(await fs.readFile(args[idsAt + 1], "utf8"))) : null;
  const cacheIdentity = await currentJevCacheIdentity();
  const rows = (await load()).filter((row) => !ids || ids.has(row.id)).filter((row) => {
    if (all) return true;
    const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
    return !validCachedDecision(store().getClassificationDecision(row.id, contentHash), cacheIdentity);
  }).slice(0, limit);
  const summary = await classifyPipeline(rows, { dryRun, shadow, force, replayOnly });
  console.log(JSON.stringify(summary));
  if (summary.degraded > 0 || summary.replay_misses > 0) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(JSON.stringify({ error: (error as Error).message })); process.exit(1); });
