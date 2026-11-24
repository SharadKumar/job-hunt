/**
 * escalation-hygiene.ts: the rules that close escalations nobody needs any more.
 *
 * Two pure checks, used by tools/twenty/escalations.ts on every sync:
 *   - doneStatus: an opening that is submitted or later, rejected or withdrawn
 *     (expiry closes a row as rejected or withdrawn) needs nothing from the
 *     person, so an escalation on it is resolved;
 *   - planDuplicates: open escalations on openings that are the same role (the
 *     same duplicateGroup, or the same normalised employer and title on two
 *     different channels) keep one, the higher priority then the newest, and
 *     the rest are dismissed as "duplicate of <name>".
 * Neither ever writes a delivery field.
 */

import type { Opportunity } from "../pipeline.ts";
import { fromOpening } from "../store/twenty-backend.ts";

/** Pipeline statuses where the person has nothing left to do on the opening. */
export const DONE_STATUSES = new Set(["submitted", "responded", "interview", "offered", "won", "rejected", "withdrawn"]);

/** The opening's status when it needs nothing from the person, else null. */
export function doneStatus(opening: Record<string, any> | undefined): string | null {
  if (!opening) return null;
  const status = String(fromOpening(opening).status ?? "").toLowerCase();
  return DONE_STATUSES.has(status) ? status : null;
}

export function resolvedReason(status: string): string {
  return `no longer needs you: opening is now ${status}`;
}

export const ABSENT_REASON = "no longer needs you: the daily run no longer raises it";

const LEGAL_SUFFIX = /\b(pty|ltd|limited|inc|llc|plc|corp|corporation|co|australia|au)\b/g;

const tidy = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ");

/** Employer name for matching: case, punctuation and legal suffixes removed. */
export function normaliseEmployer(name?: string | null): string {
  return tidy(name ?? "").replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

export function normaliseTitle(title?: string | null): string {
  return tidy(title ?? "").replace(/\s+/g, " ").trim();
}

const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3 };

/** The parts of an escalation record the merge reads. */
export type OpenEscalation = { id: string; name?: string | null; priority?: string | null; openingId?: string | null; createdAt?: string | null };

export type Dismissal = { id: string; keptId: string; reason: string };

/**
 * Which open escalations to dismiss as duplicates. openings maps an opening
 * record id to its record. Escalations without a known opening are never
 * merged. Every escalation on the kept opening stays open: two escalations on
 * one opening are two different asks.
 */
export function planDuplicates(open: OpenEscalation[], openings: Map<string, Record<string, any>>, opts: { now: string }): Dismissal[] {
  const rows = new Map<string, Opportunity>();
  for (const e of open) {
    if (!e.openingId || rows.has(e.openingId)) continue;
    const rec = openings.get(e.openingId);
    if (rec) rows.set(e.openingId, fromOpening(rec));
  }
  if (rows.size < 2) return [];

  // Union-find over openings.
  const parent = new Map<string, string>([...rows.keys()].map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const byGroup = new Map<string, string>();
  const byName = new Map<string, { id: string; channel: string }[]>();
  for (const [id, row] of rows) {
    const group = (row.duplicateGroup ?? "").trim();
    if (group) {
      const first = byGroup.get(group);
      if (first) join(first, id); else byGroup.set(group, id);
    }
    const employer = normaliseEmployer(row.company);
    const title = normaliseTitle(row.title);
    if (!employer || !title) continue;
    const key = `${employer}|${title}`;
    const seen = byName.get(key) ?? [];
    // A generic title at one employer on one channel can be two real roles;
    // only the same role on another channel counts by name.
    for (const s of seen) if (s.channel !== (row.channel ?? "")) join(s.id, id);
    seen.push({ id, channel: row.channel ?? "" });
    byName.set(key, seen);
  }

  const components = new Map<string, OpenEscalation[]>();
  for (const e of open) {
    if (!e.openingId || !rows.has(e.openingId)) continue;
    const root = find(e.openingId);
    components.set(root, [...(components.get(root) ?? []), e]);
  }

  const out: Dismissal[] = [];
  for (const members of components.values()) {
    if (new Set(members.map((m) => m.openingId)).size < 2) continue;
    const ranked = [...members].sort((a, b) =>
      (PRIORITY_RANK[a.priority ?? ""] ?? 9) - (PRIORITY_RANK[b.priority ?? ""] ?? 9)
      || (b.createdAt ?? opts.now).localeCompare(a.createdAt ?? opts.now)
      || a.id.localeCompare(b.id));
    const kept = ranked[0];
    const keptChannel = rows.get(kept.openingId!)?.channel;
    const label = `${kept.name ?? "another escalation"}${keptChannel ? ` (${keptChannel})` : ""}`;
    for (const m of ranked) {
      if (m.openingId === kept.openingId) continue;
      out.push({ id: m.id, keptId: kept.id, reason: `duplicate of ${label}` });
    }
  }
  return out;
}
