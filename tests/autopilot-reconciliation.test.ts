import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Isolate both authoritative stores before importing pipeline code.
const dir = await mkdtemp(path.join(tmpdir(), "autopilot-reconciliation-"));
process.env.PIPELINE_DB = path.join(dir, "pipeline.db");
process.env.AUDIT_DIR = path.join(dir, "audit");
const { upsertMany, get } = await import("../tools/pipeline.ts");
const { repoPath } = await import("../tools/repo-root.ts");
try {
  const id = "seek-reconciliation-fixture";
  await upsertMany([{ id, channel: "seek", title: "Architect", company: "Example",
    url: "https://www.seek.com.au/job/123", status: "submission_pending", userSaved: true }], { digest: false });
  for (const extra of [[], ["--dry-run"]]) {
    const result = spawnSync(process.execPath, [repoPath("node_modules/tsx/dist/cli.mjs"),
      repoPath("tools/autopilot-submit.ts"), "--id", id, ...extra], {
      env: process.env, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "submission_unconfirmed");
    assert.equal(report.status, "submission_pending");
    assert.match(report.reason, /reconcile/);
    assert.equal(report.gate, undefined, "must stop before gates, writer or browser work");
    assert.equal((await get(id))?.status, "submission_pending");
  }
  console.log("autopilot reconciliation guard passed (live and dry run, saved row)");
  for (const status of ["shortlisted", "drafted"] as const) {
    const blockedId = `seek-preflight-${status}-fixture`;
    await upsertMany([{ id: blockedId, channel: "seek", title: "Architect", company: "Example",
      url: `https://www.seek.com.au/job/${status}`, status, userSaved: true }], { digest: false });
    const result = spawnSync(process.execPath, [repoPath("node_modules/tsx/dist/cli.mjs"),
      repoPath("tools/autopilot-submit.ts"), "--id", blockedId], {
      env: process.env, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "no_cover_letter");
    assert.equal(report.status, "manual_action_needed", "preflight failure must leave the send queue");
    assert.equal((await get(blockedId))?.status, "manual_action_needed");
    assert.equal(report.gate, undefined, "failure transition does not authorise submission");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
