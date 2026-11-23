#!/usr/bin/env tsx
/**
 * grok-digest.ts: post new escalations and failed runs to the Grok routine
 * webhook, capped (plan F16).
 *
 * A workflow step can't read a secret application variable (R30, R48), so the
 * harness POSTs: the recorded exception to Principle 7, still driven by
 * records. It reads
 *   - OPEN escalations with grokDeliveredAt and migratedAt empty;
 *   - runs with a non-zero exitCode and grokDeliveredAt and migratedAt empty;
 * and posts them together as one JSON digest, then sets grokDeliveredAt on
 * every record the successful post carried.
 *
 * Cap: at least 15 minutes between posts and at most 6 posts in any 24 hours,
 * counted in a local ledger (state/twenty/grok-digest-ledger.json). A capped
 * run posts nothing and marks nothing, so the items wait for the next slot.
 *
 * Summaries only: names, kinds, priorities, short reasons, rates and links.
 * Never a job description, letter, CV, classification or harness data.
 *
 * Env (state/twenty/keys.env): GROK_ROUTINE_WEBHOOK_URL and
 * GROK_ROUTINE_BEARER (either unset: skipped), TWENTY_PUBLIC_URL (default
 * TWENTY_API_URL), plus the Twenty store config. GROK_DIGEST_LEDGER overrides
 * the ledger path (tests).
 *
 * Usage: tsx tools/twenty/grok-digest.ts [--dry-run]
 * Prints one JSON object. A failed POST exits 1 and marks nothing delivered.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { repoPath } from "../repo-root.ts";
import { connect, getByIds, listAll, recordUrl, type TwentyCall } from "./records.ts";

export const ESCALATION_FILTER = "and(status[eq]:OPEN,grokDeliveredAt[is]:NULL,migratedAt[is]:NULL)";
export const RUN_FILTER = "and(exitCode[neq]:0,grokDeliveredAt[is]:NULL,migratedAt[is]:NULL)";

export const MIN_GAP_MS = 15 * 60 * 1000;
export const MAX_PER_DAY = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Ledger = { posts: string[] };

/** Pure: may a post go out now? Counts the last 24 hours and the last post. */
export function capCheck(ledger: Ledger, now: Date): { ok: true } | { ok: false; reason: string; nextAt: string } {
  const t = now.getTime();
  const recent = ledger.posts.map((p) => Date.parse(p)).filter((p) => Number.isFinite(p) && p > t - DAY_MS && p <= t).sort((a, b) => a - b);
  const last = recent[recent.length - 1];
  if (last !== undefined && t - last < MIN_GAP_MS) {
    return { ok: false, reason: "posted less than 15 minutes ago", nextAt: new Date(last + MIN_GAP_MS).toISOString() };
  }
  if (recent.length >= MAX_PER_DAY) {
    return { ok: false, reason: `${MAX_PER_DAY} posts in the last 24 hours`, nextAt: new Date(recent[recent.length - MAX_PER_DAY] + DAY_MS).toISOString() };
  }
  return { ok: true };
}

/** Pure: the ledger after a post at `now`, keeping only the last 24 hours. */
export function recordPost(ledger: Ledger, now: Date): Ledger {
  const t = now.getTime();
  return { posts: [...ledger.posts.filter((p) => Date.parse(p) > t - DAY_MS), now.toISOString()] };
}

const clip = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const money = (m: any): number | null => (typeof m?.amountMicros === "number" ? Math.round(m.amountMicros / 10_000) / 100 : null);

/** "900 to 1100 AUD", one-sided, or null. */
export function rateText(min: any, max: any): string | null {
  const lo = money(min), hi = money(max);
  const cur = String(min?.currencyCode ?? max?.currencyCode ?? "").trim();
  const sfx = cur ? ` ${cur}` : "";
  if (lo !== null && hi !== null) return lo === hi ? `${lo}${sfx}` : `${lo} to ${hi}${sfx}`;
  if (lo !== null) return `from ${lo}${sfx}`;
  if (hi !== null) return `up to ${hi}${sfx}`;
  return null;
}

/** An opening as the digest may carry it: allowlisted fields only. */
export function openingBrief(o: Record<string, any> | undefined, publicUrl: string) {
  if (!o) return null;
  return {
    id: String(o.id),
    title: clip(o.title),
    status: clip(o.status, 40),
    rate: rateText(o.rateMin, o.rateMax),
    advert: clip(o.url?.primaryLinkUrl, 1000),
    link: recordUrl(publicUrl, "opening", String(o.id)),
  };
}

export type Digest = {
  kind: "job-hunt-digest";
  at: string;
  escalations: Record<string, unknown>[];
  failedRuns: Record<string, unknown>[];
  link: string;
};

