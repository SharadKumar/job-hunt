#!/usr/bin/env tsx
/**
 * pipeline.ts — CRUD + status transitions for the opportunity pipeline.
 *
 * Single source of truth for every opportunity's status, score, draft path, and
 * submission outcome. Anything mutating opportunities MUST go through this module
 * so we have one place enforcing invariants (status transitions, dedup,
 * required fields per status).
 *
 * Rows live in SQLite (state/pipeline/pipeline.db, see tools/pipeline-store.ts).
 * The legacy 7 MB JSON array is imported once with `migrate` and can be
 * reproduced at any time with `export`.
 *
 * CLI:
 *   tsx tools/pipeline.ts get <opportunity-id> | get [--id <id>] [--status <status>]
 *   tsx tools/pipeline.ts list [--status <s>] [--channel <c>] [--format json|table]
 *   tsx tools/pipeline.ts upsert --json '{...}'
 *   tsx tools/pipeline.ts set-status --id <opportunity-id> --status <status> [--reason "..."]
 *   tsx tools/pipeline.ts patch --id <id> --json '{...}' [--actor <a>] [--reason "..."]
 *   tsx tools/pipeline.ts remove --id <id>[,<id>] [--reason "..."]
 *   tsx tools/pipeline.ts summary [--brief] [--top]
 *   tsx tools/pipeline.ts export [--out <path>]
 *   tsx tools/pipeline.ts migrate [--from <path>] [--dry-run] [--force]
 *
 * `--db <path>` (or PIPELINE_DB) points any command at another database file;
 * the digest and the JSON export follow it, so a dry run never touches state/.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log as auditLog, logMany as auditLogMany, loadDedupIndex, fingerprintFor, type AuditEventType } from "./audit.ts";
import { store, type ListFilter } from "./pipeline-store.ts";
import type { Classification } from "./classify-jd.ts";

// Map pipeline statuses to canonical audit event types so the audit log
// records meaningful semantic events, not raw status names.
const STATUS_TO_EVENT: Partial<Record<PipelineStatus, AuditEventType>> = {
  discovered: "discovered",
  awaiting_external: "discovered",
  shortlisted: "scored",
  parked: "scored",
  drafted: "drafted",
  approved: "approved",
  submission_pending: "submission_pending",
  submitted: "submitted",
  responded: "response_received",
  interview: "interview_scheduled",
  offered: "offered",
  won: "won",
  rejected: "rejected",
  withdrawn: "withdrawn",
  manual_action_needed: "manual_queued",
};

export type PipelineStatus =
  | "discovered"
  | "awaiting_external"
  | "shortlisted"
  | "parked"
  | "drafted"
  | "awaiting_approval"
  | "approved"
  | "submission_pending"
  | "submitted"
  | "responded"
  | "interview"
  | "offered"
  | "won"
  | "rejected"
  | "withdrawn"
  | "manual_action_needed";

export type Opportunity = {
  id: string;                       // stable hash of channel + url
  channel: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  description?: string;             // raw JD; may be truncated on disk
  postedAt?: string;
  dayRate?: { min?: number; max?: number; currency?: string; inc_super?: boolean };
  workArrangement?: "remote" | "hybrid" | "onsite" | "unknown";
  /** How the channel expects the application to be lodged; drives the submit adapter choice and the autopilot gate. */
  applyMethod?: "quick_apply" | "easy_apply" | "external" | "unknown";

  // Pipeline metadata
  status: PipelineStatus;
  score?: number;
  /** Why the row sits in `parked` (interstate onsite, blurb-only interstate). */
  parkedReason?: string;
  scoreReasons?: string[];
  red_flag_blocker?: boolean;
  classification?: Classification;
  classificationSource?: "agent" | "regex" | "none";
  resumeId?: string;
  endEmployer?: string;            // resolved buyer when the advertiser is a recruiter
  requisitionId?: string;          // buyer/RFQ identifier shared across recruiter listings
  duplicateGroup?: string;         // stable related-ad group key; informational, never suppresses other representatives
  duplicateOf?: string;            // canonical reference for shared tailoring/research, not an application exclusion
  tailoredResume?: {
    sourceOpportunityId?: string;
    docxPath?: string;
    pdfPath?: string;
    approvalStatus: "pending" | "approved" | "stale" | "rejected";
    /** "baseline" when the approved baseline was sent as-is; absent or "tailored" for a per-role render. */
    mode?: "baseline" | "tailored";
    approvedAt?: string;
    approvedBy?: string;
    contentHash?: string;
  };
  draftDir?: string;                // e.g. state/pipeline/archive/<id>/
  /** True when the user saved this job on the channel (e.g. SEEK "Saved jobs"); a strong interest signal. */
  userSaved?: boolean;
  userSavedAt?: string;             // ISO timestamp of the first time the saved-jobs watcher saw it
  submittedAt?: string;
  responseAt?: string;
  notes?: string;
  history: { at: string; from: PipelineStatus | null; to: PipelineStatus; reason?: string }[];
};

