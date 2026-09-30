import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "seek-enrichment-"));
process.env.PIPELINE_DB = path.join(dir, "pipeline.db");
process.env.AUDIT_DIR = path.join(dir, "audit");
const { get, upsertMany } = await import("../tools/pipeline.ts");
const { closeSeekAdvertFromHeadings } = await import("../tools/channels/seek.ts");
try {
  const base = { channel: "seek", title: "Architect", company: "Example", url: "https://www.seek.com.au/job/123", description: "Original advert retained" };
  await upsertMany([
    { ...base, id: "closed", status: "shortlisted" },
    { ...base, id: "saved", status: "approved", userSaved: true },
    { ...base, id: "sent", status: "submitted", submittedAt: "2026-01-01T00:00:00Z" },
    { ...base, id: "pending", status: "submission_pending" },
    { ...base, id: "open", status: "shortlisted", postedAt: "2020-01-01" },
  ], { digest: false });
  const headings = ["This job is no longer advertised"];
  assert.equal(await closeSeekAdvertFromHeadings((await get("closed"))!, headings), true);
  assert.equal((await get("closed"))!.status, "rejected");
  assert.equal((await get("closed"))!.description, base.description);
  assert.match((await get("closed"))!.history.at(-1)!.reason!, /opening expired on SEEK/);
  assert.equal(await closeSeekAdvertFromHeadings((await get("closed"))!, headings), false);
  assert.equal(await closeSeekAdvertFromHeadings((await get("saved"))!, headings), true);
  assert.equal((await get("saved"))!.status, "withdrawn");
  for (const id of ["sent", "pending"]) {
    const before = (await get(id))!;
    assert.equal(await closeSeekAdvertFromHeadings(before, headings), false);
    assert.equal((await get(id))!.status, before.status, "never discard a confirmed or uncertain send");
  }
  for (const text of ["", "Just a moment...", "Verify you are human", "Architect", "We support clients whose job is no longer advertised"]) {
    assert.equal(await closeSeekAdvertFromHeadings((await get("open"))!, [text]), false);
  }
  assert.equal((await get("open"))!.status, "shortlisted", "age and generic page failures are not expiry evidence");
  console.log("SEEK enrichment closed-advert lifecycle tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
