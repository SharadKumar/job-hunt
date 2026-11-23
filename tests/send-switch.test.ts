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

console.log("send-switch: ok");
