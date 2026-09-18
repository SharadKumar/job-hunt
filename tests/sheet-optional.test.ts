#!/usr/bin/env tsx
/**
 * sheet-optional.test.ts — `sheet.enabled: false` retires the Google Sheet.
 *
 * The local UI is the approval surface from WP4.3, so a person must be able to
 * switch the mirror off and have every Sheet path go quiet without credentials,
 * without a client and without a non-zero exit that would look like a failure
 * to /daily. The danger this file guards is the opposite of a broken push: a
 * "skip" that still reads or rewrites a cell, or a skip that reads as blocked.
 *
 * Everything runs against a fixture repo root in a temp dir, a throwaway
 * pipeline database and a throwaway audit dir, so state/ is never touched.
 *
 * Run: npx tsx tests/sheet-optional.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTempRoot, realRoot } from "./helpers/temp-root.ts";

const { root, profileDir } = makeTempRoot("sheet-optional-");
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
// The mirror must never fall back to real credentials during this run.
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.SHEETS_SPREADSHEET_ID;

const POLICY = path.join(profileDir, "submission-policy.yaml");
const basePolicy = fs.existsSync(POLICY) ? fs.readFileSync(POLICY, "utf8") : "";

function setSheetEnabled(value: boolean | null): void {
  const block = value === null ? "" : `sheet:\n  enabled: ${value}\n`;
  fs.writeFileSync(POLICY, `${block}${basePolicy.replace(/^sheet:\n(?:\s+.*\n)*/m, "")}`);
}

const { upsert } = await import("../tools/pipeline.ts");
const { runPush, runPull, sheetEnabled, SHEET_DISABLED } = await import("../tools/sheets-sync.ts");
type SheetsApi = import("../tools/sheets-sync.ts").SheetsApi;

/** A client that refuses to be used: every call is recorded, none is legal. */
function recordingSheets(): { sheets: SheetsApi; calls: string[] } {
  const calls: string[] = [];
  const note = (method: string) => { calls.push(method); };
  const sheets = {
    spreadsheets: {
      async get() { note("spreadsheets.get"); return { data: { sheets: [] } }; },
      async batchUpdate() { note("spreadsheets.batchUpdate"); return {}; },
      values: {
        async get() { note("values.get"); return { data: { values: [] } }; },
        async update() { note("values.update"); return {}; },
        async clear() { note("values.clear"); return {}; },
        async batchClear() { note("values.batchClear"); return {}; },
      },
    },
  } as unknown as SheetsApi;
  return { sheets, calls };
}

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("a missing sheet: block means enabled, so an existing profile keeps mirroring", async () => {
  setSheetEnabled(null);
  assert.equal(await sheetEnabled(), true);
});

test("sheet.enabled: true is enabled", async () => {
  setSheetEnabled(true);
  assert.equal(await sheetEnabled(), true);
});

test("sheet.enabled: false switches the mirror off", async () => {
  setSheetEnabled(false);
  assert.equal(await sheetEnabled(), false);
});

test("runPush with the Sheet off records zero calls and returns skipped", async () => {
  setSheetEnabled(false);
  const { sheets, calls } = recordingSheets();
  const report = await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: path.join(root, "queue.json") });
  assert.deepEqual(report, { command: "push", ok: true, skipped: SHEET_DISABLED });
  assert.deepEqual(calls, []);
});

test("runPull with the Sheet off records zero calls and writes no queue file", async () => {
  setSheetEnabled(false);
  const queuePath = path.join(root, "queue-pull.json");
  const { sheets, calls } = recordingSheets();
  const report = await runPull({ sheets, spreadsheetId: "sheet-1", queuePath });
  assert.deepEqual(report, { command: "pull", ok: true, skipped: SHEET_DISABLED });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(queuePath), false);
});

test("the enabled path is unchanged: runPush still writes both tabs", async () => {
  setSheetEnabled(true);
  await upsert({
    id: "sheet-optional-1", channel: "seek", company: "Example Pty Ltd", title: "Platform Engineer",
    url: "https://example.test/1", status: "awaiting_approval", score: 80,
  } as any);
  const tabs: Record<string, any[][]> = { Pipeline: [], Tray: [] };
  const calls: string[] = [];
  const sheets = {
    spreadsheets: {
      async get() { calls.push("spreadsheets.get"); return { data: { sheets: ["Pipeline", "Tray", "Followups", "Contacts", "Market", "Summary"].map((title, i) => ({ properties: { title, sheetId: i } })) } }; },
      async batchUpdate() { calls.push("spreadsheets.batchUpdate"); return {}; },
      values: {
        async get({ range }: any) { calls.push("values.get"); return { data: { values: tabs[range.split("!")[0]] ?? [] } }; },
        async update({ range, requestBody }: any) { calls.push("values.update"); tabs[range.split("!")[0]] = requestBody.values; return {}; },
        async clear({ range }: any) { calls.push("values.clear"); tabs[range.split("!")[0]] = []; return {}; },
        async batchClear() { calls.push("values.batchClear"); return {}; },
      },
    },
  } as unknown as SheetsApi;
  const report = await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: path.join(root, "queue-enabled.json") });
  assert.equal(report.skipped, undefined);
  assert.equal(report.ok, true);
  assert.equal(report.tray_rows, 1);
  assert.ok(calls.includes("values.update"));
});

test("the CLI exits 0 with the skipped object and never asks for credentials", () => {
  setSheetEnabled(false);
  for (const cmd of ["push", "pull", "init"]) {
    const run = spawnSync("npx", ["tsx", "tools/sheets-sync.ts", cmd], {
      cwd: realRoot, encoding: "utf8",
      env: { ...process.env, TMPDIR: "/tmp", HARNESS_REPO_ROOT: root, GOOGLE_APPLICATION_CREDENTIALS: "", SHEETS_SPREADSHEET_ID: "" },
    });
    assert.equal(run.status, 0, `${cmd} exited ${run.status}: ${run.stderr}`);
    const report = JSON.parse(run.stdout.trim());
    assert.deepEqual(report, { command: cmd === "pull" ? "pull" : "push", ok: true, skipped: SHEET_DISABLED });
  }
});

test("daily-summary reports sheet: disabled instead of pushing", async () => {
  setSheetEnabled(false);
  const { run } = await import("../tools/daily-summary.ts");
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
  const summary = await run({ date, notify: false, json: true, sheet: true });
  assert.equal(summary.sheet.status, "disabled");
  assert.equal(summary.sheet.pushed, false);
  assert.equal(summary.sheet.failed, false, summary.sheet.note);
});

test("setup:check reports the sheet stage skipped and adds an informational ui stage", () => {
  setSheetEnabled(false);
  let stdout = "";
  try {
    stdout = execFileSync("npx", ["tsx", "tools/setup.ts", "check"], {
      cwd: realRoot, encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp", HARNESS_REPO_ROOT: root },
    });
  } catch (e: any) {
    // A fixture profile is nowhere near autopilot-ready, so a non-zero exit is expected.
    stdout = String(e.stdout ?? "");
  }
  const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const sheet = report.stages.find((s: any) => s.name === "sheet");
  assert.ok(sheet, "no sheet stage");
  assert.equal(sheet.skipped, true);
  assert.equal(sheet.ok, true);
  const ui = report.stages.find((s: any) => s.name === "ui");
  assert.ok(ui, "no ui stage");
  assert.equal(ui.stage, 9);
  assert.equal(ui.informational, true);
  assert.equal(ui.ok, true, "the ui stage must never block");
  assert.ok(ui.checks.some((c: any) => c.id === "plist"));
  assert.ok(ui.checks.some((c: any) => c.id === "port"));
  // Informational means informational: a silent UI cannot be the blocking stage.
  assert.notEqual(report.next_stage?.name, "ui");
});

test("the launchd installer renders a valid plist without touching the machine", () => {
  const before = fs.readdirSync(path.join(os.homedir(), "Library", "LaunchAgents")).join(",");
  const dry = execFileSync("bash", ["scripts/install-ui-launchd.sh", "--dry-run"], { cwd: realRoot, encoding: "utf8" });
  assert.ok(dry.includes("<key>Label</key>"));
  assert.ok(dry.includes("com.job-hunt-harness.ui"));
  assert.ok(dry.includes(realRoot), "the rendered plist must point at this checkout");
  assert.ok(!dry.includes("__REPO_DIR__") && !dry.includes("__PORT__"), "unsubstituted placeholder");
  assert.ok(/<key>KeepAlive<\/key>\s*<true\/>/.test(dry));
  assert.ok(/<key>RunAtLoad<\/key>\s*<true\/>/.test(dry));
  assert.ok(dry.includes("state/journal/launchd/ui.log"));
  const rendered = path.join(root, "ui.plist");
  fs.writeFileSync(rendered, dry);
  const lint = spawnSync("plutil", ["-lint", rendered], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.equal(fs.readdirSync(path.join(os.homedir(), "Library", "LaunchAgents")).join(","), before, "--dry-run installed something");
  assert.equal(spawnSync("bash", ["-n", "scripts/install-ui-launchd.sh"], { cwd: realRoot }).status, 0);
});

test("slop-killer fails on a single em dash and on a single en dash", () => {
  for (const [label, text] of [["em", "The estate is large — and it grew."], ["en", "The window is 2024–2025 wide."]]) {
    const run = spawnSync("npx", ["tsx", "tools/slop-killer.ts", "--text", text], { cwd: realRoot, encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp" } });
    const result = JSON.parse(run.stdout);
    assert.equal(result.verdict, "fail", `${label} dash should fail: ${run.stdout}`);
    assert.equal(run.status, 2, `${label} dash should exit 2`);
    assert.ok(result.hits.some((h: any) => h.fatal && h.category === "punctuation"), `${label} dash hit missing`);
  }
  const clean = spawnSync("npx", ["tsx", "tools/slop-killer.ts", "--text", "The estate is large, and it grew."], { cwd: realRoot, encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp" } });
  assert.notEqual(JSON.parse(clean.stdout).verdict, "fail", "a dash-free line must not fail");
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${e?.message ?? e}`);
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall sheet-optional tests passed");
process.exit(failures ? 1 : 0);