const VALID_TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
  discovered: ["shortlisted", "parked", "awaiting_external", "rejected", "manual_action_needed"],
  awaiting_external: ["shortlisted", "rejected", "withdrawn"],
  shortlisted: ["drafted", "parked", "discovered", "rejected", "withdrawn"],
  // parked (2026-09-15): fits the profile but held for a logistics reason the
  // user has ruled on (interstate role needing routine onsite attendance, or
  // a card-only blurb that cannot be judged). Not part of the apply queue.
  parked: ["shortlisted", "discovered", "rejected", "withdrawn"],
  drafted: ["awaiting_approval", "rejected", "withdrawn"],
  awaiting_approval: ["approved", "rejected", "withdrawn", "manual_action_needed"],
  approved: ["submission_pending", "submitted", "manual_action_needed", "withdrawn"],
  submission_pending: ["submitted", "manual_action_needed", "withdrawn"],
  submitted: ["responded", "rejected", "withdrawn"],
  responded: ["interview", "rejected", "withdrawn"],
  interview: ["offered", "rejected", "withdrawn"],
  offered: ["won", "rejected", "withdrawn"],
  won: [],
  // reopen (2026-09-15): a user may reverse a harness rejection or a withdrawal; the row re-enters at discovered and must earn its way back.
  rejected: ["discovered"],
  withdrawn: ["discovered"],
  // retry (2026-09-15): once the blocker is cleared (screening answer banked, letter fixed) the row may re-enter the autopilot path at approved.
  manual_action_needed: ["approved", "submitted", "rejected", "withdrawn"],
};

export function opportunityIdFor(channel: string, url: string): string {
  const h = createHash("sha1").update(`${channel}::${url}`).digest("hex").slice(0, 12);
  return `${channel}-${h}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The digest and the JSON export live beside whatever database is in use, so a
 * test or a dry-run migrate pointed at a temp database can never write over the
 * real state/pipeline/ artefacts.
 */
function sidecar(name: string): string {
  return path.join(path.dirname(store().path), name);
}

/** Every row, fully hydrated (JD included). Kept for readers that want the lot. */
export async function load(): Promise<Opportunity[]> {
  return store().list({ withDescription: true });
}

/** One row by id, or null. */
export async function get(id: string): Promise<Opportunity | null> {
  return store().get(id);
}

/** Filtered rows. `withDescription` is off by default: the JD is the bulk of the data. */
export async function list(filter: ListFilter = {}): Promise<Opportunity[]> {
  return store().list(filter);
}

/**
 * @deprecated Legacy whole-array write, kept so callers that mutate a loaded
 * array in place keep working. It replaces the stored set with `roles`
 * (rows absent from the array are deleted, as the JSON file did). Migrate to
 * `patch()` / `upsertMany()` / `remove()`, which touch only what changed.
 */
export async function save(roles: Opportunity[]): Promise<void> {
  const s = store();
  s.transaction(() => {
    const keep = new Set(roles.map((r) => r.id));
    const stale = s.ids().filter((id) => !keep.has(id));
    if (stale.length) s.remove(stale);
    const now = new Date().toISOString();
    for (const role of roles) s.replaceRow(role, now);
  });
  await writeDigest();
}

/** Rewrite state/pipeline/opportunities.md from the current rows. */
export async function writeDigest(): Promise<void> {
  const roles = store().list();
  const byStatus: Record<string, Opportunity[]> = {};
  for (const r of roles) (byStatus[r.status] ||= []).push(r);
  const lines: string[] = ["# Pipeline digest", ""];
  lines.push(`_generated ${new Date().toISOString()}_`, "");
  lines.push(`Total: ${roles.length}`, "");
  const order: PipelineStatus[] = [
    "awaiting_approval", "approved", "submission_pending", "submitted",
    "responded", "interview", "offered", "drafted", "shortlisted",
    "parked", "awaiting_external", "discovered", "manual_action_needed", "won", "rejected", "withdrawn",
  ];
  for (const status of order) {
    const items = byStatus[status];
    if (!items || !items.length) continue;
    lines.push(`## ${status} (${items.length})`, "");
    for (const r of items.slice(0, 10)) {
      const score = r.score != null ? ` (${r.score})` : "";
      lines.push(`- **${r.title}** at ${r.company}${score} — \`${r.channel}\` — [link](${r.url})`);
    }
    if (items.length > 10) lines.push(`- … and ${items.length - 10} more`);
    lines.push("");
  }
  const target = sidecar("opportunities.md");
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, lines.join("\n"));
  await fs.rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type UpsertInput = Partial<Opportunity> & { channel: string; url: string; title: string; company: string };

