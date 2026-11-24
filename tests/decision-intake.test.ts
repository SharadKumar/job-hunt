#!/usr/bin/env tsx
/**
 * decision-intake.test.ts — only the owner's own confirmation moves a row.
 *
 * Runs only against a disposable local Twenty test instance with the app
 * applied (skips otherwise). Needs:
 *   TWENTY_TEST_URL           http://127.0.0.1:2021
 *   TWENTY_TEST_KEY           a Harness-role API key
 *   TWENTY_TEST_ADMIN_KEY     an admin API key (to plant a forged decision)
 *   TWENTY_TEST_OWNER_TOKEN   an access token of a member holding the Owner role
 *   TWENTY_TEST_OWNER_MEMBER  that member's workspaceMemberId
 *
 * The owner's token writes the decision the way a button press does (both
 * stamps MANUAL, measured equal in V3). Fixtures are synthetic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = (k: string) => process.env[k] ?? "";
const url = env("TWENTY_TEST_URL");
if (!url || !env("TWENTY_TEST_KEY") || !env("TWENTY_TEST_OWNER_TOKEN")) {
  console.log("decision-intake: skipped (set TWENTY_TEST_URL, TWENTY_TEST_KEY, TWENTY_TEST_ADMIN_KEY, TWENTY_TEST_OWNER_TOKEN, TWENTY_TEST_OWNER_MEMBER)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-itest-"));
process.env.PIPELINE_DB = path.join(tmp, "pipeline.db");
process.env.AUDIT_DIR = path.join(tmp, "audit");
const key = env("TWENTY_TEST_KEY");
const owner = env("TWENTY_TEST_OWNER_MEMBER");

const { twentyBackend, openingId } = await import("../tools/store/twenty-backend.ts");
const { useRowBackend } = await import("../tools/store/index.ts");
useRowBackend(await twentyBackend({ config: { url, key } }));
const P = await import("../tools/pipeline.ts");
const { runIntake } = await import("../tools/decisions/intake.ts");

async function rest(token: string, method: string, p: string, body?: unknown) {
  const r = await fetch(`${url}${p}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function mcpCreate(token: string, record: Record<string, unknown>) {
  const r = await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_records", arguments: { objectName: "decision", records: [record] } } }) });
  return r.text();
}

const tag = `intake-${Date.now()}`;
const [row] = await P.upsertMany([{ channel: "seek", url: `https://example.com/${tag}`, title: "Integration lead", company: "Acme Pty Ltd" }], { digest: false });
for (const s of ["shortlisted", "drafted", "awaiting_approval"] as const) await P.setStatus(row.id, s, "itest", { actor: "itest" });
const oid = openingId(row.id);

// 1. Owner's confirmation (button-equivalent).
const good = await rest(env("TWENTY_TEST_OWNER_TOKEN"), "POST", "/rest/decisions", { name: "approve", decisionType: "APPROVE", statusSeen: "AWAITING_APPROVAL", openingId: oid });
// 2. Forged by an admin key claiming the owner.
const forged = await rest(env("TWENTY_TEST_ADMIN_KEY"), "POST", "/rest/decisions", { name: "forged", decisionType: "REJECT", statusSeen: "AWAITING_APPROVAL", openingId: oid,
  createdBy: { source: "MANUAL", workspaceMemberId: owner, name: "Owner" } });
// 3. MCP as the owner (an AI client acting with the owner's token).
await mcpCreate(env("TWENTY_TEST_OWNER_TOKEN"), { name: "via-mcp", decisionType: "WITHDRAW", statusSeen: "AWAITING_APPROVAL", openingId: oid });
assert.ok(good.data?.createDecision?.id, JSON.stringify(good).slice(0, 200));
assert.ok(forged.data?.createDecision?.id, JSON.stringify(forged).slice(0, 200));

const verdicts = await runIntake({ url, key, ownerMemberId: owner });
const byName = async (name: string) => (await rest(key, "GET", `/rest/decisions?filter=${encodeURIComponent(`name[eq]:${name}`)}`)).data.decisions.at(-1);

assert.equal((await P.get(row.id))?.status, "approved", JSON.stringify(verdicts));
assert.equal((await byName("approve")).result, "APPLIED");
assert.match((await byName("forged")).resultReason, /provenance/);
assert.match((await byName("via-mcp")).resultReason, /provenance: createdBy source is AGENT/);

// 4. A stale decision: shown AWAITING_APPROVAL, row is approved now.
await rest(env("TWENTY_TEST_OWNER_TOKEN"), "POST", "/rest/decisions", { name: "stale", decisionType: "REJECT", statusSeen: "AWAITING_APPROVAL", openingId: oid });
await runIntake({ url, key, ownerMemberId: owner });
assert.match((await byName("stale")).resultReason, /stale/);
assert.equal((await P.get(row.id))?.status, "approved");

// 5. The owner cannot edit a consumed decision to replay it.
const edit = await fetch(`${url}/rest/decisions/${good.data.createDecision.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${env("TWENTY_TEST_OWNER_TOKEN")}`, "Content-Type": "application/json" }, body: JSON.stringify({ consumedAt: null }) });
assert.equal(edit.status, 403);

await P.remove([row.id], "itest", "cleanup");
console.log("decision-intake: ok");
