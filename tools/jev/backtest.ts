#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { classificationContentHash } from "../classification.ts";
import { load } from "../pipeline.ts";
import { store } from "../pipeline-store.ts";
import { repoPath } from "../repo-root.ts";
import { classifyWithJev, currentJevCacheIdentity } from "./classifier.ts";
import { classifyPipeline } from "./classify-pipeline.ts";
import type { JevMode } from "./evaluate.ts";

const args = process.argv.slice(2);
const mode: JevMode = args.includes("--live") ? "live" : args.includes("--record") ? "record" : "replay";
const idsAt = args.indexOf("--ids-file");
const idsFile = idsAt >= 0 ? args[idsAt + 1] : "docs/benchmarks/jev-cohort.json";
const outAt = args.indexOf("--out");
const outFile = outAt >= 0 ? args[outAt + 1] : "docs/benchmarks/jev-backtest-latest.json";
const ids = new Set<string>(JSON.parse(await fs.readFile(repoPath(idsFile), "utf8")));
const rows = (await load()).filter((row) => ids.has(row.id));
const startedAt = new Date().toISOString();
const before = new Map(rows.map((row) => [row.id, row.classification ? {
  decision_id: row.classification.provenance.decision_id,
  discipline_fit: row.classification.discipline_fit,
  matched_resume_id: row.classification.matched_resume_id,
  profile_relevance: row.classification.profile_relevance,
} : null]));

const summary = await classifyPipeline(rows, {
  shadow: true,
  force: true,
  concurrency: 2,
  classify: (input) => classifyWithJev(input, { mode }),
});
const changes = rows.map((row) => {
  const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
  const after = store().getClassificationDecision(row.id, contentHash);
  const prior = before.get(row.id);
  if (!after || after.provenance.created_at < startedAt) return { id: row.id, before: prior, after: null, changed: null };
  const next = {
    decision_id: after.provenance.decision_id,
    discipline_fit: after.discipline_fit,
    matched_resume_id: after.matched_resume_id,
    profile_relevance: after.profile_relevance,
    status: after.status,
  };
  return {
    id: row.id,
    before: prior,
    after: next,
    changed: !prior || prior.discipline_fit !== next.discipline_fit || prior.matched_resume_id !== next.matched_resume_id || prior.profile_relevance !== next.profile_relevance,
  };
});
const identity = await currentJevCacheIdentity();
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  mode,
  cohort_file: idsFile,
  cohort_requested: ids.size,
  cohort_found: rows.length,
  identity: {
    policy_hash: identity.policyHash,
    profile_hash: identity.profileHash,
    resume_set_hash: identity.resumeHash,
    requested_model: identity.requestedModel,
    expected_gateway_route_fingerprint: identity.expectedGatewayRouteFingerprint,
    question_schema_hash: identity.questionSchemaHash,
  },
  summary,
  changed_decisions: changes.filter((item) => item.changed === true).length,
  unavailable_decisions: changes.filter((item) => item.after == null).length,
  changes,
};
const out = repoPath(outFile);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ out, mode, cohort: rows.length, changed: report.changed_decisions, unavailable: report.unavailable_decisions, degraded: summary.degraded, cost_usd: summary.estimated_cost_usd }));
if (summary.degraded || summary.replay_misses || report.unavailable_decisions) process.exitCode = 2;
