#!/usr/bin/env tsx
/**
 * rescore-pipeline.ts — re-score every opportunity in opportunities.json.
 *
 * Applies the ClassificationV2 already persisted on each SQLite row. It never
 * reads an external classification map and never invents a fallback.
 *
 * Usage: tsx tools/rescore-pipeline.ts [--ids-file path] [--all] [--limit N] [--dry-run]
 */

import { promises as fs } from "node:fs";
import { load, patchMany, setStatus, type Opportunity, type PipelineStatus } from "./pipeline.ts";
import { scoreRole } from "./score.ts";
import { canPromoteFromClassification } from "./classification.ts";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";

type ScoreRoleResult = Awaited<ReturnType<typeof scoreRole>>;

/**
 * The unsubmitted statuses a rescore may reconcile. Work already done remains
 * in the archive and history, but it must not pin a role in an operational
 * queue after the current decision can no longer justify it. Submitted and
 * later rows are outcomes and are never rewound by classification.
 */
export const RESCORE_MUTABLE_STATUSES: PipelineStatus[] = [
  "discovered", "shortlisted", "parked", "drafted", "awaiting_approval", "approved", "manual_action_needed",
];

export type RescoreOutcome = "promoted" | "demoted" | "unchanged" | "left_parked" | "skipped_protected";

export type RescoreDecision = {
  status: PipelineStatus;
  parkedReason?: string;
  outcome: RescoreOutcome;
  reason?: string;
};

/** Only known legacy machine holds are released automatically. Other holds
 * remain protected, including an explicit user hold overriding a legacy reason. */
export function isUserHold(row: Opportunity): boolean {
  if (row.status !== "parked") return false;
  if (row.parkedBy === "user") return true;
  if (row.parkedBy === "harness") return false;
  return !/^interstate (?:onsite\b|\([^\n]*\) with card-only blurb; location flexibility unknown$)/i.test(row.parkedReason ?? "");
}

/**
 * Decide where a rescored row belongs. Pure: the caller performs the move via
 * `setStatus` so the transition table, history and audit log all apply.
 *
 * - Explicit user holds are protected. Known legacy automatic location holds
 *   are reconciled, not mistaken for a user instruction.
 * - Any status outside `RESCORE_MUTABLE_STATUSES` is protected: scores may be
 *   refreshed under `--all`, the status is never touched.
 * - Only an automatic core-discipline ClassificationV2 decision from Jev or
 *   the supported in-agent fallback may enter or remain in an active queue.
 * - An uncertain or no-longer-eligible decision demotes an unsubmitted active
 *   row to `discovered`. It is retained for audit and can earn its way back.
 * - A saved job remains an order to apply and is never demoted here.
 */
export function rescoreStatusDecision(
  opportunity: Opportunity,
  result: Pick<ScoreRoleResult, "score" | "red_flag_blocker" | "ineligible_reason" | "classification">,
  shortlistMin: number,
): RescoreDecision {
  const current = opportunity.status;
  const keep = (outcome: RescoreOutcome): RescoreDecision => ({ status: current, parkedReason: opportunity.parkedReason, outcome });

  if (isUserHold(opportunity)) return keep("left_parked");
  if (!RESCORE_MUTABLE_STATUSES.includes(current)) return keep("skipped_protected");

  // A user-saved SEEK job is an order to apply (user, 2026-09-15): it always
  // sits in the queue whatever the score, band or location. The submission
  // gate still enforces the hard employment blocks at send time.
  if (opportunity.userSaved) {
    if (current === "discovered" || current === "shortlisted" || current === "parked") {
      return current === "shortlisted"
        ? keep("unchanged")
        : { status: "shortlisted", outcome: "promoted" };
    }
    return keep("unchanged");
  }

  if (result.ineligible_reason) return {
    status: current === "approved" ? "withdrawn" : "rejected",
    outcome: "demoted", reason: result.ineligible_reason,
  };

  const classificationEligible = canPromoteFromClassification(result.classification)
    && result.classification.discipline_fit === "core";
  const scoreEligible = !result.red_flag_blocker && result.score >= shortlistMin;
  if (!classificationEligible || !scoreEligible) {
    if (current === "discovered") return keep("unchanged");
    return { status: "discovered", outcome: "demoted" };
  }

  // Once a still-eligible role has entered package preparation or a genuine
  // manual blocker, scoring must not erase that work or its next action.
  if (["drafted", "awaiting_approval", "approved", "manual_action_needed"].includes(current)) {
    return keep("skipped_protected");
  }

  const target: PipelineStatus = "shortlisted";
  const parkedReason = undefined;
  if (target === current) return { status: current, parkedReason, outcome: "unchanged" };
  return { status: target, parkedReason, outcome: target === "shortlisted" ? "promoted" : "demoted" };
}

export function opportunityWithScoreResult(opportunity: Opportunity, result: ScoreRoleResult, shortlistMin: number): Opportunity {
  const decision = rescoreStatusDecision(opportunity, result, shortlistMin);
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
    status: decision.status,
    parkedReason: decision.parkedReason,
    parkedBy: decision.status === "parked" ? opportunity.parkedBy : undefined,
  };
}

/** Fields a rescore is allowed to write. Status is not one of them: it moves through `setStatus`. */
const RESCORE_FIELDS = [
  "workArrangement", "dayRate", "score", "scoreReasons", "red_flag_blocker",
  "classification", "resumeId", "parkedReason", "parkedBy",
] as const;

