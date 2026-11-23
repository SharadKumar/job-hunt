#!/usr/bin/env tsx
/**
 * followups.ts: follow-ups as Twenty Tasks (plan F19).
 *
 * The harness, not a workflow, decides each follow-up and its due date:
 *   - a submitted opening gets "Follow up" due 7 business days after submittedAt;
 *   - an opening in interview gets "Prepare for the interview" due the next
 *     business day.
 * Each Task is assigned to TWENTY_OWNER_MEMBER_ID and linked to the opening
 * through a taskTarget. Ids are uuid5("task:<kind>:<harnessId>") and
 * uuid5("taskTarget:<kind>:<harnessId>"), so a re-run creates nothing and a
 * Task the person edited or completed is never rewritten. Migrated openings
 * are skipped: their history predates the harness's Tasks. Twenty's Tasks list
 * does the reminding.
 *
 * Business days skip Saturday and Sunday in the profile's timezone. Public
 * holidays are not counted.
 *
 * Usage: tsx tools/twenty/followups.ts [--dry-run]
 * Prints one JSON object. Exit 1 when Twenty can't be reached or rejects a write.
 */

import { uuid5 } from "../store/twenty-backend.ts";
import { connect, getByIds, listAll, recordUrl, type TwentyCall } from "./records.ts";

export const FOLLOW_UP_BUSINESS_DAYS = 7;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type TaskKind = "follow-up" | "interview-prep";

export const taskId = (kind: TaskKind, harnessId: string) => uuid5(`task:${kind}:${harnessId}`);
export const taskTargetId = (kind: TaskKind, harnessId: string) => uuid5(`taskTarget:${kind}:${harnessId}`);

function weekdayIn(t: number, timeZone: string): number {
  return WEEKDAYS.indexOf(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(t)));
}

/** The instant n business days after iso, counting weekdays in timeZone. */
export function addBusinessDays(iso: string, n: number, timeZone = "UTC"): string {
  const start = Date.parse(iso);
  if (Number.isNaN(start)) throw new Error(`bad date: ${iso}`);
  let day = weekdayIn(start, timeZone);
  let days = 0;
  for (let counted = 0; counted < n;) {
    days++;
    day = (day + 1) % 7;
    if (day !== 0 && day !== 6) counted++;
  }
  return new Date(start + days * DAY_MS).toISOString();
}

export function isMigrated(rec: Record<string, any>): boolean {
  return Boolean(rec.migratedAt || rec.harnessData?.migratedAt);
}

export type PlannedTask = { kind: TaskKind; harnessId: string; task: Record<string, unknown>; target: Record<string, unknown> };

/** The Tasks the current openings call for. Pure. */
export function planFollowups(openings: Record<string, any>[], opts: { now: string; timeZone?: string; ownerMemberId?: string | null; publicUrl?: string }): PlannedTask[] {
  const tz = opts.timeZone ?? "UTC";
  const out: PlannedTask[] = [];
  for (const rec of openings) {
    const harnessId: string | undefined = rec.harnessId ?? rec.harnessData?.id;
    if (!harnessId || isMigrated(rec)) continue;
    const role = `${rec.title ?? rec.harnessData?.title ?? "the role"}${rec.harnessData?.company ? ` at ${rec.harnessData.company}` : ""}`;
    const link = opts.publicUrl ? `\n\n[Open the opening](${recordUrl(opts.publicUrl, "opening", rec.id)})` : "";
    let kind: TaskKind;
    let title: string;
    let dueAt: string;
    let body: string;
    if (rec.status === "SUBMITTED" && rec.submittedAt) {
      kind = "follow-up";
      title = `Follow up: ${role}`;
      dueAt = addBusinessDays(rec.submittedAt, FOLLOW_UP_BUSINESS_DAYS, tz);
      body = `Submitted ${String(rec.submittedAt).slice(0, 10)}. If there is no reply by the due date, draft a short follow-up with /follow-up.`;
    } else if (rec.status === "INTERVIEW") {
      kind = "interview-prep";
      title = `Prepare for the interview: ${role}`;
      dueAt = addBusinessDays(opts.now, 1, tz);
      body = "Research the company and rehearse your examples with /prep-interview.";
    } else continue;
    const id = taskId(kind, harnessId);
    out.push({
      kind,
      harnessId,
      task: { id, title, bodyV2: { markdown: body + link, blocknote: null }, dueAt, status: "TODO", assigneeId: opts.ownerMemberId || null },
      target: { id: taskTargetId(kind, harnessId), taskId: id, targetOpeningId: rec.id },
    });
  }
  return out;
}

const isDuplicate = (e: unknown) => /duplicate|already exists|unique/i.test(String((e as any)?.message ?? e));

export async function syncFollowups(call: TwentyCall, opts: { now?: string; timeZone?: string; ownerMemberId?: string | null; publicUrl?: string; dryRun?: boolean } = {}) {
  const openings = await listAll(call, "openings", "status[in]:[SUBMITTED,INTERVIEW]");
  const planned = planFollowups(openings, { ...opts, now: opts.now ?? new Date().toISOString() });
  const existing = await getByIds(call, "tasks", planned.map((p) => p.task.id as string));
  const missing = planned.filter((p) => !existing.has(p.task.id as string));
  let created = 0;
  let removedByPerson = 0;
  if (!opts.dryRun) {
    for (const p of missing) {
      try {
        await call("POST", "/rest/tasks", p.task);
      } catch (e) {
        // A Task the person deleted still holds its id in the trash; leave it.
        if (isDuplicate(e)) { removedByPerson++; continue; }
        throw e;
      }
      try {
        await call("POST", "/rest/taskTargets", p.target);
      } catch (e) {
        if (!isDuplicate(e)) throw e;
      }
      created++;
    }
  }
  return {
    openings: openings.length,
    skipped_migrated: openings.filter(isMigrated).length,
    planned: planned.length,
    existing: planned.length - missing.length,
    created: opts.dryRun ? 0 : created,
    would_create: opts.dryRun ? missing.length : undefined,
    removed_by_person: removedByPerson,
  };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const unknown = process.argv.slice(2).filter((a) => a !== "--dry-run");
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const call = await connect();
  const { loadLocale } = await import("../profile.ts");
  const { timezone } = await loadLocale();
  const ownerMemberId = process.env.TWENTY_OWNER_MEMBER_ID || null;
  const publicUrl = (process.env.TWENTY_PUBLIC_URL || process.env.TWENTY_API_URL || "").replace(/\/+$/, "");
  const result = await syncFollowups(call, { timeZone: timezone, ownerMemberId, publicUrl, dryRun });
  console.log(JSON.stringify({ ok: true, dryRun, ...result, ...(ownerMemberId ? {} : { warning: "TWENTY_OWNER_MEMBER_ID not set; Tasks are unassigned" }) }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  });
}
