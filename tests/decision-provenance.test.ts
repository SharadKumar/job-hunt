#!/usr/bin/env tsx
/**
 * decision-provenance.test.ts — only a button press by the owner confirms.
 *
 * The fixtures are the stamp shapes measured on Twenty 2.60.3 for each write
 * path (plan V3), with synthetic ids.
 */

import assert from "node:assert/strict";
import { verifyConfirmation } from "../tools/decisions/provenance.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const manual = (m = OWNER) => ({ source: "MANUAL", workspaceMemberId: m, context: {} });

const paths: [string, any, boolean][] = [
  ["button as owner", { createdBy: manual(), updatedBy: manual() }, true],
  ["button as another member", { createdBy: manual(OTHER), updatedBy: manual(OTHER) }, false],
  ["api key", { createdBy: { source: "API" }, updatedBy: { source: "API" } }, false],
  ["api key, forged createdBy", { createdBy: manual(), updatedBy: { source: "API" } }, false],
  ["app function, forged createdBy", { createdBy: manual(), updatedBy: { source: "APPLICATION", context: { applicationId: "x" } } }, false],
  ["workflow", { createdBy: { source: "WORKFLOW", context: { workflowId: "w" } }, updatedBy: { source: "APPLICATION" } }, false],
  ["mcp as owner", { createdBy: { source: "AGENT", workspaceMemberId: OWNER }, updatedBy: manual() }, false],
  ["manual stamps carrying a workflow", { createdBy: manual(), updatedBy: { ...manual(), context: { workflowId: "w" } } }, false],
  ["missing stamps", {}, false],
];

for (const [name, record, expected] of paths) {
  const v = verifyConfirmation(record, OWNER);
  assert.equal(v.ok, expected, `${name}: ${JSON.stringify(v)}`);
  if (!v.ok) assert.ok(v.reason.length > 0, `${name} gives a reason`);
}
assert.equal(verifyConfirmation({ createdBy: manual(), updatedBy: manual() }, "").ok, false, "no owner configured refuses everything");

console.log("decision-provenance: ok");
