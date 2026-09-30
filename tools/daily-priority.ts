#!/usr/bin/env tsx
/** Submit already-validated one-click packages before the long discovery scan. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { load, type Opportunity } from "./pipeline.ts";
import { canSatisfyAutopilotClassificationGate } from "./classification.ts";
import { classificationFreshnessIssue, type ClassificationIdentity } from "./jev/classification-freshness.ts";
import { currentJevCacheIdentity } from "./jev/classifier.ts";
import { readCurrentVerdict } from "./letter-critic.ts";
import { boundedCommand } from "./lib/bounded-command.ts";
import { writeAtomic } from "./lib/fs.ts";
import { loadLocale } from "./profile.ts";
import { repoPath } from "./repo-root.ts";

type Attempt = { id: string; channel: string; outcome: string; reason?: string; exit_code: number; duration_ms: number; finished_at: string };

export function priorityOrder(rows: Opportunity[]): Opportunity[] {
  return rows.filter(row => ["approved", "awaiting_approval"].includes(row.status)
    && ["seek", "linkedin_jobs"].includes(row.channel)
    && row.classification?.source === "agent_fallback"
    && canSatisfyAutopilotClassificationGate(row.classification))
    .sort((a, b) => Number(b.userSaved === true) - Number(a.userSaved === true)
      || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));
}

export function nextPriorityRow(rows: Opportunity[], attempted: Set<string>, seekBlocked: boolean): Opportunity | undefined {
  return rows.find(row => !attempted.has(row.id) && !(seekBlocked && row.channel === "seek"));
}

export function priorSeekVerificationRequired(report: unknown): boolean {
  return typeof report === "object" && report !== null
    && (report as any).channel_health?.seek?.verification_required === true;
}

async function seekBlockedEarlierToday(day: string): Promise<boolean> {
  const reportPath = repoPath(`state/journal/front-half/${day}.json`);
  try { return priorSeekVerificationRequired(JSON.parse(await fs.readFile(reportPath, "utf8"))); }
  catch (error: any) {
    if (error?.code === "ENOENT") return false;
    // An unreadable health checkpoint is not evidence that SEEK is safe.
    return true;
  }
}

async function run(script: string, args: string[] = [], timeoutMs = 120_000) {
  return boundedCommand("npm", ["run", "-s", script, ...(args.length ? ["--", ...args] : [])], {
    cwd: repoPath("."), timeoutMs,
  });
}

async function ready(row: Opportunity, identity: ClassificationIdentity): Promise<boolean> {
  if (classificationFreshnessIssue(row, identity)) return false;
  const archive = repoPath(`state/pipeline/archive/${row.id}`);
  try {
    const letter = await fs.readFile(path.join(archive, "cover-letter.md"), "utf8");
    const verdict = await readCurrentVerdict(path.join(archive, "letter-critic.json"), letter);
    return verdict.ok && verdict.result?.verdict === "pass";
  } catch { return false; }
}

async function main() {
  const started = new Date();
  const locale = await loadLocale();
  const day = started.toLocaleDateString("en-CA", { timeZone: locale.timezone });
  const seekPreviouslyBlocked = await seekBlockedEarlierToday(day);
  const classificationIdentity = await currentJevCacheIdentity();
  if (process.argv.includes("--plan")) {
    const candidates = priorityOrder(await load());
    const planned = [] as { id: string; channel: string; user_saved: boolean; ready: boolean }[];
    for (const row of candidates) planned.push({ id: row.id, channel: row.channel,
      user_saved: row.userSaved === true, ready: await ready(row, classificationIdentity) });
    console.log(JSON.stringify({ date: day, read_only: true,
      seek_blocked_by_previous_report: seekPreviouslyBlocked, candidates: planned }));
    return;
  }
  const reportPath = repoPath(`state/journal/priority/${day}.json`);
  const report = { started_at: started.toISOString(), finished_at: "", ok: false,
    preflight: [] as { step: string; exit_code: number; duration_ms: number; error?: string }[],
    selected: 0, attempts: [] as Attempt[], channel_health: { seek: {
      verification_required: seekPreviouslyBlocked, observed_this_pass: false,
    } },
    telemetry: { submitted: 0, time_to_first_send_ms: null as number | null } };
  const save = async () => {
    report.finished_at = new Date().toISOString();
    const sends = report.attempts.filter(attempt => attempt.outcome === "submitted");
    report.telemetry.submitted = sends.length;
    report.telemetry.time_to_first_send_ms = sends.length
      ? new Date(sends[0].finished_at).getTime() - started.getTime() : null;
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await writeAtomic(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, report_path: reportPath }));
  };
  for (const [name, script, args] of [
    ["sheet_pull", "sheets:pull", []],
    ["expire_closed_openings", "pipeline:expire", ["--apply"]],
  ] as [string, string, string[]][]) {
    const stepStarted = Date.now();
    const result = await run(script, args);
    report.preflight.push({ step: name, exit_code: result.exit_code, duration_ms: Date.now() - stepStarted,
      ...(result.exit_code ? { error: (result.stderr || result.stdout).trim().slice(-500) } : {}) });
    // A failed decision pull or expiry check must not race an old decision or deadline.
    if (result.exit_code !== 0) { await save(); process.exitCode = 1; return; }
  }

  const limit = Math.max(0, Math.min(20, Number(process.env.HARNESS_PRIORITY_MAX ?? 8)));
  const candidates = priorityOrder(await load());
  const prepared: Opportunity[] = [];
  for (const row of candidates) if (await ready(row, classificationIdentity)) prepared.push(row);
  report.selected = prepared.length;
  let stopAll = false;
  const attempted = new Set<string>();
  while (!stopAll && report.attempts.length < limit) {
    const row = nextPriorityRow(prepared, attempted, report.channel_health.seek.verification_required);
    if (!row) break;
    attempted.add(row.id);
    const attemptStarted = Date.now();
    const result = await run("autopilot:submit", ["--id", row.id, "--run-id", `priority-${day}`], 300_000);
    let parsed: { outcome?: string; reason?: string } = {};
    try { parsed = JSON.parse(result.stdout.trim()); } catch {}
    const outcome = parsed.outcome ?? (result.timed_out ? "timeout_unconfirmed" : "tool_error");
    report.attempts.push({ id: row.id, channel: row.channel, outcome,
      reason: parsed.reason ?? (result.stderr || "").trim().slice(-300), exit_code: result.exit_code,
      duration_ms: Date.now() - attemptStarted, finished_at: new Date().toISOString() });
    if (row.channel === "seek" && outcome === "channel_verification_required") {
      report.channel_health.seek.verification_required = true;
      report.channel_health.seek.observed_this_pass = true;
    }
    if (["gate_blocked", "gate_capped"].includes(outcome)) stopAll = true;
    // A timeout can leave an unknown send outcome. Stop rather than risk any
    // further submission until the pipeline and channel can be reconciled.
    if (result.timed_out || outcome === "submission_unconfirmed" || outcome === "tool_error") stopAll = true;
  }
  {
    const digestStarted = Date.now();
    const digest = await run("pipeline", ["summary"], 120_000);
    report.preflight.push({ step: "pipeline_summary", exit_code: digest.exit_code, duration_ms: Date.now() - digestStarted,
      ...(digest.exit_code ? { error: (digest.stderr || digest.stdout).trim().slice(-500) } : {}) });
    const syncStarted = Date.now();
    const sync = await run("sheets:sync", [], 120_000);
    report.preflight.push({ step: "state_sync", exit_code: sync.exit_code, duration_ms: Date.now() - syncStarted,
      ...(sync.exit_code ? { error: (sync.stderr || sync.stdout).trim().slice(-500) } : {}) });
  }
  report.ok = report.preflight.every(step => step.exit_code === 0)
    && !report.attempts.some(attempt => ["tool_error", "timeout_unconfirmed"].includes(attempt.outcome));
  await save();
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => {
  console.error(`[daily-priority] ${error?.message ?? error}`);
  process.exitCode = 2;
});
