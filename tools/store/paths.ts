/**
 * paths.ts: where runtime files go, by store (plan F10, "What stays in state/").
 *
 * File mode (HARNESS_STORE unset or sqlite) keeps every path exactly as it
 * was: state/pipeline/..., state/journal/..., state/org/....
 *
 * Twenty mode keeps no person-facing file on disk:
 *   - package work (letters, rendered CVs, screenshots) is built in
 *     state/cache/archive/<id>/, a render cache; the person-facing copy is the
 *     application record and its attachments in Twenty;
 *   - pipeline side files (queues, candidate lists) are runtime state in
 *     state/cache/pipeline/;
 *   - journals and run reports are logs in state/logs/journal/; the person
 *     reads the run record in Twenty (tools/store/runs.ts);
 *   - shared documents (keyword clouds) come from the run's materialised
 *     documents (tools/store/documents.ts).
 */

import path from "node:path";
import { repoRoot } from "../repo-root.ts";
import { currentProfileDir, isTwentyStore } from "./documents.ts";

/** Root of the per-opportunity package folders. */
export function archiveRoot(): string {
  return isTwentyStore()
    ? path.join(repoRoot(), "state", "cache", "archive")
    : path.join(repoRoot(), "state", "pipeline", "archive"); // scan:file-mode
}

/** One opportunity's package folder. */
export function archiveDir(id: string, ...rest: string[]): string {
  return path.join(archiveRoot(), id, ...rest);
}

/** A pipeline side file (queue, candidate list, curated groups). */
export function pipelineFile(...segments: string[]): string {
  return isTwentyStore()
    ? path.join(repoRoot(), "state", "cache", "pipeline", ...segments)
    : path.join(repoRoot(), "state", "pipeline", ...segments); // scan:file-mode
}

/** A journal, run report or run log path. */
export function journalPath(...segments: string[]): string {
  return isTwentyStore()
    ? path.join(repoRoot(), "state", "logs", "journal", ...segments)
    : path.join(repoRoot(), "state", "journal", ...segments); // scan:file-mode
}

/** A shared document that file mode keeps in state/org (keyword clouds). */
export function orgDocumentPath(file: string): string {
  return isTwentyStore() ? path.join(currentProfileDir(), file) : path.join(repoRoot(), "state", "org", file);
}

/**
 * CLI for skills and agents:
 *   tsx tools/store/paths.ts <profile|archive|pipeline|journal> [segments...]
 * prints { ok, store, path } for the current store.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, ...rest] = process.argv.slice(2);
  const resolvers: Record<string, (...s: string[]) => string> = {
    profile: (...s) => path.join(currentProfileDir(null), ...s),
    archive: (...s) => path.join(archiveRoot(), ...s),
    pipeline: (...s) => pipelineFile(...s),
    journal: (...s) => journalPath(...s),
  };
  const resolve = resolvers[kind ?? ""];
  if (!resolve) {
    console.log(JSON.stringify({ ok: false, error: "usage: paths.ts <profile|archive|pipeline|journal> [segments...]" }));
    process.exit(2);
  }
  if (isTwentyStore() && !process.env.HARNESS_RUN_ID && kind === "profile") {
    console.log(JSON.stringify({ ok: false, error: "HARNESS_STORE=twenty: no run cache; run `npm run -s store:materialise` and export HARNESS_RUN_ID first" }));
    process.exit(3);
  }
  console.log(JSON.stringify({ ok: true, store: isTwentyStore() ? "twenty" : "sqlite", path: resolve(...rest) }));
}
