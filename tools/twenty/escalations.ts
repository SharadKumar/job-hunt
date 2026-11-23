#!/usr/bin/env tsx
/**
 * escalations.ts: keep Twenty's escalation records in step with the run (plan F13).
 *
 * Reads the run's escalations (daily-summary's buildSummary), then for each:
 *   - id is uuid5("escalation:<dedupeKey>"), dedupeKey = kind + ":" + (opening
 *     harness id or reason), so the same escalation is always the same record;
 *   - the harness sets the priority: P1 blocks the harness, P2 needs an answer
 *     or an approval, P3 is work the person does themselves;
 *   - a new one is created OPEN; an OPEN one has its text refreshed; a RESOLVED
 *     one that came back is reopened; one the person DISMISSED is left alone.
 * Escalations this tool created that are no longer raised are set RESOLVED with
 * resolvedAt. It never writes deliveredAt or grokDeliveredAt (R36): those belong
 * to delivery, and a record keeps them for life, so each one informs once.
 *
 * notifyMemberId is TWENTY_OWNER_MEMBER_ID, the member the notify-new-escalation
 * workflow tells about a new P1. Unset, the inbox step is skipped.
 *
 * Usage: tsx tools/twenty/escalations.ts [--date YYYY-MM-DD] [--dry-run]
 * Prints one JSON object. Exit 1 when Twenty can't be reached or rejects a write.
 */

import type { Escalation } from "../daily-summary.ts";
import { clip, escalationKey, shortReason } from "../notify-escalations.ts";
import { openingId, uuid5 } from "../store/twenty-backend.ts";
import { connect, getByIds, listAll, type TwentyCall } from "./records.ts";

export type Priority = "P1" | "P2" | "P3";

export const PRIORITY_BY_KIND: Record<Escalation["kind"], Priority> = {
  kill_switch: "P1",
  cap: "P1",
  channel: "P1",
  gate: "P1",
  submission_pending: "P1",
  screening: "P2",
  awaiting_approval: "P2",
  manual: "P3",
};

/** A kind added later defaults to P2: it reaches the digest, not the pager. */
export function priorityFor(kind: string): Priority {
  return (PRIORITY_BY_KIND as Record<string, Priority>)[kind] ?? "P2";
}

export const dedupeKey = escalationKey;
export const escalationRecordId = (key: string) => uuid5(`escalation:${key}`);

/** Fields delivery owns. Sync never writes them. */
export const DELIVERY_FIELDS = ["deliveredAt", "grokDeliveredAt"] as const;

const CONTENT_FIELDS = ["name", "kind", "priority", "dedupeKey", "reason", "action", "openingId", "notifyMemberId"] as const;

export function escalationName(e: Escalation): string {
  return e.title ? `${clip(e.title, 60)} at ${e.company ?? "?"}` : clip(shortReason(e), 90);
}

/** The record fields the harness sets for one escalation (no status, no delivery). */
export function toRecord(e: Escalation, opts: { notifyMemberId?: string | null; linkOpening?: (harnessId: string) => boolean } = {}): Record<string, unknown> {
  const key = dedupeKey(e);
  const link = e.id && (opts.linkOpening ? opts.linkOpening(e.id) : true);
  return {
    id: escalationRecordId(key),
    name: escalationName(e),
    kind: e.kind,
    priority: priorityFor(e.kind),
    dedupeKey: key,
    reason: e.reason,
    action: e.action,
    openingId: link ? openingId(e.id!) : null,
    notifyMemberId: opts.notifyMemberId || null,
  };
}

export type SyncPlan = {
  create: Record<string, unknown>[];
  update: { id: string; fields: Record<string, unknown> }[];
  reopen: string[];
  resolve: string[];
  dismissed: string[];
  unchanged: number;
};

/**
 * What to write, given the run's escalations and the records that already
 * exist (every record with one of their ids, plus every OPEN record). Pure.
 */
