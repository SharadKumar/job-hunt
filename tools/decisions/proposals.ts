#!/usr/bin/env tsx
/**
 * proposals.ts — carry out what the person confirmed (plan F14, F15 executor).
 *
 * Agents (the harness, AI chat, Grok tools) create proposal records. The
 * person confirms or declines with a button; intake.ts turns that decision
 * into status CONFIRMED or DECLINED. This module is the executor's queue:
 *
 *   tsx tools/decisions/proposals.ts next            # confirmed work, allowlisted and capped
 *   tsx tools/decisions/proposals.ts done <id> --outcome <text>
 *   tsx tools/decisions/proposals.ts failed <id> --outcome <text>
 *
 * The daily run's agent half calls `next`, does each item with the matching
 * harness component, and records the outcome. A proposal never sends,
 * contacts or decides; the brief is untrusted text and reaches agents only as
 * quoted data.
 */

import { twentyClient } from "../store/twenty-backend.ts";

/** Allowlist: proposal type → the harness component that carries it out. */
export const EXECUTORS: Record<string, string> = {
  REDRAFT_LETTER: "cover-letter-writer, then the letter critic",
  DRAFT_FOLLOW_UP: "cover-letter-writer (follow-up mode)",
  RESEARCH_COMPANY: "research (interview mode)",
  PREP_INTERVIEW: "research (interview mode)",
  RESCAN_CHANNEL: "front-half hunt for that channel, within channel limits",
  ANSWER_SCREENING: "screening answer document revision",
  CONFIRM_KEYWORD: "resume:keyword-confirm record",
  APPROVE_PACKAGE: "pipeline transition to approved",
  SUGGEST_OUTCOME: "pipeline outcome transition",
  UPDATE_DOCUMENT: "document revision",
};

/** Per-day caps across every proposer (plan F14, S12). */
export const DAILY_CAP: Record<string, number> = { REDRAFT_LETTER: 3, DEFAULT: 10 };

export type ProposalRecord = { id: string; proposalType?: string | null; summary?: string | null; payload?: unknown; openingId?: string | null; status?: string | null; updatedAt?: string };

export type QueueItem = { id: string; type: string; executor: string; brief: string; openingId: string | null };

/** Pure: which confirmed proposals run now, given how many of each type already ran today. */
export function selectWork(confirmed: ProposalRecord[], doneToday: Record<string, number>): { run: QueueItem[]; refused: { id: string; reason: string }[] } {
  const used = { ...doneToday };
  const run: QueueItem[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const p of confirmed) {
    const type = p.proposalType ?? "";
    const executor = EXECUTORS[type];
    if (!executor) { refused.push({ id: p.id, reason: `type ${type || "(empty)"} is not on the allowlist` }); continue; }
    const cap = DAILY_CAP[type] ?? DAILY_CAP.DEFAULT;
    if ((used[type] ?? 0) >= cap) continue; // stays CONFIRMED for tomorrow
    used[type] = (used[type] ?? 0) + 1;
    // Untrusted text: hand it on as quoted data, never as instructions.
    const brief = `<proposal-brief untrusted="true">${String(p.summary ?? "").replace(/</g, "&lt;")}</proposal-brief>`;
    run.push({ id: p.id, type, executor, brief, openingId: p.openingId ?? null });
  }
  return { run, refused };
}

async function main(): Promise<number> {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const { loadLocalEnv } = await import("../jev/env.ts");
  await loadLocalEnv();
  await (await import("../store/twenty-backend.ts")).twentyBackend().catch(() => null);
  const url = process.env.TWENTY_API_URL ?? "", key = process.env.TWENTY_API_KEY ?? "";
  if (!url || !key) { console.log(JSON.stringify({ ok: false, error: "needs TWENTY_API_URL and TWENTY_API_KEY" })); return 2; }
  const { call } = twentyClient({ url, key });
  const outcome = rest[0] === "--outcome" ? rest.slice(1).join(" ") : "";

  if (cmd === "next") {
    const confirmed = (await call("GET", `/rest/proposals?filter=${encodeURIComponent("status[eq]:CONFIRMED")}&limit=100&order_by=updatedAt`)).data?.proposals ?? [];
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const done = (await call("GET", `/rest/proposals?filter=${encodeURIComponent(`and(status[in]:[DONE,FAILED],updatedAt[gte]:${since.toISOString()})`)}&limit=200`)).data?.proposals ?? [];
    const doneToday: Record<string, number> = {};
    for (const p of done) doneToday[p.proposalType] = (doneToday[p.proposalType] ?? 0) + 1;
    const { run, refused } = selectWork(confirmed, doneToday);
    for (const r of refused) await call("PATCH", `/rest/proposals/${r.id}`, { status: "REFUSED", outcome: r.reason });
    console.log(JSON.stringify({ ok: true, run, refused }));
    return 0;
  }
  if ((cmd === "done" || cmd === "failed") && id) {
    await call("PATCH", `/rest/proposals/${id}`, { status: cmd === "done" ? "DONE" : "FAILED", outcome: outcome.slice(0, 4000) });
    console.log(JSON.stringify({ ok: true, id, status: cmd === "done" ? "DONE" : "FAILED" }));
    return 0;
  }
  console.log(JSON.stringify({ ok: false, error: "usage: next | done <id> --outcome <text> | failed <id> --outcome <text>" }));
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
