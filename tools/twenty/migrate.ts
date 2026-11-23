#!/usr/bin/env tsx
/**
 * migrate.ts — one-time move of pipeline rows from SQLite into Twenty (plan F12).
 *
 *   tsx tools/twenty/migrate.ts --dry-run                 # counts only, writes nothing
 *   tsx tools/twenty/migrate.ts --apply                   # writes to TWENTY_API_URL
 *
 * Scope (owner, Q4): every row a person or a package touched. That is every
 * row not rejected or withdrawn, plus rejected or withdrawn rows that reached
 * a drafted-or-later status, were saved by the person, were parked by the
 * person, or have a package archive. Auto-rejected rows stay in SQLite and
 * can be imported later.
 *
 * Rules: create missing records only (never overwrite, never delete); every
 * migrated record carries migratedAt so workflows skip it; a second run plans
 * 0 creates. --apply refuses to run while TWENTY_API_URL is unset.
 *
 * Prints one JSON object (counts and skipped reasons, never row contents).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Opportunity } from "../pipeline.ts";
import { sqliteBackend } from "../store/sqlite-backend.ts";
import { repoPath } from "../repo-root.ts";

const TOUCHED = new Set([
  "drafted", "awaiting_approval", "approved", "submission_pending", "submitted",
  "responded", "interview", "offered", "won", "manual_action_needed",
]);

export function inScope(row: Opportunity, hasArchive: (id: string) => boolean): { keep: boolean; why: string } {
  if (row.status !== "rejected" && row.status !== "withdrawn") return { keep: true, why: "active" };
  if ((row.history ?? []).some((h) => TOUCHED.has(String(h.to)))) return { keep: true, why: "reached a package status" };
  if (row.userSaved) return { keep: true, why: "saved by the person" };
  if (row.parkedBy === "user") return { keep: true, why: "parked by the person" };
  if (hasArchive(row.id)) return { keep: true, why: "has a package archive" };
  return { keep: false, why: "auto-rejected, never touched" };
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const rows = await sqliteBackend().list({ withDescription: apply });
  const archive = repoPath("state", "pipeline", "archive");
  const hasArchive = (id: string) => existsSync(path.join(archive, id));
  const counts: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const keep: Opportunity[] = [];
  for (const row of rows) {
    const v = inScope(row, hasArchive);
    counts[v.why] = (counts[v.why] ?? 0) + 1;
    if (v.keep) { keep.push(row); byStatus[row.status] = (byStatus[row.status] ?? 0) + 1; }
  }

  const report: Record<string, unknown> = { mode: apply ? "apply" : "dry-run", source_rows: rows.length, in_scope: keep.length, by_reason: counts, in_scope_by_status: byStatus };
  if (!apply) {
    console.log(JSON.stringify({ ok: true, ...report }));
    return 0;
  }

  if (!process.env.TWENTY_API_URL) {
    console.log(JSON.stringify({ ok: false, error: "--apply needs TWENTY_API_URL and TWENTY_API_KEY (the target workspace)" }));
    return 2;
  }
  const { twentyBackend } = await import("../store/twenty-backend.ts");
  const target = await twentyBackend();
  const migratedAt = new Date().toISOString();
  let created = 0;
  let existing = 0;
  const ops = [];
  for (const row of keep) {
    if (await target.has(row.id)) { existing++; continue; }
    ops.push({ kind: "insert" as const, row: { ...row, migratedAt } as Opportunity });
    created++;
  }
  for (let i = 0; i < ops.length; i += 60) await target.upsert(ops.slice(i, i + 60));
  console.log(JSON.stringify({ ok: true, ...report, created, already_present: existing }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
