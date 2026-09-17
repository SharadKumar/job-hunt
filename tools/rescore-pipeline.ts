#!/usr/bin/env tsx
/**
 * rescore-pipeline.ts — re-score every opportunity in opportunities.json.
 *
 * Architecture: classifications come from the agent (in-agent reasoning).
 * This script applies them deterministically. Two modes:
 *
 *   1. --classifications <path>  Read a JSON file of {id: Classification}
 *      pre-computed by the agent. Each role gets scored against its
 *      grounded classification. This is the preferred flow.
 *
 *   2. (no flag)                 Use regex triage classification (fast,
 *      weak). Useful when you've just changed scoring-weights.yaml and
 *      want to see relative shifts without paying for LLM. Surface a
 *      clear warning that profile_relevance is the default neutral 50.
 *
 * Usage: tsx tools/rescore-pipeline.ts [--classifications path] [--ids-file path] [--all] [--limit N] [--dry-run]
 */

import { promises as fs } from "node:fs";
import { load, save, type Opportunity, type PipelineStatus } from "./pipeline.ts";
import { scoreRole } from "./score.ts";
import type { Classification } from "./classify-jd.ts";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";

type ScoreRoleResult = Awaited<ReturnType<typeof scoreRole>>;

export function classificationSource(classification: Classification | undefined): Opportunity["classificationSource"] {
  return classification?._classifier ?? "none";
}

export function opportunityWithScoreResult(opportunity: Opportunity, result: ScoreRoleResult, shortlistMin: number): Opportunity {
  const source = classificationSource(result.classification);
  const canPromote = source === "agent";
  // A user-saved SEEK job is an order to apply (user, 2026-09-15): it always
  // sits in the queue whatever the score, band or location. The submission
  // gate still enforces the hard employment blocks at send time.
  const nextStatus: PipelineStatus = canPromote
    ? (opportunity.userSaved
        ? "shortlisted"
        : result.red_flag_blocker || result.score < shortlistMin
          ? "discovered"
          : result.parked_reason ? "parked" : "shortlisted")
    : opportunity.status;
  const parkedReason = nextStatus === "parked" ? result.parked_reason : undefined;
  return {
    ...opportunity,
    workArrangement: (!opportunity.workArrangement || opportunity.workArrangement === "unknown")
      ? result.classification.work_arrangement
      : opportunity.workArrangement,
    dayRate: opportunity.dayRate ?? (result.classification.day_rate.stated_explicitly && result.classification.day_rate.min
      ? {
          min: result.classification.day_rate.min,
          max: result.classification.day_rate.max ?? result.classification.day_rate.min,
          currency: result.classification.day_rate.currency,
          inc_super: result.classification.day_rate.inc_super ?? undefined,
        }
      : undefined),
    score: result.score,
    scoreReasons: result.reasons,
    red_flag_blocker: result.red_flag_blocker,
    classification: result.classification,
    classificationSource: source,
    status: nextStatus,
    parkedReason,
  };
}

