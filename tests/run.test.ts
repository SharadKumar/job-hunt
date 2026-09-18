#!/usr/bin/env tsx
/**
 * run.test.ts — the runner itself: it must report a failing file and exit 1.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoRoot } from "../tools/repo-root.ts";
import { collect, parseArgs } from "./run.ts";

const root = repoRoot();

// Arg parsing: filters, --serial, --dir.
{
  const defaults = parseArgs([], root);
  assert.equal(defaults.dir, path.join(root, "tests"));
  assert.equal(defaults.serial, false);
  assert.equal(defaults.concurrency, 4);

  const custom = parseArgs(["resume", "--serial", "--dir", "/tmp/x", "seek"], root);
  assert.deepEqual(custom.filters, ["resume", "seek"]);
  assert.equal(custom.serial, true);
  assert.equal(custom.concurrency, 1, "--serial forces one at a time");
  assert.equal(custom.dir, "/tmp/x");
  assert.throws(() => parseArgs(["--nope"], root), /unknown flag/);
}

// Collection: only *.test.ts, sorted, narrowed by substring.
const dir = mkdtempSync(path.join(tmpdir(), "run-test-"));
writeFileSync(path.join(dir, "alpha-pass.test.ts"), `console.log("alpha ok");\n`);
writeFileSync(path.join(dir, "beta-fail.test.ts"), `console.error("beta exploded");\nprocess.exit(1);\n`);
writeFileSync(path.join(dir, "not-a-test.ts"), `throw new Error("never run");\n`);

assert.deepEqual(
  collect(dir, []).map((f) => path.basename(f)),
  ["alpha-pass.test.ts", "beta-fail.test.ts"],
  "only *.test.ts files, sorted",
);
assert.deepEqual(collect(dir, ["alpha"]).map((f) => path.basename(f)), ["alpha-pass.test.ts"]);

// End to end: a failing file makes the run fail, by name, with its output.
let stdout = "";
let code = 0;
try {
  stdout = execFileSync(process.execPath, [
    path.join(root, "node_modules", ".bin", "tsx"),
    path.join(root, "tests", "run.ts"),
    "--dir", dir,
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error: any) {
  code = error.status ?? 1;
  stdout = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

assert.equal(code, 1, "a failing test file makes the runner exit 1");
assert.match(stdout, /FAIL\s+beta-fail\.test\.ts/, "the failing file is named");
assert.match(stdout, /PASS\s+alpha-pass\.test\.ts/, "the passing file is named");
assert.match(stdout, /beta exploded/, "the failing file's captured output is replayed");
assert.match(stdout, /1\/2 passed/);
assert.doesNotMatch(stdout, /alpha ok/, "a passing file's output stays quiet");

// A run with only passing files exits 0.
const passOnly = execFileSync(process.execPath, [
  path.join(root, "node_modules", ".bin", "tsx"),
  path.join(root, "tests", "run.ts"),
  "--dir", dir, "alpha",
], { cwd: root, encoding: "utf8" });
assert.match(passOnly, /1\/1 passed/);

console.log("run tests passed");
