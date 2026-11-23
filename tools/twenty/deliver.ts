#!/usr/bin/env tsx
/**
 * deliver.ts: post undelivered escalations to Slack, once each (plan F13).
 *
 * A workflow step can't read a secret application variable (R30, R48), so the
 * harness posts the Slack webhook itself: the recorded exception to Principle 7.
 * It is still driven by records: it reads OPEN escalations with deliveredAt and
 * migratedAt empty, then
 *   - posts each P1 on its own, now;
 *   - posts the rest (P2, P3) together as one digest;
 *   - sets deliveredAt on every record a successful post carried.
 * Informing once is deliveredAt plus the unique dedupeKey behind each record id
 * (tools/twenty/escalations.ts never clears deliveredAt). Links open the record
 * in Twenty: ${TWENTY_PUBLIC_URL}/object/escalation/<id>.
 *
 * A failed run (--exit N, N != 0) always posts, with the failure on top.
 *
 * Env: SLACK_WEBHOOK_URL (unset: skipped, nothing marked delivered),
 * TWENTY_PUBLIC_URL (default TWENTY_API_URL), plus the Twenty store config.
 *
 * Usage: tsx tools/twenty/deliver.ts [--exit N] [--dry-run]
 * Prints one JSON object. A failed POST exits 1 and leaves the remaining
 * records undelivered, so the next run retries them.
 */

import type { Escalation } from "../daily-summary.ts";
import { groupLines, postSlack, shortReason, slackEscape } from "../notify-escalations.ts";
import { connect, listAll, recordUrl, type TwentyCall } from "./records.ts";

export const UNDELIVERED_FILTER = "and(status[eq]:OPEN,deliveredAt[is]:NULL,migratedAt[is]:NULL,priority[is]:NOT_NULL)";

export type Post = { ids: string[]; text: string };

/** The Slack bullet for one escalation record. */
export function recordBullet(rec: Record<string, any>, publicUrl: string): string {
  const short = shortReason({ kind: rec.kind, reason: rec.reason ?? "", id: rec.openingId ?? undefined, action: "" } as Escalation);
  const label = String(rec.name || short);
  const link = `<${recordUrl(publicUrl, "escalation", rec.id)}|${slackEscape(label)}>`;
  return label === short ? `• ${link}` : `• ${link}: ${slackEscape(short)}`;
}

/**
 * What to post, in order: one post per P1, then one digest for the rest.
 * Records already delivered or migrated never reach here (the query excludes
 * them), and the function drops them again so it stays safe on any input.
 */
export function composeDelivery(records: Record<string, any>[], opts: { publicUrl: string; timeLabel: string; exitCode?: number }): Post[] {
  const pending = records.filter((r) => r.status === "OPEN" && !r.deliveredAt && !r.migratedAt);
  const posts: Post[] = [];
  for (const r of pending.filter((x) => x.priority === "P1")) {
    posts.push({ ids: [r.id], text: `*Job hunt needs you now*\n${recordBullet(r, opts.publicUrl)}` });
  }
  const rest = pending.filter((x) => x.priority !== "P1");
  const failed = (opts.exitCode ?? 0) !== 0;
  if (rest.length || failed) {
    const n = rest.length;
    const L = [`*Job hunt, ${opts.timeLabel}: ${n ? `${n} item${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you` : "run failed"}*`];
    if (failed) L.push("", `:warning: The run failed (exit ${opts.exitCode}). Sent totals are unverified until you check the pipeline; never retry an uncertain send.`);
    L.push(...groupLines(rest, (r) => String(r.kind ?? ""), (r) => recordBullet(r, opts.publicUrl)));
    L.push("", `<${opts.publicUrl.replace(/\/+$/, "")}/objects/escalations|Open escalations in Twenty>`);
    posts.push({ ids: rest.map((r) => r.id), text: L.join("\n") });
  }
  return posts;
}

export async function deliver(call: TwentyCall, opts: { webhook: string; publicUrl: string; timeLabel: string; exitCode?: number; dryRun?: boolean; post?: (text: string) => Promise<void> }) {
  const records = await listAll(call, "escalations", UNDELIVERED_FILTER);
  const posts = composeDelivery(records, opts);
  const base = { undelivered: records.length, posts: posts.length };
  if (opts.dryRun) return { ok: true, sent: 0, delivered: 0, dryRun: true, ...base, texts: posts.map((p) => p.text) };
  if (!opts.webhook) return { ok: true, sent: 0, delivered: 0, skipped: "SLACK_WEBHOOK_URL not set", ...base };
  const post = opts.post ?? ((text: string) => postSlack(opts.webhook, text));
  let sent = 0;
  let delivered = 0;
  for (const p of posts) {
    try {
      await post(p.text);
    } catch (e: any) {
      return { ok: false, sent, delivered, error: `Slack POST failed: ${e?.message ?? e}`, ...base };
    }
    sent++;
    const at = new Date().toISOString();
    for (const id of p.ids) {
      await call("PATCH", `/rest/escalations/${id}`, { deliveredAt: at });
      delivered++;
    }
  }
  return { ok: true, sent, delivered, ...base };
}

function parseArgs(argv: string[]) {
  const out = { exit: 0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exit") out.exit = Number(argv[++i] ?? "0");
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.exit)) throw new Error("bad --exit");
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const call = await connect();
  const { loadLocale } = await import("../profile.ts");
  const { timezone } = await loadLocale();
  const timeLabel = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date());
  const publicUrl = (process.env.TWENTY_PUBLIC_URL || process.env.TWENTY_API_URL || "").replace(/\/+$/, "");
  const result = await deliver(call, { webhook: process.env.SLACK_WEBHOOK_URL || "", publicUrl, timeLabel, exitCode: args.exit, dryRun: args.dryRun });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  });
}
