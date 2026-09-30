#!/usr/bin/env tsx

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { classificationContentHash, type DisciplineFit } from "../classification.ts";
import { sha256 } from "../lib/hash.ts";
import { load, type Opportunity } from "../pipeline.ts";
import { repoPath } from "../repo-root.ts";
import { currentClassificationContext, currentJevCacheIdentity } from "./classifier.ts";

const execFileAsync = promisify(execFile);

type Decision = {
  id: string;
  discipline_fit: DisciplineFit;
  evidence_strength: 0 | 1 | 2;
  matched_resume_id: string | null;
  profile_relevance_reason: string;
  detected_domain: string;
  resume_match_explanation: string;
};

type ClaudeResult = {
  is_error: boolean;
  result?: string;
  structured_output?: { decisions?: Decision[] };
  total_cost_usd?: number;
  duration_api_ms?: number;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    thinkingTokens?: number;
    costUSD?: number;
    canonicalModel?: string;
  }>;
  errors?: string[];
};

const RELEVANCE: Record<DisciplineFit, [number, number, number]> = {
  outside: [5, 15, 25], adjacent: [30, 42, 54], platform_gap: [55, 64, 74], core: [75, 87, 100],
};

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function concurrentMap<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function operationalLabel(row: Opportunity): "apply_worthy" | "not_apply_worthy" | "unlabelled" {
  if (["submitted", "responded", "interview", "offered", "won"].includes(row.status)) return "apply_worthy";
  if (["discovered", "rejected"].includes(row.status)
    && row.classification?.discipline_fit === "outside"
    && (row.classification.profile_relevance ?? 100) <= 25) return "not_apply_worthy";
  return "unlabelled";
}

function outputSchema(ids: string[], resumeIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      decisions: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ids },
            discipline_fit: { type: "string", enum: ["core", "platform_gap", "adjacent", "outside"] },
            evidence_strength: { type: "integer", enum: [0, 1, 2] },
            matched_resume_id: { anyOf: [{ type: "string", enum: resumeIds }, { type: "null" }] },
            profile_relevance_reason: { type: "string" },
            detected_domain: { type: "string" },
            resume_match_explanation: { type: "string" },
          },
          required: ["id", "discipline_fit", "evidence_strength", "matched_resume_id", "profile_relevance_reason", "detected_domain", "resume_match_explanation"],
        },
      },
    },
    required: ["decisions"],
  };
}

const SYSTEM_PROMPT = `You are the supported generic-agent fallback for a job-hunt decision layer. Return only the requested structured output.

Classify each job's primary discipline from the title noun and must-have duties against the supplied candidate evidence:
- core: a demonstrated primary role family.
- platform_gap: the discipline fits, but a named platform or product dominates and is not evidenced.
- adjacent: a neighbouring discipline that can be argued from evidence but is not a demonstrated primary role family.
- outside: a different discipline or unevidenced specialist role for which the candidate is unlikely to be shortlisted.

Evidence strength is 0 for weak coverage or major required gaps, 1 for mixed coverage with one or two material gaps, and 2 for strong direct coverage of the principal must-haves. Choose exactly one supplied resume positioning that honestly matches the primary discipline. Use null for outside or when none is credible. Ignore rate, seniority, location and work arrangement when deciding discipline fit and evidence strength. Do not invent evidence. Output one decision for every supplied id and no duplicate ids.`;

