#!/usr/bin/env tsx
/**
 * twenty-migrate.test.ts — the one-time migration's scope and idempotence.
 *
 * Unit: the scope rule (owner, Q4). Integration (TWENTY_TEST_URL and
 * TWENTY_TEST_KEY set, local test instance only): apply synthetic rows from a
 * temp SQLite store, then apply again and expect 0 creates. Synthetic data only.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inScope } from "../tools/twenty/migrate.ts";

const none = () => false;
const r = (status: string, extra: Record<string, unknown> = {}): any => ({ id: "x", status, history: [{ to: "discovered" }], ...extra });
assert.equal(inScope(r("discovered"), none).keep, true);
assert.equal(inScope(r("rejected"), none).keep, false);
assert.equal(inScope(r("rejected", { history: [{ to: "drafted" }, { to: "rejected" }] }), none).keep, true);
assert.equal(inScope(r("withdrawn", { userSaved: true }), none).keep, true);
assert.equal(inScope(r("rejected", { parkedBy: "user" }), none).keep, true);
assert.equal(inScope(r("rejected"), () => true).keep, true);

const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_KEY;
if (!url || !key) { console.log("twenty-migrate: unit ok; integration skipped"); process.exit(0); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-itest-"));
const db = path.join(tmp, "pipeline.db");
const env = { ...process.env, PIPELINE_DB: db, AUDIT_DIR: path.join(tmp, "audit"), HARNESS_REPO_ROOT: tmp, TWENTY_API_URL: url, TWENTY_API_KEY: key, HARNESS_STORE: "sqlite", TMPDIR: "/tmp" };

// Seed a synthetic SQLite store: two active rows and one untouched reject.
const seedFile = path.join(tmp, "seed.mts");
fs.writeFileSync(seedFile, `
  const P = await import(${JSON.stringify(path.join(repo, "tools/pipeline.ts"))});
  const tag = "mig-" + Date.now();
  const rows = await P.upsertMany([
    { channel: "seek", url: "https://example.com/" + tag + "/1", title: "Architect", company: "Acme Pty Ltd" },
    { channel: "seek", url: "https://example.com/" + tag + "/2", title: "Lead", company: "Globex Ltd" },
    { channel: "seek", url: "https://example.com/" + tag + "/3", title: "Noise", company: "Initech" },
  ], { digest: false });
  await P.setStatus(rows[2].id, "rejected", "auto", { actor: "itest" });
`);
const seed = spawnSync("npx", ["tsx", seedFile], { cwd: repo, env, encoding: "utf8" });
assert.equal(seed.status, 0, seed.stderr);

const run = (args: string[]) => {
  const p = spawnSync("npx", ["tsx", path.join(repo, "tools/twenty/migrate.ts"), ...args], { cwd: repo, env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return JSON.parse(p.stdout.trim().split("\n").pop()!);
};
const dry = run(["--dry-run"]);
assert.equal(dry.in_scope, 2);
const first = run(["--apply"]);
assert.equal(first.created, 2);
const second = run(["--apply"]);
assert.equal(second.created, 0, "second run plans 0 creates");
assert.equal(second.already_present, 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("twenty-migrate: unit and integration ok");
