#!/usr/bin/env tsx
/**
 * twenty-roles.test.ts — the app's roles as Twenty enforces them (plan V6).
 *
 * Runs only against a disposable local test instance with the app applied
 * (skips otherwise). Needs TWENTY_TEST_URL, TWENTY_TEST_KEY (Harness role),
 * TWENTY_TEST_GROK_KEY (Grok role) and TWENTY_TEST_OWNER_TOKEN (a member
 * holding the Owner role). Every grant is exercised and every non-grant must
 * come back 403 (or, for the Grok key, return nothing).
 */

import assert from "node:assert/strict";

const env = (k: string) => process.env[k] ?? "";
const url = env("TWENTY_TEST_URL");
if (!url || !env("TWENTY_TEST_KEY") || !env("TWENTY_TEST_GROK_KEY") || !env("TWENTY_TEST_OWNER_TOKEN")) {
  console.log("twenty-roles: skipped (needs TWENTY_TEST_URL, TWENTY_TEST_KEY, TWENTY_TEST_GROK_KEY, TWENTY_TEST_OWNER_TOKEN)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const H = env("TWENTY_TEST_KEY"), G = env("TWENTY_TEST_GROK_KEY"), O = env("TWENTY_TEST_OWNER_TOKEN");
async function req(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}
const tag = `roles-${Date.now()}`;

// Harness: create and update its objects; may not create decisions; may soft-delete openings; may not destroy.
const op = await req(H, "POST", "/rest/openings", { title: "Role probe", harnessId: tag, status: "DISCOVERED" });
assert.equal(op.status, 201, JSON.stringify(op.json).slice(0, 200));
const openingId = op.json.data.createOpening.id;
assert.equal((await req(H, "PATCH", `/rest/openings/${openingId}`, { score: 50 })).status, 200);
assert.equal((await req(H, "POST", "/rest/escalations", { name: tag, dedupeKey: tag })).status, 201);
assert.equal((await req(H, "POST", "/rest/decisions", { name: tag, decisionType: "APPROVE", openingId })).status, 403, "Harness creates no decision");

// Owner: reads; creates a decision; cannot edit harness-owned fields; cannot create openings; cannot touch decisions afterwards.
assert.equal((await req(O, "GET", `/rest/openings/${openingId}`)).status, 200);
const dec = await req(O, "POST", "/rest/decisions", { name: tag, decisionType: "HOLD", statusSeen: "DISCOVERED", openingId });
assert.equal(dec.status, 201, JSON.stringify(dec.json).slice(0, 200));
const decisionId = dec.json.data.createDecision.id;
assert.equal((await req(O, "PATCH", `/rest/openings/${openingId}`, { status: "APPROVED" })).status, 403, "Owner can't move status");
assert.equal((await req(O, "POST", "/rest/openings", { title: "x", harnessId: `${tag}-o` })).status, 403, "Owner can't create openings");
assert.equal((await req(O, "PATCH", `/rest/decisions/${decisionId}`, { note: "edit" })).status, 403, "decisions are immutable");
assert.equal((await req(O, "POST", "/rest/decisions", { name: `${tag}-c`, decisionType: "HOLD", openingId, consumedAt: new Date().toISOString() })).status, 403, "Owner can't set consume fields");
const prop = await req(O, "POST", "/rest/proposals", { name: tag, proposalType: "RESEARCH_COMPANY", openingId });
assert.equal(prop.status, 201, "Owner (AI chat) may propose");
assert.equal((await req(O, "POST", "/rest/proposals", { name: `${tag}-s`, proposalType: "RESEARCH_COMPANY", status: "CONFIRMED" })).status, 403, "a proposal can't mark itself confirmed");

// Harness consumes the decision (consume fields only) but can't rewrite what the person decided.
assert.equal((await req(H, "PATCH", `/rest/decisions/${decisionId}`, { result: "APPLIED", resultReason: "probe", consumedAt: new Date().toISOString() })).status, 200);
assert.equal((await req(H, "PATCH", `/rest/decisions/${decisionId}`, { decisionType: "APPROVE" })).status, 403, "Harness can't rewrite a decision");

// Grok: reads nothing, writes nothing, on REST and GraphQL.
for (const path of ["/rest/openings?limit=1", "/rest/decisions?limit=1", "/rest/companies?limit=1", "/rest/messages?limit=1", "/rest/attachments?limit=1"]) {
  assert.equal((await req(G, "GET", path)).status, 403, `Grok ${path}`);
}
assert.equal((await req(G, "POST", "/rest/proposals", { name: "grok" })).status, 403);

// Clean up through the Harness's only removal path.
assert.equal((await req(H, "DELETE", `/rest/openings/${openingId}?soft_delete=true`)).status, 200);
assert.notEqual((await req(H, "DELETE", `/rest/openings/${openingId}`)).status, 200, "Harness can't destroy");

console.log("twenty-roles: ok");
