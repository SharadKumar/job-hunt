/**
 * backend.ts — where pipeline rows live.
 *
 * tools/pipeline.ts keeps the rules (valid transitions, dedup flags, audit
 * events, the digest). A RowBackend only stores and returns rows, and takes
 * whole operations, so each backend can make them atomic its own way:
 * SQLite with a transaction, Twenty with batch writes and a compare-and-set
 * status update.
 *
 * HARNESS_STORE selects the backend: `sqlite` (default) or `twenty`.
 */

import type { Opportunity, PipelineStatus } from "../pipeline.ts";
import type { HistoryEntry, ListFilter } from "../pipeline-store.ts";

export type RowUpsert =
  | { kind: "insert"; row: Opportunity }
  | { kind: "refresh"; id: string; fields: Partial<Opportunity> };

export type RowPatch = { id: string; fields: Partial<Opportunity>; history: (row: Opportunity) => HistoryEntry };

export type Transition = {
  id: string;
  /** Status the caller read; the write fails if the row has moved since. */
  from: PipelineStatus;
  to: PipelineStatus;
  extraFields: Partial<Opportunity>;
  history: HistoryEntry;
};

export interface RowBackend {
  readonly name: "sqlite" | "twenty" | "memory";
  has(id: string): Promise<boolean>;
  get(id: string, opts?: { withDescription?: boolean }): Promise<Opportunity | null>;
  list(filter?: ListFilter): Promise<Opportunity[]>;
  ids(): Promise<string[]>;
  /** Insert new rows and refresh existing ones; status and history of refreshed rows are untouched. */
  upsert(ops: RowUpsert[]): Promise<Opportunity[]>;
  /** Update fields and append one history entry per row. Throws if a row is missing. */
  patch(entries: RowPatch[]): Promise<Opportunity[]>;
  /**
   * Move one row from `from` to `to` only if it is still at `from`.
   * Throws `StatusChangedError` when it is not, and `RowMissingError` when the row is gone.
   */
  transition(t: Transition): Promise<Opportunity>;
  /** Delete rows, recording the removal in each row's history first. Returns the rows removed. */
  remove(ids: string[], history: (row: Opportunity) => HistoryEntry): Promise<Opportunity[]>;
  /** Legacy whole-set replace (pipeline.save). */
  replaceAll(rows: Opportunity[]): Promise<void>;
}

export class StatusChangedError extends Error {
  constructor(readonly id: string, readonly expected: PipelineStatus, readonly actual: string) {
    super(`status changed from ${expected} to ${actual} before transition`);
  }
}

export class RowMissingError extends Error {
  constructor(readonly id: string) {
    super(`role not found: ${id}`);
  }
}
