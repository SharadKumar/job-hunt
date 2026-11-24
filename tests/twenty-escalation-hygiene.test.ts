#!/usr/bin/env tsx
/**
 * twenty-escalation-hygiene.test.ts: escalations close when nobody needs them.
 *
 * Unit: stale escalations resolve (migrated ones included), an opening that is
 * submitted or later, rejected or withdrawn closes its escalation, a partial
 * summary resolves nothing for absence, duplicates of one role keep one (the
 * higher priority, then the newest) and dismiss the rest, and no step writes a
 * delivery field. End to end through syncEscalations with a fake Twenty
 * (fetch stub), including a second run that writes nothing. Synthetic data only.
 */

import assert from "node:assert/strict";
import type { Escalation } from "../tools/daily-summary.ts";
import { openingId } from "../tools/store/twenty-backend.ts";
import { ABSENT_REASON, doneStatus, normaliseEmployer, normaliseTitle, planDuplicates } from "../tools/twenty/escalation-hygiene.ts";
import { DELIVERY_FIELDS, dedupeKey, escalationRecordId, planSync, syncEscalations, toRecord } from "../tools/twenty/escalations.ts";
import { connect } from "../tools/twenty/records.ts";

const NOW = "2026-11-24T00:00:00.000Z";
const EARLIER = "2026-11-18T00:00:00.000Z";
const LATER = "2026-11-19T00:00:00.000Z";

type Rec = Record<string, any>;

function opening(h: string, o: { title?: string; company?: string; channel?: string; status?: string; duplicateGroup?: string } = {}): Rec {
  const status = o.status ?? "manual_action_needed";
  const data = { id: h, title: o.title ?? `Role ${h}`, company: o.company ?? `Employer ${h}`, channel: o.channel ?? "seek", status, duplicateGroup: o.duplicateGroup };
  return { id: openingId(h), harnessId: h, title: data.title, channel: data.channel, status: status.toUpperCase(), duplicateGroup: o.duplicateGroup ?? null, harnessData: data };
}
const openingMap = (...recs: Rec[]) => new Map(recs.map((r) => [r.id, r]));

const manual = (h: string, title = `Role ${h}`, company = `Employer ${h}`): Escalation => ({ kind: "manual", id: h, title, company, reason: "External ATS redirect to portal.example.test", action: "Apply" });
const approval = (h: string, title = `Role ${h}`, company = `Employer ${h}`): Escalation => ({ kind: "awaiting_approval", id: h, title, company, reason: "Package awaiting your approval", action: "Approve" });
const screening = (h: string): Escalation => ({ kind: "screening", id: h, title: `Role ${h}`, company: `Employer ${h}`, reason: 'Unanswered screening question: "Synthetic?"', action: "Answer" });
const asRecord = (e: Escalation, extra: Rec = {}): Rec => ({ ...toRecord(e), status: "OPEN", createdAt: EARLIER, deliveredAt: EARLIER, grokDeliveredAt: null, migratedAt: null, ...extra });
const idOf = (e: Escalation) => escalationRecordId(dedupeKey(e));
const noDeliveryWrites = (plan: { update: { id: string; fields: Rec }[]; create: Rec[] }, except: string[] = []) => {
  for (const u of plan.update) if (!except.includes(u.id)) for (const f of DELIVERY_FIELDS) assert.ok(!(f in u.fields), `no ${f} write on ${u.id}`);
  for (const r of plan.create) for (const f of DELIVERY_FIELDS) assert.ok(!(f in r), `no ${f} on create`);
};

// Normalisation and the done check.
assert.equal(normaliseEmployer("Acme Pty. Ltd."), "acme");
assert.equal(normaliseEmployer("ACME Australia"), "acme");
assert.equal(normaliseEmployer("Smith & Jones Limited"), "smith and jones");
assert.equal(normaliseTitle("Senior Platform Engineer - Contract"), "senior platform engineer contract");
for (const s of ["submitted", "responded", "interview", "offered", "won", "rejected", "withdrawn"]) assert.equal(doneStatus(opening("x", { status: s })), s, s);
for (const s of ["manual_action_needed", "approved", "awaiting_approval", "shortlisted", "submission_pending"]) assert.equal(doneStatus(opening("x", { status: s })), null, s);
assert.equal(doneStatus(undefined), null, "an unknown opening is not done");

