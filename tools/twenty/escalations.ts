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
 * Escalations this tool created (migrated ones included) that are no longer
 * raised, or whose opening now needs nothing (submitted or later, rejected,
 * withdrawn), are set RESOLVED with resolvedAt and a short reason. When the
 * summary reported read errors its list is partial, and only the opening's
 * status closes anything. Open escalations on openings that are the same role
 * keep one and the rest are DISMISSED as "duplicate of <name>"
 * (escalation-hygiene.ts). It never writes deliveredAt or grokDeliveredAt
 * (R36) except to clear them on a reopen: those belong to delivery, and a
 * record keeps them for life, so each one informs once.
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
import { ABSENT_REASON, doneStatus, planDuplicates, resolvedReason, type OpenEscalation } from "./escalation-hygiene.ts";
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

/**
 * The next step, said for the workspace. The summary's actions are written for
 * file mode (local paths, the Sheet Tray, slash commands); in Twenty the person
 * acts with the record's buttons. Kinds with no button keep the summary text.
 */
export function twentyAction(e: Escalation): string {
  switch (e.kind) {
    case "screening": return "Open the screening question and use Answer; the next autopilot run retries with every gate";
    case "awaiting_approval": return "Open the opening and use Approve, Hold or Reject";
    case "manual": return "Apply on the portal yourself, then use Mark sent on the opening (or Withdraw)";
    case "submission_pending": return "Check the portal for this submission, then use Mark sent or Withdraw on the opening";
    case "kill_switch": return "Sends are halted; use Enable autopilot (Cmd+K) when you want them back";
    default: return e.action;
  }
}

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
    action: twentyAction(e),
    openingId: link ? openingId(e.id!) : null,
    notifyMemberId: opts.notifyMemberId || null,
  };
}

export type SyncPlan = {
  create: Record<string, unknown>[];
  update: { id: string; fields: Record<string, unknown> }[];
  reopen: string[];
  resolve: string[];
  /** Of resolve, the ones closed because their opening needs nothing now. */
  resolvedByOpening: string[];
  /** Records this run dismissed as duplicates of another escalation. */
  merged: string[];
  dismissed: string[];
  unchanged: number;
};

export type PlanOpts = {
  now: string;
  notifyMemberId?: string | null;
  linkOpening?: (harnessId: string) => boolean;
  /** Opening records by record id, for the done check and the duplicate merge. */
  openings?: Map<string, Record<string, any>>;
  /**
   * The run's escalation list is incomplete (the summary reported errors), so
   * absence from it proves nothing: resolve only on the opening's own status.
   */
  partial?: boolean;
};

/** Harness-made: the id is derived from the dedupeKey. A hand-made record is never closed. */
const harnessMade = (r: Record<string, any>) => Boolean(r.dedupeKey) && escalationRecordId(r.dedupeKey) === r.id;

/**
 * What to write, given the run's escalations and the records that already
 * exist (every record with one of their ids, plus every OPEN record). Pure.
 */
export function planSync(current: Escalation[], existing: Record<string, any>[], opts: PlanOpts): SyncPlan {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const openings = opts.openings ?? new Map<string, Record<string, any>>();
  const plan: SyncPlan = { create: [], update: [], reopen: [], resolve: [], resolvedByOpening: [], merged: [], dismissed: [], unchanged: 0 };
  const live = new Set<string>();
  for (const e of current) {
    // An escalation on an opening that needs nothing is not raised, so a stale
    // gate or cap event can't reopen (and re-announce) it on every run.
    if (e.id && doneStatus(openings.get(openingId(e.id)))) continue;
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
    // Migrated records were made by this tool too, so they close the same way.
    if (ex.status !== "OPEN" || live.has(ex.id) || !harnessMade(ex)) continue;
    const done = doneStatus(openings.get(ex.openingId ?? ""));
    if (!done && opts.partial) continue;
    plan.resolve.push(ex.id);
    if (done) plan.resolvedByOpening.push(ex.id);
    plan.update.push({ id: ex.id, fields: { status: "RESOLVED", resolvedAt: opts.now, reason: done ? resolvedReason(done) : ABSENT_REASON } });
  }
  mergeDuplicates(plan, existing, openings, opts.now);
  return plan;
}

