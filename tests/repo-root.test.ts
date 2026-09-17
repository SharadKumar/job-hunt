#!/usr/bin/env tsx
/**
 * Tests for the deterministic repo-root resolver — tools/repo-root.ts and its
 * bash twin .claude/hooks/repo-root.sh.
 *
 * The harness runs headlessly (launchd) and under Codex, where cwd is NOT
 * reliably the repository. Both resolvers must agree, must work from a nested
 * directory, and must fail loudly outside the repo.
 *
 * Run: npx tsx tests/repo-root.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, repoPath } from "../tools/repo-root.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, ".."));
const BASH_RESOLVER = path.join(ROOT, ".claude/hooks/repo-root.sh");

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

function bashRoot(start: string): string {
  return execFileSync("bash", [BASH_RESOLVER, start], { encoding: "utf8" }).trim();
}

console.log("repo-root resolver");

test("ts resolver finds the root from the repo itself", () => {
  assert.equal(repoRoot(ROOT), ROOT);
});

test("ts resolver finds the root from a nested directory", () => {
  const nested = path.join(ROOT, "tools", "resume", "lib");
  assert.ok(fs.existsSync(nested), `fixture dir missing: ${nested}`);
  assert.equal(repoRoot(nested), ROOT);
});

test("ts resolver finds the root from a nested file path", () => {
  assert.equal(repoRoot(path.join(ROOT, "tools", "repo-root.ts")), ROOT);
});

test("repoPath joins onto the resolved root", () => {
  assert.equal(repoPath("state", "pipeline"), path.join(ROOT, "state/pipeline"));
  assert.equal(repoPath("templates/resume"), path.join(ROOT, "templates/resume"));
});

test("ts resolver throws outside the repo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-root-test-"));
  try {
    assert.throws(() => repoRoot(tmp), /repo-root: no ancestor/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ts resolver rejects a directory that has CLAUDE.md but a foreign package.json", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-root-test-"));
  try {
    fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "# not the harness\n");
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "some-other-project" }));
    assert.throws(() => repoRoot(tmp), /repo-root: no ancestor/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("bash resolver finds the root from the repo and from a nested directory", () => {
  assert.equal(bashRoot(ROOT), ROOT);
  assert.equal(bashRoot(path.join(ROOT, "tools", "resume", "lib")), ROOT);
});

test("bash resolver exits non-zero outside the repo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-root-test-"));
  try {
    assert.throws(
      () => execFileSync("bash", [BASH_RESOLVER, tmp], { encoding: "utf8", stdio: "pipe" }),
      (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
        assert.equal(error.status, 1, "expected exit status 1");
        assert.match(String(error.stderr), /repo-root: no ancestor/);
        return true;
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("bash and ts twins agree from several start points", () => {
  for (const start of [ROOT, path.join(ROOT, "tools"), path.join(ROOT, ".claude", "skills"), path.join(ROOT, "tests")]) {
    assert.equal(bashRoot(start), repoRoot(start), `mismatch for start=${start}`);
  }
});

test("bash resolver defaults to cwd when given no argument", () => {
  const out = execFileSync("bash", [BASH_RESOLVER], {
    encoding: "utf8",
    cwd: path.join(ROOT, "tools", "resume"),
  }).trim();
  assert.equal(out, ROOT);
});

if (process.exitCode) {
  console.error("repo-root: FAILURES");
} else {
  console.log(`repo-root: ${passed} passed`);
}