// 1. Stale by absence: a migrated record no longer raised resolves with a reason.
{
  const stale = asRecord(manual("r1"), { migratedAt: EARLIER });
  const plan = planSync([], [stale], { now: NOW, openings: openingMap(opening("r1")) });
  assert.deepEqual(plan.resolve, [stale.id]);
  assert.deepEqual(plan.update[0].fields, { status: "RESOLVED", resolvedAt: NOW, reason: ABSENT_REASON });
  noDeliveryWrites(plan);
}

// 2. The opening needs nothing now: resolved even while the run still raises it,
//    never created or reopened for it, and never re-announced.
{
  const subm = asRecord(manual("r2"));
  const rej = asRecord(manual("r3"));
  const wd = asRecord(approval("r4"));
  const wasResolved = asRecord({ kind: "gate", id: "r5", title: "Role r5", company: "Employer r5", reason: "Gate capped", action: "" }, { status: "RESOLVED", resolvedAt: EARLIER });
  const openings = openingMap(opening("r2", { status: "submitted" }), opening("r3", { status: "rejected" }), opening("r4", { status: "withdrawn" }), opening("r5", { status: "interview" }), opening("r6", { status: "submitted" }));
  const current: Escalation[] = [manual("r2"), { kind: "gate", id: "r5", reason: "Gate capped", action: "" }, { kind: "cap", id: "r6", reason: "Gate capped", action: "" }];
  const plan = planSync(current, [subm, rej, wd, wasResolved], { now: NOW, openings });
  assert.deepEqual(new Set(plan.resolve), new Set([subm.id, rej.id, wd.id]));
  assert.deepEqual(new Set(plan.resolvedByOpening), new Set([subm.id, rej.id, wd.id]));
  const byId = new Map(plan.update.map((u) => [u.id, u.fields]));
  assert.equal(byId.get(subm.id)?.reason, "no longer needs you: opening is now submitted");
  assert.equal(byId.get(rej.id)?.reason, "no longer needs you: opening is now rejected");
  assert.equal(byId.get(wd.id)?.reason, "no longer needs you: opening is now withdrawn");
  assert.deepEqual(plan.reopen, [], "a resolved escalation on a done opening is not reopened");
  assert.equal(plan.create.length, 0, "nothing is created for a done opening");
  noDeliveryWrites(plan);
}

// 3. A partial summary: absence proves nothing, the opening's status still counts.
{
  const absent = asRecord(screening("r7"));
  const doneOne = asRecord(manual("r8"));
  const openings = openingMap(opening("r7"), opening("r8", { status: "submitted" }));
  const plan = planSync([], [absent, doneOne], { now: NOW, openings, partial: true });
  assert.deepEqual(plan.resolve, [doneOne.id], "only the done opening closes on a partial run");
  const full = planSync([], [absent, doneOne], { now: NOW, openings });
  assert.deepEqual(new Set(full.resolve), new Set([absent.id, doneOne.id]), "a clean empty list resolves both");
}

// 4. Hand-made records are never closed, even on a done opening.
{
  const hand = { id: "11111111-1111-4111-8111-111111111111", dedupeKey: "follow up by hand", status: "OPEN", openingId: openingId("r9") };
  const plan = planSync([], [hand], { now: NOW, openings: openingMap(opening("r9", { status: "submitted" })) });
  assert.equal(plan.update.length, 0);
}

// 5. Duplicates by duplicateGroup: same priority, the newest stays.
{
  const a = manual("g1", "Data Engineer", "Agency One");
  const b = manual("g2", "Data Engineer (Contract)", "Agency Two");
  const openings = openingMap(opening("g1", { title: "Data Engineer", company: "Agency One", channel: "seek", duplicateGroup: "grp-1" }), opening("g2", { title: "Data Engineer (Contract)", company: "Agency Two", channel: "linkedin_jobs", duplicateGroup: "grp-1" }));
  const plan = planSync([a, b], [asRecord(a, { createdAt: EARLIER }), asRecord(b, { createdAt: LATER })], { now: NOW, openings });
  assert.deepEqual(plan.merged, [idOf(a)], "the older of two equal-priority duplicates is dismissed");
  const fields = plan.update.find((u) => u.id === idOf(a))!.fields;
  assert.equal(fields.status, "DISMISSED");
  assert.equal(fields.reason, "duplicate of Data Engineer (Contract) at Agency Two (linkedin_jobs)");
  assert.equal(plan.unchanged, 1, "the kept one is unchanged");
  noDeliveryWrites(plan);
}

