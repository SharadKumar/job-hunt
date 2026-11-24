/**
 * private-benchmarks.ts — keep model rationales out of the public benchmarks.
 *
 * Comparator and disagreement-review records carry free-text rationales that
 * quote the person's CV evidence (employers, ventures, clients). The numbers
 * belong in `docs/benchmarks/` for anyone to read; the rationales belong only
 * in the ignored `state/jev/benchmarks/`.
 *
 * Writers call `writeBenchmarkPair`: the full record goes to state/, a copy with
 * every PRIVATE_FIELDS value replaced goes to docs/. Readers call
 * `readBenchmark`, which prefers the full private copy and falls back to the
 * public one.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { repoPath } from "../repo-root.ts";

/** Keys whose values are free text that may quote the person's evidence. */
export const PRIVATE_FIELDS = new Set([
  "profile_relevance_reason",
  "resume_match_explanation",
  "detected_domain",
  "reason",
  "notes",
]);

export const REDACTED = "(redacted: full text kept in state/jev/benchmarks/)";

export function redactRationales<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactRationales(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PRIVATE_FIELDS.has(k) && typeof v === "string" && v.length ? REDACTED : redactRationales(v);
    }
    return out as T;
  }
  return value;
}

/** `docs/benchmarks/x.json` → `state/jev/benchmarks/x.json` (absolute). */
export function privatePathFor(publicPath: string): string {
  return repoPath("state", "jev", "benchmarks", path.basename(publicPath));
}

export async function writeBenchmarkPair(publicPath: string, data: unknown): Promise<{ public: string; private: string }> {
  const pub = path.isAbsolute(publicPath) ? publicPath : repoPath(publicPath);
  const priv = privatePathFor(pub);
  await fs.mkdir(path.dirname(priv), { recursive: true });
  await fs.writeFile(priv, JSON.stringify(data, null, 2) + "\n");
  await fs.mkdir(path.dirname(pub), { recursive: true });
  await fs.writeFile(pub, JSON.stringify(redactRationales(data), null, 2) + "\n");
  return { public: pub, private: priv };
}

export async function readBenchmark<T>(publicPath: string, fallback: T): Promise<T> {
  const pub = path.isAbsolute(publicPath) ? publicPath : repoPath(publicPath);
  for (const file of [privatePathFor(pub), pub]) {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { /* next */ }
  }
  return fallback;
}
