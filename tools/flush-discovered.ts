#!/usr/bin/env tsx

/**
 * Remove only pipeline rows that have never advanced beyond `discovered`.
 * Defaults to dry-run. `--apply` writes a recoverable JSON snapshot first.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { load, save } from "./pipeline.ts";
import { repoPath } from "./repo-root.ts";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const allUnsubmitted = process.argv.includes("--all-unsubmitted");
  const roles = await load();
  const preservedStatuses = new Set(["submitted", "responded", "interview", "offered", "won"]);
  const shouldRemove = (status: string) => allUnsubmitted ? !preservedStatuses.has(status) : status === "discovered";
  const removed = roles.filter((role) => shouldRemove(role.status));
  const kept = roles.filter((role) => !shouldRemove(role.status));

  let backupPath: string | null = null;
  if (apply && removed.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(repoPath("state/pipeline/archive"), `discovery-flush-${stamp}.json`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, JSON.stringify(removed, null, 2));
    await save(kept);
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    scope: allUnsubmitted ? "all-unsubmitted" : "discovered-only",
    removed: removed.length,
    kept: kept.length,
    backupPath,
    removedByChannel: removed.reduce<Record<string, number>>((counts, role) => {
      counts[role.channel] = (counts[role.channel] ?? 0) + 1;
      return counts;
    }, {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
