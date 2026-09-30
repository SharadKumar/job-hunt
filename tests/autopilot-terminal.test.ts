#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "autopilot-terminal-"));
process.env.PIPELINE_DB = path.join(dir, "pipeline.db");
process.env.AUDIT_DIR = path.join(dir, "audit");
const { upsertMany, get } = await import("../tools/pipeline.ts");
const { classificationReverificationRequired, closeAdvertAfterAdapterNotice, deferForChannelVerification, markSeekVerificationRequired, seekVerificationRequiredForRun } = await import("../tools/autopilot-submit.ts");
try {
  for (const gate of ["autopilot_classified", "jev_autopilot_authority", "autopilot_classification_current"]) {
    assert.equal(classificationReverificationRequired({ checks: [{ gate, ok: false, detail: "stale" }] }), true);
  }
  assert.equal(classificationReverificationRequired({ checks: [{ gate: "autopilot_letter_critic", ok: false, detail: "blocked" }] }), false);
  const id = "linkedin_jobs-terminal-fixture";
  await upsertMany([{ id, channel: "linkedin_jobs", title: "Architect", company: "Example", url: "https://www.linkedin.com/jobs/view/123/", status: "submission_pending" }], { digest: false });
  assert.equal(await closeAdvertAfterAdapterNotice(id, "LinkedIn ad is no longer accepting applications", "daily-test"), "withdrawn");
  const row = await get(id);
  assert.equal(row?.status, "withdrawn");
  assert.ok(row?.channelExpiredAt);
  assert.match(row?.history?.at(-1)?.reason ?? "", /no application form was opened/);
  await assert.rejects(closeAdvertAfterAdapterNotice(id, "closed", "daily-test"), /expected submission_pending/);
  const retryId = "seek-verification-fixture";
  await upsertMany([{ id: retryId, channel: "seek", title: "Architect", company: "Example", url: "https://www.seek.com.au/job/456", status: "submission_pending" }], { digest: false });
  assert.equal(await deferForChannelVerification(retryId, "SEEK human verification required", "daily-test"), "approved");
  const retry = await get(retryId);
  assert.equal(retry?.status, "approved");
  assert.match(retry?.notes ?? "", /human verification required/);
  await assert.rejects(deferForChannelVerification(retryId, "challenge", "daily-test"), /expected submission_pending/);
  const report = path.join(dir, "front-half.json");
  await writeFile(report, JSON.stringify({ ok: true, partial: false, steps: [], channel_health: { seek: { verification_required: false } } }));
  assert.equal(await seekVerificationRequiredForRun("daily-2026-09-30", report), false);
  assert.equal(await markSeekVerificationRequired("daily-2026-09-30", report), true);
  assert.equal(await seekVerificationRequiredForRun("daily-2026-09-30", report), true);
  assert.equal(JSON.parse(await readFile(report, "utf8")).partial, true);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log("autopilot terminal closure test OK");
