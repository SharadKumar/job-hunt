#!/usr/bin/env tsx
/**
 * twenty-backend.test.ts — the pipeline facade over a Twenty workspace.
 *
 * Unit part (always): uuid5 ids are stable and the opening projection
 * round-trips the full row.
 *
 * Integration part (only with TWENTY_TEST_URL and TWENTY_TEST_KEY, against a
 * disposable `twenty local start --test` instance with the app applied and a
 * Harness-role key): insert, refresh, patch, compare-and-set transitions under
 * two writers, filtered list, and soft-delete removal, all through
 * tools/pipeline.ts with HARNESS_STORE=twenty. Fixtures are synthetic.
 */

import assert from "node:assert/strict";
import { uuid5, openingId, toOpening, fromOpening, twentyBackend } from "../tools/store/twenty-backend.ts";

// --- unit ---
assert.equal(uuid5("opening:x"), uuid5("opening:x"));
assert.notEqual(uuid5("opening:x"), uuid5("opening:y"));
assert.match(openingId("seek-abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
{
  const row: any = {
    id: "seek-0001", channel: "seek", url: "https://example.com/job/1", title: "Solution architect", company: "Acme Pty Ltd",
    status: "shortlisted", score: 82, scoreReasons: ["fit", "rate"], dayRate: { min: 1100, max: 1300, currency: "AUD" },
    workArrangement: "hybrid", history: [{ at: "2026-11-01T00:00:00Z", from: null, to: "discovered" }], notes: "kept", description: "JD text",
  };
  const rec = toOpening(row);
  assert.equal(rec.status, "SHORTLISTED");
  assert.deepEqual(rec.rateMin, { amountMicros: 1_100_000_000, currencyCode: "AUD" });
  assert.equal((rec.jd as any).markdown, "JD text");
  assert.equal((rec.harnessData as any).description, undefined, "JD is kept out of harnessData");
  const back = fromOpening({ ...rec, status: "SHORTLISTED" }, true);
  assert.deepEqual({ ...back, description: (back as any).description }, row);
}

// --- integration ---
const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_KEY;
if (!url || !key) {
  console.log("twenty-backend: unit ok; integration skipped (set TWENTY_TEST_URL and TWENTY_TEST_KEY)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("integration runs only against a local test instance");

// The digest is written beside PIPELINE_DB; keep it in a temp dir, never state/.
const os = await import("node:os"); const fsx = await import("node:fs"); const pathx = await import("node:path");
const tmp = fsx.mkdtempSync(pathx.join(os.tmpdir(), "twenty-itest-"));
process.env.PIPELINE_DB = pathx.join(tmp, "pipeline.db");
process.env.AUDIT_DIR ??= pathx.join(tmp, "audit");
process.env.TWENTY_API_URL = url;
process.env.TWENTY_API_KEY = key;
process.env.HARNESS_STORE = "twenty";
const { useRowBackend } = await import("../tools/store/index.ts");
useRowBackend(await twentyBackend({ config: { url, key } }));
const P = await import("../tools/pipeline.ts");

const tag = `itest-${Date.now()}`;
const a = { channel: "seek", url: `https://example.com/${tag}/a`, title: "Delivery lead", company: "Acme Pty Ltd", score: 70 };
const b = { channel: "seek", url: `https://example.com/${tag}/b`, title: "Platform architect", company: "Globex Ltd", score: 55 };

const [ra, rb] = await P.upsertMany([a, b], { digest: false });
assert.equal(ra.status, "discovered");
assert.equal((await P.get(ra.id))?.title, "Delivery lead");

// Refresh keeps status and history.
await P.setStatus(ra.id, "shortlisted", "fit", { actor: "itest" });
await P.upsertMany([{ ...a, title: "Delivery lead (updated)" }], { digest: false });
const refreshed = await P.get(ra.id);
assert.equal(refreshed?.status, "shortlisted");
assert.equal(refreshed?.title, "Delivery lead (updated)");
assert.equal(refreshed?.history.length, 2);

// Patch appends a field_update entry.
const patched = await P.patch(ra.id, { notes: "checked" } as any, "itest", "enrich");
assert.equal((patched as any).notes, "checked");
assert.match(patched.history.at(-1)?.reason ?? "", /field_update: notes/);

// Invalid transition refused.
await assert.rejects(P.setStatus(rb.id, "submitted"), /invalid transition/);

// Two writers race for the same move: exactly one wins.
await P.setStatus(rb.id, "shortlisted", undefined, { actor: "itest" });
const race = await Promise.allSettled([
  P.setStatus(rb.id, "drafted", "w1", { actor: "itest" }),
  P.setStatus(rb.id, "drafted", "w2", { actor: "itest" }),
]);
assert.equal(race.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(race.map((r) => r.status)));

// Filtered list sees both by status.
const drafted = (await P.list({ status: "drafted" })).map((r) => r.id);
assert.ok(drafted.includes(rb.id));

// Removal is a soft delete and leaves the row out of reads.
assert.deepEqual(await P.remove([ra.id, rb.id], "itest", "cleanup"), { removed: 2 });
assert.equal(await P.get(ra.id), null);

console.log("twenty-backend: unit and integration ok");
