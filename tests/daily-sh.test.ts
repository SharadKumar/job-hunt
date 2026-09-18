#!/usr/bin/env tsx
/**
 * daily-sh.test.ts — the launchd wrapper's watchdog and failure trail.
 *
 * Everything runs inside a throwaway repo root (CLAUDE.md + a package.json
 * named like the harness, so .claude/hooks/repo-root.sh resolves it — see
 * repo-root.test.ts for that contract) with a fake agent CLI, so no real
 * `claude`/`codex` process is ever spawned and state/ is never touched.
 *
 * Run: npx tsx tests/daily-sh.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

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

/** A temp repo root holding just enough for daily.sh to resolve and run. */
function makeFakeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-sh-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts/daily.sh"), path.join(root, "scripts/daily.sh"));
  fs.copyFileSync(path.join(ROOT, ".claude/hooks/repo-root.sh"), path.join(root, ".claude/hooks/repo-root.sh"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# fake harness\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "job-hunt-career-harness" }));
  return root;
}

function fakeCli(root: string, body: string): string {
  const bin = path.join(root, "fake-cli");
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

function today(): string {
  return spawnSync("date", ["+%Y-%m-%d"], { encoding: "utf8" }).stdout.trim();
}

type Run = { status: number | null; log: string; summaryPath: string; summary: string | null };

function runDaily(root: string, env: Record<string, string>): Run {
  const result = spawnSync("bash", [path.join(root, "scripts/daily.sh")], {
    cwd: os.tmpdir(), // launchd gives an arbitrary cwd; the script must not care
    env: { ...process.env, HARNESS_CLI: "claude", ...env },
    encoding: "utf8",
  });
  const date = today();
  const logPath = path.join(root, "state/journal/launchd", `${date}.log`);
  const summaryPath = path.join(root, "state/journal/summary", `${date}.md`);
  assert.ok(fs.existsSync(logPath), `expected a log at ${logPath}`);
  return {
    status: result.status,
    log: fs.readFileSync(logPath, "utf8"),
    summaryPath,
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : null,
  };
}

console.log("daily.sh wrapper");

test("a wedged CLI is killed at the timeout and the run exits 124", () => {
  const root = makeFakeRepo();
  try {
    const bin = fakeCli(root, "sleep 5");
    const started = Date.now();
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "1", HARNESS_KILL_GRACE_SEC: "2" });
    assert.equal(run.status, 124, "a timed-out run must exit 124");
    assert.ok(Date.now() - started < 5000, "the watchdog must not wait for the CLI to finish");
    assert.match(run.log, /timeout after 1s/);
    assert.match(run.log, /finished daily run \(exit 124\)/);
    assert.ok(run.summary, "a timed-out run must leave a failure summary");
    assert.match(run.summary!, /Run failed \(exit 124\)/);
    assert.match(run.summary!, /state\/journal\/launchd/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a nonzero CLI exit propagates and writes a failure summary", () => {
  const root = makeFakeRepo();
  try {
    const bin = fakeCli(root, "exit 3");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "30" });
    assert.equal(run.status, 3, "the agent CLI exit code must propagate");
    assert.match(run.log, /finished daily run \(exit 3\)/);
    assert.ok(run.summary, "a failed run must leave a failure summary");
    assert.match(run.summary!, /Run failed \(exit 3\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean run writes no failure summary", () => {
  const root = makeFakeRepo();
  try {
    const bin = fakeCli(root, "echo fine; exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "30" });
    assert.equal(run.status, 0);
    assert.match(run.log, /finished daily run \(exit 0\)/);
    assert.equal(run.summary, null, "a clean run must not write a failure summary");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing summary is never clobbered by the failure block", () => {
  const root = makeFakeRepo();
  try {
    const summaryDir = path.join(root, "state/journal/summary");
    fs.mkdirSync(summaryDir, { recursive: true });
    const existing = path.join(summaryDir, `${today()}.md`);
    fs.writeFileSync(existing, "# real summary\n");
    const bin = fakeCli(root, "exit 3");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "30" });
    assert.equal(run.status, 3);
    assert.equal(run.summary, "# real summary\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("logs older than the retention window are rotated away", () => {
  const root = makeFakeRepo();
  try {
    const logDir = path.join(root, "state/journal/launchd");
    fs.mkdirSync(logDir, { recursive: true });
    const stale = path.join(logDir, "2000-01-01.log");
    const fresh = path.join(logDir, "2000-01-02.log");
    for (const file of [stale, fresh]) fs.writeFileSync(file, "x");
    const old = Date.now() - 40 * 86400e3;
    fs.utimesSync(stale, old / 1000, old / 1000);
    const bin = fakeCli(root, "exit 0");
    runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "30" });
    assert.equal(fs.existsSync(stale), false, "a 40-day-old log must be deleted");
    assert.equal(fs.existsSync(fresh), true, "a log written just now must survive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown HARNESS_CLI still exits 2", () => {
  const root = makeFakeRepo();
  try {
    const result = spawnSync("bash", [path.join(root, "scripts/daily.sh")], {
      env: { ...process.env, HARNESS_CLI: "gemini" },
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown HARNESS_CLI=gemini/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HARNESS_CLI defaults to claude", () => {
  const text = fs.readFileSync(path.join(ROOT, "scripts/daily.sh"), "utf8");
  assert.match(text, /CLI="\$\{HARNESS_CLI:-claude\}"/);
});

if (process.exitCode) {
  console.error("daily.sh: FAILURES");
} else {
  console.log(`daily.sh: ${passed} passed`);
}
