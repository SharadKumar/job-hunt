#!/usr/bin/env tsx
/**
 * migrate.ts: the one-time move of the harness's person-facing data into
 * Twenty (plan F12, with F18's contact minimisation). It is not a sync.
 *
 *   tsx tools/twenty/migrate.ts --dry-run             # counts per object from the files, writes nothing
 *   tsx tools/twenty/migrate.ts --dry-run --target    # also counts what the target still lacks (reads only)
 *   tsx tools/twenty/migrate.ts --apply               # creates the missing records in TWENTY_API_URL
 *   tsx tools/twenty/migrate.ts --apply --confirm-cutover   # required for any non-local target
 *
 * What moves (tools/twenty/migrate-plan.ts reads the sources):
 *   - openings: pipeline rows from SQLite in scope (below);
 *   - applications: one per archived opening in scope, with its CV PDF and
 *     DOCX, letter (markdown; the harness has no letter renderer),
 *     screenshots and checklist attached; briefs and debriefs become Notes;
 *   - documents and their first revisions: one per profile file kind;
 *   - screening questions, keyword questions, positionings (baseline PDF and
 *     DOCX attached), runs (latest 50 daily summaries);
 *   - people: contacts minimised to name, role title, company, email and
 *     LinkedIn URL, deduplicated by email or LinkedIn URL;
 *   - open escalations, through tools/twenty/escalations.ts (--apply only).
 *
 * Opening scope (owner, Q4): every row a person or a package touched. That is
 * every row not rejected or withdrawn, plus rejected or withdrawn rows that
 * reached a drafted-or-later status, were saved by the person, were parked by
 * the person, or have a package archive. Auto-rejected rows stay in SQLite.
 *
 * Rules: ids are uuid5("<object>:<sourceId>"); create missing records only,
 * never overwrite, never delete; every app record carries migratedAt so
 * workflows skip it (Twenty's standard person, note and attachment objects
 * have no such field: their stable ids keep the run idempotent); a second
 * run creates 0. --apply refuses while TWENTY_API_URL is unset.
 *
 * Cutover guard (F18): before --apply against a target that is not localhost,
 * the operator takes the encrypted pg_dump and then writes
 * state/twenty/last-backup.json, for example
 *   { "at": "2026-11-23T01:00:00Z", "file": "<encrypted dump name>" }
 * The apply refuses without --confirm-cutover, and refuses unless that marker
 * exists with an `at` under 24 hours old.
 *
 * Prints one JSON object: counts per object and skipped reasons, never row
 * contents.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Opportunity } from "../pipeline.ts";
import { repoPath } from "../repo-root.ts";
import { openingId } from "../store/twenty-backend.ts";
import { buildPlan, type MigrationPlan, type PlannedRecord } from "./migrate-plan.ts";
import type { TwentyCall } from "./records.ts";

const TOUCHED = new Set([
  "drafted", "awaiting_approval", "approved", "submission_pending", "submitted",
  "responded", "interview", "offered", "won", "manual_action_needed",
]);

export function inScope(row: Opportunity, hasArchive: (id: string) => boolean): { keep: boolean; why: string } {
  if (row.status !== "rejected" && row.status !== "withdrawn") return { keep: true, why: "active" };
  if ((row.history ?? []).some((h) => TOUCHED.has(String(h.to)))) return { keep: true, why: "reached a package status" };
  if (row.userSaved) return { keep: true, why: "saved by the person" };
  if (row.parkedBy === "user") return { keep: true, why: "parked by the person" };
  if (hasArchive(row.id)) return { keep: true, why: "has a package archive" };
  return { keep: false, why: "auto-rejected, never touched" };
}

export const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** Why an apply against this URL must not run, or null when it may. */
export async function cutoverRefusal(url: string, confirmCutover: boolean, now = Date.now(), markerPath = repoPath("state", "twenty", "last-backup.json")): Promise<string | null> {
  if (isLocalUrl(url)) return null;
  if (!confirmCutover) return "a non-local target needs --confirm-cutover (plan F12 cutover, checkpoint C3)";
  let marker: any;
  try { marker = JSON.parse(await fs.readFile(markerPath, "utf8")); } catch { return "no backup marker: take the encrypted pg_dump, then write state/twenty/last-backup.json with its time (F18)"; }
  const at = Date.parse(String(marker?.at ?? ""));
  if (Number.isNaN(at)) return "the backup marker has no readable `at` time";
  if (at > now + 5 * 60 * 1000) return "the backup marker's time is in the future";
  if (now - at > BACKUP_MAX_AGE_MS) return "the last backup is more than 24 hours old; take a fresh encrypted dump first";
  return null;
}

