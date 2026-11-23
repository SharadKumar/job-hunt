#!/usr/bin/env tsx
/**
 * preflight.ts — fail closed when the Twenty store can't be reached (plan E9).
 *
 * Runs first in scripts/daily.sh. With HARNESS_STORE=twenty it reads one
 * opening with the Harness key; on any failure it exits 3, and daily.sh then
 * skips every pipeline step and sends, raising one fallback alert. With any
 * other store it passes straight through.
 *
 * Prints one JSON object. Exit 0 ready, 3 unreachable, 2 misconfigured.
 */

import { twentyBackend } from "../store/twenty-backend.ts";

async function main(): Promise<number> {
  const store = (process.env.HARNESS_STORE ?? "sqlite").toLowerCase();
  if (store !== "twenty") {
    console.log(JSON.stringify({ ok: true, store, skipped: "not the Twenty store" }));
    return 0;
  }
  let backend;
  try { backend = await twentyBackend(); } catch (e: any) {
    console.log(JSON.stringify({ ok: false, store, error: String(e?.message ?? e) }));
    return 2;
  }
  try {
    const started = Date.now();
    await backend.list({ status: "approved" });
    console.log(JSON.stringify({ ok: true, store, ms: Date.now() - started }));
    return 0;
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, store, error: `Twenty unreachable: ${String(e?.message ?? e).slice(0, 200)}` }));
    return 3;
  }
}

main().then((code) => process.exit(code));