export function selectOpportunitiesForRescore(
  roles: Opportunity[],
  eligibleStatuses: PipelineStatus[],
  targetIds: ReadonlySet<string> | null,
  limit: number,
): Opportunity[] {
  return roles
    .filter((role) => eligibleStatuses.includes(role.status) && (!targetIds || targetIds.has(role.id)))
    .slice(0, limit);
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const dryRun = argv.includes("--dry-run");
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;
  const idsIdx = argv.indexOf("--ids-file");
  const idsPath = idsIdx >= 0 ? argv[idsIdx + 1] : null;
  const requestedIds: string[] | null = idsPath
    ? JSON.parse(await fs.readFile(idsPath, "utf8"))
    : null;
  if (requestedIds && (!Array.isArray(requestedIds) || requestedIds.some((id) => typeof id !== "string"))) {
    throw new Error("--ids-file must contain a JSON array of opportunity ids");
  }
  const targetIds = requestedIds ? new Set(requestedIds) : null;
  const classIdx = argv.indexOf("--classifications");
  const classificationsPath = classIdx >= 0 ? argv[classIdx + 1] : null;
  const classifications: Record<string, Classification> = classificationsPath
    ? JSON.parse(await fs.readFile(classificationsPath, "utf8"))
    : {};
  if (!classificationsPath) {
    console.error("[rescore] no --classifications provided; using regex triage diagnostics only. profile_relevance defaults to 50 and status will not be promoted.");
  }

  const weights = YAML.parse(await fs.readFile(repoPath("state/profile/scoring-weights.yaml"), "utf8"));
  const shortlistMin = weights.thresholds?.shortlist_min_score ?? 55;

  const roles = await load();
  const eligibleStatuses: PipelineStatus[] = all
    ? (["discovered", "shortlisted", "parked", "drafted", "awaiting_approval"] as PipelineStatus[])
    : (["discovered", "shortlisted", "parked"] as PipelineStatus[]);
  if (targetIds) {
    const pipelineIds = new Set(roles.map((role) => role.id));
    const missingPipelineIds = requestedIds!.filter((id) => !pipelineIds.has(id));
    if (missingPipelineIds.length) {
      throw new Error(`--ids-file contains ${missingPipelineIds.length} ids absent from the pipeline: ${missingPipelineIds.slice(0, 5).join(", ")}`);
    }
    if (classificationsPath) {
      const missingClassificationIds = requestedIds!.filter((id) => !classifications[id]);
      if (missingClassificationIds.length) {
        throw new Error(`classification map is missing ${missingClassificationIds.length} targeted ids: ${missingClassificationIds.slice(0, 5).join(", ")}`);
      }
    }
  }
  const opportunities = selectOpportunitiesForRescore(roles, eligibleStatuses, targetIds, limit);
  console.error(`[rescore] re-scoring ${opportunities.length} opportunities${idsPath ? ` selected by ${idsPath}` : ""} (shortlist threshold = ${shortlistMin})`);

  const before: Record<string, number> = Object.fromEntries(opportunities.map((r) => [r.id, r.score ?? 0]));
  const changes: { opportunity: Opportunity; oldScore: number; newScore: number; newClass: any }[] = [];
  const upsertQueue: Opportunity[] = [];

  // Concurrency-limited fan-out: classify+score in parallel batches.
  // Haiku tolerates 10-20 concurrent requests comfortably; the bottleneck
  // becomes the prompt-cache hit rate, which we maximise by sharing the
  // same system prompt across all calls.
  const concurrency = 10;
  let completed = 0;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= opportunities.length) return;
      const r = opportunities[i];
      try {
        const result = await scoreRole({
          id: r.id, channel: r.channel, title: r.title, company: r.company,
          description: r.description ?? "", url: r.url, workArrangement: r.workArrangement,
          postedAt: r.postedAt, location: r.location, dayRate: r.dayRate,
        }, classifications[r.id] ?? r.classification);
        const newScore = result.score;
        changes.push({ opportunity: r, oldScore: before[r.id], newScore, newClass: result.classification });
        if (!dryRun) {
          // Queue upserts so we serialise file writes (opportunities.json is shared mutable state).
          upsertQueue.push(opportunityWithScoreResult(r, result, shortlistMin));
        }
      } catch (e) {
        console.error(`[rescore] failed ${r.id}: ${(e as Error).message}`);
      }
      completed++;
      if (completed % 20 === 0 || completed === opportunities.length) console.error(`[rescore] ${completed}/${opportunities.length}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Apply every deterministic score update with one atomic pipeline write.
  // The former serial-upsert loop reloaded and rewrote the whole pipeline once
  // per role (O(n²) I/O), which made large SEEK refreshes appear hung.
  if (!dryRun && upsertQueue.length) {
    const updates = new Map(upsertQueue.map((role) => [role.id, role]));
    await save(roles.map((role) => updates.get(role.id) ?? role));
  }

  // Summary
  const big = changes.filter((c) => Math.abs(c.newScore - c.oldScore) >= 20).sort((a, b) => Math.abs(b.newScore - b.oldScore) - Math.abs(a.newScore - a.oldScore));
  console.log(JSON.stringify({
    rescored: changes.length,
    biggest_changes: big.slice(0, 20).map((c) => ({
      id: c.opportunity.id,
      company: c.opportunity.company,
      title: c.opportunity.title.slice(0, 60),
      old: c.oldScore,
      new: c.newScore,
      delta: c.newScore - c.oldScore,
      relevance: c.newClass.profile_relevance,
      domain: c.newClass.detected_domain,
      reason: c.newClass.profile_relevance_reason,
    })),
    new_distribution: {
      "0-25": changes.filter((c) => c.newScore < 25).length,
      "25-50": changes.filter((c) => c.newScore >= 25 && c.newScore < 50).length,
      "50-70": changes.filter((c) => c.newScore >= 50 && c.newScore < 70).length,
      "70-100": changes.filter((c) => c.newScore >= 70).length,
    },
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
