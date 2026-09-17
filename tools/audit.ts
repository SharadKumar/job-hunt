#!/usr/bin/env tsx
/**
 * audit.ts — append-only event log for the harness, plus a cross-channel
 * dedup index. Every meaningful state change gets logged here, regardless
 * of which subagent or tool triggered it. The log is the legal-quality
 * answer to "did I apply to this role / contact this recruiter / when /
 * how?" — opportunities.json's per-role history is a fast read; the audit
 * log is the durable record.
 *
 * Storage:
 *   state/audit/audit-log.jsonl    — one JSON object per line, append-only
 *   state/audit/dedup-index.json   — { fingerprint → [{ role_id, ts, status }] }
 *   state/audit/contacts.jsonl     — per-contact event stream (separate from roles)
 *
 * Events shape:
 *   {
 *     ts: ISO-8601,
 *     event_type: discovered | scored | drafted | approved | submitted |
 *                 response_received | interview_scheduled | rejected |
 *                 withdrawn | manual_action_completed | dedup_skipped |
 *                 contact_recorded | follow_up_sent | screening_q_paused |
 *                 ...,
 *     role_id: string | null,
 *     actor: 'opportunity-finder' | 'apply-orchestration' | 'submission-runner' |
 *            'outreach-drafter' | 'state-syncer' | 'user' | 'manual',
 *     channel: string | null,
 *     details: { ... event-type specific ... },
 *     contact: { name, email, phone, linkedin_url, role_title, company } | null,
 *     provenance: { url, channel, source_pipeline_id } | null,
 *   }
 *
 * Dedup fingerprint:
 *   `${normalised_company}::${role_family}` — channel-agnostic. So
 *   "Senior Solutions Architect at DXC Technology" via Seek dedups
 *   against the same role posted on LinkedIn.
 *
 * CLI:
 *   tsx tools/audit.ts log --json '{...event...}'
 *   tsx tools/audit.ts query [--type submitted] [--since 7d] [--opportunity-id <id>] [--company "<name>"]
 *   tsx tools/audit.ts check-dup --company "<co>" --title "<title>" --within-days 60
 *   tsx tools/audit.ts summary [--days 30]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.ts";

// Override with AUDIT_DIR for test isolation (so tests never pollute the real
// append-only audit trail). Defaults to the production location.
const AUDIT_DIR = process.env.AUDIT_DIR || repoPath("state/audit");
const LOG_PATH = path.join(AUDIT_DIR, "audit-log.jsonl");
const DEDUP_PATH = path.join(AUDIT_DIR, "dedup-index.json");
const CONTACTS_PATH = path.join(AUDIT_DIR, "contacts.jsonl");

export type AuditEventType =
  | "policy_change"
  | "discovered" | "scored" | "drafted" | "approved" | "rejected"
  | "submission_pending" | "submitted" | "submission_failed" | "manual_queued"
  | "manual_action_completed" | "response_received" | "interview_scheduled"
  | "interview_completed" | "offered" | "won" | "withdrawn"
  | "follow_up_drafted" | "follow_up_sent_externally"
  | "contact_recorded" | "screening_q_paused" | "screening_q_answered"
  | "dedup_skipped" | "duplicate_detected"
  | "voice_check_failed" | "slop_check_failed" | "lint_failed"
  | "channel_login_expired" | "channel_search_failed"
  | "policy_kill_switch_blocked" | "daily_cap_hit" | "validation_gate_failed";

export type Contact = {
  name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  role_title?: string;        // e.g. "Recruiter at Hays", "Hiring Manager"
  company?: string;
};

export type AuditEvent = {
  ts: string;
  event_type: AuditEventType;
  role_id: string | null;
  actor: string;                                  // agent / script name
  channel?: string | null;
  details?: Record<string, unknown>;
  contact?: Contact | null;
  provenance?: { url?: string; channel?: string; source_pipeline_id?: string } | null;
};

function normaliseCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|inc|llc|gmbh|sa|corp|corporation|group|holdings|plc)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/** Reduce a free-text role title to a short family slug. */
function roleFamily(title: string): string {
  const t = title.toLowerCase();
  if (/\b(director|head of)\b/.test(t)) return "director";
  if (/principal/.test(t)) return "principal";
  if (/\b(architect|enterprise architect|solutions architect|solution architect)\b/.test(t)) return "architect";
  if (/\b(engineering lead|tech lead|delivery manager|delivery lead|engineering manager)\b/.test(t)) return "lead";
  if (/\b(senior|staff)\b/.test(t) && /\b(engineer|developer)\b/.test(t)) return "senior-eng";
  if (/\b(consultant|advisor|advisory)\b/.test(t)) return "consultant";
  if (/\b(business analyst|product manager|product owner)\b/.test(t)) return "product";
  return "other";
}

export function fingerprintFor(company: string, title: string): string {
  return `${normaliseCompany(company)}::${roleFamily(title)}`;
}

export async function log(event: Omit<AuditEvent, "ts"> & { ts?: string }): Promise<void> {
  await logMany([event]);
}

/** Events that create a "we acted on this role" trail and so feed the dedup index. */
const TRAILING_EVENTS: AuditEventType[] = ["discovered", "drafted", "approved", "submitted", "manual_action_completed", "response_received", "interview_scheduled", "interview_completed", "offered"];

