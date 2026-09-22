#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-expiry-"));
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
process.env.HARNESS_REPO_ROOT = root;

const { extractClosingDate, reconcileExpiredOpportunities, closeOpportunityAsExpired } = await import("../tools/opportunity-expiry.ts");
const { upsertMany, setStatus, get, patch } = await import("../tools/pipeline.ts");

const now = new Date("2026-09-22T02:00:00.000Z");

assert.equal(extractClosingDate("Applications close: 11:55pm, Tuesday 15th September 2026", { now })?.date, "2026-09-15");
assert.equal(extractClosingDate("Please note that the role closes on the 14th of September @ midday.", { now })?.date, "2026-09-14");
assert.equal(extractClosingDate("Closing Date: 2pm Wednesday 9 September 2026", { now })?.date, "2026-09-09");
assert.equal(extractClosingDate("The role closes on 14/09/2026", { now })?.date, "2026-09-14");
assert.equal(extractClosingDate("Applications close Thursday 24 September.", { now })?.date, "2026-09-24");
assert.equal(extractClosingDate("Applications close 21 September 2026. Updated: applications close 30 September 2026.", { now })?.date, "2026-09-30", "a stated extension wins over the retained original date");
assert.equal(extractClosingDate("Strong ability to meet deadlines and manage priorities", { now }), null, "generic deadlines are not expiry evidence");

const seed = (n: number, description: string) => ({
  channel: "seek",
  url: `https://example.test/job/${n}`,
  title: `Role ${n}`,
  company: "Example",
  description,
  status: "discovered" as const,
});

const [expired, open, submitted, approved, channelExpired] = await upsertMany([
  seed(1, "Applications close Monday 21 September 2026."),
  seed(2, "Applications close Thursday 24 September 2026."),
  seed(3, "Applications close Friday 18 September 2026."),
  seed(4, "Closing date: Sunday 20 September 2026."),
  seed(5, "No stated closing date."),
]);
await setStatus(submitted.id, "shortlisted", "fits");
await setStatus(submitted.id, "drafted", "ready");
await setStatus(submitted.id, "awaiting_approval", "ready");
await setStatus(submitted.id, "approved", "approved");
await setStatus(submitted.id, "submitted", "sent");
await setStatus(approved.id, "shortlisted", "fits");
await setStatus(approved.id, "drafted", "ready");
await setStatus(approved.id, "awaiting_approval", "ready");
await setStatus(approved.id, "approved", "approved");

const dry = await reconcileExpiredOpportunities({ apply: false, now });
assert.equal(dry.expired, 2, "dry run identifies the expired unsent rows");
assert.equal((await get(expired.id))?.status, "discovered", "dry run does not mutate state");

const applied = await reconcileExpiredOpportunities({ apply: true, now });
assert.equal(applied.expired, 2);
assert.equal((await get(expired.id))?.status, "rejected", "ordinary active work closes as rejected");
assert.equal((await get(approved.id))?.status, "withdrawn", "approved work closes through its legal terminal transition");
assert.equal((await get(open.id))?.status, "discovered", "today and future deadlines remain active");
assert.equal((await get(open.id))?.closingDate, "2026-09-24", "future explicit deadlines are retained");
assert.equal((await get(submitted.id))?.status, "submitted", "submitted work is never expired by the pipeline cleanup");
assert.match((await get(expired.id))?.history.at(-1)?.reason ?? "", /stated closing date 2026-09-21/);

await patch(open.id, { description: "Deadline extended. Applications close 30 September 2026." }, "test", "advert updated");
const extended = await reconcileExpiredOpportunities({ apply: true, now: new Date("2026-09-25T02:00:00.000Z") });
assert.equal(extended.results.some((result) => result.id === open.id), false, "an amended deadline prevents closure against the stored old date");
assert.equal((await get(open.id))?.status, "discovered");
assert.equal((await get(open.id))?.closingDate, "2026-09-30", "the stored closing date follows the current advert");

const board = await closeOpportunityAsExpired(channelExpired.id, { source: "channel", channelName: "SEEK" }, { apply: true });
assert.equal(board?.to, "rejected");
assert.equal((await get(channelExpired.id))?.status, "rejected", "a channel-expired advert also leaves active work");
assert.match((await get(channelExpired.id))?.history.at(-1)?.reason ?? "", /expired on SEEK/);

console.log("Pipeline expiry tests passed");
