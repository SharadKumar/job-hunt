#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { load, type Opportunity } from "../pipeline.ts";
import { fingerprintFor } from "../audit.ts";
import { repoPath } from "../repo-root.ts";
import { evaluateWithJev } from "./evaluate.ts";
import { recordDegradation } from "./degradation.ts";

type Candidate = { a: Opportunity; b: Opportunity; lexical: number };

function company(value: string): string {
  return value.toLowerCase().replace(/\b(pty|ltd|limited|inc|group|holdings)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token.length > 2 && !["senior", "lead", "contract", "manager"].includes(token)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function ambiguousDuplicateCandidates(rows: Opportunity[]): Candidate[] {
  const grouped = new Map<string, Opportunity[]>();
  for (const row of rows) {
    const key = company(row.endEmployer ?? row.company);
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const out: Candidate[] = [];
  for (const list of grouped.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (fingerprintFor(a.company, a.title) === fingerprintFor(b.company, b.title)) continue;
      const lexical = jaccard(tokens(a.title), tokens(b.title));
      if (lexical >= 0.25 && lexical < 0.85) out.push({ a, b, lexical });
    }
  }
  return out.sort((x, y) => y.lexical - x.lexical);
}

async function main(): Promise<void> {
  const limitAt = process.argv.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : 50;
  const candidates = ambiguousDuplicateCandidates(await load()).slice(0, limit);
  const matches: Record<string, unknown>[] = [];
  let degraded = 0;
  let cost = 0;
  for (const candidate of candidates) {
    const evaluation = await evaluateWithJev({
      callSite: "fuzzy-dedup",
      state: {
        role_a: { title: candidate.a.title, description: (candidate.a.description ?? "").slice(0, 3000), requisition: candidate.a.requisitionId ?? "" },
        role_b: { title: candidate.b.title, description: (candidate.b.description ?? "").slice(0, 3000), requisition: candidate.b.requisitionId ?? "" },
      },
      questions: {
        same_requisition: {
          type: "boolean",
          instructions: "Are these two advertisements for the same underlying employer requisition? Require matching responsibilities and requirements, not merely the same role family.",
        },
      },
    });
    if (evaluation.status === "degraded" || !evaluation.route_fingerprint_matches) {
      degraded++;
      continue;
    }
    cost += evaluation.estimated_cost_usd ?? 0;
    const probability = evaluation.result.answers.same_requisition.probability ?? 0;
    if (probability >= 0.9) matches.push({ a: candidate.a.id, b: candidate.b.id, probability, lexical: candidate.lexical });
  }
  const output = { generated_at: new Date().toISOString(), candidates: candidates.length, matches, degraded, estimated_cost_usd: Number(cost.toFixed(8)), informational_only: true };
  if (degraded) await recordDegradation("fuzzy_dedup", `Jev fuzzy-dedup batch had ${degraded} degraded decision${degraded === 1 ? "" : "s"}`);
  const file = repoPath("state/pipeline/jev-duplicate-candidates.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ candidates: candidates.length, matches: matches.length, degraded, estimated_cost_usd: output.estimated_cost_usd, file }));
  if (degraded) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(JSON.stringify({ error: (error as Error).message })); process.exit(1); });
