#!/usr/bin/env tsx
/**
 * dedup-pipeline.ts — one-shot maintenance: re-canonicalise URLs across the
 * pipeline and collapse rows that now share an id.
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
 * It used to finish with the legacy whole-array `save(merged)`, which deleted
 * every row absent from the array with no audit event and no trace in any
 * row's history: a collapsed duplicate simply vanished. Now the survivor is
 * patched (carrying a `merged_from` reason into its own history) and the
 * losers go through `remove()`, which appends a removal entry and writes a
 * `withdrawn` audit event per row.
 *
 * Usage: tsx tools/dedup-pipeline.ts [--dry-run]
 */

import { load, get, patchMany, upsertMany, remove, opportunityIdFor, type Opportunity } from "./pipeline.ts";
import { canonicaliseUrl } from "./url-canonical.ts";

/** Fields the merge may carry onto the survivor; id/status/history are not patchable. */
const MERGEABLE_KEYS = (row: Opportunity): (keyof Opportunity)[] =>
  (Object.keys(row) as (keyof Opportunity)[]).filter((k) => k !== "id" && k !== "status" && k !== "history");

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

type Bucket = {
  /** Canonical id every row in the bucket now resolves to. */
  id: string;
  /** Merged row, carrying the canonical id and url. */
  survivor: Opportunity;
  /** Ids that existed on disk and must go away (never includes `id`). */
  loserIds: string[];
  /** True when no member already lived at the canonical id, so it must be inserted. */
  insert: boolean;
};

export function bucketise(all: Opportunity[]): Bucket[] {
  const byId = new Map<string, { row: Opportunity; originalId: string }[]>();
  for (const r of all) {
    const url = canonicaliseUrl(r.channel, r.url);
    const id = opportunityIdFor(r.channel, url);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push({ row: { ...r, url, id }, originalId: r.id });
  }

  const buckets: Bucket[] = [];
  for (const [id, members] of byId) {
    const anchored = members.some((m) => m.originalId === id);
    const loserIds = members.map((m) => m.originalId).filter((originalId) => originalId !== id);
    if (members.length === 1 && anchored) continue; // untouched row
    buckets.push({ id, survivor: mergeBest(members.map((m) => m.row)), loserIds, insert: !anchored });
  }
  return buckets;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const all = await load();
  console.error(`[dedup] loaded ${all.length} rows`);

  const buckets = bucketise(all);
  const collapsed = buckets.reduce((n, b) => n + b.loserIds.length, 0);
  const inserted = buckets.filter((b) => b.insert).length;

  const summary = {
    before: all.length,
    after: all.length - collapsed,
    collapsed,
    recanonicalised_ids: inserted,
    buckets: buckets.map((b) => ({ id: b.id, removing: b.loserIds, inserting: b.insert })),
    dry_run: dryRun,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun || !buckets.length) return;

  for (const bucket of buckets) {
    const reason = bucket.loserIds.length ? `merged_from: ${bucket.loserIds.join(", ")}` : "url re-canonicalised";
    if (bucket.insert) {
      // The canonical id has no row yet: create it, then record where it came from.
      await upsertMany([{ ...bucket.survivor, status: bucket.survivor.status }], { digest: false });
      await patchMany([{ id: bucket.id, fields: survivorFields(bucket.survivor), reason }], "dedup-pipeline");
    } else if (await get(bucket.id)) {
      await patchMany([{ id: bucket.id, fields: survivorFields(bucket.survivor), reason }], "dedup-pipeline");
    }
    if (bucket.loserIds.length) {
      await remove(bucket.loserIds, "dedup-pipeline", `merged into ${bucket.id}`);
    }
  }
  console.error(`[dedup] collapsed ${collapsed} row(s) into ${buckets.length} canonical id(s)`);
}

function survivorFields(survivor: Opportunity): Partial<Opportunity> {
  const fields: Partial<Opportunity> = {};
  for (const k of MERGEABLE_KEYS(survivor)) (fields as any)[k] = survivor[k];
  return fields;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
