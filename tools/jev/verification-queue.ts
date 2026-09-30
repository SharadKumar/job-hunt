#!/usr/bin/env tsx

/**
 * Small generative-verification queue for the daily back half.
 *
 * Jev remains the bulk classifier. The ordinary queue contains core automatic
 * candidates that need the supported in-agent decision before unattended
 * application. The parachute adds only high-scoring adjacent/platform-gap
 * near misses, because the corrected benchmark found one historically
 * submitted role the core-only rule would have dropped. It never reviews all
 * Jev rejections.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import { load, type Opportunity } from "../pipeline.ts";
import { repoPath } from "../repo-root.ts";

export type VerificationCandidate = {
  id: string;
  title: string;
  company: string;
  channel: string;
  score: number | null;
  discipline_fit: string;
  matched_resume_id: string | null;
  user_saved: boolean;
  reason: "positive_candidate" | "near_miss_parachute" | "saved_job";
};

type SubmissionPolicy = {
  kill_switch?: boolean;
  autopilot?: { enabled?: boolean; channels?: string[] };
  channels?: Record<string, { auto_submit?: boolean }>;
};

function isOneClick(row: Opportunity): boolean {
  if (row.channel === "seek") return row.applyMethod !== "external";
  if (row.channel === "linkedin_jobs") return row.applyMethod === "easy_apply";
  return false;
}

export function verificationCandidates(
  rows: Opportunity[],
  policy: SubmissionPolicy,
  shortlistMin: number,
): VerificationCandidate[] {
  if (policy.kill_switch || policy.autopilot?.enabled !== true) return [];
  const enabled = new Set(policy.autopilot?.channels ?? []);
  const active = new Set([
    "discovered", "shortlisted", "drafted", "awaiting_approval", "approved",
    "submission_pending", "manual_action_needed",
  ]);
  const out: VerificationCandidate[] = [];
  for (const row of rows) {
    const c = row.classification;
    if (!active.has(row.status) || !enabled.has(row.channel) || policy.channels?.[row.channel]?.auto_submit !== true || !isOneClick(row)) continue;
    const saved = row.userSaved === true;
    if (saved) {
      out.push({
        id: row.id, title: row.title, company: row.company, channel: row.channel,
        score: row.score ?? null, discipline_fit: c?.discipline_fit ?? "unclassified",
        matched_resume_id: c?.matched_resume_id ?? null, user_saved: true, reason: "saved_job",
      });
      continue;
    }
    if (!c || c.source !== "jev" || c.status !== "automatic") continue;
    if (row.red_flag_blocker && !row.userSaved) continue;
    const positive = c.discipline_fit === "core" && Boolean(c.matched_resume_id);
    const nearMiss = ["platform_gap", "adjacent"].includes(c.discipline_fit)
      && Boolean(c.matched_resume_id)
      && (row.score ?? -1) >= shortlistMin;
    if (!positive && !nearMiss) continue;
    out.push({
      id: row.id, title: row.title, company: row.company, channel: row.channel,
      score: row.score ?? null, discipline_fit: c.discipline_fit,
      matched_resume_id: c.matched_resume_id, user_saved: false,
      reason: positive ? "positive_candidate" : "near_miss_parachute",
    });
  }
  const reasonRank: Record<VerificationCandidate["reason"], number> = {
    saved_job: 0, positive_candidate: 1, near_miss_parachute: 2,
  };
  return out.sort((a, b) => Number(b.user_saved) - Number(a.user_saved)
    || reasonRank[a.reason] - reasonRank[b.reason]
    || (b.score ?? -1) - (a.score ?? -1)
    || a.id.localeCompare(b.id));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limitAt = argv.indexOf("--limit");
  const limit = limitAt >= 0 ? Math.max(1, Number(argv[limitAt + 1]) || 1) : 30;
  const [policyRaw, weightsRaw, rows] = await Promise.all([
    fs.readFile(repoPath("state/profile/submission-policy.yaml"), "utf8"),
    fs.readFile(repoPath("state/profile/scoring-weights.yaml"), "utf8"),
    load(),
  ]);
  const policy = YAML.parse(policyRaw) as SubmissionPolicy;
  const weights = YAML.parse(weightsRaw) as { thresholds?: { shortlist_min_score?: number } };
  const all = verificationCandidates(rows, policy, weights.thresholds?.shortlist_min_score ?? 55);
  const candidates = all.slice(0, limit);
  console.log(JSON.stringify({
    ok: true,
    candidates,
    total: all.length,
    shown: candidates.length,
    by_reason: Object.fromEntries(["saved_job", "positive_candidate", "near_miss_parachute"].map((reason) => [reason, all.filter((item) => item.reason === reason).length])),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(JSON.stringify({ ok: false, error: (error as Error).message })); process.exit(1); });
}
