#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { huntScriptFor } from "./channels/_interface.ts";
import { load } from "./pipeline.ts";
import { repoPath } from "./repo-root.ts";
import { classifyPipeline, classificationWorkset } from "./jev/classify-pipeline.ts";
import { blockingDegradation, readDegradation } from "./jev/degradation.ts";
import { loadLocale } from "./profile.ts";
import { boundedCommand } from "./lib/bounded-command.ts";
import { writeAtomic } from "./lib/fs.ts";

type Step = { name: string; ok: boolean; partial?: boolean; exit_code: number; duration_ms: number; result?: unknown; error?: string; timed_out?: boolean };

async function npmStep(name: string, script: string, args: string[] = []): Promise<Step> {
  const started = Date.now();
  try {
    const { stdout, stderr, exit_code, timed_out } = await boundedCommand("npm", ["run", "-s", script, ...(args.length ? ["--", ...args] : [])], {
      cwd: repoPath("."), timeoutMs: Number(process.env.HARNESS_STEP_TIMEOUT_MS ?? 20 * 60_000),
    });
    if (exit_code !== 0) return { name, ok: false, exit_code, timed_out, duration_ms: Date.now() - started,
      error: `${timed_out ? "Step exceeded its time limit. " : ""}${(stderr || stdout || `Exit ${exit_code}`).trim().slice(-4000)}` };
    const trimmed = stdout.trim();
    let result: unknown = trimmed;
    try { result = JSON.parse(trimmed); } catch {
      try { result = JSON.parse(trimmed.split(/\r?\n/).at(-1) ?? "null"); } catch {}
    }
    return { name, ok: true, exit_code: 0, duration_ms: Date.now() - started, result };
  } catch (error: any) {
    return { name, ok: false, exit_code: 1, duration_ms: Date.now() - started, error: String(error?.stderr || error?.message || error).trim().slice(-4000) };
  }
}