/** Duplicate lookup against the audit dedup index, from an index loaded once. */
function duplicatesFrom(
  idx: Record<string, { role_id: string; ts: string; status: string }[]>,
  company: string,
  title: string,
  withinDays = 60,
): { role_id: string; ts: string; status: string }[] {
  const since = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  return (idx[fingerprintFor(company, title)] ?? []).filter((m) => m.ts >= since);
}

type PendingAudit = Parameters<typeof auditLog>[0];

/**
 * Insert or refresh one row. A refresh never rewinds status or history:
 * channel searches always describe their results as `discovered`, and that is
 * an insertion default, not permission to undo a workflow.
 */
export async function upsert(opportunity: UpsertInput): Promise<Opportunity> {
  const [row] = await upsertMany([opportunity], { digest: true });
  return row;
}

/** Insert or refresh many rows in one transaction, then write the digest once. */
export async function upsertMany(rows: UpsertInput[], opts: { digest?: boolean } = {}): Promise<Opportunity[]> {
  if (!rows.length) return [];
  const s = store();
  const now = new Date().toISOString();
  const dedupIndex = await loadDedupIndex();
  const events: PendingAudit[] = [];

  const out = s.transaction(() => {
    const result: Opportunity[] = [];
    for (const opportunity of rows) {
      const id = opportunity.id ?? opportunityIdFor(opportunity.channel, opportunity.url);
      if (s.has(id)) {
        const { status: _status, history: _history, ...refreshFields } = opportunity;
        result.push(s.updateFields(id, refreshFields, now)!);
        continue;
      }

      // Cross-channel dedup check: have we already acted on this company +
      // role family recently? We still insert (the user should see both), but
      // the audit trail flags it for the opportunity-finder.
      const dup = duplicatesFrom(dedupIndex, opportunity.company, opportunity.title, 60);
      if (dup.length) {
        events.push({
          event_type: "duplicate_detected",
          role_id: id,
          actor: "pipeline.upsert",
          channel: opportunity.channel,
          details: {
            company: opportunity.company,
            title: opportunity.title,
            existing_role_ids: dup.map((m) => m.role_id),
            existing_statuses: dup.map((m) => m.status),
          },
          provenance: { url: opportunity.url, channel: opportunity.channel },
        });
      }

      const next: Opportunity = {
        ...opportunity,
        id,
        status: opportunity.status ?? "discovered",
        history: [{ at: now, from: null, to: opportunity.status ?? "discovered" }],
      } as Opportunity;
      s.insert(next, now);
      result.push(next);

      events.push({
        event_type: STATUS_TO_EVENT[next.status] ?? "discovered",
        role_id: id,
        actor: "pipeline.upsert",
        channel: opportunity.channel,
        details: { company: opportunity.company, title: opportunity.title, score: next.score, duplicate_of: dup.map((m) => m.role_id) },
        provenance: { url: opportunity.url, channel: opportunity.channel },
      });
    }
    return result;
  });

  await auditLogMany(events);
  if (opts.digest !== false) await writeDigest();
  return out;
}

/**
 * Update fields on an existing row without moving it. Appends a `field_update`
 * history entry so an enrichment pass is visible in the row's own trail.
 */
export async function patch(
  id: string,
  fields: Partial<Opportunity>,
  actor: string,
  reason?: string,
): Promise<Opportunity> {
  const [row] = await patchMany([{ id, fields, reason }], actor);
  return row;
}

