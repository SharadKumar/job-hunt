#!/usr/bin/env tsx
/** slack-questions.test.ts: parked questions to Slack and replies back, pure parts. Synthetic data only. */
import assert from "node:assert/strict";
const S = await import("../tools/slack-questions.ts");
const doc = [
  "answers: []",
  "unknown_questions:",
  "  - opportunity_id: seek-1",
  "    company: \"Example Pty Ltd\"",
  "    title: \"Architect\"",
  "    question: \"Do you hold a licence?\"",
  "    context: \"Yes | No\"",
  "    answer: null",
  "  - opportunity_id: seek-2",
  "    question: \"Already answered?\"",
  "    answer: \"Yes\"",
  "  - opportunity_id: seek-3",
  "    question: \"Do you hold a licence?\"",
  "    answer: null",
  "",
].join("\n");
const open = S.openRows(doc);
assert.deepEqual(open.map((r) => r.index), [0, 2]);
assert.match(S.questionText(open[0]), /Architect at Example Pty Ltd/);
assert.match(S.questionText(open[0]), /Choices: Yes \| No/);
let b = S.setRowField(doc, 0, "slack_ts", "123.45");
b = S.setRowField(b, 2, "answer", "No");
assert.ok(b.includes('slack_ts: "123.45"'));
assert.equal(S.openRows(b).map((r) => r.index).join(","), "0", "answered row leaves the open list");
assert.ok(b.includes('    answer: "No"'));
assert.equal(S.setRowField(doc, 9, "answer", "x"), doc, "a missing row changes nothing");
console.log("slack-questions: ok");
