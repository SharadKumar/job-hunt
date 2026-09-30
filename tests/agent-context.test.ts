import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dailyIndex, source, letterContext } from "../tools/agent-context.ts";
import type { Opportunity } from "../tools/pipeline.ts";

const row = (id: string, status: Opportunity["status"], userSaved = false): Opportunity => ({
  id, status, userSaved, title: id, company: "test", channel: "seek", url: "https://example.com",
  description: "large JD", notes: "historical notes", history: [],
});
const index = dailyIndex([row("queue", "shortlisted"), row("saved", "rejected", true),
  row("pending", "submission_pending"), row("sent", "submitted", true), row("noise", "discovered")]);
assert.deepEqual(index.work.map(r => r.id), ["queue", "saved", "pending"]);
assert.equal(index.total, 5);
assert.equal(index.by_status.submitted, 1);
assert.ok(!JSON.stringify(index).includes("large JD"));
assert.ok(!JSON.stringify(index).includes("historical notes"));
await assert.rejects(letterContext("../invalid"), /Invalid id/);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-"));
try {
  const file = path.join(dir, "rules.md");
  const text = "Hard rule\n".repeat(10000);
  await fs.writeFile(file, text);
  const first = await source(file);
  assert.equal(first.text, text, "rules must never be truncated");
  await fs.writeFile(file, `${text}Changed`);
  assert.notEqual((await source(file)).sha256, first.sha256);
  assert.equal((await source(path.join(dir, "optional"), true)).missing, true);
  await assert.rejects(source(path.join(dir, "required")));
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log("Agent context tests passed");