/** Many patches in one transaction (channel enrichment writes back this way). */
export async function patchMany(
  entries: { id: string; fields: Partial<Opportunity>; reason?: string }[],
  actor: string,
): Promise<Opportunity[]> {
  if (!entries.length) return [];
  const s = store();
  const now = new Date().toISOString();
  return s.transaction(() => {
    const out: Opportunity[] = [];
    for (const { id, fields, reason } of entries) {
      const { status: _s, history: _h, ...rest } = fields;
      const updated = s.updateFields(id, rest, now);
      if (!updated) throw new Error(`role not found: ${id}`);
      const names = Object.keys(rest).join(", ");
      const entry = {
        at: now,
        from: updated.status,
        to: updated.status,
        reason: `field_update: ${names}${reason ? ` (${reason})` : ""}${actor ? ` [${actor}]` : ""}`,
      };
      s.appendHistory(id, entry);
      updated.history = [...updated.history, entry];
      out.push(updated);
    }
    return out;
  });
}

export async function setStatus(
  id: string,
  next: PipelineStatus,
  reason?: string,
  extras?: { contact?: any; details?: Record<string, unknown>; actor?: string },
): Promise<Opportunity> {
  const s = store();
  const role = s.get(id);
  if (!role) throw new Error(`role not found: ${id}`);
  const allowed = VALID_TRANSITIONS[role.status] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`invalid transition ${role.status} → ${next} (allowed: ${allowed.join(", ") || "none"})`);
  }
  const from = role.status;
  const at = new Date().toISOString();
  const extraFields: Partial<Opportunity> = {};
  if (next === "submitted" && !role.submittedAt) extraFields.submittedAt = at;
  if (next === "responded" && !role.responseAt) extraFields.responseAt = at;

  const updated = s.transaction(() => {
    const row = s.setStatusColumn(id, next, extraFields, at)!;
    const entry = { at, from, to: next, ...(reason ? { reason } : {}) };
    s.appendHistory(id, entry);
    row.history = [...row.history, entry];
    return row;
  });

  await auditLog({
    event_type: STATUS_TO_EVENT[next] ?? "discovered",
    role_id: id,
    actor: extras?.actor ?? "pipeline.setStatus",
    channel: role.channel,
    details: { company: role.company, title: role.title, from, to: next, reason, ...(extras?.details ?? {}) },
    contact: extras?.contact ?? null,
    provenance: { url: role.url, channel: role.channel },
  });

  return updated;
}

/** Delete rows, leaving the removal in each row's history and in the audit log. */
export async function remove(ids: string[], actor: string, reason: string): Promise<{ removed: number }> {
  const s = store();
  const removed: Opportunity[] = [];
  const at = new Date().toISOString();
  s.transaction(() => {
    for (const id of ids) {
      const role = s.get(id, { withDescription: false });
      if (!role) continue;
      s.appendHistory(id, { at, from: role.status, to: role.status, reason: `removed: ${reason} [${actor}]` });
      s.remove([id]);
      removed.push(role);
    }
  });
  for (const role of removed) {
    await auditLog({
      event_type: "withdrawn",
      role_id: role.id,
      actor,
      channel: role.channel,
      details: { company: role.company, title: role.title, status: role.status, reason, removed: true },
      provenance: { url: role.url, channel: role.channel },
    });
  }
  if (removed.length) await writeDigest();
  return { removed: removed.length };
}

/**
 * Duplicate ids are impossible now that `id` is the primary key; the command
 * stays so scripts and docs that call it keep working.
 */
