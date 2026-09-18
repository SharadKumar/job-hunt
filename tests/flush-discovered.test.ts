#!/usr/bin/env tsx
/**
 * flush-discovered.test.ts — the pruning tool's scope, filters and audit trail.
 *
 * Runs against a throwaway database and audit dir (PIPELINE_DB / AUDIT_DIR, see
 * pipeline-store.test.ts), so state/pipeline is never touched. The tool itself
 * is spawned as a child process with the same env, which is also how it proves
 * the snapshot lands beside the database rather than in the real archive.
 *
 * Run: npx tsx tests/flush-discovered.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flush-discovered-"));

process.env.PIPELINE_DB = path.join(tempRoot, "pipeline.db");
process.env.AUDIT_DIR = path.join(tempRoot, "audit");

const { upsert, setStatus, patch, get, list } = await import("../tools/pipeline.ts");
const { store } = await import("../tools/pipeline-store.ts");

const DAY = 86400e3;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((error: Error) => {
      console.error(`  FAIL ${name}\n       ${error.message}`);
      process.exitCode = 1;
    });
}

/** Run the tool the way a human would, in the temp database. */
function flush(...args: string[]): { status: number | null; json: any; stderr: string } {
  const result = spawnSync("npx", ["tsx", path.join(ROOT, "tools/flush-discovered.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: "utf8",
  });
  let json: any = null;
  try { json = JSON.parse(result.stdout); } catch { /* left null; the assertions report it */ }
  return { status: result.status, json, stderr: result.stderr };
}

/** Seed a row, then back-date `first_seen_at` so age filters have something to bite. */
async function seed(id: number, opts: {
  ageDays: number;
  status?: "discovered" | "shortlisted";
  agentClassified?: boolean;
  score?: number;
}) {
  const row = await upsert({
    channel: "seek",
    url: `https://example.test/job/${id}`,
    title: `Solution Architect ${id}`,
    company: `Company ${id}`,
    status: "discovered",
  });
  if (opts.status === "shortlisted") await setStatus(row.id, "shortlisted", "fits");
  const fields: Record<string, unknown> = {};
  if (opts.agentClassified) {
    fields.classification = { discipline: "solution_architecture" };
    fields.classificationSource = "agent";
  }
  if (opts.score !== undefined) fields.score = opts.score;
  if (Object.keys(fields).length) await patch(row.id, fields as any, "test:seed");
  // upsert stamps first_seen_at with `now`; only raw SQL can age a row.
  store().db.prepare("UPDATE opportunities SET first_seen_at = ? WHERE id = ?")
    .run(iso(opts.ageDays * DAY), row.id);
  return row.id;
}

console.log("flush-discovered");

// young (2 days), unclassified discovered — must survive an --older-than 14d flush
const young = await seed(1, { ageDays: 2, score: 10 });
// old, unclassified discovered — the single intended victim
const oldUnclassified = await seed(2, { ageDays: 40, score: 12 });
// old but agent-classified discovered — a judged row is never junk
const oldClassified = await seed(3, { ageDays: 40, agentClassified: true, score: 55 });
// old shortlisted — out of the `discovered` scope entirely
const oldShortlisted = await seed(4, { ageDays: 40, status: "shortlisted", score: 70 });

await test("--older-than 14d --unclassified dry-run matches exactly one and removes nothing", async () => {
  const { status, json, stderr } = flush("--older-than", "14d", "--unclassified");
  assert.equal(status, 0, stderr);
  assert.equal(json.dry_run, true);
  assert.equal(json.matched, 1, `expected one match, got ${JSON.stringify(json)}`);
  assert.equal(json.removed, 0);
  assert.equal(json.snapshot, null);
  assert.equal((await list()).length, 4, "a dry run must not remove anything");
});

await test("--apply removes the matched row, snapshots it, and records history + audit", async () => {
  const { status, json, stderr } = flush("--older-than", "14d", "--unclassified", "--apply");
  assert.equal(status, 0, stderr);
  assert.equal(json.dry_run, false);
  assert.equal(json.matched, 1);
  assert.equal(json.removed, 1);

  assert.ok(json.snapshot, "an applied flush must write a snapshot");
  assert.equal(path.dirname(json.snapshot), path.join(tempRoot, "archive"), "the snapshot lives beside the database");
  const snapshot = JSON.parse(fs.readFileSync(json.snapshot, "utf8"));
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, oldUnclassified);

  assert.equal(await get(oldUnclassified), null, "the row is gone");
  const audit = fs.readFileSync(path.join(tempRoot, "audit", "audit-log.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const event = audit.find((e) => e.role_id === oldUnclassified && e.details?.removed === true);
  assert.ok(event, "removal must write an audit event");
  assert.equal(event.actor, "flush-discovered");
  assert.match(String(event.details.reason), /older-than=14d/);
});

await test("the young, the classified and the shortlisted rows are intact", async () => {
  const survivors = (await list()).map((r) => r.id).sort();
  assert.deepEqual(survivors, [young, oldClassified, oldShortlisted].sort());
  assert.equal((await get(oldClassified))!.status, "discovered");
  assert.equal((await get(oldShortlisted))!.status, "shortlisted");
});

await test("--below-score narrows the scope and is ANDed with the age filter", async () => {
  // oldClassified scores 55; only a threshold above it can match, and only
  // because --unclassified is not in play.
  assert.equal(flush("--older-than", "14d", "--below-score", "50").json.matched, 0);
  assert.equal(flush("--older-than", "14d", "--below-score", "60").json.matched, 1);
  assert.equal(flush("--below-score", "60").json.matched, 2, "without --older-than the young row matches too");
});

await test("--all-unsubmitted widens the scope past `discovered`", async () => {
  assert.equal(flush("--older-than", "14d").json.matched, 1, "discovered-only sees one old row");
  assert.equal(flush("--older-than", "14d", "--all-unsubmitted").json.matched, 2, "the old shortlisted row joins");
});

await test("a junk --older-than fails loudly instead of flushing everything", () => {
  const { status, stderr } = flush("--older-than", "soon", "--apply");
  assert.equal(status, 1);
  assert.match(stderr, /--older-than/);
});

fs.rmSync(tempRoot, { recursive: true, force: true });

if (process.exitCode) {
  console.error("flush-discovered: FAILURES");
} else {
  console.log(`flush-discovered: ${passed} passed`);
}