// 6. Duplicates by employer and title across channels: higher priority wins over newer.
{
  const older = approval("n1", "Platform Engineer", "Acme Pty Ltd");
  const newer = manual("n2", "Platform engineer", "ACME");
  const openings = openingMap(opening("n1", { title: "Platform Engineer", company: "Acme Pty Ltd", channel: "seek" }), opening("n2", { title: "Platform engineer", company: "ACME", channel: "linkedin_jobs" }));
  const plan = planSync([older, newer], [asRecord(older, { createdAt: EARLIER }), asRecord(newer, { createdAt: LATER })], { now: NOW, openings });
  assert.deepEqual(plan.merged, [idOf(newer)]);
  assert.match(plan.update.find((u) => u.id === idOf(newer))!.fields.reason as string, /^duplicate of Platform Engineer at Acme Pty Ltd \(seek\)$/);
}

// 7. Same employer and title on one channel can be two real roles: no merge.
{
  const a = manual("s1", "Developer", "Agency One");
  const b = manual("s2", "Developer", "Agency One");
  const openings = openingMap(opening("s1", { title: "Developer", company: "Agency One" }), opening("s2", { title: "Developer", company: "Agency One" }));
  const plan = planSync([a, b], [asRecord(a), asRecord(b)], { now: NOW, openings });
  assert.deepEqual(plan.merged, []);
}

// 8. Every escalation on the kept opening stays; a new duplicate is created dismissed;
//    a resolved duplicate that came back is dismissed without being reopened.
{
  const keptScreening = screening("k1");
  const keptManual = manual("k1");
  const fresh = manual("k2");
  const returning = manual("k3");
  const group = { duplicateGroup: "grp-2" };
  const openings = openingMap(opening("k1", { ...group, channel: "seek" }), opening("k2", { ...group, channel: "linkedin_jobs" }), opening("k3", { ...group, channel: "hn" }));
  const existing = [asRecord(keptScreening), asRecord(keptManual), asRecord(returning, { status: "RESOLVED", resolvedAt: EARLIER })];
  const plan = planSync([keptScreening, keptManual, fresh, returning], existing, { now: NOW, openings });
  assert.deepEqual(new Set(plan.merged), new Set([idOf(fresh), idOf(returning)]));
  assert.ok(!plan.merged.includes(idOf(keptManual)), "a second ask on the kept opening stays open");
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].status, "DISMISSED");
  assert.match(plan.create[0].reason as string, /^duplicate of /);
  assert.deepEqual(plan.reopen, [], "the returning duplicate is not reopened");
  assert.deepEqual(plan.update.find((u) => u.id === idOf(returning))!.fields, { status: "DISMISSED", resolvedAt: NOW, reason: plan.create[0].reason });
  noDeliveryWrites(plan);
}

// 9. planDuplicates ignores escalations with no known opening.
assert.deepEqual(planDuplicates([{ id: "a", priority: "P1" }, { id: "b", priority: "P1", openingId: "missing" }], new Map(), { now: NOW }), []);

