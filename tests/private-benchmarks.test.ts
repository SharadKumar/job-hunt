#!/usr/bin/env tsx
/**
 * private-benchmarks.test.ts — benchmark rationales stay out of docs/.
 *
 * The public copy keeps every number and id; free-text rationale fields are
 * replaced. The private copy under state/jev/benchmarks/ keeps the full text,
 * and readBenchmark prefers it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-bench-"));
process.env.HARNESS_REPO_ROOT = root;
const { redactRationales, writeBenchmarkPair, readBenchmark, REDACTED } = await import("../tools/jev/private-benchmarks.ts");

const report = {
  metrics: { agreement: 0.82 },
  records: [{ id: "r1", discipline_fit: "core", profile_relevance_reason: "quotes Acme Pty Ltd evidence", resume_match_explanation: "x", detected_domain: "y" }],
  items: [{ id: "r1", generic_agent: { reason: "quotes evidence" }, human: { notes: "private note" }, description_excerpt: "public advert text" }],
};

const red = redactRationales(report);
assert.equal(red.metrics.agreement, 0.82);
assert.equal(red.records[0].discipline_fit, "core");
assert.equal(red.records[0].profile_relevance_reason, REDACTED);
assert.equal(red.items[0].generic_agent.reason, REDACTED);
assert.equal(red.items[0].human.notes, REDACTED);
assert.equal(red.items[0].description_excerpt, "public advert text");
assert.ok(!JSON.stringify(red).includes("Acme"));

const { public: pub, private: priv } = await writeBenchmarkPair("docs/benchmarks/x.json", report);
assert.ok(priv.startsWith(path.join(root, "state", "jev", "benchmarks")));
assert.ok(!fs.readFileSync(pub, "utf8").includes("Acme"));
assert.ok(fs.readFileSync(priv, "utf8").includes("Acme"));
assert.equal((await readBenchmark<any>("docs/benchmarks/x.json", null)).records[0].profile_relevance_reason, "quotes Acme Pty Ltd evidence");
fs.rmSync(priv);
assert.equal((await readBenchmark<any>("docs/benchmarks/x.json", null)).records[0].profile_relevance_reason, REDACTED);

fs.rmSync(root, { recursive: true, force: true });
console.log("private-benchmarks: ok");
