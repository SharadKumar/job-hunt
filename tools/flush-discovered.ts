#!/usr/bin/env tsx

/**
 * flush-discovered.ts — prune pipeline rows that never earned their place.
 *
 * The old version removed EVERY `discovered` row, including ones imported an
 * hour ago that the next hunt would have scored. Flushing is now opt-in per
 * axis and defaults to dry-run:
 *
 *   --older-than <Nd>   only rows first seen more than N days ago (also Nh, Nw)
 *   --unclassified      only rows with no agent classification
 *   --below-score <n>   only rows scored under n (rows with no score never match)
 *   --all-unsubmitted   widen the base scope from `discovered` to every status
 *                       that has not reached submission
 *   --apply             actually remove (default is a dry run)
 *
 * Filters are ANDed. With no filter at all the base scope is the whole of
 * `discovered`, which is the old behaviour and is why `--apply` is opt-in.
 *
 * Removal goes through `remove()`, so each row gets a history entry and an
 * audit event naming this tool. A JSON snapshot of the removed rows is still
 * written beside the database (state/pipeline/archive/) so a mistaken flush can
 * be reconstructed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { list, remove, type Opportunity } from "./pipeline.ts";
import { store } from "./pipeline-store.ts";
import { parseArgs } from "./lib/args.ts";

const PRESERVED = new Set(["submitted", "responded", "interview", "offered", "won"]);

const UNITS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

/** `14d`, `36h`, `2w` or a bare number of days → milliseconds. Throws on junk. */
export function parseAge(spec: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([hdw]?)$/i.exec(spec.trim());
  if (!match) throw new Error(`--older-than: expected a duration like 14d, got "${spec}"`);
  return Number(match[1]) * UNITS[(match[2] || "d").toLowerCase()];
}

/** True when nothing but the regex fallback (or nothing at all) has judged the row. */
export function isUnclassified(role: Opportunity): boolean {
  return !role.classification || role.classificationSource !== "agent";
}

function num(value: string | boolean | undefined, flag: string): number {
  if (typeof value !== "string" || value.trim() === "" || Number.isNaN(Number(value))) {
    throw new Error(`${flag}: expected a number, got "${String(value)}"`);
  }
  return Number(value);
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const apply = flags.apply === true;
  const allUnsubmitted = flags["all-unsubmitted"] === true;
  const unclassifiedOnly = flags.unclassified === true;

  const maxAgeMs = flags["older-than"] !== undefined
    ? parseAge(String(flags["older-than"]))
    : null;
  const belowScore = flags["below-score"] !== undefined
    ? num(flags["below-score"] as string, "--below-score")
    : null;

  const roles = allUnsubmitted
    ? (await list()).filter((role) => !PRESERVED.has(role.status))
    : await list({ status: "discovered" });

  // Age comes from the store's `first_seen_at` (itself the earliest history
  // entry), asked for as its complement: the store can only filter for rows
  // seen SINCE a cutoff, so anything not in that set is older than it.
  let young: Set<string> | null = null;
  if (maxAgeMs !== null) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    young = new Set((await list({ firstSeenSince: cutoff })).map((role) => role.id));
  }

  const matched = roles.filter((role) => {
    if (young?.has(role.id)) return false;
    if (unclassifiedOnly && !isUnclassified(role)) return false;
    if (belowScore !== null && !(typeof role.score === "number" && role.score < belowScore)) return false;
    return true;
  });

  const reason = [
    allUnsubmitted ? "scope=all-unsubmitted" : "scope=discovered",
    maxAgeMs === null ? null : `older-than=${flags["older-than"]}`,
    unclassifiedOnly ? "unclassified" : null,
    belowScore === null ? null : `below-score=${belowScore}`,
  ].filter(Boolean).join(" ");

  let snapshot: string | null = null;
  let removed = 0;

  if (apply && matched.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveDir = path.join(path.dirname(store().path), "archive");
    snapshot = path.join(archiveDir, `discovery-flush-${stamp}.json`);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(snapshot, JSON.stringify(matched, null, 2));
    ({ removed } = await remove(matched.map((role) => role.id), "flush-discovered", reason));
  }

  console.log(JSON.stringify({
    dry_run: !apply,
    matched: matched.length,
    removed,
    snapshot,
    scope: allUnsubmitted ? "all-unsubmitted" : "discovered-only",
    filters: reason,
    matchedByChannel: matched.reduce<Record<string, number>>((counts, role) => {
      counts[role.channel] = (counts[role.channel] ?? 0) + 1;
      return counts;
    }, {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
