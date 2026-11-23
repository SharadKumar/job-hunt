#!/usr/bin/env tsx
/**
 * grok-digest.test.ts: the Grok digest (plan F16, V16).
 *
 * Unit: the cap (15 minutes apart, 6 in 24 hours) over a synthetic day, the
 * ledger, and a payload that carries rates and links but never a job
 * description, letter or harness data.
 *
 * Integration (TWENTY_TEST_URL and TWENTY_TEST_KEY set, local test instance
 * only, Harness-role key): a new escalation and a failed run reach a local
 * fake webhook once, with the bearer, and get grokDeliveredAt; a capped run
 * posts nothing. Synthetic data only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { capCheck, composeDigest, grokDigest, MAX_PER_DAY, readLedger, recordPost, type Ledger } from "../tools/twenty/grok-digest.ts";

const SECRET = "SECRET-FULL-TEXT";
const T0 = new Date("2026-11-23T00:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

// Cap over a synthetic day: try every 5 minutes for 24 hours.
{
  let ledger: Ledger = { posts: [] };
  const posted: number[] = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    if (capCheck(ledger, at(m)).ok) { ledger = recordPost(ledger, at(m)); posted.push(m); }
  }
  assert.equal(posted.length, MAX_PER_DAY, "at most 6 posts a day");
  for (let i = 1; i < posted.length; i++) assert.ok(posted[i] - posted[i - 1] >= 15, "at least 15 minutes apart");
  assert.deepEqual(posted, [0, 15, 30, 45, 60, 75]);
  const blocked = capCheck(ledger, at(600));
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.nextAt === at(24 * 60).toISOString(), "the next slot is 24 hours after the oldest counted post");
  assert.equal(capCheck(ledger, at(24 * 60)).ok, true, "a slot frees after 24 hours");
  assert.equal(recordPost(ledger, at(48 * 60)).posts.length, 1, "the ledger keeps only the last 24 hours");
}
{
  const l = recordPost({ posts: [] }, at(0));
  assert.equal(capCheck(l, at(14)).ok, false, "14 minutes is too soon");
  assert.equal(capCheck(l, at(15)).ok, true, "15 minutes is enough");
  assert.equal(capCheck({ posts: ["not a date"] }, at(0)).ok, true, "junk in the ledger is ignored");
}

// Payload: summaries with rates and links, never full text.
{
  const opening = {
    id: "o1", title: "Platform lead", status: "SHORTLISTED",
    rateMin: { amountMicros: 900_000_000, currencyCode: "AUD" }, rateMax: { amountMicros: 1_100_000_000, currencyCode: "AUD" },
    url: { primaryLinkUrl: "https://example.com/job/1" },
    jd: { markdown: SECRET }, harnessData: { letter: SECRET }, classification: { why: SECRET },
  };
  const escalations = [
    { id: "e1", status: "OPEN", name: "Platform lead at Acme", kind: "gate", priority: "P1", reason: "Letter critic blocked", openingId: "o1", letterMarkdown: SECRET },
    { id: "e2", status: "OPEN", grokDeliveredAt: "2026-11-22T00:00:00Z" },
    { id: "e3", status: "OPEN", migratedAt: "2026-11-01T00:00:00Z" },
    { id: "e4", status: "RESOLVED" },
  ];
  const runs = [
    { id: "r1", name: "Daily", exitCode: 2, summary: "Front half failed", lettersSentUnattended: SECRET },
    { id: "r2", name: "Daily", exitCode: 0 },
    { id: "r3", name: "Daily", exitCode: 1, grokDeliveredAt: "2026-11-22T00:00:00Z" },
  ];
  const d = composeDigest(escalations, runs, new Map([["o1", opening]]), { publicUrl: "https://crm.example.com/", now: T0 });
  assert.ok(d);
  assert.deepEqual(d!.escalationIds, ["e1"]);
  assert.deepEqual(d!.runIds, ["r1"]);
  const text = JSON.stringify(d!.body);
  assert.ok(!text.includes(SECRET), "no full text, letter or harness data");
  assert.ok(text.includes("900 to 1100 AUD"), "rates");
  assert.ok(text.includes("https://example.com/job/1"), "advert link");
  assert.ok(text.includes("https://crm.example.com/object/escalation/e1"), "record link");
  assert.ok(text.includes("https://crm.example.com/object/run/r1"));
  assert.equal(composeDigest([], [{ id: "r2", exitCode: 0 }], new Map(), { publicUrl: "x", now: T0 }), null, "nothing to say, nothing posted");
}

// Not configured: skipped before any read.
{
  const call = async () => { throw new Error("must not be called"); };
  const r = await grokDigest(call as any, { webhook: "", bearer: "", publicUrl: "x", ledgerFile: "/nonexistent" });
  assert.match(String((r as any).skipped), /not set/);
}

const env = (k: string) => process.env[k] ?? "";
const url = env("TWENTY_TEST_URL");
if (!url || !env("TWENTY_TEST_KEY")) {
  console.log("grok-digest: unit ok; integration skipped (set TWENTY_TEST_URL and TWENTY_TEST_KEY)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const { connect } = await import("../tools/twenty/records.ts");
const call = await connect({ url, key: env("TWENTY_TEST_KEY") });
const received: { auth: string | undefined; body: any }[] = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { received.push({ auth: req.headers.authorization, body: JSON.parse(raw) }); res.writeHead(200).end("{}"); });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const webhook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-digest-")), "ledger.json");

try {
  const tag = `grok-digest-${Date.now()}`;
  const opening = (await call("POST", "/rest/openings", {
    title: `Integration architect ${tag}`, status: "SHORTLISTED",
    rateMin: { amountMicros: 800_000_000, currencyCode: "AUD" }, rateMax: { amountMicros: 950_000_000, currencyCode: "AUD" },
    url: { primaryLinkUrl: `https://example.com/${tag}`, primaryLinkLabel: "Advert" },
    jd: { markdown: `${SECRET} ${tag}` },
  })).data.createOpening;
  const esc = (await call("POST", "/rest/escalations", { name: `Needs you ${tag}`, kind: "gate", priority: "P2", status: "OPEN", reason: "Synthetic", openingId: opening.id })).data.createEscalation;
  const run = (await call("POST", "/rest/runs", { name: `Run ${tag}`, kind: "DAILY", exitCode: 3, summary: "Synthetic failure", lettersSentUnattended: `${SECRET} letter` })).data.createRun;

  const first = await grokDigest(call, { webhook, bearer: "test-bearer", publicUrl: url, ledgerFile, now: new Date() });
  assert.equal((first as any).posted, 1, JSON.stringify(first));
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, "Bearer test-bearer");
  const body = JSON.stringify(received[0].body);
  assert.ok(body.includes(esc.id) && body.includes(run.id), "carries the new escalation and the failed run");
  assert.ok(body.includes("800 to 950 AUD") && body.includes(`https://example.com/${tag}`), "rates and links");
  assert.ok(!body.includes(SECRET), "no job description or letter");
  assert.ok((await call("GET", `/rest/escalations/${esc.id}`)).data.escalation.grokDeliveredAt, "escalation marked");
  assert.ok((await call("GET", `/rest/runs/${run.id}`)).data.run.grokDeliveredAt, "run marked");
  assert.equal((await readLedger(ledgerFile)).posts.length, 1);

  // A second item straight away is capped: nothing posted, nothing marked.
  const esc2 = (await call("POST", "/rest/escalations", { name: `Again ${tag}`, kind: "gate", priority: "P2", status: "OPEN" })).data.createEscalation;
  const second = await grokDigest(call, { webhook, bearer: "test-bearer", publicUrl: url, ledgerFile, now: new Date() });
  assert.match(String((second as any).capped), /15 minutes/);
  assert.equal(received.length, 1);
  assert.equal((await call("GET", `/rest/escalations/${esc2.id}`)).data.escalation.grokDeliveredAt, null);

  // 16 minutes later it goes, and only the undelivered item is carried.
  const third = await grokDigest(call, { webhook, bearer: "test-bearer", publicUrl: url, ledgerFile, now: new Date(Date.now() + 16 * 60_000) });
  assert.equal((third as any).posted, 1, JSON.stringify(third));
  const ids = received[1].body.escalations.map((e: any) => e.id);
  assert.ok(ids.includes(esc2.id) && !ids.includes(esc.id), "only undelivered items");
  assert.ok(!received[1].body.failedRuns.some((r: any) => r.id === run.id));

  for (const id of [esc.id, esc2.id]) await call("PATCH", `/rest/escalations/${id}`, { status: "DISMISSED" });
} finally {
  server.close();
}
console.log("grok-digest: ok");
