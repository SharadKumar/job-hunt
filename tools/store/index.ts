/**
 * index.ts — picks the RowBackend for this process.
 *
 * HARNESS_STORE=sqlite (default) keeps rows in state/pipeline/pipeline.db.
 * HARNESS_STORE=twenty keeps them in the Twenty workspace (tools/store/twenty-backend.ts).
 * Tests can install any backend with useRowBackend().
 */

import type { RowBackend } from "./backend.ts";
import { sqliteBackend } from "./sqlite-backend.ts";

let override: RowBackend | null = null;
let cached: { key: string; backend: RowBackend } | null = null;

export async function rows(): Promise<RowBackend> {
  if (override) return override;
  const key = (process.env.HARNESS_STORE ?? "sqlite").toLowerCase();
  if (cached?.key === key) return cached.backend;
  let backend: RowBackend;
  if (key === "twenty") {
    const { twentyBackend } = await import("./twenty-backend.ts");
    backend = await twentyBackend();
  } else if (key === "sqlite") {
    backend = sqliteBackend();
  } else {
    throw new Error(`unknown HARNESS_STORE=${key} (expected sqlite or twenty)`);
  }
  cached = { key, backend };
  return backend;
}

/** Test hook. Pass null to go back to HARNESS_STORE. */
export function useRowBackend(backend: RowBackend | null): void {
  override = backend;
}