export function rescoreFieldPatch(before: Opportunity, after: Opportunity): Partial<Opportunity> {
  const fields: Record<string, unknown> = {};
  for (const key of RESCORE_FIELDS) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) fields[key] = after[key];
  }
  return fields as Partial<Opportunity>;
}

export type RescoreCounts = { promoted: number; demoted: number; left_parked: number; skipped_protected: number };

/**
 * Apply a batch of rescore results to the pipeline. Deterministic field
 * updates land in one `patchMany` transaction; each status move goes through
 * `setStatus`, so the transition table, the row's history and the audit log
 * all see it. The former whole-array `save()` wrote none of that, and could
 * rewind a drafted or awaiting_approval row to `discovered`.
 */
export async function applyRescore(
  entries: { before: Opportunity; result: ScoreRoleResult }[],
  shortlistMin: number,
  opts: { dryRun?: boolean } = {},
): Promise<RescoreCounts> {
  const counts: RescoreCounts = { promoted: 0, demoted: 0, left_parked: 0, skipped_protected: 0 };
  const decided = entries.map(({ before, result }) => ({
    before,
    after: opportunityWithScoreResult(before, result, shortlistMin),
    decision: rescoreStatusDecision(before, result, shortlistMin),
  }));
  for (const { decision } of decided) {
    if (decision.outcome === "left_parked" || decision.outcome === "skipped_protected") counts[decision.outcome]++;
  }
  if (opts.dryRun || !decided.length) {
    // Nothing is written, so report the intent.
    for (const { decision } of decided) {
      if (decision.outcome === "promoted" || decision.outcome === "demoted") counts[decision.outcome]++;
    }
    return counts;
  }

  const patches = decided
    .map(({ before, after }) => ({ id: before.id, fields: rescoreFieldPatch(before, after) }))
    .filter((entry) => Object.keys(entry.fields).length > 0);
  if (patches.length) await patchMany(patches, "rescore");

  for (const { before, decision } of decided) {
    if (decision.status === before.status) continue;
    const reason = `rescore: ${before.status} → ${decision.status}`
      + (decision.reason ? ` (${decision.reason})` : "")
      + (decision.parkedReason ? ` (${decision.parkedReason})` : "");
    try {
      await setStatus(before.id, decision.status, reason, { actor: "rescore" });
      if (decision.outcome === "promoted" || decision.outcome === "demoted") counts[decision.outcome]++;
    } catch (e) {
      // The transition table is the authority: a move it refuses leaves the
      // row where it is rather than being forced through.
      console.error(`[rescore] status move refused for ${before.id}: ${(e as Error).message}`);
    }
  }
  return counts;
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

export function validateRescoreArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--help", "-h", "--all", "--dry-run"].includes(arg)) continue;
    if (arg === "--ids-file" || arg === "--limit") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      if (arg === "--limit" && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error("--limit must be a positive integer");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  validateRescoreArgs(argv);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(JSON.stringify({ usage: "pipeline:rescore [--ids-file path] [--all] [--limit N] [--dry-run]", mutates: false }));
    return;
  }
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
  const weights = YAML.parse(await fs.readFile(repoPath("state/profile/scoring-weights.yaml"), "utf8"));
  const shortlistMin = weights.thresholds?.shortlist_min_score ?? 55;

  const roles = await load();
  const eligibleStatuses: PipelineStatus[] = all
    ? RESCORE_MUTABLE_STATUSES
    : ["discovered", "shortlisted", "parked"];
  if (targetIds) {
    const pipelineIds = new Set(roles.map((role) => role.id));
    const missingPipelineIds = requestedIds!.filter((id) => !pipelineIds.has(id));
    if (missingPipelineIds.length) {
      throw new Error(`--ids-file contains ${missingPipelineIds.length} ids absent from the pipeline: ${missingPipelineIds.slice(0, 5).join(", ")}`);
    }
  }
  const opportunities = selectOpportunitiesForRescore(roles, eligibleStatuses, targetIds, limit);
  console.error(`[rescore] re-scoring ${opportunities.length} opportunities${idsPath ? ` selected by ${idsPath}` : ""} (shortlist threshold = ${shortlistMin})`);

  const before: Record<string, number> = Object.fromEntries(opportunities.map((r) => [r.id, r.score ?? 0]));
  const changes: { opportunity: Opportunity; oldScore: number; newScore: number; newClass: any }[] = [];
  const writeQueue: { before: Opportunity; result: ScoreRoleResult }[] = [];

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
        }, r.classification);
        changes.push({ opportunity: r, oldScore: before[r.id], newScore: result.score, newClass: result.classification });
        writeQueue.push({ before: r, result });
      } catch (e) {
        console.error(`[rescore] failed ${r.id}: ${(e as Error).message}`);
      }
      completed++;
      if (completed % 20 === 0 || completed === opportunities.length) console.error(`[rescore] ${completed}/${opportunities.length}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const counts = await applyRescore(writeQueue, shortlistMin, { dryRun });

  // Summary
  const big = changes.filter((c) => Math.abs(c.newScore - c.oldScore) >= 20).sort((a, b) => Math.abs(b.newScore - b.oldScore) - Math.abs(a.newScore - a.oldScore));
  console.log(JSON.stringify({
    rescored: changes.length,
    promoted: counts.promoted,
    demoted: counts.demoted,
    left_parked: counts.left_parked,
    skipped_protected: counts.skipped_protected,
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