/**
 * Batched twin of log(): one append for the log, one rewrite of the dedup
 * index, one append for contacts. A channel hunt logs hundreds of `discovered`
 * events at once; rewriting the whole dedup index per event made that
 * quadratic and dominated the ingest.
 */
export async function logMany(events: (Omit<AuditEvent, "ts"> & { ts?: string })[]): Promise<void> {
  if (!events.length) return;
  await fs.mkdir(AUDIT_DIR, { recursive: true });
  const stamped: AuditEvent[] = events.map((event) => ({ ts: event.ts ?? new Date().toISOString(), ...event }));
  await fs.appendFile(LOG_PATH, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n");

  let idx: Awaited<ReturnType<typeof loadDedupIndex>> | null = null;
  for (const e of stamped) {
    if (!TRAILING_EVENTS.includes(e.event_type) || !e.role_id) continue;
    const company = (e.details?.company as string) ?? (e.contact?.company as string) ?? "";
    const title = (e.details?.title as string) ?? "";
    if (!company || !title) continue;
    idx ??= await loadDedupIndex();
    const fp = fingerprintFor(company, title);
    idx[fp] = idx[fp] ?? [];
    // Only append if not already recorded for this role+event combination
    if (!idx[fp].some((entry) => entry.role_id === e.role_id && entry.status === e.event_type)) {
      idx[fp].push({ role_id: e.role_id, ts: e.ts, status: e.event_type });
    }
  }
  if (idx) await fs.writeFile(DEDUP_PATH, JSON.stringify(idx, null, 2));

  const contacts = stamped.filter((e) => e.contact);
  if (contacts.length) {
    await fs.appendFile(
      CONTACTS_PATH,
      contacts.map((e) => JSON.stringify({ ts: e.ts, role_id: e.role_id, contact: e.contact, event_type: e.event_type, actor: e.actor })).join("\n") + "\n",
    );
  }
}

export async function loadDedupIndex(): Promise<Record<string, { role_id: string; ts: string; status: string }[]>> {
  try { return JSON.parse(await fs.readFile(DEDUP_PATH, "utf8")); } catch { return {}; }
}

export async function query(filters: { type?: AuditEventType; sinceISO?: string; role_id?: string; company?: string } = {}): Promise<AuditEvent[]> {
  let text: string;
  try { text = await fs.readFile(LOG_PATH, "utf8"); } catch { return []; }
  const out: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEvent;
      if (filters.type && e.event_type !== filters.type) continue;
      if (filters.sinceISO && e.ts < filters.sinceISO) continue;
      if (filters.role_id && e.role_id !== filters.role_id) continue;
      if (filters.company) {
        const c = (e.details?.company as string) ?? (e.contact?.company as string) ?? "";
        if (!c.toLowerCase().includes(filters.company.toLowerCase())) continue;
      }
      out.push(e);
    } catch {}
  }
  return out;
}

export async function checkDuplicate(company: string, title: string, withinDays = 60): Promise<{ duplicate: boolean; matches: { role_id: string; ts: string; status: string }[] }> {
  const idx = await loadDedupIndex();
  const fp = fingerprintFor(company, title);
  const since = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const matches = (idx[fp] ?? []).filter((m) => m.ts >= since);
  return { duplicate: matches.length > 0, matches };
}

function parseSinceArg(s: string): string {
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) return new Date(s).toISOString();
  const n = Number(m[1]);
  const ms = m[2] === "d" ? n * 86_400_000 : m[2] === "h" ? n * 3_600_000 : n * 60_000;
  return new Date(Date.now() - ms).toISOString();
}

async function summary(days: number): Promise<void> {
  const sinceISO = new Date(Date.now() - days * 86_400_000).toISOString();
  const events = await query({ sinceISO });
  const byType: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  const submitted = events.filter((e) => e.event_type === "submitted");
  const contacts = new Map<string, number>();
  for (const e of events) {
    byType[e.event_type] = (byType[e.event_type] ?? 0) + 1;
    byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;
    if (e.contact?.email) contacts.set(e.contact.email, (contacts.get(e.contact.email) ?? 0) + 1);
  }
  console.log(JSON.stringify({
    days, total_events: events.length,
    by_type: byType, by_actor: byActor,
    submitted_count: submitted.length,
    submitted_companies: [...new Set(submitted.map((e) => (e.details?.company as string) ?? "").filter(Boolean))],
    distinct_contacts: contacts.size,
    top_contacts: [...contacts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([email, n]) => ({ email, events: n })),
  }, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  const a: Record<string, string> = {};
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) a[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
  }
  if (cmd === "log") {
    if (!a.json) { console.error("--json required"); process.exit(2); }
    await log(JSON.parse(a.json));
    console.log("logged");
  } else if (cmd === "query") {
    const events = await query({
      type: a.type as AuditEventType | undefined,
      sinceISO: a.since ? parseSinceArg(a.since) : undefined,
      role_id: a["opportunity-id"],
      company: a.company,
    });
    console.log(JSON.stringify(events, null, 2));
  } else if (cmd === "check-dup") {
    if (!a.company || !a.title) { console.error("--company and --title required"); process.exit(2); }
    const result = await checkDuplicate(a.company, a.title, a["within-days"] ? Number(a["within-days"]) : 60);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.duplicate ? 1 : 0);
  } else if (cmd === "summary") {
    await summary(a.days ? Number(a.days) : 30);
  } else {
    console.error("Usage: tsx tools/audit.ts (log|query|check-dup|summary) [...]");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
