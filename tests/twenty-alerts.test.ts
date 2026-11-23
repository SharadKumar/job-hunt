#!/usr/bin/env tsx
/**
 * twenty-alerts.test.ts: escalations, delivery and follow-ups on Twenty (F13, F19).
 *
 * Unit: priority mapping, the sync plan (dedupe, reopen, resolve, never a
 * delivery field), delivery composition and inform-once, business-day due
 * dates, idempotent Task ids.
 *
 * Integration (TWENTY_TEST_URL and TWENTY_TEST_KEY set, local test instance
 * only, Harness-role key): P1, P2 and a repeat dedupeKey give one immediate
 * post for the P1 and one digest with the P2, a second run posts nothing and
 * the repeat creates nothing; follow-ups create one Task per submitted opening
 * and none on re-run. A local HTTP server stands in for the Slack webhook.
 * Synthetic data only.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Escalation } from "../tools/daily-summary.ts";
import { openingId } from "../tools/store/twenty-backend.ts";
import { DELIVERY_FIELDS, dedupeKey, escalationRecordId, planSync, priorityFor, syncEscalations, toRecord } from "../tools/twenty/escalations.ts";
import { composeDelivery, deliver } from "../tools/twenty/deliver.ts";
import { addBusinessDays, planFollowups, syncFollowups, taskId, taskTargetId } from "../tools/twenty/followups.ts";
import { connect, getByIds } from "../tools/twenty/records.ts";

const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = "2026-11-23T00:00:00.000Z";

// Priority: the harness sets it from the kind.
for (const k of ["kill_switch", "cap", "channel", "gate", "submission_pending"]) assert.equal(priorityFor(k), "P1", k);
for (const k of ["screening", "awaiting_approval"]) assert.equal(priorityFor(k), "P2", k);
assert.equal(priorityFor("manual"), "P3");
assert.equal(priorityFor("some_new_kind"), "P2");

// Dedupe key and record id.
const gate: Escalation = { kind: "gate", id: "row-1", title: "Platform lead", company: "Acme", reason: "Letter critic blocked", action: "Fix it" };
const channel: Escalation = { kind: "channel", reason: "Channel sign-in expired", action: "Sign in" };
const screening: Escalation = { kind: "screening", id: "row-2", title: "Architect", company: "Globex", reason: 'Unanswered screening question: "Do you hold a licence?"', action: "Answer it" };
const manual: Escalation = { kind: "manual", id: "row-3", title: "Engineer", company: "Initech", reason: "External ATS redirect to example.com", action: "Apply" };
assert.equal(dedupeKey(gate), "gate:row-1");
assert.equal(dedupeKey(channel), "channel:Channel sign-in expired");
assert.match(escalationRecordId("gate:row-1"), UUID5);
assert.equal(escalationRecordId("gate:row-1"), escalationRecordId(dedupeKey({ ...gate, reason: "different text" })));
const rec = toRecord(gate, { notifyMemberId: "member-1" });
assert.equal(rec.priority, "P1");
assert.equal(rec.openingId, openingId("row-1"));
assert.equal(rec.notifyMemberId, "member-1");
assert.equal(rec.name, "Platform lead at Acme");
assert.equal(toRecord(gate, { linkOpening: () => false }).openingId, null);
for (const f of DELIVERY_FIELDS) assert.ok(!(f in rec), `toRecord never sets ${f}`);

// Sync plan.
{
  const plan = planSync([gate, screening, gate], [], { now: NOW });
  assert.equal(plan.create.length, 2, "a repeat dedupeKey collapses");
  assert.ok(plan.create.every((r) => r.status === "OPEN"));
  for (const r of plan.create) for (const f of DELIVERY_FIELDS) assert.ok(!(f in r));
}
{
  const delivered = "2026-11-22T00:00:00.000Z";
  const existing = [
    { ...toRecord(gate), status: "OPEN", deliveredAt: delivered },
    { ...toRecord(screening), reason: "old text", status: "OPEN", deliveredAt: delivered },
    { ...toRecord(manual), status: "RESOLVED", deliveredAt: delivered, resolvedAt: delivered },
    { ...toRecord(channel), status: "DISMISSED" },
    { ...toRecord({ kind: "cap", reason: "cap used up", action: "" }), status: "OPEN" },
    { ...toRecord({ kind: "cap", reason: "migrated one", action: "" }), status: "OPEN", migratedAt: delivered },
    { id: "11111111-1111-4111-8111-111111111111", dedupeKey: "made-by-hand", status: "OPEN" },
  ];
  const plan = planSync([gate, screening, manual, channel], existing, { now: NOW });
  assert.equal(plan.create.length, 0);
  assert.equal(plan.unchanged, 1, "an unchanged OPEN record is not rewritten");
  assert.deepEqual(plan.reopen, [escalationRecordId(dedupeKey(manual))]);
  assert.deepEqual(plan.dismissed, [escalationRecordId(dedupeKey(channel))]);
  assert.deepEqual(plan.resolve, [escalationRecordId("cap:cap used up")], "only this tool's live records resolve; migrated and hand-made ones stay");
  const byId = new Map(plan.update.map((u) => [u.id, u.fields]));
  assert.deepEqual(byId.get(escalationRecordId(dedupeKey(screening))), { reason: screening.reason });
  assert.equal(byId.get(escalationRecordId(dedupeKey(manual)))?.status, "OPEN");
  assert.equal(byId.get(escalationRecordId(dedupeKey(manual)))?.resolvedAt, null);
  assert.deepEqual(byId.get(escalationRecordId("cap:cap used up")), { status: "RESOLVED", resolvedAt: NOW });
  for (const u of plan.update) for (const f of DELIVERY_FIELDS) assert.ok(!(f in u.fields), "sync never writes a delivery field (R36)");
}

// Delivery composition.
const publicUrl = "https://crm.example.test/";
const asRecord = (e: Escalation, extra: Record<string, unknown> = {}): Record<string, any> => ({ ...toRecord(e), status: "OPEN", deliveredAt: null, migratedAt: null, ...extra });
{
  const records = [asRecord(gate), asRecord(screening), asRecord(manual), asRecord(channel, { deliveredAt: NOW }), asRecord({ kind: "cap", reason: "old", action: "" }, { migratedAt: NOW })];
  const posts = composeDelivery(records, { publicUrl, timeLabel: "23 Nov, 11:00 am" });
  assert.equal(posts.length, 2, "one P1 post, one digest");
  assert.deepEqual(posts[0].ids, [rec.id]);
  assert.ok(posts[0].text.includes(`<https://crm.example.test/object/escalation/${rec.id}|Platform lead at Acme>`));
  assert.deepEqual(posts[1].ids.sort(), [toRecord(screening).id, toRecord(manual).id].sort());
  assert.ok(posts[1].text.includes("2 items need you"));
  assert.ok(posts[1].text.includes("*Answer a screening question*") && posts[1].text.includes("*Apply yourself*"));
  assert.ok(posts[1].text.includes('"Do you hold a licence?"'));
  assert.ok(!posts.some((p) => p.text.includes("Channel sign-in")), "delivered records never post again");
  assert.deepEqual(composeDelivery([], { publicUrl, timeLabel: "x" }), []);
  const failed = composeDelivery([], { publicUrl, timeLabel: "x", exitCode: 3 });
  assert.equal(failed.length, 1);
  assert.ok(failed[0].text.includes("exit 3"));
  for (const p of posts) assert.ok(!/[\u2013\u2014]/.test(p.text), "no dashes");
}

// Inform once, through deliver() with a fake Twenty.
{
  const store = [asRecord(gate), asRecord(screening)];
  const fakeCall = async (method: string, path: string, body?: any) => {
    if (method === "GET") return { data: { escalations: store.filter((r) => !r.deliveredAt) }, pageInfo: {} };
    if (method === "PATCH") { Object.assign(store.find((r) => path.endsWith(r.id as string))!, body); return {}; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const sent: string[] = [];
  const opts = { webhook: "http://fake", publicUrl, timeLabel: "x", post: async (t: string) => { sent.push(t); } };
  const first = await deliver(fakeCall as any, opts);
  assert.equal(first.sent, 2);
  assert.equal(first.delivered, 2);
  assert.ok(store.every((r) => r.deliveredAt));
  const second = await deliver(fakeCall as any, opts);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 2);
  const failing = await deliver((async () => ({ data: { escalations: [asRecord(gate)] } })) as any, { ...opts, post: async () => { throw new Error("HTTP 500"); } });
  assert.equal(failing.ok, false);
  assert.equal(failing.delivered, 0, "a failed POST marks nothing delivered");
  const unset = await deliver((async () => ({ data: { escalations: [asRecord(gate)] } })) as any, { ...opts, webhook: "" });
  assert.equal(unset.delivered, 0);
}

// Business days.
assert.equal(addBusinessDays("2026-11-23T03:00:00.000Z", 7), "2026-12-02T03:00:00.000Z", "Monday + 7 is the Wednesday after next");
assert.equal(addBusinessDays("2026-11-27T03:00:00.000Z", 1), "2026-11-30T03:00:00.000Z", "Friday + 1 is Monday");
assert.equal(addBusinessDays("2026-11-28T03:00:00.000Z", 1), "2026-11-30T03:00:00.000Z", "Saturday + 1 is Monday");
assert.equal(addBusinessDays("2026-11-27T20:00:00.000Z", 1, "UTC"), "2026-11-30T20:00:00.000Z");
assert.equal(addBusinessDays("2026-11-27T20:00:00.000Z", 1, "Australia/Sydney"), "2026-11-29T20:00:00.000Z", "already Saturday in Sydney");

// Follow-up plan.
{
  const op = (harnessId: string, status: string, extra: Record<string, unknown> = {}) => ({ id: openingId(harnessId), harnessId, title: "Architect", status, harnessData: { id: harnessId, company: "Acme" }, ...extra });
  const openings = [
    op("s1", "SUBMITTED", { submittedAt: "2026-11-23T03:00:00.000Z" }),
    op("s2", "SUBMITTED", { submittedAt: "2026-11-23T03:00:00.000Z", migratedAt: NOW }),
    op("s3", "SUBMITTED", { submittedAt: "2026-11-23T03:00:00.000Z", harnessData: { id: "s3", migratedAt: NOW } }),
    op("i1", "INTERVIEW"),
    op("d1", "DRAFTED"),
  ];
  const plan = planFollowups(openings, { now: NOW, ownerMemberId: "member-1" });
  assert.deepEqual(plan.map((p) => `${p.kind}:${p.harnessId}`), ["follow-up:s1", "interview-prep:i1"]);
  assert.equal(plan[0].task.id, taskId("follow-up", "s1"));
  assert.match(String(plan[0].task.id), UUID5);
  assert.equal(plan[0].task.dueAt, "2026-12-02T03:00:00.000Z");
  assert.equal(plan[0].task.assigneeId, "member-1");
  assert.equal(plan[0].task.title, "Follow up: Architect at Acme");
  assert.deepEqual(plan[0].target, { id: taskTargetId("follow-up", "s1"), taskId: taskId("follow-up", "s1"), targetOpeningId: openingId("s1") });
  assert.equal(plan[1].task.dueAt, "2026-11-24T00:00:00.000Z");
  assert.deepEqual(planFollowups(openings, { now: NOW, ownerMemberId: "member-1" }), plan, "same input, same ids");
  assert.notEqual(taskId("follow-up", "s1"), taskId("interview-prep", "s1"));
}

const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_KEY;
if (!url || !key) { console.log("twenty-alerts: unit ok; integration skipped"); process.exit(0); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const OWNER = process.env.TWENTY_TEST_OWNER_MEMBER_ID ?? "20202020-77d5-4cb6-b60a-f4a835a85d61";
const call = await connect({ url, key });

// A local server stands in for the Slack webhook and counts POSTs.
const posts: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => { if (req.method === "POST") posts.push(JSON.parse(body).text); res.end("ok"); });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const webhook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
const deliverOpts = { webhook, publicUrl: url, timeLabel: "test" };

try {
  // Drain anything earlier runs left undelivered, so the counts below are ours.
  await deliver(call, deliverOpts);
  posts.length = 0;

  const tag = `itest-${Date.now()}`;
  const p1: Escalation = { kind: "gate", reason: `${tag} gate blocked`, action: "Look" };
  const p2: Escalation = { kind: "screening", reason: `${tag} screening`, action: "Answer" };
  const first = await syncEscalations(call, [p1, p2, { ...p1 }], { notifyMemberId: OWNER });
  assert.equal(first.created, 2, "a repeat dedupeKey creates one record");

  const d1 = await deliver(call, deliverOpts);
  assert.equal(d1.ok, true, JSON.stringify(d1));
  assert.equal(posts.length, 2, "one immediate post and one digest");
  assert.ok(posts[0].includes(`${tag} gate blocked`) && posts[0].startsWith("*Job hunt needs you now*"));
  assert.ok(posts[1].includes(`${tag} screening`) && !posts[1].includes(`${tag} gate`));

  const again = await syncEscalations(call, [p1, p2, p1], { notifyMemberId: OWNER });
  assert.equal(again.created, 0, "the repeat creates nothing");
  const d2 = await deliver(call, deliverOpts);
  assert.equal(d2.sent, 0);
  assert.equal(posts.length, 2, "the digest run twice posts once");

  const ids = [p1, p2].map((e) => escalationRecordId(dedupeKey(e)));
  const delivered = await getByIds(call, "escalations", ids);
  for (const id of ids) assert.ok(delivered.get(id)?.deliveredAt, "deliveredAt set");

  // Cleared: resolved with resolvedAt, deliveredAt kept, so it never informs again.
  const cleared = await syncEscalations(call, [p2], { notifyMemberId: OWNER });
  assert.ok(cleared.resolved >= 1);
  const after = await getByIds(call, "escalations", ids);
  assert.equal(after.get(ids[0])?.status, "RESOLVED");
  assert.ok(after.get(ids[0])?.resolvedAt);
  assert.ok(after.get(ids[0])?.deliveredAt);
  await syncEscalations(call, [], { notifyMemberId: OWNER });

  // Follow-ups: one Task per submitted opening, none for a migrated one, none on re-run.
  const opening = (harnessId: string, extra: Record<string, unknown>) => ({ id: openingId(harnessId), harnessId, title: `Architect ${tag}`, channel: "seek", harnessData: { id: harnessId, title: `Architect ${tag}`, company: "Acme Pty Ltd" }, ...extra });
  const subA = `${tag}-a`;
  const subB = `${tag}-b`;
  const migrated = `${tag}-m`;
  const iv = `${tag}-i`;
  await call("POST", "/rest/batch/openings", [
    opening(subA, { status: "SUBMITTED", submittedAt: "2026-11-23T03:00:00.000Z" }),
    opening(subB, { status: "SUBMITTED", submittedAt: "2026-11-20T03:00:00.000Z" }),
    opening(migrated, { status: "SUBMITTED", submittedAt: "2026-11-20T03:00:00.000Z", migratedAt: NOW }),
    opening(iv, { status: "INTERVIEW" }),
  ]);
  try {
    const f1 = await syncFollowups(call, { ownerMemberId: OWNER, timeZone: "UTC" });
    assert.ok(f1.created >= 3, JSON.stringify(f1));
    const want = [taskId("follow-up", subA), taskId("follow-up", subB), taskId("interview-prep", iv)];
    const tasks = await getByIds(call, "tasks", [...want, taskId("follow-up", migrated)]);
    for (const id of want) {
      assert.ok(tasks.has(id), `task ${id}`);
      assert.equal(tasks.get(id)?.assigneeId, OWNER);
    }
    assert.ok(!tasks.has(taskId("follow-up", migrated)), "no Task for a migrated opening");
    assert.equal(tasks.get(taskId("follow-up", subA))?.dueAt?.slice(0, 10), "2026-12-02");
    const target = await getByIds(call, "taskTargets", [taskTargetId("follow-up", subA)]);
    assert.equal(target.get(taskTargetId("follow-up", subA))?.targetOpeningId, openingId(subA));
    const f2 = await syncFollowups(call, { ownerMemberId: OWNER, timeZone: "UTC" });
    assert.equal(f2.created, 0, "a re-run creates nothing");
  } finally {
    for (const h of [subA, subB, migrated, iv]) await call("DELETE", `/rest/openings/${openingId(h)}?soft_delete=true`).catch(() => {});
  }
} finally {
  server.close();
}
console.log("twenty-alerts: unit and integration ok");