export async function runDailyFrontHalf(): Promise<{ ok: boolean; degraded: boolean; steps: Step[]; report_path: string }> {
  const startedMs = Date.now();
  const started = new Date().toISOString();
  const steps: Step[] = [];
  const locale = await loadLocale();
  const localDay = new Date(started).toLocaleDateString("en-CA", { timeZone: locale.timezone });
  const reportPath = repoPath(`state/journal/front-half/${localDay}.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  let currentStep: string | null = null;
  let progress: unknown = null;
  let writing = Promise.resolve();
  let writeError: unknown = null;
  const checkpoint = () => {
    const report = JSON.stringify({ schema_version: 2, started_at: started, updated_at: new Date().toISOString(),
      finished_at: null, running: true, pid: process.pid, current_step: currentStep, classification_progress: progress, steps }, null, 2) + "\n";
    writing = writing.then(() => writeAtomic(reportPath, report)).catch(error => { writeError = error; });
    return writing;
  };
  const runStep = async (name: string, script: string, args: string[] = []) => {
    currentStep = name;
    await checkpoint();
    steps.push(await npmStep(name, script, args));
    await checkpoint();
  };
  const heartbeat = setInterval(() => { void checkpoint(); }, 10_000);
  heartbeat.unref();
  try {
  await runStep("sheet_pull", "sheets:pull");
  await runStep("seek_saved", "seek:saved", ["--upsert"]);
  // Saved-job import provides search-card text, sometimes none at all. Fetch
  // the actual advert before classification, regardless of score or status.
  await runStep("seek_saved_enrichment", "seek:enrich", ["--saved-pending", "--concurrency", "1"]);

  const channels = YAML.parse(await fs.readFile(repoPath("state/profile/channels.yaml"), "utf8"))?.channels ?? {};
  for (const [id, config] of Object.entries(channels) as [string, { enabled?: boolean }][]) {
    if (!config?.enabled) continue;
    const adapter = huntScriptFor(id);
    if (!adapter.ok) {
      steps.push({ name: `hunt:${id}`, ok: false, exit_code: 2, duration_ms: 0, error: adapter.reason });
      continue;
    }
    await runStep(`hunt:${id}`, adapter.script, ["--upsert"]);
  }

  // Recover full adverts and channel closure signals for the existing queue.
  // Search cards alone omit eligibility constraints and closing dates.
  await runStep("seek_shortlist_enrichment", "seek:enrich", ["--status", "shortlisted", "--concurrency", "1"]);

  // Remove work that can no longer be acted on before spending model calls on
  // it. Expiry is based only on an explicit deadline or channel signal.
  await runStep("expire_closed_openings", "pipeline:expire", ["--apply"]);

  const rows = await load();
  const previouslyUnclassified = rows.filter((row) => !row.classification).length;
  const classifyStarted = Date.now();
  const workset = classificationWorkset(rows);
  currentStep = "jev_classify_score";
  await checkpoint();
  let lastProgressWrite = 0;
  const classification = await classifyPipeline(workset, { concurrency: 2,
    maxRequests: Number(process.env.HARNESS_JEV_MAX_REQUESTS ?? 100), failureLimit: 3,
    onProgress: async summary => {
      progress = summary;
      if (Date.now() - lastProgressWrite >= 1000) {
        lastProgressWrite = Date.now();
        await checkpoint();
      }
    },
  });
  steps.push({ name: "jev_classify_score", ok: classification.degraded === 0, partial: classification.deferred > 0, exit_code: classification.degraded ? 2 : 0, duration_ms: Date.now() - classifyStarted, result: classification });
  await runStep("tag_duplicates", "pipeline:tag-duplicates");
  if (!classification.circuit_open) await runStep("fuzzy_duplicate_candidates", "jev:fuzzy-dedup", ["--limit", "25"]);
  // Deferred work is not stale merely because the service failed to classify it.
  if (!classification.deferred && !classification.degraded) await runStep("flush_old_unclassified", "pipeline:flush-discovered", ["--older-than", "14d", "--unclassified", "--apply"]);
  await runStep("state_sync", "sheets:sync");

  const degraded = classification.degraded > 0;
  const degradation = await readDegradation();
  const blocking = blockingDegradation(degradation);
  const report = {
    schema_version: 2,
    running: false,
    pid: process.pid,
    current_step: null,
    updated_at: new Date().toISOString(),
    started_at: started,
    finished_at: new Date().toISOString(),
    ok: steps.every((step) => step.ok || ["sheet_pull"].includes(step.name)) && !degraded,
    degraded,
    partial: classification.deferred > 0,
    degradation_acknowledged: blocking?.incident.acknowledged_at != null,
    cli_required_for_classification: false,
    telemetry: {
      rows_seen: rows.length,
      eligible_rows: workset.length,
      excluded_rows: rows.length - workset.length,
      deferred: classification.deferred,
      circuit_open: classification.circuit_open,
      request_limit: classification.request_limit,
      cache_miss_reasons: classification.cache_miss_reasons,
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
  clearInterval(heartbeat);
  await writing;
  if (writeError) throw writeError;
  await writeAtomic(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ok: report.ok, degraded, steps, report_path: reportPath };
  } catch (error) {
    clearInterval(heartbeat);
    await writing;
    await writeAtomic(reportPath, JSON.stringify({ schema_version: 2, started_at: started,
      updated_at: new Date().toISOString(), finished_at: new Date().toISOString(), running: false,
      ok: false, pid: process.pid, current_step: currentStep, classification_progress: progress,
      error: (error as Error).message, steps }, null, 2) + "\n");
    throw error;
  } finally { clearInterval(heartbeat); await writing; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyFrontHalf().then((result) => {
    console.log(JSON.stringify(result));
    if (result.degraded) process.exitCode = 2;
    else if (!result.ok) process.exitCode = 1;
  }).catch((error) => { console.error(JSON.stringify({ ok: false, error: (error as Error).message })); process.exit(1); });
}
