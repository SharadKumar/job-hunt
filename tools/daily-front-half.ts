#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import { huntScriptFor } from "./channels/_interface.ts";
import { load } from "./pipeline.ts";
import { repoPath } from "./repo-root.ts";
import { classifyPipeline } from "./jev/classify-pipeline.ts";
import { blockingDegradation, readDegradation } from "./jev/degradation.ts";
import { loadLocale } from "./profile.ts";

const exec = promisify(execFile);

type Step = { name: string; ok: boolean; exit_code: number; duration_ms: number; result?: unknown; error?: string };

async function npmStep(name: string, script: string, args: string[] = []): Promise<Step> {
  const started = Date.now();
  try {
    const { stdout } = await exec("npm", ["run", "-s", script, ...(args.length ? ["--", ...args] : [])], { cwd: repoPath("."), maxBuffer: 20 * 1024 * 1024 });
    const trimmed = stdout.trim();
    let result: unknown = trimmed;
    try { result = JSON.parse(trimmed.split(/\r?\n/).at(-1) ?? "null"); } catch {}
    return { name, ok: true, exit_code: 0, duration_ms: Date.now() - started, result };
  } catch (error: any) {
    return { name, ok: false, exit_code: Number(error?.code ?? 1), duration_ms: Date.now() - started, error: String(error?.stderr || error?.message || error).trim().slice(0, 1000) };
  }
}

export async function runDailyFrontHalf(): Promise<{ ok: boolean; degraded: boolean; steps: Step[]; report_path: string }> {
  const startedMs = Date.now();
  const started = new Date().toISOString();
  const steps: Step[] = [];
  steps.push(await npmStep("sheet_pull", "sheets:pull"));
  steps.push(await npmStep("seek_saved", "seek:saved", ["--upsert"]));

  const channels = YAML.parse(await fs.readFile(repoPath("state/profile/channels.yaml"), "utf8"))?.channels ?? {};
  for (const [id, config] of Object.entries(channels) as [string, { enabled?: boolean }][]) {
    if (!config?.enabled) continue;
    const adapter = huntScriptFor(id);
    if (!adapter.ok) {
      steps.push({ name: `hunt:${id}`, ok: false, exit_code: 2, duration_ms: 0, error: adapter.reason });
      continue;
    }
    steps.push(await npmStep(`hunt:${id}`, adapter.script, ["--upsert"]));
  }

  // Remove work that can no longer be acted on before spending model calls on
  // it. Expiry is based only on an explicit deadline or channel signal.
  steps.push(await npmStep("expire_closed_openings", "pipeline:expire", ["--apply"]));

  const rows = await load();
  const previouslyUnclassified = rows.filter((row) => !row.classification).length;
  const classifyStarted = Date.now();
  const classification = await classifyPipeline(rows, { concurrency: 2 });
  steps.push({ name: "jev_classify_score", ok: classification.degraded === 0, exit_code: classification.degraded ? 2 : 0, duration_ms: Date.now() - classifyStarted, result: classification });
  steps.push(await npmStep("tag_duplicates", "pipeline:tag-duplicates"));
  steps.push(await npmStep("fuzzy_duplicate_candidates", "jev:fuzzy-dedup", ["--limit", "25"]));
  steps.push(await npmStep("flush_old_unclassified", "pipeline:flush-discovered", ["--older-than", "14d", "--unclassified", "--apply"]));
  steps.push(await npmStep("state_sync", "sheets:sync"));

  const degraded = classification.degraded > 0;
  const degradation = await readDegradation();
  const blocking = blockingDegradation(degradation);
  const report = {
    schema_version: 1,
    started_at: started,
    finished_at: new Date().toISOString(),
    ok: steps.every((step) => step.ok || ["sheet_pull"].includes(step.name)) && !degraded,
    degraded,
    degradation_acknowledged: blocking?.incident.acknowledged_at != null,
    cli_required_for_classification: false,
    telemetry: {
      rows_seen: rows.length,
      new_or_unclassified: previouslyUnclassified,
      changed: classification.changed,
      unchanged: classification.unchanged,
      cache_hits: classification.cache_hits,
      cache_misses: classification.requested,
      jev_calls: classification.requested,
      automatic: classification.automatic,
      uncertain: classification.uncertain,
      agent_fallbacks: 0,
      jev_latency_p50_ms: classification.latency_p50_ms,
      jev_latency_p95_ms: classification.latency_p95_ms,
      deterministic_fields_resolved: classification.deterministic_fields_resolved,
      deterministic_fields_ambiguous: classification.deterministic_fields_ambiguous,
      extraction_ms: classification.extraction_ms,
      jev_ms: classification.jev_ms,
      scoring_ms: classification.scoring_ms,
      classification_total_ms: classification.total_ms,
      sync_ms: steps.find((step) => step.name === "state_sync")?.duration_ms ?? null,
      total_front_half_ms: Date.now() - startedMs,
      jev_input_tokens: classification.input_tokens,
      jev_cost_usd: classification.estimated_cost_usd,
      gateway_daily_spend_cap_usd: classification.gateway_daily_spend_cap_usd,
      generic_agent_classification_tokens: null,
      generic_agent_classification_cost_usd: null,
      requested_models: classification.requested_models,
      effective_models: classification.effective_models,
      gateway_route_fingerprints: classification.gateway_route_fingerprints,
      policy_hashes: classification.policy_hashes,
      profile_hashes: classification.profile_hashes,
      resume_set_hashes: classification.resume_set_hashes,
      content_set_hash: classification.content_set_hash,
      state_application_enabled: classification.state_application_enabled,
      state_applied: classification.state_applied,
    },
    steps,
  };
  const locale = await loadLocale();
  const localDay = new Date(started).toLocaleDateString("en-CA", { timeZone: locale.timezone });
  const reportPath = repoPath(`state/journal/front-half/${localDay}.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ok: report.ok, degraded, steps, report_path: reportPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyFrontHalf().then((result) => {
    console.log(JSON.stringify(result));
    if (result.degraded) process.exitCode = 2;
    else if (!result.ok) process.exitCode = 1;
  }).catch((error) => { console.error(JSON.stringify({ ok: false, error: (error as Error).message })); process.exit(1); });
}