async function classifyBatch(
  batch: Opportunity[],
  context: Awaited<ReturnType<typeof currentClassificationContext>>,
  model: string,
  fixtureDir: string,
  replayOnly: boolean,
): Promise<{ decisions: Decision[]; usage: ClaudeResult; fixture_hit: boolean }> {
  const ids = batch.map((row) => row.id);
  const request = {
    candidate_profile: context.profile,
    active_resumes: context.resumes,
    jobs: batch.map((row) => ({ id: row.id, title: row.title, description: row.description ?? "", location: row.location ?? "" })),
  };
  const fixtureKey = sha256(JSON.stringify({ ids, profile_hash: context.profileHash, resume_hash: context.resumeHash, model, system: SYSTEM_PROMPT }), 32);
  const fixturePath = path.join(fixtureDir, `${fixtureKey}.json`);
  let usage: ClaudeResult;
  try {
    usage = JSON.parse(await fs.readFile(fixturePath, "utf8")) as ClaudeResult;
  } catch {
    if (replayOnly) throw new Error(`generic-agent replay fixture is unavailable: ${fixtureKey}`);
    const args = [
    "-p", "--output-format", "json", "--no-session-persistence", "--permission-prompts", "none",
    "--disable-slash-commands", "--setting-sources", "", "--exclude-dynamic-system-prompt-sections",
    "--tools", "", "--system-prompt", SYSTEM_PROMPT, "--model", model,
    "--max-budget-usd", "1", "--json-schema", JSON.stringify(outputSchema(ids, context.resumes.map((resume) => resume.id))),
    JSON.stringify(request),
    ];
    let lastError = "unknown Claude CLI failure";
    let completed: ClaudeResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { stdout } = await execFileAsync(process.env.CLAUDE_BIN ?? "claude", args, {
          cwd: repoPath(), env: process.env, maxBuffer: 20 * 1024 * 1024,
        });
        completed = JSON.parse(stdout) as ClaudeResult;
        break;
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        try {
          const payload = JSON.parse(failure.stdout ?? "") as ClaudeResult;
          lastError = (payload.errors ?? [payload.result ?? failure.stderr ?? failure.message]).join("; ");
        } catch {
          lastError = (failure.stderr || failure.message).trim().slice(0, 1000);
        }
        if (attempt === 2) throw new Error(`generic-agent comparator CLI failed after 2 attempts: ${lastError}`);
      }
    }
    usage = completed!;
  }
  if (usage.is_error) throw new Error(`generic-agent comparator failed: ${(usage.errors ?? [usage.result ?? "unknown error"]).join("; ")}`);
  const decisions = usage.structured_output?.decisions;
  if (!Array.isArray(decisions)) throw new Error("generic-agent comparator returned no structured decisions");
  const returnedIds = decisions.map((decision) => decision.id);
  if (new Set(returnedIds).size !== ids.length || ids.some((id) => !returnedIds.includes(id))) {
    throw new Error(`generic-agent comparator returned an invalid id set for batch: ${ids.join(",")}`);
  }
  for (const decision of decisions) {
    if (decision.discipline_fit === "outside") decision.matched_resume_id = null;
    if (decision.discipline_fit !== "outside" && !decision.matched_resume_id) {
      throw new Error(`${decision.id}: generic-agent comparator omitted the resume for ${decision.discipline_fit}`);
    }
  }
  let fixtureHit = true;
  try {
    await fs.access(fixturePath);
  } catch {
    fixtureHit = false;
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(fixturePath, JSON.stringify(usage, null, 2) + "\n");
  }
  return { decisions, usage, fixture_hit: fixtureHit };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, fallback: string) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const idsFile = arg("--ids-file", "docs/benchmarks/jev-cohort.json");
  const outFile = arg("--out", "docs/benchmarks/jev-agent-comparator.json");
  const model = arg("--model", "sonnet");
  const batchSize = Number(arg("--batch-size", "5"));
  const concurrency = Number(arg("--concurrency", "2"));
  const replayOnly = argv.includes("--replay");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 30) throw new Error("--batch-size must be an integer from 1 to 30");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("--concurrency must be an integer from 1 to 4");

  const ids = new Set<string>(JSON.parse(await fs.readFile(repoPath(idsFile), "utf8")));
  const rows = (await load()).filter((row) => ids.has(row.id));
  if (rows.length !== ids.size) throw new Error(`frozen cohort has ${ids.size} ids but only ${rows.length} pipeline rows`);
  const [context, identity] = await Promise.all([currentClassificationContext(), currentJevCacheIdentity()]);
  const batches = chunks(rows, batchSize);
  const fixtureDir = repoPath("state/jev/agent-comparator");
  const started = Date.now();
  const outputs = await concurrentMap(batches, concurrency, (batch) => classifyBatch(batch, context, model, fixtureDir, replayOnly));
  const wallMs = Date.now() - started;
  const decisions = outputs.flatMap((output) => output.decisions);

  const usageByModel = new Map<string, { input_tokens: number; output_tokens: number; thinking_tokens: number; cost_usd: number; canonical_model: string | null }>();
  for (const output of outputs) {
    for (const [name, usage] of Object.entries(output.usage.modelUsage ?? {})) {
      const prior = usageByModel.get(name) ?? { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cost_usd: 0, canonical_model: usage.canonicalModel ?? null };
      prior.input_tokens += (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
      prior.output_tokens += usage.outputTokens ?? 0;
      prior.thinking_tokens += usage.thinkingTokens ?? 0;
      prior.cost_usd += usage.costUSD ?? 0;
      usageByModel.set(name, prior);
    }
  }
  const inputTokens = [...usageByModel.values()].reduce((sum, usage) => sum + usage.input_tokens, 0);
  const outputTokens = [...usageByModel.values()].reduce((sum, usage) => sum + usage.output_tokens, 0);
  const recordedCostUsd = outputs.reduce((sum, output) => sum + (output.usage.total_cost_usd ?? 0), 0);
  const actualCostUsd = outputs.filter((output) => !output.fixture_hit).reduce((sum, output) => sum + (output.usage.total_cost_usd ?? 0), 0);
  const apiMs = outputs.reduce((sum, output) => sum + (output.usage.duration_api_ms ?? 0), 0);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const records = decisions.map((decision) => {
    const row = byId.get(decision.id)!;
    return {
      ...decision,
      profile_relevance: RELEVANCE[decision.discipline_fit][decision.evidence_strength],
      operational_label: operationalLabel(row),
      content_hash: classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location }),
    };
  });
  const labelled = records.filter((record) => record.operational_label !== "unlabelled");
  const falseLow = labelled.filter((record) => record.operational_label === "apply_worthy" && (record.discipline_fit === "outside" || !record.matched_resume_id));
  const falseHigh = labelled.filter((record) => record.operational_label === "not_apply_worthy" && record.discipline_fit !== "outside" && Boolean(record.matched_resume_id));
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    measurement_schema: "jev-agent-comparator-v1",
    decider: "supported generic-agent ClassificationV2 fallback",
    model_requested: model,
    context: {
      policy_hash: identity.policyHash,
      profile_hash: identity.profileHash,
      resume_set_hash: identity.resumeHash,
      content_set_hash: sha256(records.map((record) => record.content_hash).sort().join("\n")),
    },
    execution: {
      platform: process.platform, architecture: process.arch, node: process.version, concurrency, batch_size: batchSize, batches: batches.length,
      mode: replayOnly ? "replay" : outputs.some((output) => !output.fixture_hit) ? "record" : "cached",
      recorded_batches: outputs.filter((output) => !output.fixture_hit).length,
      replayed_batches: outputs.filter((output) => output.fixture_hit).length,
    },
    metrics: {
      cohort_size: rows.length,
      measured_decisions: records.length,
      generic_agent_input_tokens: inputTokens,
      generic_agent_output_tokens: outputTokens,
      generic_agent_total_tokens: inputTokens + outputTokens,
      generic_agent_cost_usd: Number(actualCostUsd.toFixed(6)),
      recorded_agent_cost_usd: Number(recordedCostUsd.toFixed(6)),
      classification_wall_ms: wallMs,
      summed_api_ms: apiMs,
      cost_per_100_changed_rows_usd: Number((actualCostUsd / rows.length * 100).toFixed(6)),
      tokens_per_100_changed_rows: Math.round((inputTokens + outputTokens) / rows.length * 100),
    },
    quality_proxy: {
      labelled: labelled.length,
      apply_worthy_false_low: falseLow.length,
      apply_worthy_false_low_ids: falseLow.map((record) => record.id),
      known_negative_false_high: falseHigh.length,
      known_negative_false_high_ids: falseHigh.map((record) => record.id),
      label_basis: "submitted-or-later is apply-worthy; historical outside at relevance <=25 in discovered/rejected is not-apply-worthy; this is not human ground truth",
    },
    model_usage: Object.fromEntries([...usageByModel].map(([name, usage]) => [name, { ...usage, cost_usd: Number(usage.cost_usd.toFixed(6)) }])),
    records,
  };
  const out = repoPath(outFile);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ out, cohort: rows.length, batches: batches.length, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: report.metrics.generic_agent_cost_usd, recorded_cost_usd: report.metrics.recorded_agent_cost_usd, wall_ms: wallMs, false_low: falseLow.length, false_high: falseHigh.length }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
