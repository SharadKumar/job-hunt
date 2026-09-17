import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "job-hunt-pipeline-upsert-"));

// pipeline.ts resolves state/ through tools/repo-root.ts at import time, so the
// fixture root must be pinned BEFORE the module is evaluated — otherwise this
// test writes into the real pipeline.
process.env.HARNESS_REPO_ROOT = tempRoot;
process.env.AUDIT_DIR = path.join(tempRoot, "state", "audit");
const { upsert } = await import("../tools/pipeline.ts");

try {
  process.chdir(tempRoot);
  fs.mkdirSync(path.join("state", "pipeline"), { recursive: true });
  fs.writeFileSync(
    path.join("state", "pipeline", "opportunities.json"),
    JSON.stringify([
      {
        id: "seek-existing",
        channel: "seek",
        title: "Existing role",
        company: "Existing company",
        url: "https://www.seek.com.au/job/123",
        description: "old card",
        status: "submitted",
        submittedAt: "2026-09-04T00:00:00.000Z",
        history: [{ at: "2026-09-04T00:00:00.000Z", from: "submission_pending", to: "submitted" }],
      },
    ]),
  );

  await upsert({
    id: "seek-existing",
    channel: "seek",
    title: "Existing role",
    company: "Existing company",
    url: "https://www.seek.com.au/job/123",
    description: "fresh card",
    status: "discovered",
  });

  const [role] = JSON.parse(fs.readFileSync(path.join("state", "pipeline", "opportunities.json"), "utf8"));
  assert.equal(role.description, "fresh card", "refreshable card fields should update");
  assert.equal(role.status, "submitted", "refresh must not rewind workflow status");
  assert.equal(role.submittedAt, "2026-09-04T00:00:00.000Z");
  assert.deepEqual(role.history, [
    { at: "2026-09-04T00:00:00.000Z", from: "submission_pending", to: "submitted" },
  ]);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Pipeline upsert status-preservation test passed");
