#!/usr/bin/env tsx
/**
 * scan-file-access.ts: which code paths still read or write person-facing
 * files directly on the Twenty store (plan V22).
 *
 * Scans tools/, scripts/, .claude/skills/ and agents/ for references to the
 * files that move into Twenty: state/pipeline (archives included),
 * pipeline.db, opportunities.json, state/profile(s), state/journal and
 * approval-queue.json. The one-time migration, the SQLite store and this
 * scanner are excluded; tests live outside the scanned folders.
 *
 * What counts as direct:
 *   - a code line (comments are not accesses) or a prose line in a skill or
 *     agent that names one of those files;
 *   - except a line marked `scan:file-mode`: the file-mode branch of a store
 *     switch, counted separately as file_mode_hits;
 *   - except a line marked `scan:label`: a file name used only as a label (a
 *     provenance key or a prompt heading), counted as label_hits;
 *   - calls through the store's resolvers (resolveProfileContext,
 *     currentProfileDir, profilePath, archiveDir, pipelineFile, journalPath,
 *     orgDocumentPath) and the npm entry points that wrap them read the run's
 *     materialised cache or runtime paths on the Twenty store; they are
 *     counted as routed_hits, never as direct.
 *
 *   tsx tools/twenty/scan-file-access.ts           # JSON report, exit 0
 *   tsx tools/twenty/scan-file-access.ts --gate    # exit 1 while any direct hit remains
 *
 * Prints counts per path and per pattern, never file contents.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "../repo-root.ts";

/** Each pattern is one kind of person-facing file access. */
export const PATTERNS: Record<string, RegExp> = {
  pipeline_dir: /state\/pipeline\b|["']state["']\s*,\s*["']pipeline["']/,
  pipeline_db: /pipeline\.db\b/,
  opportunities_json: /opportunities\.json\b/,
  profile: /state\/profiles?\b|["']state["']\s*,\s*["']profiles?["']/,
  journal: /state\/journal\b|["']state["']\s*,\s*["']journal["']/,
  approval_queue: /approval-queue\.json\b/,
};

/** Calls and commands that go through the store's resolvers (not direct). */
export const ROUTED = /\b(resolveProfileContext|currentProfileDir|profilePath|archiveDir|archiveRoot|pipelineFile|journalPath|orgDocumentPath)\s*\(|npm run -s (profile:path|store:|journal\b)/;

/** Marks the file-mode branch of a store switch. */
export const FILE_MODE_MARK = "scan:file-mode";

/**
 * Marks a line that names a profile file only as a label (a provenance key
 * stored in compositions, or a heading inside a model prompt); it opens
 * nothing. Counted separately as label_hits.
 */
export const LABEL_MARK = "scan:label";

export const SCAN_DIRS = ["tools", "scripts", ".claude/skills", "agents"];

/** Paths (repo-relative, forward slashes) that may touch the files by design. */
export const EXCLUDED = new Set([
  "tools/twenty/migrate.ts",
  "tools/twenty/migrate-plan.ts",
  "tools/twenty/scan-file-access.ts",
  "tools/store/sqlite-backend.ts",
  "tools/pipeline-store.ts",
]);

const TEXT = /\.(ts|tsx|js|mjs|cjs|sh|md|py|ya?ml|toml)$/i;
const CODE = /\.(ts|tsx|js|mjs|cjs|sh|py|ya?ml|toml)$/i;
const HASH_COMMENT = /\.(sh|py|ya?ml|toml)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** The pattern names one line matches. */
export function matchLine(line: string): string[] {
  return Object.entries(PATTERNS).filter(([, re]) => re.test(line)).map(([name]) => name);
}

/** A whole-line comment in a code file: it describes, it never accesses. */
export function isCommentLine(line: string, file = "x.ts"): boolean {
  if (!CODE.test(file)) return false;
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return true;
  return HASH_COMMENT.test(file) && t.startsWith("#");
}

export type FileScan = { direct: Record<string, number>; fileMode: number; labels: number; routed: number };

/** Hits in one file's text. A line counts once per pattern it names. */
export function scanFile(text: string, file = "x.md"): FileScan {
  const direct: Record<string, number> = {};
  let fileMode = 0;
  let labels = 0;
  let routed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (isCommentLine(line, file)) continue;
    if (ROUTED.test(line)) { routed++; continue; }
    const names = matchLine(line);
    if (!names.length) continue;
    if (line.includes(FILE_MODE_MARK)) { fileMode++; continue; }
    if (line.includes(LABEL_MARK)) { labels++; continue; }
    for (const name of names) direct[name] = (direct[name] ?? 0) + 1;
  }
  return { direct, fileMode, labels, routed };
}

/** Direct hits per pattern (prose rules unless a code file name is given). */
export function scanText(text: string, file = "x.md"): Record<string, number> {
  return scanFile(text, file).direct;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && TEXT.test(e.name)) out.push(p);
  }
}

export async function scan(root = repoRoot()): Promise<Record<string, unknown>> {
  const files: string[] = [];
  for (const d of SCAN_DIRS) await walk(path.join(root, d), files);
  const paths: { path: string; hits: number; patterns: Record<string, number> }[] = [];
  const byPattern: Record<string, number> = {};
  const byDir: Record<string, number> = {};
  let scanned = 0;
  let fileModeHits = 0;
  let labelHits = 0;
  let routedHits = 0;
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (EXCLUDED.has(rel)) continue;
    scanned++;
    const r = scanFile(await fs.readFile(file, "utf8"), rel);
    fileModeHits += r.fileMode;
    labelHits += r.labels;
    routedHits += r.routed;
    const patterns = r.direct;
    const hits = Object.values(patterns).reduce((a, b) => a + b, 0);
    if (!hits) continue;
    paths.push({ path: rel, hits, patterns });
    for (const [k, v] of Object.entries(patterns)) byPattern[k] = (byPattern[k] ?? 0) + v;
    const top = SCAN_DIRS.find((d) => rel.startsWith(`${d}/`)) ?? rel.split("/")[0];
    byDir[top] = (byDir[top] ?? 0) + hits;
  }
  paths.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
  return {
    ok: true,
    gate: false,
    files_scanned: scanned,
    files_with_hits: paths.length,
    total_hits: paths.reduce((n, p) => n + p.hits, 0),
    file_mode_hits: fileModeHits,
    label_hits: labelHits,
    routed_hits: routedHits,
    by_pattern: byPattern,
    by_dir: byDir,
    excluded: [...EXCLUDED],
    paths,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gate = process.argv.includes("--gate");
  scan().then(
    (r) => { console.log(JSON.stringify({ ...r, gate })); process.exit(gate && Number(r.total_hits) > 0 ? 1 : 0); },
    (e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); },
  );
}
