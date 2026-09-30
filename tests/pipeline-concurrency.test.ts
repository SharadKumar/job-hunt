/** Two independent runners must not both claim one approved application. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-claim-"));
const db = path.join(dir, "pipeline.db");
const go = path.join(dir, "go");
process.env.PIPELINE_DB = db;
process.env.AUDIT_DIR = path.join(dir, "audit");

try {
  const { upsert, get, setStatus } = await import("../tools/pipeline.ts");
  const row = await upsert({ channel: "seek", url: "https://example.test/job/claim",
    title: "Solution Architect", company: "Example", status: "approved" });
  const moduleUrl = pathToFileURL(path.join(repo, "tools/pipeline.ts")).href;
  const childCode = `
    import fs from "node:fs";
    const { setStatus } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write("READY\\n");
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise(resolve => setTimeout(resolve, 2));
    try {
      await setStatus(${JSON.stringify(row.id)}, "submission_pending", "concurrent claim", { actor: "test" });
      process.stdout.write("CLAIMED\\n");
    } catch (error) {
      process.stderr.write(String(error));
      process.exitCode = 3;
    }
  `;
  const start = (code = childCode) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: repo, env: { ...process.env, PIPELINE_DB: db, AUDIT_DIR: path.join(dir, "audit") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`claim child did not start: ${stderr}`)), 10_000);
      child.stdout.on("data", () => {
        if (stdout.includes("READY\n")) { clearTimeout(deadline); resolve(); }
      });
      child.on("error", reject);
    });
    return { ready, finished };
  };
  const a = start();
  const b = start();
  await Promise.all([a.ready, b.ready]);
  fs.writeFileSync(go, "go");
  const results = await Promise.all([a.finished, b.finished]);
  assert.equal(results.filter(result => result.code === 0 && result.stdout.includes("CLAIMED")).length, 1,
    `exactly one runner may claim the row: ${JSON.stringify(results)}`);
  assert.equal(results.filter(result => result.code === 3 && /invalid transition submission_pending/.test(result.stderr)).length, 1,
    `the second runner must see the claimed status: ${JSON.stringify(results)}`);
  const after = await get(row.id);
  assert.equal(after?.status, "submission_pending");
  assert.equal(after?.history.filter(event => event.to === "submission_pending").length, 1);
  await assert.rejects(() => setStatus(row.id, "manual_action_needed", "stale pre-send failure",
    { actor: "autopilot", expectedStatus: "approved" }), /status changed from approved to submission_pending/);
  assert.equal((await get(row.id))?.status, "submission_pending", "a stale runner cannot park another runner's claim");

  fs.rmSync(go);
  const approval = await upsert({ channel: "seek", url: "https://example.test/job/approval",
    title: "Delivery Lead", company: "Example", status: "awaiting_approval" });
  const autopilotUrl = pathToFileURL(path.join(repo, "tools/autopilot-submit.ts")).href;
  const walkCode = `
    import fs from "node:fs";
    const { walkToApproved } = await import(${JSON.stringify(autopilotUrl)});
    process.stdout.write("READY\\n");
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise(resolve => setTimeout(resolve, 2));
    try {
      await walkToApproved(${JSON.stringify(approval.id)}, "parallel-test", []);
      process.stdout.write("APPROVED\\n");
    } catch (error) {
      process.stderr.write(String(error));
      process.exitCode = 3;
    }
  `;
  const c = start(walkCode);
  const d = start(walkCode);
  await Promise.all([c.ready, d.ready]);
  fs.writeFileSync(go, "go");
  const approvalResults = await Promise.all([c.finished, d.finished]);
  assert.ok(approvalResults.every(result => result.code === 0 && result.stdout.includes("APPROVED")),
    `parallel approval walks must converge without parking: ${JSON.stringify(approvalResults)}`);
  const approved = await get(approval.id);
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.history.filter(event => event.to === "approved").length, 1);
  console.log("pipeline-concurrency: one portal claim across two runners");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