/** Pure: the JSON body for one post. Drops delivered or migrated records again, so it is safe on any input. */
export function composeDigest(escalations: Record<string, any>[], runs: Record<string, any>[], openings: Map<string, Record<string, any>>, opts: { publicUrl: string; now: Date }): { body: Digest; escalationIds: string[]; runIds: string[] } | null {
  const esc = escalations.filter((r) => r.status === "OPEN" && !r.grokDeliveredAt && !r.migratedAt);
  const failed = runs.filter((r) => typeof r.exitCode === "number" && r.exitCode !== 0 && !r.grokDeliveredAt && !r.migratedAt);
  if (!esc.length && !failed.length) return null;
  const base = opts.publicUrl.replace(/\/+$/, "");
  return {
    escalationIds: esc.map((r) => r.id),
    runIds: failed.map((r) => r.id),
    body: {
      kind: "job-hunt-digest",
      at: opts.now.toISOString(),
      escalations: esc.map((r) => ({
        id: r.id,
        name: clip(r.name),
        kind: clip(r.kind, 40),
        priority: clip(r.priority, 8),
        reason: clip(r.reason),
        action: clip(r.action),
        link: recordUrl(base, "escalation", r.id),
        opening: openingBrief(r.openingId ? openings.get(r.openingId) : undefined, base),
      })),
      failedRuns: failed.map((r) => ({
        id: r.id,
        name: clip(r.name),
        kind: clip(r.kind, 40),
        exitCode: r.exitCode,
        startedAt: clip(r.startedAt, 40),
        finishedAt: clip(r.finishedAt, 40),
        summary: clip(r.summary),
        link: recordUrl(base, "run", r.id),
      })),
      link: `${base}/objects/escalations`,
    },
  };
}

export async function readLedger(file: string): Promise<Ledger> {
  try {
    const j = JSON.parse(await fs.readFile(file, "utf8"));
    return { posts: Array.isArray(j?.posts) ? j.posts.filter((p: unknown) => typeof p === "string") : [] };
  } catch {
    return { posts: [] };
  }
}

async function writeLedger(file: string, ledger: Ledger): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2) + "\n");
  await fs.rename(tmp, file);
}

export async function postDigest(webhook: string, bearer: string, body: Digest, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(webhook, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function grokDigest(call: TwentyCall, opts: { webhook: string; bearer: string; publicUrl: string; ledgerFile: string; now?: Date; dryRun?: boolean; fetchImpl?: typeof fetch }) {
  const now = opts.now ?? new Date();
  if (!opts.webhook || !opts.bearer) return { ok: true, posted: 0, skipped: "GROK_ROUTINE_WEBHOOK_URL or GROK_ROUTINE_BEARER not set" };
  const ledger = await readLedger(opts.ledgerFile);
  const cap = capCheck(ledger, now);
  if (!cap.ok && !opts.dryRun) return { ok: true, posted: 0, capped: cap.reason, nextAt: cap.nextAt };
  const escalations = await listAll(call, "escalations", ESCALATION_FILTER);
  const runs = await listAll(call, "runs", RUN_FILTER);
  const openingIds = [...new Set(escalations.map((r) => r.openingId).filter(Boolean))] as string[];
  const openings = openingIds.length ? await getByIds(call, "openings", openingIds) : new Map();
  const digest = composeDigest(escalations, runs, openings, { publicUrl: opts.publicUrl, now });
  if (!digest) return { ok: true, posted: 0, escalations: 0, failedRuns: 0 };
  const counts = { escalations: digest.escalationIds.length, failedRuns: digest.runIds.length };
  if (opts.dryRun) return { ok: true, posted: 0, dryRun: true, ...counts, body: digest.body };
  try {
    await postDigest(opts.webhook, opts.bearer, digest.body, opts.fetchImpl);
  } catch (e: any) {
    return { ok: false, posted: 0, ...counts, error: `Grok POST failed: ${e?.message ?? e}` };
  }
  // The post went out: count it before marking, so a marking failure never frees a slot.
  await writeLedger(opts.ledgerFile, recordPost(ledger, now));
  const at = now.toISOString();
  for (const id of digest.escalationIds) await call("PATCH", `/rest/escalations/${id}`, { grokDeliveredAt: at });
  for (const id of digest.runIds) await call("PATCH", `/rest/runs/${id}`, { grokDeliveredAt: at });
  return { ok: true, posted: 1, ...counts };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  for (const a of argv) if (a !== "--dry-run") throw new Error(`unknown argument: ${a}`);
  const call = await connect(); // also loads state/twenty/keys.env into the environment
  const publicUrl = (process.env.TWENTY_PUBLIC_URL || process.env.TWENTY_API_URL || "").replace(/\/+$/, "");
  const result = await grokDigest(call, {
    webhook: process.env.GROK_ROUTINE_WEBHOOK_URL || "",
    bearer: process.env.GROK_ROUTINE_BEARER || "",
    publicUrl,
    ledgerFile: process.env.GROK_DIGEST_LEDGER || repoPath("state", "twenty", "grok-digest-ledger.json"),
    dryRun: argv.includes("--dry-run"),
  });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  });
}
