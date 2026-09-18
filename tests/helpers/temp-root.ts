/**
 * tests/helpers/temp-root.ts — a throwaway repo root built from the fixture
 * profile, for tests that exercise tools which read `state/profile/…`.
 *
 * A fresh clone has no `state/profile/` at all (it is git-ignored), so any test
 * that let a tool resolve `repoPath("state/profile/cv-source.md")` against the
 * real checkout only passed on a machine with live personal state. Such a test
 * is also reading the person's CV, which no test should.
 *
 * `makeTempRoot()` copies `tests/fixtures/profile-min/` into
 * `<tmp>/state/profile/`, lands the org-level files the loaders expect, points
 * `templates/` and `references/` at the real framework directories, and sets
 * `HARNESS_REPO_ROOT` to the temp root.
 *
 * Call it BEFORE the first `import` of anything under `tools/`: module-level
 * `repoPath(...)` constants are computed at import time, so every tool import
 * in the caller must be a dynamic `await import(...)` placed after this call.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const realRoot = path.dirname(testsDir);
export const fixtureProfileDir = path.join(testsDir, "fixtures", "profile-min");

/** Absolute path to a file in the real checkout (templates, samples, tools). */
export function repoFile(...segments: string[]): string {
  return path.join(realRoot, ...segments);
}

export type TempRoot = {
  /** The fixture repo root; also exported as HARNESS_REPO_ROOT. */
  root: string;
  profileDir: string;
  orgDir: string;
};

/**
 * Build the fixture root and export HARNESS_REPO_ROOT.
 *
 * `today` stamps every `refreshed_at:` in the fixture keyword clouds, so a
 * cloud is never stale just because the fixture aged.
 */
export function makeTempRoot(label = "harness-test-"): TempRoot {
  const root = mkdtempSync(path.join(tmpdir(), label));
  const profileDir = path.join(root, "state", "profile");
  const orgDir = path.join(root, "state", "org");

  mkdirSync(orgDir, { recursive: true });
  cpSync(fixtureProfileDir, profileDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(orgDir, "keyword-clouds.yaml"),
    readFileSync(path.join(fixtureProfileDir, "org", "keyword-clouds.yaml"), "utf8")
      .replace(/refreshed_at: "[^"]+"/g, `refreshed_at: "${today}"`),
  );

  // The fixture ships no channels.yaml: the shipped template is the honest
  // stand-in, and a test that reads it is testing what a new clone gets.
  if (!existsSync(path.join(profileDir, "channels.yaml"))) {
    cpSync(repoFile("templates", "profile", "channels.yaml"), path.join(profileDir, "channels.yaml"));
  }

  // Framework, not state: point the fixture root at the real directories.
  for (const dir of ["templates", "references"]) {
    if (existsSync(repoFile(dir))) symlinkSync(repoFile(dir), path.join(root, dir), "dir");
  }

  process.env.HARNESS_REPO_ROOT = root;
  return { root, profileDir, orgDir };
}
