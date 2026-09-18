/**
 * tools/ui/jobs.ts - the in-memory job table behind the UI's "Retry now".
 *
 * A retry is `tools/autopilot-submit.ts` for one row: the same gated tool the
 * daily run calls, with the person sitting in front of it (AGENTS.md section 2
 * allows exactly that, and nothing else from a browser click). It takes tens of
 * seconds and it talks to a browser, so the request cannot wait for it. The
 * request starts the child, records it here, and returns a job id; the UI polls
 * `GET /api/jobs/:id` until `finished_at` is set.
 *
 * Deliberately in memory and deliberately small. A job is a live process, not a
 * record: when the server restarts, every job it was watching is gone, and the
 * truth about what happened is in the pipeline row, the archive and the audit
 * log, which the tool itself wrote. Persisting a second copy here would invent
 * a source of truth that could disagree with those three.
 *
 * What is kept per job: the command, the timestamps, the exit code, the last
 * 4 KB of combined output (enough to read a stack trace or an adapter message
 * in the browser), and the tool's final JSON line if it printed one, so the UI
 * can show `outcome` / `reason` rather than make the person parse a log.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

import { repoPath } from "../repo-root.ts";

/** What the UI is shown. `result` is the tool's own final JSON line, if any. */
export type Job = {
  id: string;
  row_id: string;
  command: string;
  args: string[];
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  /** The last 4 KB of stdout and stderr interleaved, oldest bytes dropped. */
  tail: string;
  result: unknown | null;
};

/** How much output the browser is shown. */
const TAIL_BYTES = 4 * 1024;
/** How much is held for the final-JSON scan; a summary line can be long. */
const BUFFER_BYTES = 64 * 1024;
/** How many jobs `listJobs` returns by default, newest first. */
const DEFAULT_LIST = 20;
/** How many jobs are remembered at all, so a long-lived server cannot grow. */
const MAX_JOBS = 200;

type JobRecord = Job & { buffer: string; running: boolean };

const JOBS = new Map<string, JobRecord>();
let sequence = 0;

const snapshot = (job: JobRecord): Job => ({
  id: job.id,
  row_id: job.row_id,
  command: job.command,
  args: [...job.args],
  started_at: job.started_at,
  finished_at: job.finished_at,
  exit_code: job.exit_code,
  tail: job.tail,
  result: job.result,
});

/** Keep the end of the stream: the interesting part of a failure is the last of it. */
function appendCapped(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  return next.length <= cap ? next : next.slice(next.length - cap);
}

/**
 * The tool's own summary. `autopilot-submit` prints one JSON object as its last
 * line; anything else it prints is prose for a log. Scanning from the end means
 * a JSON line inside the noise cannot be mistaken for the verdict.
 */
export function finalJsonLine(output: string): unknown | null {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try { return JSON.parse(line); } catch { /* not the summary; keep looking */ }
  }
  return null;
}

/**
 * How the retry is launched. `HARNESS_AUTOPILOT_BIN` replaces the tool itself
 * (the tests point it at a fake that prints a JSON line); a `.ts` target runs
 * through the repo's tsx, anything else is executed directly, so a fake can be
 * a plain executable script and cost nothing to start.
 */
export function resolveAutopilotCommand(id: string, extraArgs: string[] = []): { command: string; args: string[] } {
  const bin = (process.env.HARNESS_AUTOPILOT_BIN ?? "").trim() || repoPath("tools/autopilot-submit.ts");
  const args = ["--id", id, ...extraArgs];
  if (!bin.endsWith(".ts")) return { command: bin, args };
  const local = repoPath("node_modules/.bin/tsx");
  return fs.existsSync(local) ? { command: local, args: [bin, ...args] } : { command: "npx", args: ["tsx", bin, ...args] };
}

export type StartJobInput = {
  rowId: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Defaults to the server's own env, so PIPELINE_DB and HARNESS_REPO_ROOT carry. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Start a child and return immediately. The child inherits the server's env by
 * default: the UI and the tool must see the same pipeline database and the same
 * repo root, or the retry would run against different state than the row the
 * person clicked.
 */
export function startJob(input: StartJobInput): Job {
  const id = `job-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  const job: JobRecord = {
    id,
    row_id: input.rowId,
    command: input.command,
    args: [...input.args],
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    tail: "",
    result: null,
    buffer: "",
    running: true,
  };
  JOBS.set(id, job);
  prune();

  const child = spawn(input.command, input.args, {
    cwd: input.cwd ?? repoPath("."),
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const absorb = (chunk: unknown): void => {
    const text = String(chunk);
    job.buffer = appendCapped(job.buffer, text, BUFFER_BYTES);
    job.tail = job.buffer.length <= TAIL_BYTES ? job.buffer : job.buffer.slice(job.buffer.length - TAIL_BYTES);
  };
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);

  const settle = (code: number | null, note?: string): void => {
    if (!job.running) return;
    job.running = false;
    if (note) absorb(note);
    job.finished_at = new Date().toISOString();
    job.exit_code = code;
    job.result = finalJsonLine(job.buffer);
  };

  // A spawn that never started is a finished job with no exit code and the
  // reason in its own tail, not a job that polls forever.
  child.on("error", (error) => settle(null, `\nfailed to start ${input.command}: ${String(error)}\n`));
  child.on("close", (code) => settle(code ?? null));
  child.unref();

  return snapshot(job);
}

/** Drop the oldest finished jobs once the table is full. */
function prune(): void {
  if (JOBS.size <= MAX_JOBS) return;
  for (const [key, value] of JOBS) {
    if (JOBS.size <= MAX_JOBS) return;
    if (!value.running) JOBS.delete(key);
  }
}

export function getJob(id: string): Job | null {
  const job = JOBS.get(id);
  return job ? snapshot(job) : null;
}

/** Newest first, so the UI's Runs list reads top down. */
export function listJobs(limit: number = DEFAULT_LIST): Job[] {
  return [...JOBS.values()].reverse().slice(0, Math.max(0, limit)).map(snapshot);
}

/** The job still running for a row, if there is one: one retry per row at a time. */
export function runningJobFor(rowId: string): Job | null {
  for (const job of [...JOBS.values()].reverse()) if (job.running && job.row_id === rowId) return snapshot(job);
  return null;
}

/** Test hook: forget every job (the table is process-wide). */
export function resetJobs(): void {
  JOBS.clear();
}