export async function dedup(): Promise<{ removed: number }> {
  return { removed: 0 };
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

/** Write the rows out as a compact JSON array (backup, or a hand-off format). */
export async function exportJson(outPath?: string): Promise<{ out: string; rows: number }> {
  const target = outPath ? path.resolve(outPath) : sidecar("opportunities.json");
  const rows = store().list({ withDescription: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(rows));
  await fs.rename(tmp, target);
  return { out: target, rows: rows.length };
}

/**
 * Import the legacy JSON array. Verifies the row count and that every id round
 * trips before renaming the source aside. `--dry-run` fills the database but
 * leaves the source file alone.
 */
export async function migrate(opts: { from?: string; dryRun?: boolean; force?: boolean } = {}): Promise<Record<string, unknown>> {
  const source = opts.from ? path.resolve(opts.from) : sidecar("opportunities.json");
  const s = store();
  const existing = s.count();
  if (existing > 0 && !opts.force) {
    throw new Error(`pipeline database already holds ${existing} rows (${s.path}); pass --force to import anyway`);
  }
  const rows = JSON.parse(await fs.readFile(source, "utf8")) as Opportunity[];
  if (!Array.isArray(rows)) throw new Error(`${source} is not a JSON array`);

  const now = new Date().toISOString();
  s.transaction(() => {
    for (const row of rows) {
      if (!row?.id) throw new Error(`row without an id in ${source}`);
      s.replaceRow({ ...row, history: row.history ?? [] }, now);
    }
  });

  const missing = rows.filter((r) => !s.has(r.id)).map((r) => r.id);
  const expected = new Set(rows.map((r) => r.id)).size;
  const actual = s.count();
  if (missing.length) throw new Error(`migrate: ${missing.length} id(s) did not round-trip, e.g. ${missing.slice(0, 3).join(", ")}`);
  if (actual < expected) throw new Error(`migrate: expected at least ${expected} rows in the database, found ${actual}`);

  let renamedTo: string | null = null;
  if (!opts.dryRun) {
    renamedTo = path.join(path.dirname(source), `opportunities.migrated-${new Date().toISOString().slice(0, 10)}.json`);
    await fs.rename(source, renamedTo);
  }
  await writeDigest();
  return {
    source,
    db: s.path,
    read: rows.length,
    unique_ids: expected,
    rows_in_db: actual,
    by_status: s.countsByStatus(),
    dry_run: !!opts.dryRun,
    renamed_to: renamedTo,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function briefCounts(): { line: string; top: string | null } {
  const s = store();
  const counts = s.countsByStatus();
  const n = (k: string) => counts[k] ?? 0;
  const line = `${s.count()} pipeline | ${n("shortlisted")} queue | ${n("parked")} parked | ${n("awaiting_approval")} awaiting | ${n("manual_action_needed")} manual | ${n("submitted")} submitted`;
  const tray = s.list({ status: "awaiting_approval" }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  return { line, top: tray ? `${tray.score} ${String(tray.title).slice(0, 40)} @ ${tray.company}` : null };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    else positional.push(argv[i]);
  }
  if (args.db) process.env.PIPELINE_DB = args.db;

  if (cmd === "get") {
    const id = positional[0] ?? args.id;
    if (id && !args.status) {
      const row = await get(id);
      if (!row) { console.error(`role not found: ${id}`); process.exit(1); }
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    let out = await load();
    if (id) out = out.filter((r) => r.id === id);
    if (args.status) out = out.filter((r) => r.status === args.status);
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === "list") {
    const rows = await list({ status: args.status, channel: args.channel, since: args.since });
    if (args.format === "table") {
      for (const r of rows) console.log(`${r.id}\t${r.status}\t${r.score ?? ""}\t${r.title} @ ${r.company}`);
    } else {
      console.log(JSON.stringify(rows, null, 2));
    }
  } else if (cmd === "upsert") {
    console.log(JSON.stringify(await upsert(JSON.parse(args.json)), null, 2));
  } else if (cmd === "set-status") {
    console.log(JSON.stringify(await setStatus(args.id, args.status as PipelineStatus, args.reason), null, 2));
  } else if (cmd === "patch") {
    console.log(JSON.stringify(await patch(args.id, JSON.parse(args.json), args.actor ?? "cli", args.reason), null, 2));
  } else if (cmd === "remove") {
    const ids = (args.id ?? positional.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
    console.log(JSON.stringify(await remove(ids, args.actor ?? "cli", args.reason ?? "removed from the CLI"), null, 2));
  } else if (cmd === "dedup") {
    console.log(JSON.stringify(await dedup(), null, 2));
  } else if (cmd === "summary") {
    if (args.brief === "true") {
      const { line, top } = briefCounts();
      console.log(line);
      if (args.top === "true" && top) console.log(top);
      return;
    }
    const s = store();
    const total = s.count();
    console.log(JSON.stringify({ total, byStatus: s.countsByStatus() }, null, 2));
    // Refresh the human digest from the same read, but never let a summary run
    // against an empty or not-yet-migrated database overwrite a real digest.
    if (total > 0) await writeDigest();
  } else if (cmd === "export") {
    console.log(JSON.stringify(await exportJson(args.out), null, 2));
  } else if (cmd === "migrate") {
    console.log(JSON.stringify(await migrate({ from: args.from, dryRun: args["dry-run"] === "true", force: args.force === "true" }), null, 2));
  } else {
    console.error(
      "Usage: tsx tools/pipeline.ts (get <id> | list | upsert | set-status | patch | remove | dedup | summary [--brief] | export | migrate) " +
        "[--id ...] [--status ...] [--channel ...] [--json '{...}'] [--format json|table] [--out path] [--from path] [--dry-run] [--db path]",
    );
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
