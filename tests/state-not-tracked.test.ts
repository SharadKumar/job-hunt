#!/usr/bin/env tsx
/**
 * Tests that nothing personal under state/ is tracked by git.
 *
 * state/ holds the person's profile, pipeline and journal. .gitignore covers it,
 * but a file added before the ignore rule stays tracked forever and silently
 * ships personal data to any shared remote. Two assertions guard that:
 *   1. no tracked file under state/ is also matched by an ignore rule
 *   2. the only tracked files under state/ are the two generic org templates
 *
 * Run: npx tsx tests/state-not-tracked.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repoRoot } from "../tools/repo-root.ts";

const ROOT = repoRoot();

const ALLOWED_TRACKED = ["state/org/resume-formats.yaml", "state/org/resume-types.example.yaml"];

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isGitRepo(): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function lines(out: string): string[] {
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

if (!isGitRepo()) {
  console.log("state-not-tracked: skipped (not a git repository)");
  process.exit(0);
}

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

console.log("state not tracked");

test("no tracked file under state/ is covered by an ignore rule", () => {
  const offenders = lines(git(["ls-files", "-i", "-c", "--exclude-standard", "state"]));
  const preview = offenders.slice(0, 10).join("\n       ");
  assert.equal(
    offenders.length,
    0,
    `${offenders.length} tracked file(s) under state/ are git-ignored and must be untracked ` +
      `(git rm --cached). First ${Math.min(10, offenders.length)}:\n       ${preview}`,
  );
});

test("only the generic org templates are tracked under state/", () => {
  const tracked = lines(git(["ls-files", "state"])).sort();
  assert.deepEqual(
    tracked,
    [...ALLOWED_TRACKED].sort(),
    `unexpected tracked files under state/. Tracked:\n       ${tracked.slice(0, 10).join("\n       ")}`,
  );
});

if (process.exitCode) {
  console.error("state-not-tracked: FAILURES");
} else {
  console.log(`state-not-tracked: ${passed} passed`);
}
