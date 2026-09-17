/**
 * tools/repo-root.ts — deterministic repository-root resolver (TypeScript twin
 * of .claude/hooks/repo-root.sh).
 *
 * Walks up from `start` to the first directory containing BOTH CLAUDE.md and a
 * package.json whose "name" matches this harness. Throws when there is none.
 *
 * Why: headless launchd runs and Codex invocations do not reliably inherit the
 * repo as cwd, so tools must not build `state/…` or `templates/…` paths off
 * `process.cwd()`. Use `repoPath("state/pipeline/opportunities.json")` instead.
 *
 * Paths supplied by a CLI argument stay relative to the caller's cwd on
 * purpose — only harness-owned defaults are resolved through here.
 *
 * HARNESS_REPO_ROOT overrides resolution entirely (tests that build a fixture
 * repo in a temp dir, and any launcher that already knows the root).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NAME = process.env.HARNESS_REPO_NAME || "job-hunt-career-harness";

function isRoot(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, "CLAUDE.md"))) return false;
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"))?.name === EXPECTED_NAME;
  } catch {
    return false;
  }
}

function walkUp(start: string): string | null {
  let dir: string;
  try {
    dir = fs.realpathSync(path.resolve(start));
  } catch {
    return null;
  }
  if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (isRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let cached: string | null = null;

/**
 * Absolute path to the harness repository root.
 * Resolution order: explicit `start` → process.cwd() → this module's own
 * directory (which is always inside the repo, so tools work from anywhere).
 */
export function repoRoot(start?: string): string {
  const override = process.env.HARNESS_REPO_ROOT;
  if (override) return path.resolve(override);
  if (!start && cached) return cached;

  const candidates = start
    ? [start]
    : [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];

  for (const candidate of candidates) {
    const found = walkUp(candidate);
    if (found) {
      if (!start) cached = found;
      return found;
    }
  }

  throw new Error(
    `repo-root: no ancestor of '${candidates[0]}' contains CLAUDE.md + package.json with name "${EXPECTED_NAME}". ` +
      "Run from inside the harness repository, or set HARNESS_REPO_NAME if this is a fork.",
  );
}

/** Join one or more repo-relative segments onto the resolved repo root. */
export function repoPath(...segments: string[]): string {
  return path.join(repoRoot(), ...segments);
}
