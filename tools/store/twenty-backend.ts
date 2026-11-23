/**
 * twenty-backend.ts — the RowBackend over a Twenty workspace (plan F10).
 *
 * Filled in once the app's `opening` object lands (F5). Until then selecting
 * HARNESS_STORE=twenty fails loudly instead of silently using another store.
 */

import type { RowBackend } from "./backend.ts";

export async function twentyBackend(): Promise<RowBackend> {
  throw new Error("HARNESS_STORE=twenty is not available yet: the Twenty backend lands with the workspace app (plan F10).");
}