/** Per-object counts of a plan, for the dry-run report. */
export function planCounts(openings: number, plan: MigrationPlan): Record<string, number> {
  return {
    opening: openings,
    company: plan.companies.length,
    positioning: plan.positionings.length,
    document: plan.documents.length,
    documentRevision: plan.documentRevisions.length,
    application: plan.applications.length,
    screeningQuestion: plan.screeningQuestions.length,
    keywordQuestion: plan.keywordQuestions.length,
    run: plan.runs.length,
    person: plan.people.length,
    note: plan.notes.length,
    attachment: plan.attachments.length,
  };
}

type Outcome = { planned: number; created: number; already_present: number };

async function missing(call: TwentyCall, plural: string, ids: string[]): Promise<Set<string>> {
  const { getByIds } = await import("./records.ts");
  const have = await getByIds(call, plural, [...new Set(ids)]);
  return new Set(ids.filter((id) => !have.has(id)));
}

async function createMissing(call: TwentyCall, plural: string, records: PlannedRecord[], write: boolean): Promise<Outcome> {
  const lacking = await missing(call, plural, records.map((r) => r.id));
  const todo = records.filter((r) => lacking.has(r.id));
  if (write) for (let i = 0; i < todo.length; i += 60) await call("POST", `/rest/batch/${plural}`, todo.slice(i, i + 60).map((r) => r.record));
  return { planned: records.length, created: todo.length, already_present: records.length - todo.length };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const checkTarget = apply || argv.includes("--target");
  const confirmCutover = argv.includes("--confirm-cutover");
  // The migration's source is always the SQLite store, whatever the run uses.
  process.env.HARNESS_STORE = "sqlite";

  if (apply && !process.env.TWENTY_API_URL) {
    console.log(JSON.stringify({ ok: false, error: "--apply needs TWENTY_API_URL and TWENTY_API_KEY (the target workspace)" }));
    return 2;
  }
  if (apply) {
    const refusal = await cutoverRefusal(process.env.TWENTY_API_URL!, confirmCutover);
    if (refusal) { console.log(JSON.stringify({ ok: false, error: refusal })); return 2; }
  }

  const { sqliteBackend } = await import("../store/sqlite-backend.ts");
  const rows = await sqliteBackend().list({ withDescription: apply });
  const archive = repoPath("state", "pipeline", "archive");
  const hasArchive = (id: string) => existsSync(path.join(archive, id));
  const counts: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const keep: Opportunity[] = [];
  for (const row of rows) {
    const v = inScope(row, hasArchive);
    counts[v.why] = (counts[v.why] ?? 0) + 1;
    if (v.keep) { keep.push(row); byStatus[row.status] = (byStatus[row.status] ?? 0) + 1; }
  }
  const migratedAt = new Date().toISOString();
  const plan = await buildPlan(keep, migratedAt);

  const report: Record<string, unknown> = {
    mode: apply ? "apply" : "dry-run",
    source_rows: rows.length,
    in_scope: keep.length,
    by_reason: counts,
    in_scope_by_status: byStatus,
    objects: planCounts(keep.length, plan),
    skipped: plan.skipped,
  };

  if (!checkTarget) {
    // Escalations come from the day's summary; count them without writing.
    try {
      const { buildSummary } = await import("../daily-summary.ts");
      const { loadLocale } = await import("../profile.ts");
      const { timezone } = await loadLocale();
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      (report.objects as Record<string, number>).escalation = (await buildSummary(date)).escalations.length;
    } catch (e: any) {
      report.escalation_error = String(e?.message ?? e).slice(0, 200);
    }
    console.log(JSON.stringify({ ok: true, ...report }));
    return 0;
  }

  const { connect } = await import("./records.ts");
  const call = await connect();
  const results: Record<string, Outcome> = {};

  // Companies first: people point at them.
  results.company = await createMissing(call, "companies", plan.companies, apply);

  // Openings through the store layer, which owns their projection.
  const { twentyBackend } = await import("../store/twenty-backend.ts");
  const target = await twentyBackend();
  const openingIds = keep.map((r) => openingId(r.id));
  const lacking = await missing(call, "openings", openingIds);
  const ops = keep.filter((r) => lacking.has(openingId(r.id))).map((row) => ({ kind: "insert" as const, row: { ...row, migratedAt } as Opportunity }));
  if (apply) for (let i = 0; i < ops.length; i += 60) await target.upsert(ops.slice(i, i + 60));
  results.opening = { planned: keep.length, created: ops.length, already_present: keep.length - ops.length };

  results.positioning = await createMissing(call, "positionings", plan.positionings, apply);
  results.document = await createMissing(call, "documents", plan.documents, apply);
  results.documentRevision = await createMissing(call, "documentRevisions", plan.documentRevisions, apply);
  results.application = await createMissing(call, "applications", plan.applications, apply);
  results.screeningQuestion = await createMissing(call, "screeningQuestions", plan.screeningQuestions, apply);
  results.keywordQuestion = await createMissing(call, "keywordQuestions", plan.keywordQuestions, apply);
  results.run = await createMissing(call, "runs", plan.runs, apply);
  results.person = await createMissing(call, "people", plan.people, apply);

  // Notes and their link to the opening.
  const noteLacking = await missing(call, "notes", plan.notes.map((n) => n.id));
  const notes = plan.notes.filter((n) => noteLacking.has(n.id));
  if (apply) {
    for (const n of notes) {
      await call("POST", "/rest/notes", { id: n.id, title: n.title, bodyV2: { markdown: n.markdown, blocknote: null } });
      await call("POST", "/rest/noteTargets", { id: n.targetId, noteId: n.id, targetOpeningId: n.targetOpeningId });
    }
  }
  results.note = { planned: plan.notes.length, created: notes.length, already_present: plan.notes.length - notes.length };

  // Files last: their parent records now exist.
  const attLacking = await missing(call, "attachments", plan.attachments.map((a) => a.id));
  const files = plan.attachments.filter((a) => attLacking.has(a.id));
  // One bad file (Twenty checks content against the extension) must not stop
  // the rest; failures are counted by reason, the run exits 1, and the next
  // run retries them because their attachment records still do not exist.
  const uploadFailures: Record<string, number> = {};
  let uploaded = 0;
  if (apply && files.length) {
    const { attachmentFileFieldId, uploadAttachment } = await import("./files.ts");
    const fieldId = await attachmentFileFieldId(call);
    for (const a of files) {
      try {
        await uploadAttachment(call, fieldId, a);
        uploaded++;
      } catch (e: any) {
        const reason = String(e?.message ?? e).replace(/'[^']*'/g, "'?'").slice(0, 120);
        uploadFailures[reason] = (uploadFailures[reason] ?? 0) + 1;
      }
    }
  }
  results.attachment = { planned: plan.attachments.length, created: apply ? uploaded : files.length, already_present: plan.attachments.length - files.length };

  // Open escalations: the sync tool owns them; the migration stamps its creates.
  let escalationError: string | null = null;
  try {
    const { syncEscalations } = await import("./escalations.ts");
    const { buildSummary } = await import("../daily-summary.ts");
    const { loadLocale } = await import("../profile.ts");
    const { timezone } = await loadLocale();
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const summary = await buildSummary(date);
    const r = await syncEscalations(call, summary.escalations, { notifyMemberId: null, dryRun: !apply, createFields: { migratedAt } });
    results.escalation = { planned: r.open, created: r.created, already_present: r.open - r.created };
  } catch (e: any) {
    escalationError = String(e?.message ?? e).slice(0, 200);
  }

  const created = Object.values(results).reduce((n, r) => n + r.created, 0);
  const failed = Object.values(uploadFailures).reduce((n, v) => n + v, 0);
  const ok = escalationError == null && failed === 0;
  console.log(JSON.stringify({ ok, ...report, results, created, ...(failed ? { attachment_failures: uploadFailures } : {}), ...(escalationError ? { escalation_error: escalationError } : {}) }));
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