/** Dismiss open duplicates of one role, on the state the plan leaves behind. */
function mergeDuplicates(plan: SyncPlan, existing: Record<string, any>[], openings: Map<string, Record<string, any>>, now: string): void {
  const after = new Map<string, Record<string, any>>(existing.map((r) => [r.id, { ...r }]));
  for (const r of plan.create) after.set(r.id as string, { ...r });
  for (const u of plan.update) after.set(u.id, { ...after.get(u.id), ...u.fields });
  const open = [...after.values()].filter((r) => r.status === "OPEN" && harnessMade(r));
  for (const d of planDuplicates(open as OpenEscalation[], openings, { now })) {
    const fields = { status: "DISMISSED", resolvedAt: now, reason: d.reason };
    plan.merged.push(d.id);
    const created = plan.create.find((r) => r.id === d.id);
    if (created) { Object.assign(created, fields); continue; }
    const i = plan.update.findIndex((u) => u.id === d.id);
    if (plan.reopen.includes(d.id)) {
      // Not reopened after all, so its delivery stamps stay as they were.
      plan.reopen = plan.reopen.filter((x) => x !== d.id);
      plan.update[i] = { id: d.id, fields };
    } else if (i >= 0) {
      plan.update[i] = { id: d.id, fields: { ...plan.update[i].fields, ...fields } };
    } else {
      if (plan.unchanged > 0) plan.unchanged--;
      plan.update.push({ id: d.id, fields });
    }
  }
}

/**
 * createFields are merged into every record this call creates; the one-time
 * migration passes { migratedAt } so delivery workflows skip what it brings in.
 * partial: the run's escalation list is incomplete, so nothing is resolved for
 * being absent from it (see PlanOpts).
 */
export async function syncEscalations(call: TwentyCall, current: Escalation[], opts: { now?: string; notifyMemberId?: string | null; dryRun?: boolean; createFields?: Record<string, unknown>; partial?: boolean } = {}) {
  const now = opts.now ?? new Date().toISOString();
  const ids = [...new Set(current.map((e) => escalationRecordId(dedupeKey(e))))];
  const known = await getByIds(call, "escalations", ids);
  for (const rec of await listAll(call, "escalations", "status[eq]:OPEN")) known.set(rec.id, rec);
  // Openings for the run's escalations and for every open record: links only
  // go to openings that exist, so a stale id can't fail the whole batch, and
  // the done check and the duplicate merge read their status and role.
  const harnessIds = [...new Set(current.map((e) => e.id).filter((x): x is string => Boolean(x)))];
  const openingIds = new Set(harnessIds.map(openingId));
  for (const rec of known.values()) if (rec.status === "OPEN" && rec.openingId) openingIds.add(rec.openingId);
  const openings = await getByIds(call, "openings", [...openingIds]);
  const plan = planSync(current, [...known.values()], { now, notifyMemberId: opts.notifyMemberId, linkOpening: (h) => openings.has(openingId(h)), openings, partial: opts.partial });
  if (opts.createFields) plan.create = plan.create.map((r) => ({ ...r, ...opts.createFields }));
  if (!opts.dryRun) {
    for (let i = 0; i < plan.create.length; i += 60) await call("POST", "/rest/batch/escalations", plan.create.slice(i, i + 60));
    for (const u of plan.update) await call("PATCH", `/rest/escalations/${u.id}`, u.fields);
  }
  const createdIds = new Set(plan.create.map((r) => r.id as string));
  // Status after this sync, for the count of the run's escalations left open.
  const after = new Map<string, unknown>([...known.values()].map((r) => [r.id, r.status]));
  for (const u of plan.update) if (u.fields.status) after.set(u.id, u.fields.status);
  for (const r of plan.create) after.set(r.id as string, r.status);
  return {
    open: ids.filter((id) => after.get(id) === "OPEN").length,
    created: plan.create.length,
    updated: plan.update.length - plan.reopen.length - plan.resolve.length - plan.merged.filter((id) => !createdIds.has(id)).length,
    reopened: plan.reopen.length,
    resolved: plan.resolve.length,
    resolvedByOpening: plan.resolvedByOpening.length,
    merged: plan.merged.length,
    dismissed: plan.dismissed.length,
    unchanged: plan.unchanged,
    partial: Boolean(opts.partial),
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
  // A summary that could not read part of the state lists only what it could
  // read; absence from it proves nothing, so only the openings' own status
  // closes anything this run.
  const partial = summary.errors.length > 0;
  const result = await syncEscalations(call, summary.escalations, { notifyMemberId: process.env.TWENTY_OWNER_MEMBER_ID || null, dryRun: args.dryRun, partial });
  console.log(JSON.stringify({ ok: true, date, dryRun: args.dryRun, ...result }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  });
}
