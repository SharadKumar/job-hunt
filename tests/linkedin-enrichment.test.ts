import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "linkedin-enrichment-"));
process.env.PIPELINE_DB = path.join(dir, "pipeline.db");
process.env.AUDIT_DIR = path.join(dir, "audit");
const { get, upsertMany } = await import("../tools/pipeline.ts");
const { persistLinkedInEnrichment } = await import("../tools/channels/linkedin-jobs.ts");
try {
  const base = { channel: "linkedin_jobs", title: "Architect", company: "Example", url: "https://www.linkedin.com/jobs/view/123/" };
  await upsertMany([
    { ...base, id: "closed", status: "shortlisted", description: "Original description retained" },
    { ...base, id: "saved", status: "approved", userSaved: true },
    { ...base, id: "submitted", status: "submitted", submittedAt: "2026-01-01T00:00:00Z" },
    { ...base, id: "open", status: "shortlisted", postedAt: "2020-01-01" },
    { ...base, id: "already-noted", status: "shortlisted", notes: "[closed] LinkedIn: no longer accepting applications" },
  ], { digest: false });
  const data = { description: "", applyMethod: "unknown" as const, applied: false, closed: true, pills: [], applicants: "", ago: "", location: "" };
  assert.deepEqual(await persistLinkedInEnrichment((await get("closed"))!, data), { changed: false, expired: true });
  const closed = (await get("closed"))!;
  assert.equal(closed.status, "rejected");
  assert.equal(closed.description, "Original description retained");
  assert.match(closed.history.at(-1)!.reason!, /opening expired on LinkedIn/);
  assert.equal((await persistLinkedInEnrichment((await get("closed"))!, data)).expired, false, "expiry must be idempotent");
  await persistLinkedInEnrichment((await get("saved"))!, data);
  assert.equal((await get("saved"))!.status, "withdrawn");
  await persistLinkedInEnrichment((await get("submitted"))!, data);
  assert.equal((await get("submitted"))!.status, "submitted", "channel expiry cannot close a sent application");
  await persistLinkedInEnrichment((await get("already-noted"))!, data);
  assert.equal((await get("already-noted"))!.status, "rejected", "an old note is not a completed transition");
  const openData = { ...data, closed: false, description: "An open architecture contract with integration and governance responsibilities. ".repeat(3) };
  await persistLinkedInEnrichment((await get("open"))!, openData);
  assert.equal((await get("open"))!.status, "shortlisted", "posting age alone never means expired");
  await assert.rejects(persistLinkedInEnrichment((await get("open"))!, { ...data, closed: false }), /empty or too short/);
  console.log("LinkedIn enrichment expiry lifecycle tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
