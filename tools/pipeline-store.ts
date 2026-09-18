/**
 * pipeline-store.ts — SQLite storage for the opportunity pipeline.
 *
 * Why: the pipeline used to be one pretty-printed JSON array. Every `upsert()`
 * read and rewrote the whole file, so a channel search that touches 750 cards
 * did 750 full loads and 750 full 7 MB writes (O(n^2) I/O). The row shape and
 * the invariants have not changed; only where the rows live.
 *
 * Layout (state/pipeline/pipeline.db, WAL):
 *   opportunities(id, channel, status, title, company, score, user_saved,
 *                 first_seen_at, updated_at, data)
 *     `data` is the JSON of the Opportunity MINUS `description` and `history`.
 *     The promoted columns exist for filtering and indexing only; `data` stays
 *     the full record, so hydration never has to reconcile two sources.
 *   jd(id, description)              — the bulky raw JD, joined only on demand.
 *   history(seq, id, at, from_status, to_status, reason) — ordered by seq.
 *
 * `tools/pipeline.ts` owns the semantics (valid transitions, dedup audit,
 * digest). This module owns rows and SQL and nothing else.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repoPath } from "./repo-root.ts";
import type { Opportunity, PipelineStatus } from "./pipeline.ts";

export type HistoryEntry = Opportunity["history"][number];

export type ListFilter = {
  status?: PipelineStatus | string;
  channel?: string;
  /** ISO timestamp; keeps rows whose `updated_at` is at or after it. */
  since?: string;
  /** ISO timestamp; keeps rows first seen at or after it. */
  firstSeenSince?: string;
  /** Hydrate the raw JD too. Off by default: it is the bulk of the database. */
  withDescription?: boolean;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS opportunities (
  id            TEXT PRIMARY KEY,
  channel       TEXT,
  status        TEXT,
  title         TEXT,
  company       TEXT,
  score         REAL,
  user_saved    INTEGER,
  first_seen_at TEXT,
  updated_at    TEXT,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_status  ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opportunities_channel ON opportunities(channel);
CREATE INDEX IF NOT EXISTS idx_opportunities_company ON opportunities(company);

CREATE TABLE IF NOT EXISTS jd (
  id          TEXT PRIMARY KEY,
  description TEXT
);

CREATE TABLE IF NOT EXISTS history (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL,
  at          TEXT,
  from_status TEXT,
  to_status   TEXT,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_id ON history(id);
`;

type Row = {
  id: string;
  channel: string | null;
  status: string | null;
  title: string | null;
  company: string | null;
  score: number | null;
  user_saved: number | null;
  first_seen_at: string | null;
  updated_at: string | null;
  data: string;
  description?: string | null;
};

/** Split an Opportunity into the three things the schema stores separately. */
function shred(row: Opportunity): { data: string; description: string | undefined; history: HistoryEntry[] } {
  const { description, history, ...rest } = row;
  return { data: JSON.stringify(rest), description, history: history ?? [] };
}

function hydrate(row: Row, history: HistoryEntry[]): Opportunity {
  const base = JSON.parse(row.data) as Omit<Opportunity, "description" | "history">;
  const out = { ...base, history } as Opportunity;
  if (row.description != null) out.description = row.description;
  return out;
}

function earliestAt(history: HistoryEntry[], fallback: string): string {
  let min: string | undefined;
  for (const h of history) if (h?.at && (min === undefined || h.at < min)) min = h.at;
  return min ?? fallback;
}

export type PipelineStore = ReturnType<typeof openStore>;

/** Default database location, overridable with PIPELINE_DB (tests, dry runs). */
export function defaultDbPath(): string {
  return process.env.PIPELINE_DB ? path.resolve(process.env.PIPELINE_DB) : repoPath("state/pipeline/pipeline.db");
}

export function openStore(dbPath?: string) {
  const file = dbPath ? path.resolve(dbPath) : defaultDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const st = {
    insertRow: db.prepare(
      `INSERT INTO opportunities (id, channel, status, title, company, score, user_saved, first_seen_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel=excluded.channel, status=excluded.status, title=excluded.title,
         company=excluded.company, score=excluded.score, user_saved=excluded.user_saved,
         first_seen_at=excluded.first_seen_at, updated_at=excluded.updated_at, data=excluded.data`,
    ),
    getRow: db.prepare("SELECT * FROM opportunities WHERE id = ?"),
    getRowJd: db.prepare(
      "SELECT o.*, jd.description AS description FROM opportunities o LEFT JOIN jd ON jd.id = o.id WHERE o.id = ?",
    ),
    setJd: db.prepare("INSERT INTO jd (id, description) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET description=excluded.description"),
    delJd: db.prepare("DELETE FROM jd WHERE id = ?"),
    delRow: db.prepare("DELETE FROM opportunities WHERE id = ?"),
    delHistory: db.prepare("DELETE FROM history WHERE id = ?"),
    addHistory: db.prepare("INSERT INTO history (id, at, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?)"),
    historyFor: db.prepare("SELECT at, from_status, to_status, reason FROM history WHERE id = ? ORDER BY seq"),
    historyCount: db.prepare("SELECT COUNT(*) AS n FROM history WHERE id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM opportunities"),
    counts: db.prepare("SELECT status, COUNT(*) AS n FROM opportunities GROUP BY status"),
    allHistory: db.prepare("SELECT id, at, from_status, to_status, reason FROM history ORDER BY seq"),
  };

  let depth = 0;
  function transaction<T>(fn: () => T): T {
    if (depth++ > 0) {
      try { return fn(); } finally { depth--; }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    } finally {
      depth--;
    }
  }

  function historyOf(id: string): HistoryEntry[] {
    return (st.historyFor.all(id) as any[]).map((h) => {
      const entry: HistoryEntry = { at: String(h.at), from: (h.from_status ?? null) as any, to: h.to_status as PipelineStatus };
      if (h.reason != null) entry.reason = String(h.reason);
      return entry;
    });
  }

  function hasRow(id: string): boolean {
    return !!st.getRow.get(id);
  }

  function getOne(id: string, opts: { withDescription?: boolean } = {}): Opportunity | null {
    const withDescription = opts.withDescription !== false;
    const row = (withDescription ? st.getRowJd : st.getRow).get(id) as Row | undefined;
    if (!row) return null;
    return hydrate(row, historyOf(id));
  }

  function writeRow(row: Opportunity, now: string): void {
    const { data, description } = shred(row);
    const existing = st.getRow.get(row.id) as Row | undefined;
    const firstSeen = existing?.first_seen_at ?? earliestAt(row.history ?? [], now);
    st.insertRow.run(
      row.id,
      row.channel ?? null,
      row.status ?? null,
      row.title ?? null,
      row.company ?? null,
      row.score ?? null,
      row.userSaved ? 1 : 0,
      firstSeen,
      now,
      data,
    );
    if (description != null && description !== "") st.setJd.run(row.id, description);
  }

  return {
    path: file,
    db,
    transaction,
    close(): void { db.close(); },

    has: hasRow,

    count(): number {
      return Number((st.count.get() as any).n);
    },

    countsByStatus(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of st.counts.all() as any[]) out[String(r.status)] = Number(r.n);
      return out;
    },

    historyOf,

    get: getOne,

    list(filter: ListFilter = {}): Opportunity[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.status) { where.push("o.status = ?"); params.push(filter.status); }
      if (filter.channel) { where.push("o.channel = ?"); params.push(filter.channel); }
      if (filter.since) { where.push("o.updated_at >= ?"); params.push(filter.since); }
      if (filter.firstSeenSince) { where.push("o.first_seen_at >= ?"); params.push(filter.firstSeenSince); }
      const select = filter.withDescription
        ? "SELECT o.*, jd.description AS description FROM opportunities o LEFT JOIN jd ON jd.id = o.id"
        : "SELECT o.* FROM opportunities o";
      const sql = `${select}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY o.first_seen_at, o.id`;
      const rows = db.prepare(sql).all(...(params as any)) as Row[];
      // One pass over the history table beats one query per row on a 2k pipeline.
      const byId = new Map<string, HistoryEntry[]>();
      for (const h of st.allHistory.all() as any[]) {
        const entry: HistoryEntry = { at: String(h.at), from: (h.from_status ?? null) as any, to: h.to_status as PipelineStatus };
        if (h.reason != null) entry.reason = String(h.reason);
        const list = byId.get(String(h.id));
        if (list) list.push(entry); else byId.set(String(h.id), [entry]);
      }
      return rows.map((r) => hydrate(r, byId.get(r.id) ?? []));
    },

    /** Full insert of a brand new row: replaces any orphaned history for the id. */
    insert(row: Opportunity, now = new Date().toISOString()): Opportunity {
      return transaction(() => {
        st.delHistory.run(row.id);
        writeRow(row, now);
        for (const h of row.history ?? []) st.addHistory.run(row.id, h.at, h.from ?? null, h.to, h.reason ?? null);
        return row;
      });
    },

    /**
     * Merge `fields` into an existing row. Never touches status or history:
     * those are owned by setStatus()/patch() in pipeline.ts.
     */
    updateFields(id: string, fields: Partial<Opportunity>, now = new Date().toISOString()): Opportunity | null {
      return transaction(() => {
        const current = getOne(id, { withDescription: true });
        if (!current) return null;
        const { status: _s, history: _h, ...rest } = fields;
        const merged = { ...current, ...rest, id } as Opportunity;
        writeRow(merged, now);
        if (rest.description === "") st.delJd.run(id);
        return merged;
      });
    },

    /** Write a row exactly as given, including status and history (legacy save()). */
    replaceRow(row: Opportunity, now = new Date().toISOString()): void {
      transaction(() => {
        writeRow(row, now);
        const have = Number((st.historyCount.get(row.id) as any).n);
        const want = (row.history ?? []).length;
        if (have !== want) {
          st.delHistory.run(row.id);
          for (const h of row.history ?? []) st.addHistory.run(row.id, h.at, h.from ?? null, h.to, h.reason ?? null);
        }
      });
    },

    appendHistory(id: string, entry: HistoryEntry): void {
      st.addHistory.run(id, entry.at, entry.from ?? null, entry.to, entry.reason ?? null);
    },

    /** Move a row's status column (the transition itself is validated upstream). */
    setStatusColumn(id: string, status: PipelineStatus, extraFields: Partial<Opportunity> = {}, now = new Date().toISOString()): Opportunity | null {
      return transaction(() => {
        const current = getOne(id, { withDescription: true });
        if (!current) return null;
        const merged = { ...current, ...extraFields, status } as Opportunity;
        writeRow(merged, now);
        return merged;
      });
    },

    remove(ids: string[]): number {
      return transaction(() => {
        let n = 0;
        for (const id of ids) {
          if (!hasRow(id)) continue;
          st.delRow.run(id);
          st.delJd.run(id);
          n++;
        }
        return n;
      });
    },

    ids(): string[] {
      return (db.prepare("SELECT id FROM opportunities").all() as any[]).map((r) => String(r.id));
    },
  };
}

let cached: { path: string; store: PipelineStore } | null = null;

/** Process-wide store for the default (or PIPELINE_DB) database. */
export function store(): PipelineStore {
  const want = defaultDbPath();
  if (cached && cached.path === want) return cached.store;
  cached = { path: want, store: openStore(want) };
  return cached.store;
}

/** Test hook: point the process-wide store at another file. */
export function useStore(dbPath: string): PipelineStore {
  cached = { path: path.resolve(dbPath), store: openStore(dbPath) };
  return cached.store;
}
