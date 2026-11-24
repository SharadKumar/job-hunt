#!/usr/bin/env tsx
/** decision-plan.test.ts — each button's decision maps to one harness action. */

import assert from "node:assert/strict";
import { engagementRecord, planDecision } from "../tools/decisions/plan.ts";

const row = (status: string): any => ({ id: "seek-1", status, history: [] });
const d = (decisionType: string, extra: Record<string, unknown> = {}): any => ({ id: "d1", decisionType, statusSeen: null, ...extra });

assert.deepEqual(planDecision(d("APPROVE", { statusSeen: "AWAITING_APPROVAL" }), row("awaiting_approval")), { kind: "transition", to: "approved" });
assert.equal(planDecision(d("APPROVE", { statusSeen: "AWAITING_APPROVAL" }), row("approved")).kind, "refuse", "stale status refused");
assert.equal(planDecision(d("EDIT_LETTER", { letterShaSeen: "a" }), row("awaiting_approval"), "b").kind, "refuse", "stale letter refused");
assert.deepEqual(planDecision(d("MARK_SENT", { value: "REF-1" }), row("manual_action_needed")), { kind: "transition", to: "submitted", fields: { confirmationRef: "REF-1" } });
assert.deepEqual(planDecision(d("OUTCOME_INTERVIEW"), row("submitted")), { kind: "transition", to: "interview" });
assert.equal(planDecision(d("HOLD"), row("awaiting_approval")).kind, "none");
assert.equal(planDecision(d("APPROVE"), null).kind, "refuse", "missing opening refused");
assert.deepEqual(planDecision(d("HALT_SENDS", { statusSeen: "ANYTHING" }), null), { kind: "halt" }, "halts are exempt from staleness");
assert.deepEqual(planDecision(d("ENABLE_AUTOPILOT"), null), { kind: "autopilot", enabled: true });
assert.equal(planDecision(d("CONFIRM"), null).kind, "refuse", "confirm needs a proposal");
assert.equal(planDecision(d("CONFIRM", { proposalId: "p1" }), null).kind, "proposal");
assert.equal(planDecision(d("START_ENGAGEMENT"), row("offered")).kind, "refuse");
assert.equal(planDecision(d("START_ENGAGEMENT"), row("won")).kind, "engagement");
assert.equal(planDecision(d("RETRY_NOW"), row("approved")).kind, "refuse", "no retry action exists");

// Start engagement (F17): the record is named for the role and employer and linked to both.
assert.deepEqual(engagementRecord({ id: "o1", title: "Platform lead", employerId: "c1", employer: { name: "Acme Pty Ltd" } }),
  { name: "Platform lead at Acme Pty Ltd", status: "ACTIVE", openingId: "o1", clientId: "c1" });
assert.deepEqual(engagementRecord({ id: "o2", title: "  ", employerId: null }), { name: "Engagement", status: "ACTIVE", openingId: "o2" });
assert.ok(!("rate" in engagementRecord({ id: "o3", title: "x" })), "the advert rate is not the contract rate");

console.log("decision-plan: ok");