// 10. End to end with a fake Twenty: resolve, merge, then a second run writes nothing.
{
  const BASE = "https://twenty.example.test";
  const db: Record<string, Rec[]> = { escalations: [], openings: [] };
  const writes: { method: string; path: string; body: any }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const matches = (r: Rec, filter: string | null) => {
    if (!filter) return true;
    const ids = filter.match(/^id\[in\]:\[(.*)\]$/);
    if (ids) return ids[1].split(",").includes(r.id);
    const eq = filter.match(/^(\w+)\[eq\]:(\w+)$/);
    if (eq) return r[eq[1]] === eq[2];
    throw new Error(`fake: unsupported filter ${filter}`);
  };
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    assert.equal(url.origin, BASE, "requests stay on the fake workspace");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "GET" && parts.length === 2) {
      const plural = parts[1];
      return json({ data: { [plural]: (db[plural] ?? []).filter((r) => matches(r, url.searchParams.get("filter"))) }, pageInfo: { hasNextPage: false } });
    }
    writes.push({ method, path: url.pathname, body });
    if (method === "POST" && url.pathname === "/rest/batch/escalations") {
      for (const r of body) db.escalations.push({ createdAt: NOW, deliveredAt: null, grokDeliveredAt: null, ...r });
      return json({ data: {} });
    }
    if (method === "PATCH" && parts[1] === "escalations") {
      const rec = db.escalations.find((r) => r.id === parts[2]);
      if (!rec) return json({ messages: ["not found"] }, 404);
      Object.assign(rec, body);
      return json({ data: {} });
    }
    throw new Error(`fake: unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  const call = await connect({ url: BASE, key: "test-key" }, fetchImpl);

  const stillManual = manual("e1", "Cloud Architect", "Example Corp");
  const dupOther = manual("e2", "Cloud architect", "Example Corp Pty Ltd");
  const applied = manual("e3");
  const goneAway = screening("e4");
  db.openings.push(
    opening("e1", { title: "Cloud Architect", company: "Example Corp", channel: "seek" }),
    opening("e2", { title: "Cloud architect", company: "Example Corp Pty Ltd", channel: "linkedin_jobs" }),
    opening("e3", { status: "submitted" }),
    opening("e4"),
  );
  const delivered = { deliveredAt: EARLIER, grokDeliveredAt: EARLIER };
  db.escalations.push(
    { ...asRecord(stillManual, { createdAt: LATER, migratedAt: EARLIER }), ...delivered },
    { ...asRecord(dupOther, { createdAt: EARLIER, migratedAt: EARLIER }), ...delivered },
    { ...asRecord(applied, { migratedAt: EARLIER }), ...delivered },
    { ...asRecord(goneAway), ...delivered },
  );

  // A partial run first: only the submitted opening closes; the merge still runs.
  const partial = await syncEscalations(call, [stillManual, dupOther], { now: NOW, partial: true });
  assert.equal(partial.partial, true);
  assert.equal(partial.resolved, 1);
  assert.equal(partial.resolvedByOpening, 1);
  assert.equal(partial.merged, 1);
  const status = (e: Escalation) => db.escalations.find((r) => r.id === idOf(e))!.status;
  assert.equal(status(applied), "RESOLVED");
  assert.equal(status(goneAway), "OPEN", "a partial run leaves an absent escalation open");
  assert.equal(status(dupOther), "DISMISSED");
  assert.equal(status(stillManual), "OPEN");
  assert.equal(partial.open, 1);

  // A clean run resolves the absent one.
  const clean = await syncEscalations(call, [stillManual, dupOther], { now: NOW });
  assert.equal(clean.resolved, 1);
  assert.equal(status(goneAway), "RESOLVED");
  assert.equal(db.escalations.find((r) => r.id === idOf(goneAway))!.reason, ABSENT_REASON);
  assert.equal(status(dupOther), "DISMISSED", "a dismissed duplicate stays dismissed");

  // A third run with nothing new writes nothing.
  const before = writes.length;
  const again = await syncEscalations(call, [stillManual, dupOther], { now: NOW });
  assert.equal(writes.length, before, "an idempotent re-run writes nothing");
  assert.deepEqual({ resolved: again.resolved, merged: again.merged, created: again.created, unchanged: again.unchanged, dismissed: again.dismissed }, { resolved: 0, merged: 0, created: 0, unchanged: 1, dismissed: 1 });

  for (const w of writes) for (const f of DELIVERY_FIELDS) {
    const bodies = Array.isArray(w.body) ? w.body : [w.body];
    for (const b of bodies) assert.ok(!(f in (b ?? {})), `no write touched ${f}`);
  }
  for (const r of db.escalations) for (const f of DELIVERY_FIELDS) assert.equal(r[f], EARLIER, `${f} kept on ${r.id}`);
  for (const r of db.escalations) assert.ok(!/[\u2013\u2014]/.test(String(r.reason)), "no dashes in reasons");
}

console.log(JSON.stringify({ ok: true, test: "twenty-escalation-hygiene" }));
