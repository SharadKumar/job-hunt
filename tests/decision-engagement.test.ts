#!/usr/bin/env tsx
/**
 * decision-engagement.test.ts: Start engagement creates one engagement (F17, V17).
 *
 * Runs only against a disposable local Twenty test instance with the app
 * applied (skips otherwise). Needs:
 *   TWENTY_TEST_URL           http://127.0.0.1:2021
 *   TWENTY_TEST_KEY           a Harness-role API key
 *   TWENTY_TEST_OWNER_TOKEN   an access token of a member holding the Owner role
 *   TWENTY_TEST_OWNER_MEMBER  that member's workspaceMemberId
 *
 * The owner's token writes the decision the way the button does (both stamps
 * MANUAL). A forged one from the Harness key creates nothing. Synthetic data.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = (k: string) => process.env[k] ?? "";
const url = env("TWENTY_TEST_URL");
if (!url || !env("TWENTY_TEST_KEY") || !env("TWENTY_TEST_OWNER_TOKEN") || !env("TWENTY_TEST_OWNER_MEMBER")) {
  console.log("decision-engagement: skipped (set TWENTY_TEST_URL, TWENTY_TEST_KEY, TWENTY_TEST_OWNER_TOKEN, TWENTY_TEST_OWNER_MEMBER)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engagement-itest-"));
process.env.PIPELINE_DB = path.join(tmp, "pipeline.db");
process.env.AUDIT_DIR = path.join(tmp, "audit");
const key = env("TWENTY_TEST_KEY");
const ownerToken = env("TWENTY_TEST_OWNER_TOKEN");
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

const tag = `engagement-${Date.now()}`;
const [row] = await P.upsertMany([{ channel: "seek", url: `https://example.com/${tag}`, title: `Delivery lead ${tag}`, company: "Example Holdings Pty Ltd" }], { digest: false });
for (const s of ["shortlisted", "drafted", "awaiting_approval", "approved", "submitted", "responded", "interview", "offered", "won"] as const) {
  await P.setStatus(row.id, s, "itest", { actor: "itest" });
}
const oid = openingId(row.id);
const opening = (await rest(key, "GET", `/rest/openings/${oid}`)).data.opening;
assert.ok(opening.employerId, "the opening has an employer");
const engagementsFor = async () => (await rest(key, "GET", `/rest/engagements?filter=${encodeURIComponent(`openingId[eq]:${oid}`)}`)).data.engagements;

// A forged decision from the Harness key is refused and creates nothing.
const forged = await rest(key, "POST", "/rest/decisions", { name: "forged", decisionType: "START_ENGAGEMENT", statusSeen: "WON", openingId: oid });
assert.ok(forged.error || forged.statusCode >= 400 || !forged.data?.createDecision, "the Harness key can't create a decision");

// The owner's button-equivalent decision.
const made = await rest(ownerToken, "POST", "/rest/decisions", { name: "start", decisionType: "START_ENGAGEMENT", statusSeen: "WON", openingId: oid });
const decisionId = made.data?.createDecision?.id;
assert.ok(decisionId, JSON.stringify(made).slice(0, 200));
const verdicts = await runIntake({ url, key, ownerMemberId: owner });
const mine = verdicts.find((v) => v.id === decisionId);
assert.equal(mine?.result, "APPLIED", JSON.stringify(mine));

const created = await engagementsFor();
assert.equal(created.length, 1, "one engagement");
assert.equal(created[0].openingId, oid);
assert.equal(created[0].clientId, opening.employerId);
assert.equal(created[0].status, "ACTIVE");
assert.equal(created[0].name, `Delivery lead ${tag} at Example Holdings Pty Ltd`);
const decision = (await rest(key, "GET", `/rest/decisions/${decisionId}`)).data.decision;
assert.equal(decision.result, "APPLIED");
assert.match(decision.resultReason, /engagement .* created/);
assert.equal(decision.createdBy.source, "MANUAL", "the confirmation is the owner's");

// A second press on the same won opening does not duplicate it.
const again = await rest(ownerToken, "POST", "/rest/decisions", { name: "start-again", decisionType: "START_ENGAGEMENT", statusSeen: "WON", openingId: oid });
await runIntake({ url, key, ownerMemberId: owner });
assert.equal((await engagementsFor()).length, 1, "no duplicate engagement");
assert.match((await rest(key, "GET", `/rest/decisions/${again.data.createDecision.id}`)).data.decision.resultReason, /already exists/);

console.log("decision-engagement: ok");
