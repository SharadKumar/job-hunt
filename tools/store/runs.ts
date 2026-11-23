#!/usr/bin/env tsx
/**
 * runs.ts: the journal as run records (plan F5 `run`, F22).
 *
 * File mode appends to state/journal/<date>.md as the harness always has.
 * Twenty mode appends the same text to the local log
 * (state/logs/journal/<date>.md, a log, never person-facing) and upserts one
 * `run` record per day and kind, whose summary is the day's journal so far.
 * The person reads the run record in Twenty.
 *
 *   tsx tools/store/runs.ts append --from <file> [--date YYYY-MM-DD] [--kind DAILY]
 *   tsx tools/store/runs.ts append --text "<markdown>"
 *
 * Prints one JSON object.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { isTwentyStore } from "./documents.ts";
import { journalPath } from "./paths.ts";

export type RunRecord = {
  kind?: "DAILY" | "HUNT" | "PREPARE" | "SUBMIT" | "INTAKE" | "OTHER";
  name?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  sentCount?: number | null;
  escalationCount?: number | null;
  summary?: string | null;
  lettersSentUnattended?: string | null;
};

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

async function caller(call?: Call): Promise<Call> {
  if (call) return call;
  const { connect } = await import("../twenty/records.ts");
  return connect();
}

/** The stable run record id for one key, so re-runs update instead of duplicating. */
export async function runRecordId(key: string): Promise<string> {
  const { uuid5 } = await import("./twenty-backend.ts");
  return uuid5(`run:${key}`);
}

/** Create or update the run record for `key` (Twenty mode only). */
export async function upsertRun(key: string, run: RunRecord, opts: { call?: Call } = {}): Promise<{ id: string }> {
  const call = await caller(opts.call);
  const id = await runRecordId(key);
  const body: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(run)) if (v !== undefined) body[k] = v;
  await call("POST", "/rest/batch/runs?upsert=true", [body]);
  return { id };
}

const localDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * Append markdown to the day's journal. Returns the local file written and,
 * in Twenty mode, the run record id.
 */
export async function appendJournal(text: string, opts: { date?: string; kind?: RunRecord["kind"]; call?: Call } = {}): Promise<{ file: string; runId?: string }> {
  const date = opts.date ?? localDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date ${date}`);
  const file = journalPath(`${date}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text.endsWith("\n") ? text : `${text}\n`);
  if (!isTwentyStore()) return { file };
  const summary = await fs.readFile(file, "utf8");
  const kind = opts.kind ?? "DAILY";
  const { id } = await upsertRun(`journal:${kind}:${date}`, { kind, name: `Journal ${date}`, summary }, { call: opts.call });
  return { file, runId: id };
}

async function cli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd !== "append") {
    console.log(JSON.stringify({ ok: false, error: "usage: runs.ts append (--from <file> | --text <markdown>) [--date YYYY-MM-DD] [--kind DAILY]" }));
    return 2;
  }
  const from = flag("--from");
  const text = from ? await fs.readFile(from, "utf8") : flag("--text");
  if (!text) { console.log(JSON.stringify({ ok: false, error: "nothing to append" })); return 2; }
  const r = await appendJournal(text, { date: flag("--date"), kind: flag("--kind") as RunRecord["kind"] });
  console.log(JSON.stringify({ ok: true, store: isTwentyStore() ? "twenty" : "sqlite", ...r }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 300) }));
    process.exit(1);
  });
}
