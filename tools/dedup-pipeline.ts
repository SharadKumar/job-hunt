#!/usr/bin/env tsx
/**
 * dedup-pipeline.ts — one-shot maintenance: re-canonicalise URLs in
 * opportunities.json and collapse rows that now share an id.
 *
 * Use after introducing url-canonical.ts (or any change to canonical
 * URL logic) to clean up historical duplicates that were ingested under
 * the older, looser rule. The script is idempotent.
 *
 * Merge policy when N rows collapse to the same canonical id:
 *   - Keep the row with the longest history (the one we've actually
 *     done the most with).
 *   - If tied on history, keep the row with the richest data
 *     (description length, score, scoreReasons present).
 *   - All other fields take the first non-null across all duplicates.
 *
 * Usage: tsx tools/dedup-pipeline.ts [--dry-run]
 */

import { load, save, opportunityIdFor, type Opportunity } from "./pipeline.ts";
import { canonicaliseUrl } from "./url-canonical.ts";

function mergeBest(rows: Opportunity[]): Opportunity {
  // Score each row by data richness so the best survivor wins.
  const score = (r: Opportunity) =>
    (r.history?.length ?? 0) * 100 +
    (r.score != null ? 10 : 0) +
    (r.scoreReasons?.length ?? 0) +
    (r.description?.length ?? 0) / 100;
  const sorted = [...rows].sort((a, b) => score(b) - score(a));
  const survivor = { ...sorted[0] };
  // Fill gaps from the others
  for (const r of sorted.slice(1)) {
    for (const k of Object.keys(r) as (keyof Opportunity)[]) {
      if (survivor[k] == null && r[k] != null) (survivor as any)[k] = r[k];
    }
  }
  return survivor;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const all = await load();
  console.error(`[dedup] loaded ${all.length} rows`);

  // Re-canonicalise + re-id every row
  const rebuilt: Opportunity[] = all.map((r) => {
    const canonUrl = canonicaliseUrl(r.channel, r.url);
    const newId = opportunityIdFor(r.channel, canonUrl);
    return { ...r, url: canonUrl, id: newId };
  });

  // Bucket by new id, then merge each bucket
  const byId = new Map<string, Opportunity[]>();
  for (const r of rebuilt) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id)!.push(r);
  }

  const merged: Opportunity[] = [];
  let collapsed = 0;
  for (const [id, rows] of byId) {
    if (rows.length === 1) merged.push(rows[0]);
    else {
      merged.push(mergeBest(rows));
      collapsed += rows.length - 1;
    }
  }

  const summary = {
    before: all.length,
    after: merged.length,
    collapsed,
    by_channel_before: countBy(all, "channel"),
    by_channel_after: countBy(merged, "channel"),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!dryRun && merged.length !== all.length) {
    await save(merged);
    console.error(`[dedup] wrote ${merged.length} rows to opportunities.json`);
  }
}

function countBy<T extends Record<string, any>>(arr: T[], key: keyof T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of arr) out[r[key]] = (out[r[key]] || 0) + 1;
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
