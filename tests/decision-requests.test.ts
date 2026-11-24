#!/usr/bin/env tsx
/**
 * decision-requests.test.ts: the person's requests run without a second
 * confirmation, after automatic checks (plan rev 7, Principle 3).
 * Synthetic data only.
 */

import assert from "node:assert/strict";

const R = await import("../tools/decisions/requests.ts");
const OWNER = "11111111-1111-4111-8111-111111111111";

// Origin comes from Twenty's stamp, never from a field the caller sets.
const grok = { id: "a", proposer: "GROK", createdBy: { source: "APPLICATION", workspaceMemberId: null } };
const chat = { id: "b", proposer: "AI_CHAT", createdBy: { source: "AGENT", workspaceMemberId: OWNER } };
assert.equal(R.requestOrigin(grok, OWNER), "GROK");
assert.equal(R.requestOrigin(chat, OWNER), "AI_CHAT");
assert.equal(R.requestOrigin({ ...chat, createdBy: { source: "AGENT", workspaceMemberId: "someone-else" } }, OWNER), null, "another member's chat is not the owner's request");
assert.equal(R.requestOrigin({ id: "c", proposer: "GROK", createdBy: { source: "API", workspaceMemberId: null } }, OWNER), null, "an API key claiming to be Grok is not a request");
assert.equal(R.requestOrigin({ id: "d", proposer: "HARNESS", createdBy: { source: "APPLICATION" } }, OWNER), null);

// Routing.
assert.deepEqual(R.routeRequest({ ...grok, proposalType: "APPROVE_PACKAGE" }, OWNER), { id: "a", type: "APPROVE_PACKAGE", status: "PROPOSED", outcome: "needs your tap: approve package is always yours to confirm" });
assert.equal((R.routeRequest({ ...grok, proposalType: "RESEARCH_COMPANY" }, OWNER) as any).status, "CONFIRMED");
assert.equal(R.routeRequest({ ...chat, proposalType: "ANSWER_SCREENING" }, OWNER), "ANSWER");
assert.equal((R.routeRequest({ id: "e", proposer: "GROK", proposalType: "ANSWER_SCREENING", createdBy: { source: "API" } }, OWNER) as any).status, "PROPOSED", "not the person's request: it waits for a tap");
assert.equal((R.routeRequest({ ...grok, proposalType: "SEND_EMAIL" }, OWNER) as any).status, "FAILED");

// Answers as they would reach an employer's form.
assert.deepEqual(R.cleanAnswer('  "About 2 years."  '), { ok: true, answer: "About 2 years." });
assert.equal(R.cleanAnswer("Over 15 years (verify exact years from CV)").ok, false, "a note to check something is refused, not sent");
assert.equal(R.cleanAnswer("").ok, false);
assert.equal(R.cleanAnswer(null).ok, false);
assert.deepEqual(R.cleanAnswer("Yes — currently contracting"), { ok: true, answer: "Yes, currently contracting" });

// Never-named rules from the profile.
const rules = "never_named:\n  - pattern: '\\bExample Lender\\b'\n    issue: Names the lender.\n    fix: Say a regulated lender.\n";
assert.equal(R.neverNamedFindings("Working with Example Lender via an agency", rules).length, 1);
assert.equal(R.neverNamedFindings("Working with a regulated lender", rules).length, 0);
assert.equal(R.neverNamedFindings("anything", null).length, 0);

// Answering open questions in the document text.
const doc = [
  "answers:",
  "  - question: \"Do you have the right to work?\"",
  "    answer: \"Yes.\"",
  "",
  "# keep this comment",
  "unknown_questions:",
  "  - opportunity_id: seek-1",
  "    company: \"Example Pty Ltd\"",
  "    question: \"How many years' experience do you have as an Architect?\"",
  "    answer: null",
  "  - opportunity_id: seek-2",
  "    company: \"Sample Co\"",
  "    question: \"How many years' experience do you have as an architect\"",
  "    answer: null",
  "  - opportunity_id: seek-3",
  "    question: \"Are you currently employed?\"",
  "    answer: \"Yes.\"",
  "",
].join("\n");
const a = R.answerUnknownQuestion(doc, "How many years' experience do you have as an Architect?", "More than 10 years", "grok");
assert.equal(a.answered, 2, "both open copies of the same question");
assert.ok(a.body.includes("# keep this comment"));
assert.equal((a.body.match(/answer: "More than 10 years"/g) ?? []).length, 2);
assert.ok(a.body.includes('answered_via: "grok"'));
const b = R.answerUnknownQuestion(doc, "Are you currently employed?", "No", "grok");
assert.equal(b.answered, 0, "an answered question is left alone");
assert.equal(R.answerUnknownQuestion(doc, "Unrelated question?", "x", "grok").answered, 0);

console.log("decision-requests: ok");
