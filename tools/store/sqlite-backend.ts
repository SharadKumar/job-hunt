/**
 * sqlite-backend.ts — the RowBackend over the local SQLite pipeline store.
 *
 * Every operation runs inside one SQLite transaction, as pipeline.ts did
 * before the backend split, so behaviour is unchanged.
 */

import type { Opportunity } from "../pipeline.ts";
import { store, type ListFilter } from "../pipeline-store.ts";
import { RowMissingError, StatusChangedError, type RowBackend, type RowPatch, type RowUpsert, type Transition } from "./backend.ts";

export function sqliteBackend(): RowBackend {
  return {
    name: "sqlite",
    async has(id) { return store().has(id); },
    async get(id, opts) { return store().get(id, opts); },
    async list(filter: ListFilter = {}) { return store().list(filter); },
    async ids() { return store().ids(); },

    async upsert(ops: RowUpsert[]) {
      const s = store();
      const now = new Date().toISOString();
      return s.transaction(() => ops.map((op) => {
        if (op.kind === "insert") { s.insert(op.row, now); return op.row; }
        const row = s.updateFields(op.id, op.fields, now);
        if (!row) throw new RowMissingError(op.id);
        return row;
      }));
    },

    async patch(entries: RowPatch[]) {
      const s = store();
      const now = new Date().toISOString();
      return s.transaction(() => entries.map(({ id, fields, history }) => {
        const row = s.updateFields(id, fields, now);
        if (!row) throw new RowMissingError(id);
        const entry = history(row);
        s.appendHistory(id, entry);
        row.history = [...row.history, entry];
        return row;
      }));
    },

    async transition(t: Transition) {
      const s = store();
      // BEGIN IMMEDIATE precedes the status read, so two runs can't both claim a row.
      return s.transaction(() => {
        const role = s.get(t.id);
        if (!role) throw new RowMissingError(t.id);
        if (role.status !== t.from) throw new StatusChangedError(t.id, t.from, role.status);
        const row = s.setStatusColumn(t.id, t.to, t.extraFields, t.history.at)!;
        s.appendHistory(t.id, t.history);
        row.history = [...row.history, t.history];
        return row;
      });
    },

    async remove(ids, history) {
      const s = store();
      const removed: Opportunity[] = [];
      s.transaction(() => {
        for (const id of ids) {
          const role = s.get(id, { withDescription: false });
          if (!role) continue;
          s.appendHistory(id, history(role));
          s.remove([id]);
          removed.push(role);
        }
      });
      return removed;
    },

    async replaceAll(rows) {
      const s = store();
      s.transaction(() => {
        const keep = new Set(rows.map((r) => r.id));
        const stale = s.ids().filter((id) => !keep.has(id));
        if (stale.length) s.remove(stale);
        const now = new Date().toISOString();
        for (const role of rows) s.replaceRow(role, now);
      });
    },
  };
}
