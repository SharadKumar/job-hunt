/**
 * pipeline-store.test.ts — the SQLite pipeline store's contract.
 *
 * Everything here runs against a throwaway database and a throwaway audit dir,
 * so the real state/pipeline is never touched. The last block is a real dry-run
 * migrate of a COPY of the live JSON array, asserting the row counts we expect
 * to carry over.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-store-"));

// Both must be set before pipeline.ts is evaluated: the store resolves its file
// from PIPELINE_DB, and audit.ts pins AUDIT_DIR at import time.
process.env.PIPELINE_DB = path.join(tempRoot, "pipeline.db");
process.env.AUDIT_DIR = path.join(tempRoot, "audit");

const {
  upsert, upsertMany, patch, setStatus, remove, get, list, load, save,
} = await import("../tools/pipeline.ts");
const { openStore } = await import("../tools/pipeline-store.ts");

const card = (n: number) => ({
  channel: "seek",
  url: `https://example.test/job/${n}`,
  title: `Solution Architect ${n}`,
  company: `Company ${n}`,
  description: `Description for job ${n}`,
});

try {
  // --- upsert never rewinds status or history -------------------------------
  const created = await upsert({ ...card(1), status: "discovered" });
  await setStatus(created.id, "shortlisted", "fits");
  await setStatus(created.id, "drafted");
  const refreshed = await upsert({ ...card(1), description: "fresh card", status: "discovered" });
  assert.equal(refreshed.description, "fresh card", "refreshable fields update");
  assert.equal(refreshed.status, "drafted", "a refresh must not rewind workflow status");
  assert.equal(refreshed.history.length, 3, "a refresh must not rewrite history");
  assert.deepEqual(refreshed.history.map((h) => h.to), ["discovered", "shortlisted", "drafted"]);

  // --- setStatus enforces the transition table ------------------------------
  await assert.rejects(
    () => setStatus(created.id, "submitted"),
    /invalid transition drafted → submitted/,
    "an illegal transition must throw",
  );
  const approved = await setStatus(created.id, "awaiting_approval", "package ready");
  assert.equal(approved.status, "awaiting_approval");
  assert.equal(approved.history.at(-1)?.reason, "package ready");

  const auditLines = fs.readFileSync(path.join(tempRoot, "audit", "audit-log.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    auditLines.some((e) => e.role_id === created.id && e.details?.to === "awaiting_approval"),
    "setStatus writes an audit event",
  );

  // --- patch appends a field_update history row without moving the row ------
  const before = (await get(created.id))!;
  const patched = await patch(created.id, { description: "enriched JD", applyMethod: "quick_apply" }, "seek:enrich");
  assert.equal(patched.status, before.status, "patch must not change status");
  assert.equal(patched.description, "enriched JD");
  assert.equal(patched.applyMethod, "quick_apply");
  const last = patched.history.at(-1)!;
  assert.equal(last.from, before.status);
  assert.equal(last.to, before.status);
  assert.match(last.reason ?? "", /^field_update: description, applyMethod/);
  assert.equal(patched.history.length, before.history.length + 1);

  // --- upsertMany: one transaction, 1000 rows, one digest write -------------
  const digestPath = path.join(tempRoot, "opportunities.md");
  const digestBefore = fs.existsSync(digestPath) ? fs.statSync(digestPath).mtimeMs : 0;
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...card(1000 + i), status: "discovered" as const }));
  const t0 = Date.now();
  const inserted = await upsertMany(many);
  const elapsed = Date.now() - t0;
  assert.equal(inserted.length, 1000);
  assert.ok(elapsed < 2000, `upsertMany of 1000 rows took ${elapsed}ms, expected under 2000ms`);
  assert.ok(fs.existsSync(digestPath), "upsertMany writes the human digest");
  assert.notEqual(fs.statSync(digestPath).mtimeMs, digestBefore, "the digest is refreshed once at the end");
  assert.equal((await load()).length, 1001);

  // A second pass over the same cards refreshes rather than duplicating.
  await upsertMany(many.map((m) => ({ ...m, company: `${m.company} Pty Ltd` })));
  assert.equal((await load()).length, 1001, "re-upserting the same urls must not duplicate rows");
  assert.equal((await get(inserted[0].id))!.company, "Company 1000 Pty Ltd");

  // --- list filters ---------------------------------------------------------
  assert.equal((await list({ status: "discovered" })).length, 1000);
  assert.equal((await list({ status: "awaiting_approval" })).length, 1);
  assert.equal((await list({ channel: "seek" })).length, 1001);
  assert.equal((await list({ channel: "linkedin_jobs" })).length, 0);
  assert.equal((await list({ since: "2999-01-01T00:00:00.000Z" })).length, 0);
  assert.equal((await list({}))[0].description, undefined, "list omits the JD unless asked");
  assert.ok((await list({ status: "awaiting_approval", withDescription: true }))[0].description);

  // --- remove records history, then deletes ---------------------------------
  const doomed = inserted[0].id;
  const removeResult = await remove([doomed], "test", "no longer listed");
  assert.equal(removeResult.removed, 1);
  assert.equal(await get(doomed), null, "removed rows are gone");
  const store = openStore(process.env.PIPELINE_DB!);
  const trail = store.historyOf(doomed);
  assert.match(trail.at(-1)?.reason ?? "", /^removed: no longer listed/);
  store.close();
  const afterRemove = fs.readFileSync(path.join(tempRoot, "audit", "audit-log.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(afterRemove.some((e) => e.role_id === doomed && e.details?.removed === true), "remove writes an audit event");

  // --- deprecated save() still behaves like the whole-array write -----------
  const all = await load();
  all[0].notes = "touched by legacy save";
  await save(all);
  assert.equal((await get(all[0].id))!.notes, "touched by legacy save");
  assert.equal((await load()).length, all.length);
  await save(all.filter((r) => r.id !== all.at(-1)!.id));
  assert.equal((await load()).length, all.length - 1, "save() drops rows absent from the array, as the JSON file did");

  console.log("pipeline-store: core API ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// --- migrate round-trips the fixture ---------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-migrate-"));
  try {
    const source = path.join(dir, "opportunities.json");
    fs.copyFileSync(path.join(here, "fixtures", "pipeline-sample.json"), source);
    process.env.PIPELINE_DB = path.join(dir, "pipeline.db");
    const { migrate: migrateFn, exportJson: exportFn, get: getFn } = await import("../tools/pipeline.ts");

    const report = await migrateFn({ from: source });
    assert.equal(report.read, 3);
    assert.equal(report.rows_in_db, 3);
    assert.ok(!fs.existsSync(source), "a real migrate renames the source aside");
    assert.ok(
      fs.readdirSync(dir).some((f) => /^opportunities\.migrated-\d{4}-\d{2}-\d{2}\.json$/.test(f)),
      "the source is renamed to opportunities.migrated-<date>.json",
    );
    await assert.rejects(() => migrateFn({ from: source }), /already holds 3 rows/, "migrate refuses a populated database");

    const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pipeline-sample.json"), "utf8"));
    const out = path.join(dir, "export.json");
    await exportFn(out);
    const exported = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(exported.length, fixture.length);
    for (const original of fixture) {
      const round = exported.find((r: any) => r.id === original.id);
      assert.ok(round, `${original.id} round-trips`);
      for (const key of Object.keys(original)) {
        assert.deepEqual(round[key], original[key], `${original.id}.${key} survives the round trip`);
      }
      const live = await getFn(original.id);
      assert.deepEqual(live!.history, original.history, `${original.id} history order is preserved`);
    }
    console.log("pipeline-store: migrate + export round-trip ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- real dry run against a copy of the live pipeline -----------------------
{
  const live = path.join(repo, "state", "pipeline", "opportunities.json");
  if (!fs.existsSync(live)) {
    console.log("pipeline-store: no live opportunities.json, skipping the dry-run check");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-dryrun-"));
    try {
      const copy = path.join(dir, "opportunities.json");
      fs.copyFileSync(live, copy);
      process.env.PIPELINE_DB = path.join(dir, "pipeline.db");
      process.env.AUDIT_DIR = path.join(dir, "audit");
      const { migrate: migrateFn, get: getFn } = await import("../tools/pipeline.ts");
      const report = await migrateFn({ from: copy, dryRun: true }) as any;
      assert.equal(report.read, 1907, "row count");
      assert.equal(report.rows_in_db, 1907);
      assert.ok(fs.existsSync(copy), "a dry run leaves the source in place");
      assert.deepEqual(report.by_status, {
        discovered: 1609,
        submitted: 85,
        parked: 128,
        rejected: 41,
        manual_action_needed: 30,
        withdrawn: 11,
        awaiting_external: 2,
        responded: 1,
      });
      const row = await getFn("seek-d39fa6c6a237");
      assert.ok(row, "seek-d39fa6c6a237 is present");
      assert.match(row!.title, /Solution Architect/);
      assert.ok(row!.history.length > 0, "its history survived");
      console.log("pipeline-store: live dry-run migrate ok (1907 rows)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log("Pipeline store tests passed");
