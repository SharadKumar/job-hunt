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
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "job-hunt-career-harness",
    scripts: {
      "daily:priority": "sh -c 'mkdir -p state && echo priority > state/priority-marker'",
      "daily:front-half": "sh -c 'mkdir -p state && echo completed > state/front-half-marker'",
    },
  }));
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

test("Claude daily explicitly selects Sonnet instead of inheriting an expensive default", () => {
  const root = makeFakeRepo();
  try {
    const bin = fakeCli(root, 'printf "%s\\n" "$@"');
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_DAILY_MODEL: "" });
    assert.equal(run.status, 0);
    assert.match(run.log, /--model\nsonnet\n/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Codex daily pins Sol and the isolated Codex letter critic", () => {
  const root = makeFakeRepo();
  try {
    const bin = fakeCli(root, 'printf "LETTER_CRITIC_CLI=%s\\nCODEX_CLI_BIN=%s\\nHARNESS_DAILY_MODEL=%s\\n" "$LETTER_CRITIC_CLI" "$CODEX_CLI_BIN" "$HARNESS_DAILY_MODEL"; printf "%s\\n" "$@"');
    const run = runDaily(root, { HARNESS_CLI: "codex", HARNESS_CLI_BIN: bin, HARNESS_DAILY_MODEL: "" });
    assert.equal(run.status, 0);
    assert.match(run.log, /LETTER_CRITIC_CLI=codex/);
    assert.match(run.log, /HARNESS_DAILY_MODEL=gpt-6-sol/);
    assert.ok(run.log.includes(`CODEX_CLI_BIN=${bin}`));
    assert.match(run.log, /exec\n--json\n--model\ngpt-6-sol\n--sandbox\ndanger-full-access\n-C\n/);
    assert.doesNotMatch(run.log, /--ephemeral/, "writer subagents need a persisted parent thread");
    assert.match(run.log, /Record that exact model id in agent-fallback provenance/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a completed same-day front half can be resumed without rerunning discovery", () => {
  const root = makeFakeRepo();
  try {
    const reportDir = path.join(root, "state/journal/front-half");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, `${today()}.json`), JSON.stringify({
      schema_version: 2, running: false, ok: true, degraded: false,
      finished_at: new Date().toISOString(),
    }));
    const bin = fakeCli(root, "echo resumed-agent; exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_REUSE_FRONT_HALF: "1" });
    assert.equal(run.status, 0);
    assert.match(run.log, /reusing completed front half/);
    assert.match(run.log, /resumed-agent/);
    assert.equal(fs.existsSync(path.join(root, "state/front-half-marker")), false);
    assert.equal(fs.existsSync(path.join(root, "state/priority-marker")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fresh runs do the prepared-package priority pass before discovery", () => {
  const root = makeFakeRepo();
  try {
    const bin = fakeCli(root, "echo agent-ran; exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin });
    assert.equal(run.status, 0);
    assert.ok(run.log.indexOf("priority pass exit 0") < run.log.indexOf("deterministic front half exit 0"));
    assert.equal(fs.readFileSync(path.join(root, "state/priority-marker"), "utf8").trim(), "priority");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a fresh priority SEEK challenge blocks later SEEK work in the front half", () => {
  const root = makeFakeRepo();
  try {
    const priority = `node -e 'const fs=require("fs"); const d=new Date(); const day=d.toLocaleDateString("en-CA"); fs.mkdirSync("state/journal/priority",{recursive:true}); fs.writeFileSync("state/journal/priority/"+day+".json",JSON.stringify({started_at:d.toISOString(),channel_health:{seek:{verification_required:true,observed_this_pass:true}}}))'`;
    const front = `node -e 'require("fs").writeFileSync("state/seek-flag",process.env.HARNESS_SEEK_VERIFICATION_REQUIRED||"")'`;
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "job-hunt-career-harness", scripts: { "daily:priority": priority, "daily:front-half": front },
    }));
    const bin = fakeCli(root, "exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin });
    assert.equal(run.status, 0);
    assert.equal(fs.readFileSync(path.join(root, "state/seek-flag"), "utf8"), "1");
    assert.match(run.log, /SEEK verification required in priority pass/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an inherited SEEK block still allows the new front half to recheck access", () => {
  const root = makeFakeRepo();
  try {
    const priority = `node -e 'const fs=require("fs"); const d=new Date(); const day=d.toLocaleDateString("en-CA"); fs.mkdirSync("state/journal/priority",{recursive:true}); fs.writeFileSync("state/journal/priority/"+day+".json",JSON.stringify({started_at:d.toISOString(),channel_health:{seek:{verification_required:true,observed_this_pass:false}}}))'`;
    const front = `node -e 'require("fs").writeFileSync("state/seek-flag",process.env.HARNESS_SEEK_VERIFICATION_REQUIRED||"")'`;
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "job-hunt-career-harness", scripts: { "daily:priority": priority, "daily:front-half": front },
    }));
    const bin = fakeCli(root, "exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin });
    assert.equal(run.status, 0);
    assert.equal(fs.readFileSync(path.join(root, "state/seek-flag"), "utf8"), "");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a stale or unhealthy front-half report cannot launch the agent", () => {
  const root = makeFakeRepo();
  try {
    const reportDir = path.join(root, "state/journal/front-half");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, `${today()}.json`), JSON.stringify({
      schema_version: 2, running: false, ok: false, degraded: true,
      finished_at: new Date().toISOString(),
    }));
    const bin = fakeCli(root, "echo agent-must-not-run; exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_REUSE_FRONT_HALF: "1" });
    assert.equal(run.status, 2);
    assert.match(run.log, /cannot reuse front half/);
    assert.doesNotMatch(run.log, /agent-must-not-run/);
    assert.equal(fs.existsSync(path.join(root, "state/front-half-marker")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
    assert.match(run.summary!, /Submission totals are unverified/);
    assert.doesNotMatch(run.summary!, /Nothing was submitted/);
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

test("the deterministic front half completes before an unavailable agent CLI fails", () => {
  const root = makeFakeRepo();
  try {
    const missing = path.join(root, "agent-cli-does-not-exist");
    const run = runDaily(root, { HARNESS_CLI_BIN: missing, HARNESS_TIMEOUT_SEC: "30" });
    assert.notEqual(run.status, 0, "the absent agent CLI must still fail the back half");
    assert.equal(fs.readFileSync(path.join(root, "state/front-half-marker"), "utf8").trim(), "completed");
    assert.match(run.log, /deterministic front half exit 0/);
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

test("front-half failure survives successful back-half recovery", () => {
  const root = makeFakeRepo();
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "job-hunt-career-harness",
      scripts: { "daily:front-half": "exit 2" },
    }));
    const bin = fakeCli(root, "echo recovered-valid-packages; exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "30" });
    assert.equal(run.status, 2);
    assert.match(run.log, /recovered-valid-packages/, "valid back-half work is still attempted");
    assert.match(run.summary!, /deterministic front half exited 2/);
    assert.match(run.summary!, /Submission totals are unverified/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed priority pass cannot be reported as a healthy daily run", () => {
  const root = makeFakeRepo();
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "job-hunt-career-harness",
      scripts: { "daily:priority": "exit 2", "daily:front-half": "sh -c 'mkdir -p state && echo completed > state/front-half-marker'" },
    }));
    const bin = fakeCli(root, "echo back-half-completed; exit 0");
    const run = runDaily(root, { HARNESS_CLI_BIN: bin, HARNESS_TIMEOUT_SEC: "30" });
    assert.equal(run.status, 2);
    assert.match(run.log, /back-half-completed/);
    assert.match(run.summary!, /prepared-package priority pass exited 2/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

test("the installer schedules weekday queue retries every two or four hours and pins the Codex binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-install-"));
  try {
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const codexBin = fakeCli(root, "exit 0");
    for (const interval of [2, 4]) {
      const result = spawnSync("bash", [path.join(ROOT, "scripts/install-launchd.sh")], {
        cwd: os.tmpdir(),
        env: { ...process.env, HOME: root, PATH: `${binDir}:${process.env.PATH}`, HARNESS_CLI: "codex", HARNESS_CLI_BIN: codexBin,
          HARNESS_START_HOUR: "7", HARNESS_END_HOUR: "17", HARNESS_INTERVAL_HOURS: String(interval) },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const plist = fs.readFileSync(path.join(root, "Library/LaunchAgents/com.job-hunt-harness.daily.plist"), "utf8");
      assert.ok(plist.includes(`<string>${codexBin}</string>`));
      const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map(match => Number(match[1]));
      const expectedHours = interval === 2 ? [7, 9, 11, 13, 15, 17] : [7, 11, 15];
      assert.deepEqual(hours, Array.from({ length: 5 }, () => expectedHours).flat());
      const weekdays = [...plist.matchAll(/<key>Weekday<\/key><integer>(\d+)<\/integer>/g)].map(match => Number(match[1]));
      assert.deepEqual(weekdays, [1, 2, 3, 4, 5].flatMap(day => expectedHours.map(() => day)));
      assert.match(plist, /<string>codex<\/string>/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

if (process.exitCode) {
  console.error("daily.sh: FAILURES");
} else {
  console.log(`daily.sh: ${passed} passed`);
}