export function planSync(current: Escalation[], existing: Record<string, any>[], opts: { now: string; notifyMemberId?: string | null; linkOpening?: (harnessId: string) => boolean }): SyncPlan {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const plan: SyncPlan = { create: [], update: [], reopen: [], resolve: [], dismissed: [], unchanged: 0 };
  const live = new Set<string>();
  for (const e of current) {
    const rec = toRecord(e, opts);
    const id = rec.id as string;
    if (live.has(id)) continue;
    live.add(id);
    const ex = byId.get(id);
    if (!ex) { plan.create.push({ ...rec, status: "OPEN" }); continue; }
    if (ex.status === "DISMISSED") { plan.dismissed.push(id); continue; }
    const { id: _id, ...fields } = rec;
    if (ex.status === "RESOLVED") {
      plan.reopen.push(id);
      // A cleared escalation that comes back is new to the person (plan F13):
      // reopening is the one write that clears the delivery stamps, so it is
      // announced again. Routine refreshes never touch them (R36).
      plan.update.push({ id, fields: { ...fields, status: "OPEN", resolvedAt: null, deliveredAt: null, grokDeliveredAt: null } });
      continue;
    }
    const changed = Object.fromEntries(CONTENT_FIELDS.filter((f) => (ex[f] ?? null) !== (rec[f] ?? null)).map((f) => [f, rec[f]]));
    if (Object.keys(changed).length) plan.update.push({ id, fields: changed });
    else plan.unchanged++;
  }
  for (const ex of existing) {
    // Only records this tool made: their id is derived from their dedupeKey.
    if (ex.status !== "OPEN" || ex.migratedAt || live.has(ex.id)) continue;
    if (!ex.dedupeKey || escalationRecordId(ex.dedupeKey) !== ex.id) continue;
    plan.resolve.push(ex.id);
    plan.update.push({ id: ex.id, fields: { status: "RESOLVED", resolvedAt: opts.now } });
  }
  return plan;
}

/**
 * createFields are merged into every record this call creates; the one-time
 * migration passes { migratedAt } so delivery workflows skip what it brings in.
 */
export async function syncEscalations(call: TwentyCall, current: Escalation[], opts: { now?: string; notifyMemberId?: string | null; dryRun?: boolean; createFields?: Record<string, unknown> } = {}) {
  const now = opts.now ?? new Date().toISOString();
  const ids = [...new Set(current.map((e) => escalationRecordId(dedupeKey(e))))];
  const known = await getByIds(call, "escalations", ids);
  for (const rec of await listAll(call, "escalations", "status[eq]:OPEN")) known.set(rec.id, rec);
  // Link only openings that exist, so a stale id can't fail the whole batch.
  const harnessIds = [...new Set(current.map((e) => e.id).filter((x): x is string => Boolean(x)))];
  const openings = await getByIds(call, "openings", harnessIds.map(openingId));
  const plan = planSync(current, [...known.values()], { now, notifyMemberId: opts.notifyMemberId, linkOpening: (h) => openings.has(openingId(h)) });
  if (opts.createFields) plan.create = plan.create.map((r) => ({ ...r, ...opts.createFields }));
  if (!opts.dryRun) {
    for (let i = 0; i < plan.create.length; i += 60) await call("POST", "/rest/batch/escalations", plan.create.slice(i, i + 60));
    for (const u of plan.update) await call("PATCH", `/rest/escalations/${u.id}`, u.fields);
  }
  return {
    open: ids.length - plan.dismissed.length,
    created: plan.create.length,
    updated: plan.update.length - plan.reopen.length - plan.resolve.length,
    reopened: plan.reopen.length,
    resolved: plan.resolve.length,
    dismissed: plan.dismissed.length,
    unchanged: plan.unchanged,
  };
}

function parseArgs(argv: string[]) {
  const out = { date: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i] ?? "";
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error(`bad --date: ${out.date}`);
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const call = await connect();
  const { buildSummary } = await import("../daily-summary.ts");
  const { loadLocale } = await import("../profile.ts");
  const { timezone } = await loadLocale();
  const date = args.date || new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const summary = await buildSummary(date);
  const result = await syncEscalations(call, summary.escalations, { notifyMemberId: process.env.TWENTY_OWNER_MEMBER_ID || null, dryRun: args.dryRun });
  console.log(JSON.stringify({ ok: true, date, dryRun: args.dryRun, ...result }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  });
}
