#!/usr/bin/env tsx
/** send-switch.test.ts — the person's switch in Twenty, derived before every send. */

import assert from "node:assert/strict";
import { deriveSendSwitch, readSendSwitch } from "../tools/decisions/send-switch.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const manual = { source: "MANUAL", workspaceMemberId: OWNER, context: {} };
const mine = (decisionType: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ decisionType, createdAt, createdBy: manual, updatedBy: manual, ...extra });
const agent = (decisionType: string, createdAt: string) => ({ decisionType, createdAt, createdBy: { source: "AGENT", workspaceMemberId: OWNER }, updatedBy: manual });
const api = (decisionType: string, createdAt: string) => ({ decisionType, createdAt, createdBy: manual, updatedBy: { source: "API" } });
const now = new Date("2026-11-23T10:00:00Z");

assert.equal(deriveSendSwitch([], OWNER, now).allowed, false, "never enabled");
assert.equal(deriveSendSwitch([mine("ENABLE_AUTOPILOT", "2026-11-23T01:00:00Z")], OWNER, now).allowed, true);
assert.equal(deriveSendSwitch([agent("ENABLE_AUTOPILOT", "2026-11-23T01:00:00Z")], OWNER, now).allowed, false, "AI chat or MCP enable refused");
assert.equal(deriveSendSwitch([api("ENABLE_AUTOPILOT", "2026-11-23T01:00:00Z")], OWNER, now).allowed, false, "API or Grok enable refused");
assert.equal(deriveSendSwitch([mine("ENABLE_AUTOPILOT", "2026-11-23T01:00:00Z"), api("HALT_SENDS", "2026-11-23T02:00:00Z")], OWNER, now).allowed, false, "any halt wins, even unverified");
assert.equal(deriveSendSwitch([mine("ENABLE_AUTOPILOT", "2026-11-23T03:00:00Z"), mine("HALT_SENDS", "2026-11-23T02:00:00Z")], OWNER, now).allowed, true, "a later enable resumes");
assert.equal(deriveSendSwitch([mine("ENABLE_AUTOPILOT", "2026-11-23T03:00:00Z"), agent("ENABLE_AUTOPILOT", "2026-11-23T04:00:00Z"), mine("DISABLE_AUTOPILOT", "2026-11-23T03:30:00Z")], OWNER, now).allowed, false, "an agent enable can't override a disable");
assert.equal(deriveSendSwitch([mine("ENABLE_AUTOPILOT", "2026-11-23T01:00:00Z", { expiresAt: "2026-11-23T09:00:00Z" })], OWNER, now).allowed, false, "expired enable");
assert.equal(deriveSendSwitch([mine("ENABLE_AUTOPILOT", "2026-11-23T01:00:00Z", { expiresAt: "2026-11-24T00:00:00Z" })], OWNER, now).allowed, true);

// Fail closed on read errors.
const down = await readSendSwitch({ url: "http://127.0.0.1:9", key: "x", ownerMemberId: OWNER, fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as any });
assert.equal(down.allowed, false);
const forbidden = await readSendSwitch({ url: "http://x", key: "x", ownerMemberId: OWNER, fetchImpl: (async () => new Response("{}", { status: 403 })) as any });
assert.equal(forbidden.allowed, false);


// An enable intake verified and APPLIED counts, though applying re-stamped
// updatedBy as the harness; the same re-stamp without APPLIED, or a non-owner
// creator, does not.
{
  const { deriveSendSwitch: d2 } = await import("../tools/decisions/send-switch.ts");
  const OWNER2 = "22222222-2222-4222-8222-222222222222";
  const base = { decisionType: "ENABLE_AUTOPILOT", createdAt: "2026-01-02T00:00:00Z", createdBy: { source: "MANUAL", workspaceMemberId: OWNER2 }, updatedBy: { source: "API", workspaceMemberId: null } };
  assert.equal(d2([{ ...base, result: "APPLIED" }], OWNER2, new Date("2026-01-03T00:00:00Z")).allowed, true, "applied by intake counts");
  assert.equal(d2([{ ...base, result: null }], OWNER2, new Date("2026-01-03T00:00:00Z")).allowed, false, "unverified re-stamp does not");
  assert.equal(d2([{ ...base, result: "APPLIED", createdBy: { source: "MANUAL", workspaceMemberId: "someone-else" } }], OWNER2, new Date("2026-01-03T00:00:00Z")).allowed, false, "another member's enable never counts");
  assert.equal(d2([{ ...base, result: "APPLIED", createdBy: { source: "AGENT", workspaceMemberId: OWNER2 } }], OWNER2, new Date("2026-01-03T00:00:00Z")).allowed, false, "AI chat never counts");
}
console.log("send-switch: ok");
