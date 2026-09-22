#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../tools/repo-root.ts";

const root = repoRoot();
const targets = ["tools", "scripts", ".claude", ".codex", "agents", "references", "templates", "tests", "package.json", "README.md", "AGENTS.md"];
const banned = [
  "classificationSource",
  "state/pipeline/classifications.json",
  "classifications:merge",
  "classify:diagnostic",
  "classifyJdRegex",
  "high_agent_relevance",
  "expected_model_fingerprint",
  "model_fingerprints",
  "model_fingerprint",
  "rollout_percent",
  "rollout_eligible",
  "require_observable_model_version_for_promotion",
];
const hits: string[] = [];

function scan(file: string): void {
  if (path.basename(file) === "jev-architecture.test.ts") return;
  const text = fs.readFileSync(file, "utf8");
  for (const symbol of banned) if (text.includes(symbol)) hits.push(`${path.relative(root, file)}: ${symbol}`);
}

function walk(item: string): void {
  if (item.includes("-workspace/")) return;
  const full = path.join(root, item);
  const stat = fs.statSync(full);
  if (stat.isFile()) { scan(full); return; }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && item !== ".claude") continue;
    const child = path.join(item, entry.name);
    if (entry.isDirectory()) walk(child);
    else if (/\.(?:ts|js|md|json|yaml|yml|sh)$/.test(entry.name)) scan(path.join(root, child));
  }
}

for (const target of targets) walk(target);
assert.deepEqual(hits, [], `retired classification architecture references remain:\n${hits.join("\n")}`);
console.log("Legacy classification architecture has zero runtime references");
