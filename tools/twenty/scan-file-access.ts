#!/usr/bin/env tsx
/**
 * scan-file-access.ts: which code paths still read or write person-facing
 * files directly (plan V22, measured before the cutover).
 *
 *   tsx tools/twenty/scan-file-access.ts            # JSON report, exit 0
 *
 * Scans tools/, scripts/, .claude/skills/ and agents/ for references to the
 * files that move into Twenty: state/pipeline (archives included),
 * pipeline.db, opportunities.json, state/profile(s), state/journal,
 * approval-queue.json, and resolveProfileContext() (the profile path
 * resolver). The one-time migration, the SQLite backend and this scanner are
 * excluded; tests live outside the scanned folders.
 *
 * It is a measurement, not a gate yet: it always exits 0 and prints counts
 * per path and per pattern, never file contents.
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
  profile_resolver: /\bresolveProfileContext\s*\(/,
};

export const SCAN_DIRS = ["tools", "scripts", ".claude/skills", "agents"];

/** Paths (repo-relative, forward slashes) that may touch the files by design. */
export const EXCLUDED = new Set([
  "tools/twenty/migrate.ts",
  "tools/twenty/migrate-plan.ts",
  "tools/twenty/scan-file-access.ts",
  "tools/store/sqlite-backend.ts",
]);

const TEXT = /\.(ts|tsx|js|mjs|cjs|sh|md|py|ya?ml|toml)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** The pattern names one line matches. */
export function matchLine(line: string): string[] {
  return Object.entries(PATTERNS).filter(([, re]) => re.test(line)).map(([name]) => name);
}

/** Hits per pattern in one file's text (a line counts once per pattern). */
export function scanText(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) for (const name of matchLine(line)) out[name] = (out[name] ?? 0) + 1;
  return out;
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
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (EXCLUDED.has(rel)) continue;
    scanned++;
    const patterns = scanText(await fs.readFile(file, "utf8"));
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
    by_pattern: byPattern,
    by_dir: byDir,
    excluded: [...EXCLUDED],
    paths,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scan().then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
}
