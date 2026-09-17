#!/usr/bin/env tsx
/**
 * pipeline.ts — CRUD + status transitions for state/pipeline/opportunities.json.
 *
 * Single source of truth for every opportunity's status, score, draft path, and
 * submission outcome. Anything mutating opportunities MUST go through this module
 * so we have one place enforcing invariants (status transitions, dedup,
 * required fields per status).
 *
 * CLI:
 *   tsx tools/pipeline.ts get [--id <opportunity-id>] [--status <status>]
 *   tsx tools/pipeline.ts upsert --json '{...}'
 *   tsx tools/pipeline.ts set-status --id <opportunity-id> --status <status> [--reason "..."]
 *   tsx tools/pipeline.ts dedup
 *   tsx tools/pipeline.ts summary
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { repoPath } from "./repo-root.ts";
import { log as auditLog, checkDuplicate, type AuditEventType } from "./audit.ts";
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

const PIPELINE_PATH = repoPath("state/pipeline/opportunities.json");
const PIPELINE_MD_PATH = repoPath("state/pipeline/opportunities.md");

const VALID_TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
  discovered: ["shortlisted", "parked", "awaiting_external", "rejected", "manual_action_needed"],
  awaiting_external: ["shortlisted", "rejected", "withdrawn"],
  shortlisted: ["drafted", "parked", "rejected", "withdrawn"],
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

export async function load(): Promise<Opportunity[]> {
  try {
    const txt = await fs.readFile(PIPELINE_PATH, "utf8");
    return JSON.parse(txt) as Opportunity[];
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Atomic write: stage to a sibling temp file, fsync-free rename into place.
 * `fs.rename` is atomic on POSIX, so a crash mid-write can never leave a
 * half-written or truncated target — readers see either the old file or the
 * complete new one. Used for both the JSON and its human digest so the pair
 * can't drift if the process dies between the two writes.
 */
async function writeAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

export async function save(roles: Opportunity[]): Promise<void> {
  await fs.mkdir(path.dirname(PIPELINE_PATH), { recursive: true });
  await writeAtomic(PIPELINE_PATH, JSON.stringify(roles, null, 2));
  await writeHumanDigest(roles);
}

async function writeHumanDigest(roles: Opportunity[]): Promise<void> {
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
  await writeAtomic(PIPELINE_MD_PATH, lines.join("\n"));
}

export async function upsert(opportunity: Partial<Opportunity> & { channel: string; url: string; title: string; company: string }): Promise<Opportunity> {
  const all = await load();
  const id = opportunity.id ?? opportunityIdFor(opportunity.channel, opportunity.url);
  const existing = all.find((r) => r.id === id);
  const now = new Date().toISOString();
  if (existing) {
    // Channel refreshes always describe their results as `discovered`. Treat
    // that as the insertion default, never as permission to rewind an existing
    // workflow. Status transitions and history are owned by setStatus().
    const { status: _status, history: _history, ...refreshFields } = opportunity;
    Object.assign(existing, refreshFields, { id });
    await save(all);
    return existing;
  }

  // Cross-channel dedup check: have we already acted on this company+role-family
  // in the last 60 days? If so, log a duplicate_detected event so the opportunity-finder
  // can decide whether to merge or skip. We still insert here (so the user can
  // see both occurrences), but the audit trail flags it.
  const dup = await checkDuplicate(opportunity.company, opportunity.title, 60);
  if (dup.duplicate) {
    await auditLog({
      event_type: "duplicate_detected",
      role_id: id,
      actor: "pipeline.upsert",
      channel: opportunity.channel,
      details: {
        company: opportunity.company,
        title: opportunity.title,
        existing_role_ids: dup.matches.map((m) => m.role_id),
        existing_statuses: dup.matches.map((m) => m.status),
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
  all.push(next);
  await save(all);

  await auditLog({
    event_type: STATUS_TO_EVENT[next.status] ?? "discovered",
    role_id: id,
    actor: "pipeline.upsert",
    channel: opportunity.channel,
    details: { company: opportunity.company, title: opportunity.title, score: next.score, duplicate_of: dup.matches.map((m) => m.role_id) },
    provenance: { url: opportunity.url, channel: opportunity.channel },
  });

  return next;
}

export async function setStatus(id: string, next: PipelineStatus, reason?: string, extras?: { contact?: any; details?: Record<string, unknown>; actor?: string }): Promise<Opportunity> {
  const all = await load();
  const role = all.find((r) => r.id === id);
  if (!role) throw new Error(`role not found: ${id}`);
  const allowed = VALID_TRANSITIONS[role.status] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`invalid transition ${role.status} → ${next} (allowed: ${allowed.join(", ") || "none"})`);
  }
  const from = role.status;
  role.history.push({ at: new Date().toISOString(), from, to: next, reason });
  role.status = next;
  if (next === "submitted" && !role.submittedAt) role.submittedAt = new Date().toISOString();
  if (next === "responded" && !role.responseAt) role.responseAt = new Date().toISOString();
  await save(all);

  await auditLog({
    event_type: STATUS_TO_EVENT[next] ?? "discovered",
    role_id: id,
    actor: extras?.actor ?? "pipeline.setStatus",
    channel: role.channel,
    details: { company: role.company, title: role.title, from, to: next, reason, ...(extras?.details ?? {}) },
    contact: extras?.contact ?? null,
    provenance: { url: role.url, channel: role.channel },
  });

  return role;
}

export async function dedup(): Promise<{ removed: number }> {
  const all = await load();
  const byId = new Map<string, Opportunity>();
  for (const r of all) {
    if (!byId.has(r.id)) byId.set(r.id, r);
    else {
      // Keep the newer/longer history entry
      const a = byId.get(r.id)!;
      const merged = a.history.length >= r.history.length ? a : r;
      byId.set(r.id, merged);
    }
  }
  const before = all.length;
  await save([...byId.values()]);
  return { removed: before - byId.size };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  if (cmd === "get") {
    const all = await load();
    let out = all;
    if (args.id) out = out.filter((r) => r.id === args.id);
    if (args.status) out = out.filter((r) => r.status === args.status);
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === "upsert") {
    const role = JSON.parse(args.json);
    const r = await upsert(role);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "set-status") {
    const r = await setStatus(args.id, args.status as PipelineStatus, args.reason);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "dedup") {
    console.log(JSON.stringify(await dedup(), null, 2));
  } else if (cmd === "summary") {
    const all = await load();
    const byStatus: Record<string, number> = {};
    for (const r of all) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    console.log(JSON.stringify({ total: all.length, byStatus }, null, 2));
  } else {
    console.error(`Usage: tsx tools/pipeline.ts (get|upsert|set-status|dedup|summary) [--id ...] [--status ...] [--json '{...}']`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
