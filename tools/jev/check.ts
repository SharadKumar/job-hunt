#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import { extractMechanicalClassification } from "../classification.ts";
import { repoPath } from "../repo-root.ts";
import { gatewayCredential } from "./env.ts";
import { loadJevPolicy } from "./policy.ts";
import { jevSpendTodayUsd } from "./evaluate.ts";

async function main(): Promise<void> {
  const { policy } = await loadJevPolicy();
  const sample = extractMechanicalClassification(
    "Senior Solutions Architect",
    "Six month contract, fully remote, $1400 per day including super.",
  );
  const offline = process.argv.includes("--offline");
  const credential = offline ? null : await gatewayCredential();
  const mechanicalOk = sample.work_arrangement === "remote" && sample.day_rate.min === 1400;
  const spendToday = await jevSpendTodayUsd();
  const benchmark = await fs.readFile(repoPath("docs/benchmarks/jev-after.json"), "utf8").then(JSON.parse).catch(() => null);
  const resolvedVersions = Array.isArray(benchmark?.model?.resolved_model_versions) ? benchmark.model.resolved_model_versions : [];
  const modelVersionObservable = benchmark?.model?.model_version_observable_all === true;
  const result = {
    ok: mechanicalOk && policy.model === "typesafe-ai/jev" && Boolean(policy.expected_gateway_route_fingerprint) && (offline || Boolean(credential)),
    mechanical_ok: mechanicalOk,
    model: policy.model,
    gateway_credential_present: Boolean(credential),
    zero_data_retention_required: true,
    provider_fallbacks: 0,
    gateway_route_fingerprint: policy.expected_gateway_route_fingerprint ?? null,
    resolved_model_versions: resolvedVersions,
    model_version_observable: modelVersionObservable,
    classification_state_application_enabled: policy.classification_state_application_enabled,
    jev_autopilot_authority_enabled: false,
    gateway_daily_spend_cap_usd: policy.gateway_daily_spend_cap_usd,
    gateway_spend_today_usd: spendToday,
    gateway_spend_remaining_usd: Number(Math.max(0, policy.gateway_daily_spend_cap_usd - spendToday).toFixed(8)),
    spend_cap_reached: spendToday >= policy.gateway_daily_spend_cap_usd,
  };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, error: (error as Error).message })); process.exit(1); });
