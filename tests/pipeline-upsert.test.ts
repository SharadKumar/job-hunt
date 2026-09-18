import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "job-hunt-pipeline-upsert-"));

// pipeline.ts resolves its database from PIPELINE_DB and audit.ts pins
// AUDIT_DIR at import time, so both must be set BEFORE the modules evaluate —
// otherwise this test writes into the real pipeline.
process.env.HARNESS_REPO_ROOT = tempRoot;
process.env.PIPELINE_DB = path.join(tempRoot, "pipeline.db");
process.env.AUDIT_DIR = path.join(tempRoot, "state", "audit");
const { upsert, get } = await import("../tools/pipeline.ts");
const { openStore } = await import("../tools/pipeline-store.ts");

try {
  // Seed a row that has already been submitted, the way the pipeline holds it.
  const store = openStore(process.env.PIPELINE_DB);
  store.insert({
    id: "seek-existing",
    channel: "seek",
    title: "Existing role",
    company: "Existing company",
    url: "https://www.seek.com.au/job/123",
    description: "old card",
    status: "submitted",
    submittedAt: "2026-09-04T00:00:00.000Z",
    history: [{ at: "2026-09-04T00:00:00.000Z", from: "submission_pending", to: "submitted" }],
  });
  store.close();

  await upsert({
    id: "seek-existing",
    channel: "seek",
    title: "Existing role",
    company: "Existing company",
    url: "https://www.seek.com.au/job/123",
    description: "fresh card",
    status: "discovered",
  });

  const role = (await get("seek-existing"))!;
  assert.equal(role.description, "fresh card", "refreshable card fields should update");
  assert.equal(role.status, "submitted", "refresh must not rewind workflow status");
  assert.equal(role.submittedAt, "2026-09-04T00:00:00.000Z");
  assert.deepEqual(role.history, [
    { at: "2026-09-04T00:00:00.000Z", from: "submission_pending", to: "submitted" },
  ]);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Pipeline upsert status-preservation test passed");
