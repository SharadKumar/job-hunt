/**
 * paths.ts: where runtime files go, by store (plan F10, "What stays in state/").
 *
 * File mode (HARNESS_STORE unset or sqlite) keeps every path exactly as it
 * was: state/pipeline/..., state/journal/..., state/org/....
 *
 * Twenty mode keeps no person-facing file on disk:
 *   - package work (letters, rendered CVs, screenshots) is built in the run
 *     cache, state/cache/run-<id>/archive/<opening>/; the person-facing copy
 *     is the application record and its attachments in Twenty, downloaded at
 *     materialise for openings in an active state and uploaded at finish
 *     (tools/store/artefacts.ts);
 *   - pipeline side files (queues, candidate lists) are runtime state in
 *     state/cache/pipeline/;
 *   - journals and run reports are logs in state/logs/journal/; the person
 *     reads the run record in Twenty (tools/store/runs.ts);
 *   - shared documents (keyword clouds) come from the run's materialised
 *     documents (tools/store/documents.ts).
 */

import path from "node:path";
import { repoRoot } from "../repo-root.ts";
import { currentProfileDir, currentRunDir, isTwentyStore } from "./documents.ts";

/** Root of the per-opportunity package folders. */
export function archiveRoot(): string {
  return isTwentyStore()
    ? path.join(currentRunDir(), "archive")
    : path.join(repoRoot(), "state", "pipeline", "archive"); // scan:file-mode
}

/**
 * A file named in package metadata (a baseline reference such as
 * metadata.resume.ref), as an absolute path. File mode resolves it against
 * the repo root, as always. Twenty mode maps a path inside any run cache, or
 * a legacy profile path recorded before the migration, onto this run's cache,
 * where the same file was materialised.
 */
export function resolveRepoRef(ref: string): string {
  if (!isTwentyStore()) return path.isAbsolute(ref) ? ref : path.join(repoRoot(), ref);
  const posix = ref.split(path.sep).join("/");
  const inRun = posix.match(/(?:^|\/)state\/cache\/run-[A-Za-z0-9-]+\/(.+)$/);
  if (inRun) return path.join(currentRunDir(), ...inRun[1].split("/"));
  const legacy = posix.match(/(?:^|\/)state\/profiles?\/(?:[^/]+\/)?(resumes\/.+|cv\/.+)$/); // scan:label
  if (legacy) return path.join(currentProfileDir(null), ...legacy[1].split("/"));
  return path.isAbsolute(ref) ? ref : path.join(repoRoot(), ref);
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
