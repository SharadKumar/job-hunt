#!/usr/bin/env tsx
/**
 * autopilot-submit.ts — the unattended one-click submission path: SEEK Quick
 * Apply (user decision 2026-09-15) and LinkedIn Easy Apply (2026-09-16, live
 * once linkedin_jobs is in autopilot.channels). Invoked by /daily for each prepared package whose letter passed
 * slop and voice. Nobody reads the package first: the machine gates are the
 * authority, so this tool does nothing that the gate has not explicitly
 * cleared. Repairable failures go to `manual_action_needed`; an advert that
 * the channel explicitly says is closed exits to Closed with an audit reason.
 *
 * Steps:
 *   1. Load the opportunity and its archive (state/pipeline/archive/<id>/):
 *      cover-letter.md (required), jd.md, metadata.json (resume docx path; if
 *      missing, the approved baseline docx under state/profile/resumes/<matched_resume_id>/).
 *   2. Letter-critic: reuse <archive>/letter-critic.json when it is a pass for
 *      the current letter sha; otherwise run tools/letter-critic.ts. A block
 *      parks the row (manual_action_needed) with the findings; exit 1.
 *   3. Walk status to `approved` through the valid transitions
 *      (drafted → awaiting_approval → approved as needed).
 *   4. Run tools/submission-gate.ts with --approved-by autopilot:<run-id>.
 *      A stale or Jev-only classification returns to discovered for bounded
 *      agent verification. Other failures go to manual_action_needed, while
 *      blocked / capped leave the approved package waiting; exit 1.
 *   5. submission_pending → the channel's one-click adapter (ADAPTERS below:
 *      seek → seek-submit.ts submitSeek, linkedin_jobs → linkedin-submit.ts
 *      submitLinkedIn; the gate has already required applyMethod easy_apply).
 *   6. ok → submitted, submittedAt, <archive>/confirmation.txt, audit event
 *      (actor "autopilot"), resumeId/draftDir like the attended flow, and
 *      `npm run seek:unsave` when the row was user-saved.
 *      needsManual / newScreeningQuestion / other → manual_action_needed with
 *      the reason; unknown questions appended to screening-answers.yaml.
 *      Explicit closed-advert notice before opening the form → withdrawn.
 *
 * CLI:
 *   tsx tools/autopilot-submit.ts --id <opportunityId> [--dry-run] [--run-id <id>] [--model <critic-model>]
 *
 * Prints a JSON summary. Exit 0 only when the row reached `submitted` (or, in
 * --dry-run, the adapter reached the review page); 1 on any parked outcome;
 * 2 on a usage or environment error.
 */

import { exists } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import { get as getPipeline, load as loadPipeline, patch as patchPipeline, setStatus, type Opportunity, type PipelineStatus } from "./pipeline.ts";
import { normaliseQuestion } from "./channels/seek-submit.ts";
import { evaluateSubmission, type GateDecision } from "./submission-gate.ts";
import { critiqueLetter, readCurrentVerdict, sha256Text, type CriticResult } from "./letter-critic.ts";
import { log as auditLog } from "./audit.ts";
import { reencodeScreenshots } from "./archive-compact.ts";
import { repoPath } from "./repo-root.ts";
import type { SubmitPackage, SubmitResult } from "./channels/_interface.ts";

const exec = promisify(execFile);

export function classificationReverificationRequired(decision: Pick<GateDecision, "checks">): boolean {
  return decision.checks.some(check => !check.ok && [
    "autopilot_classified", "jev_autopilot_authority", "autopilot_classification_current",
  ].includes(check.gate));
}

type Summary = {
  id: string;
  runId: string;
  dryRun: boolean;
  outcome: "submitted" | "dry_run_ok" | "letter_critic_block" | "gate_" | string;
  status: PipelineStatus | null;
  reason?: string;
  gate?: Pick<GateDecision, "action" | "reason" | "checks">;
  critic?: { verdict: string; sha: string; reused: boolean; fails: number; warns: number };
  confirmationRef?: string;
  screenshotPath?: string;
  unsaved?: string;
  notes: string[];
};

function parseArgs(argv: string[]): Record<string, string> {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return a;
}

function seekJobId(url: string): string | null {
  return url.match(/\/job\/(\d+)/)?.[1] ?? null;
}

function frontHalfReportPath(runId: string): string | null {
  const date = runId.match(/^daily-(\d{4}-\d{2}-\d{2})(?:$|[-_])/)?.[1];
  return date ? repoPath(`state/journal/front-half/${date}.json`) : null;
}

/** The front-half report is also the run's channel-health checkpoint. Once a
 * SEEK challenge is seen, later packages in this run must not re-hit it. */
export async function seekVerificationRequiredForRun(runId: string, reportPath = frontHalfReportPath(runId)): Promise<boolean> {
  if (!reportPath) return false;
  try {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    return report?.channel_health?.seek?.verification_required === true;
  } catch { return false; }
}

export async function markSeekVerificationRequired(runId: string, reportPath = frontHalfReportPath(runId)): Promise<boolean> {
  if (!reportPath) return false;
  let report: Record<string, any>;
  try { report = JSON.parse(await fs.readFile(reportPath, "utf8")); }
  catch { return false; }
  report.channel_health = { ...report.channel_health, seek: { ...report.channel_health?.seek, verification_required: true, observed_at: new Date().toISOString(), source: "autopilot_submit" } };
  report.partial = true;
  report.updated_at = new Date().toISOString();
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(report, null, 2) + "\n");
  await fs.rename(temporary, reportPath);
  return true;
}

/** Resolve the resume docx for this package: metadata.json first, else the approved baseline. */
async function resolveResumeDocx(opportunity: Opportunity, archiveDir: string): Promise<{ docx: string; source: string }> {
  const metaPath = path.join(archiveDir, "metadata.json");
  if (await exists(metaPath)) {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as { resume?: { docx?: string; ref?: string; mode?: string } };
    // A baseline package carries a reference to the approved baseline docx
    // rather than a copy of it (see prepare-baseline-packages). Both adapters
    // take a docx path and derive the stored-resumé name from its basename, so
    // pointing them at the baseline file itself is exactly equivalent to the
    // copy that used to sit in the package. submission-gate re-hashes it.
    const named = meta.resume?.ref ?? meta.resume?.docx;
    if (named) {
      const abs = path.isAbsolute(named) ? named : repoPath(named);
      if (await exists(abs)) return { docx: abs, source: meta.resume?.ref ? "metadata.json baseline ref" : "metadata.json" };
      throw new Error(`metadata.json names a resume docx that does not exist: ${abs}`);
    }
  }
  const resumeId = opportunity.resumeId ?? opportunity.classification?.matched_resume_id;
  if (!resumeId) throw new Error("no metadata.json resume and no matched_resume_id to derive a baseline from");
  const baselineDir = repoPath(`state/profile/resumes/${resumeId}`);
  const baselineMeta = path.join(baselineDir, "metadata.json");
  if (await exists(baselineMeta)) {
    const m = JSON.parse(await fs.readFile(baselineMeta, "utf8")) as { approval_status?: string; content_hash?: string; approved_hash?: string; artefacts?: { docx?: string } };
    if (m.approval_status !== "approved" || !m.content_hash || m.content_hash !== m.approved_hash) {
      throw new Error(`baseline ${resumeId} is not currently approved; refusing to derive a resume`);
    }
    if (m.artefacts?.docx && (await exists(m.artefacts.docx))) return { docx: m.artefacts.docx, source: `baseline ${resumeId}` };
  }
  const files = (await fs.readdir(baselineDir)).filter((f) => f.endsWith(".docx"));
  if (files.length !== 1) throw new Error(`expected exactly one .docx under ${baselineDir}, found ${files.length}`);
  return { docx: path.join(baselineDir, files[0]), source: `baseline ${resumeId} (dir scan)` };
}

/** Move a row to `approved` along the valid path, or throw. */
export async function walkToApproved(id: string, runId: string, notes: string[]): Promise<Opportunity> {
  const path_: Partial<Record<PipelineStatus, PipelineStatus>> = {
    shortlisted: "drafted",
    drafted: "awaiting_approval",
    awaiting_approval: "approved",
    manual_action_needed: "approved",   // retry after the blocker was cleared
  };
  let row = await getPipeline(id);
  if (!row) throw new Error(`opportunity not found: ${id}`);
  let guard = 0;
  while (row.status !== "approved" && guard++ < 8) {
    const next = path_[row.status];
    if (!next) throw new Error(`cannot walk status '${row.status}' to approved; autopilot only advances shortlisted (with a package) / drafted / awaiting_approval rows`);
    try {
      row = await setStatus(id, next, `autopilot ${runId}: package prepared unattended`, { actor: "autopilot" });
      notes.push(`status → ${next}`);
    } catch (error) {
      // Another runner may have advanced the row after our read. Follow its
      // current status rather than calling the failed transition a bad package.
      const current = await getPipeline(id);
      if (!current || current.status === row.status) throw error;
      row = current;
    }
  }
  const current = await getPipeline(id);
  if (!current || current.status !== "approved") throw new Error(`status changed during approval walk: ${current?.status ?? "missing"}`);
  return current;
}

async function park(id: string, reason: string, runId: string, notes: string[], claimedByThisRun = false): Promise<PipelineStatus> {
  const row = await getPipeline(id);
  if (!row) throw new Error(`opportunity not found: ${id}`);
  if (row.status === "submitted" || (row.status === "submission_pending" && !claimedByThisRun)) {
    notes.push(`not parked: another run owns status '${row.status}'`);
    return row.status;
  }
  const stamped = `[autopilot ${runId}] ${reason}`;
  if (row.status === "manual_action_needed") {
    await patchPipeline(id, { notes: row.notes ? `${row.notes}\n${stamped}` : stamped }, "autopilot", "park note");
    return row.status;
  }
  try {
    const r = await setStatus(id, "manual_action_needed", stamped, { actor: "autopilot", expectedStatus: row.status });
    await patchPipeline(id, { notes: row.notes ? `${row.notes}\n${stamped}` : stamped }, "autopilot", "park note");
    notes.push("status → manual_action_needed");
    return r.status;
  } catch (e: any) {
    const current = await getPipeline(id);
    notes.push(`could not move '${row.status}' to manual_action_needed: ${e.message}; current '${current?.status ?? "missing"}' left intact`);
    return current?.status ?? row.status;
  }
}

/** Close only a pre-form, explicitly closed advert. Unknown send outcomes must
 * stay in submission_pending for reconciliation and never call this helper. */
export async function closeAdvertAfterAdapterNotice(id: string, reason: string, runId: string): Promise<PipelineStatus> {
  const row = (await loadPipeline()).find((candidate) => candidate.id === id);
  if (!row || row.status !== "submission_pending") throw new Error(`cannot close ${id}: expected submission_pending`);
  const auditedReason = `${reason}; no application form was opened`;
  await patchPipeline(id, { channelExpiredAt: new Date().toISOString() }, "autopilot", auditedReason);
  const closed = await setStatus(id, "withdrawn", auditedReason, { actor: "autopilot", details: { run_id: runId, expiry_source: "channel" } });
  return closed.status;
}

/** A verification page seen before Submit is a channel-wide retry condition,
 * not an opportunity that needs a new personal decision. */
export async function deferForChannelVerification(id: string, reason: string, runId: string): Promise<PipelineStatus> {
  const row = (await loadPipeline()).find((candidate) => candidate.id === id);
  if (!row || row.status !== "submission_pending") throw new Error(`cannot defer ${id}: expected submission_pending`);
  await patchPipeline(id, { notes: [row.notes, `[autopilot ${runId}] ${reason}`].filter(Boolean).join("\n") }, "autopilot", "SEEK channel verification before submit");
  const retryable = await setStatus(id, "approved", `autopilot ${runId}: channel verification before Submit; approved package retained for next run`, { actor: "autopilot" });
  return retryable.status;
}

/**
 * Append one unknown screening question to screening-answers.yaml, unless the
 * same question (normalised) is already parked there. Returns true when it
 * appended. The file is rewritten as text, not re-serialised, so the user's
 * comments and hand-written answers survive.
 */
export async function appendUnknownQuestion(
  opportunity: Pick<Opportunity, "id" | "company" | "title">,
  q: { text: string; context: string },
  file = repoPath("state/profile/screening-answers.yaml"),
): Promise<boolean> {
  let text = await fs.readFile(file, "utf8");
  const target = normaliseQuestion(q.text);
  let parsed: any = null;
  try {
    parsed = YAML.parse(text);
  } catch {
    parsed = null;
  }
  const existing = Array.isArray(parsed?.unknown_questions) ? parsed.unknown_questions : [];
  if (existing.some((u: any) => u && typeof u.question === "string" && normaliseQuestion(u.question) === target)) return false;
  if (!/^unknown_questions:\s*$/m.test(text)) {
    // `unknown_questions: []` from the template, or no key at all.
    if (/^unknown_questions:\s*\[\s*\]\s*$/m.test(text)) text = text.replace(/^unknown_questions:\s*\[\s*\]\s*$/m, "unknown_questions:");
    else text = text.trimEnd() + "\n\nunknown_questions:\n";
  }
  if (!text.endsWith("\n")) text += "\n";
  const yamlStr = (v: string) => JSON.stringify(v);
  text += [
    `  - opportunity_id: ${opportunity.id}`,
    `    company: ${yamlStr(opportunity.company)}`,
    `    title: ${yamlStr(opportunity.title)}`,
    `    question: ${yamlStr(q.text)}`,
    q.context ? `    context: ${yamlStr(q.context.slice(0, 400))}` : null,
    `    answer: null`,
  ].filter(Boolean).join("\n") + "\n";
  await fs.writeFile(file, text);
  return true;
}

type SubmitAdapter = (o: Opportunity, p: SubmitPackage, opts: { dryRun?: boolean; resumeFilename: string; screenshotDir?: string }) => Promise<SubmitResult>;

/** One-click adapters by channel. Anything not listed here has no unattended path. */
const ADAPTERS: Record<string, { module: string; export: string; label: string }> = {
  seek: { module: "./channels/seek-submit.ts", export: "submitSeek", label: "SEEK Quick Apply" },
  linkedin_jobs: { module: "./channels/linkedin-submit.ts", export: "submitLinkedIn", label: "LinkedIn Easy Apply" },
};

async function loadAdapter(channel: string): Promise<{ submit: SubmitAdapter; label: string } | { error: string }> {
  const spec = ADAPTERS[channel];
  if (!spec) return { error: `no unattended adapter for channel '${channel}'` };
  try {
    const mod = await import(spec.module);
    const fn = (mod as any)[spec.export];
    if (typeof fn !== "function") return { error: `${spec.module} does not export ${spec.export}` };
    return { submit: fn as SubmitAdapter, label: spec.label };
  } catch (e: any) {
    return { error: `could not import ${spec.module}: ${e.message}` };
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const id = a.id;
  if (!id) {
    console.error("Usage: tsx tools/autopilot-submit.ts --id <opportunityId> [--dry-run] [--run-id <id>] [--model <critic-model>]");
    process.exit(2);
  }
  const dryRun = a["dry-run"] === "true";
  const runId = a["run-id"] ?? `daily-${new Date().toISOString().slice(0, 10)}`;
  const summary: Summary = { id, runId, dryRun, outcome: "error", status: null, notes: [] };
  const finish: (code: number) => never = (code) => {
    // A concurrent runner may have claimed or completed the row while this
    // process was preparing it. Report the authoritative status, not the
    // stale local package failure that happened to finish second.
    if (summary.status === "submission_pending") {
      summary.outcome = "submission_unconfirmed";
      summary.reason = "Another submission is in progress or unresolved; reconcile before retrying";
    } else if (summary.status === "submitted" && summary.outcome !== "submitted") {
      summary.outcome = "already_submitted";
      summary.reason = "Another runner has already confirmed this application";
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exit(code);
  };

  const all = await loadPipeline();
  const opportunity = all.find((r) => r.id === id);
  if (!opportunity) { summary.reason = `opportunity not found: ${id}`; finish(2); }
  summary.status = opportunity!.status;
  if (opportunity!.status === "submission_pending") {
    summary.outcome = "submission_unconfirmed";
    summary.reason = "Previous submission is unresolved; reconcile its outcome before retrying";
    finish(1);
  }
  if (opportunity!.channel === "seek" && await seekVerificationRequiredForRun(runId)) {
    summary.outcome = "channel_verification_required";
    summary.reason = "SEEK human verification already recorded for this daily run; no further SEEK form attempt";
    finish(1);
  }

  const archiveDir = repoPath(`state/pipeline/archive/${id}`);
  const letterPath = path.join(archiveDir, "cover-letter.md");
  const jdPath = path.join(archiveDir, "jd.md");
  if (!(await exists(letterPath))) {
    summary.outcome = "no_cover_letter";
    summary.reason = `cover-letter.md missing under ${archiveDir}; autopilot never submits without the letter`;
    summary.status = await park(id, summary.reason, runId, summary.notes);
    finish(1);
  }
  if (["submitted", "responded", "interview", "offered", "won", "rejected", "withdrawn"].includes(opportunity!.status)) {
    summary.outcome = "not_eligible";
    summary.reason = `status '${opportunity!.status}' is past or outside the apply queue`;
    finish(1);
  }

  // Resume docx.
  let resume: { docx: string; source: string };
  try {
    resume = await resolveResumeDocx(opportunity!, archiveDir);
    summary.notes.push(`resume: ${path.basename(resume.docx)} (${resume.source})`);
  } catch (e: any) {
    summary.outcome = "no_resume";
    summary.reason = String(e.message);
    summary.status = await park(id, String(e.message), runId, summary.notes);
    finish(1);
  }

  // Letter-critic: reuse a current pass, else run it.
  const letterText = await fs.readFile(letterPath, "utf8");
  const criticPath = path.join(archiveDir, "letter-critic.json");
  const existing = await readCurrentVerdict(criticPath, letterText);
  let critic: CriticResult;
  let reused = false;
  if (existing.ok && existing.result) {
    critic = existing.result;
    reused = true;
  } else {
    try {
      critic = await critiqueLetter({ letterPath, jdPath: (await exists(jdPath)) ? jdPath : undefined, model: a.model });
    } catch (e: any) {
      summary.outcome = "letter_critic_error";
      summary.reason = `letter-critic could not run: ${e.message}`;
      summary.status = await park(id, summary.reason, runId, summary.notes);
      finish(1);
    }
    await fs.writeFile(criticPath, JSON.stringify(critic!, null, 2) + "\n");
  }
  const fails = critic!.findings.filter((f) => f.severity === "fail").length;
  const warns = critic!.findings.filter((f) => f.severity === "warn").length;
  summary.critic = { verdict: critic!.verdict, sha: sha256Text(letterText).slice(0, 12), reused, fails, warns };
  if (critic!.verdict !== "pass") {
    const top = critic!.findings.filter((f) => f.severity === "fail").slice(0, 3).map((f) => `"${f.quote.slice(0, 60)}": ${f.issue.slice(0, 120)}`).join(" | ");
    summary.outcome = "letter_critic_block";
    summary.reason = `letter-critic block (${fails} fail): ${top}`;
    summary.status = await park(id, summary.reason, runId, summary.notes);
    finish(1);
  }

  // Walk to approved.
  let row: Opportunity;
  try {
    row = await walkToApproved(id, runId, summary.notes);
    summary.status = row.status;
  } catch (e: any) {
    const current = await getPipeline(id);
    if (current?.status === "submission_pending" || current?.status === "submitted") {
      summary.outcome = current.status === "submitted" ? "already_submitted" : "submission_unconfirmed";
      summary.reason = "Another runner advanced this application; do not retry without reconciling its outcome";
      summary.status = current.status;
    } else {
      summary.outcome = "status_walk_failed";
      summary.reason = String(e.message);
      summary.status = await park(id, String(e.message), runId, summary.notes);
    }
    finish(1);
  }

  // Gate.
  const decision = await evaluateSubmission({
    opportunityId: id,
    channel: row!.channel,
    cvDocxPath: resume!.docx,
    coverMdPath: letterPath,
    approvedBy: `autopilot:${runId}`,
    archiveDir,
  });
  summary.gate = { action: decision.action, reason: decision.reason, checks: decision.checks };
  if (decision.action !== "submit") {
    summary.outcome = `gate_${decision.action}`;
    summary.reason = decision.reason;
    if (classificationReverificationRequired(decision)) {
      // A stale or Jev-only decision is run-owned re-verification work, not a
      // question for the person. Retain the package but remove it from Queue.
      summary.outcome = "classification_reverification_required";
      const moved = await setStatus(id, "discovered", `autopilot ${runId}: ${decision.reason}; bounded agent verification required`, { actor: "autopilot" });
      summary.status = moved.status;
    } else if (decision.action === "blocked" || decision.action === "capped") {
      // Not a package fault: leave the row at approved for a later run.
      const r2 = (await loadPipeline()).find((r) => r.id === id)!;
      const stamped = `[autopilot ${runId}] ${decision.reason}`;
      const patched = await patchPipeline(id, { notes: r2.notes ? `${r2.notes}\n${stamped}` : stamped }, "autopilot", `gate ${decision.action}`);
      summary.status = patched.status;
    } else {
      summary.status = await park(id, decision.reason, runId, summary.notes);
    }
    finish(1);
  }

  // Adapter.
  const adapter = await loadAdapter(row!.channel);
  if ("error" in adapter) {
    summary.outcome = "adapter_missing";
    summary.reason = adapter.error;
    summary.status = await park(id, summary.reason, runId, summary.notes);
    finish(1);
  }
  const { submit, label: adapterLabel } = adapter as { submit: SubmitAdapter; label: string };
  if (!dryRun) {
    try {
      await setStatus(id, "submission_pending", `autopilot ${runId}: gate cleared, invoking ${adapterLabel}`, { actor: "autopilot" });
    } catch (error: any) {
      const current = await getPipeline(id);
      summary.status = current?.status ?? null;
      summary.outcome = current?.status === "submission_pending" ? "submission_unconfirmed"
        : current?.status === "submitted" ? "already_submitted" : "tool_error";
      summary.reason = current?.status === "submission_pending" || current?.status === "submitted"
        ? "Another runner claimed this application; do not retry without reconciling its outcome"
        : `could not claim application before portal: ${error?.message ?? error}`;
      finish(1);
    }
    summary.notes.push("status → submission_pending");
  }
  const pkg: SubmitPackage = { cvDocxPath: resume!.docx, coverLetterMd: letterText, screeningAnswers: [] };
  let result: SubmitResult;
  const startedAt = Date.now();
  try {
    result = await submit(row!, pkg, { dryRun, resumeFilename: path.basename(resume!.docx), screenshotDir: archiveDir });
  } catch (e: any) {
    result = { ok: false, reason: `adapter threw: ${e?.message ?? e}` };
  }
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);

  if (result.ok) {
    summary.confirmationRef = result.confirmationRef;
    summary.screenshotPath = result.screenshotPath;
    if (dryRun) {
      summary.outcome = "dry_run_ok";
      summary.reason = result.confirmationRef ?? "review page reached";
      summary.status = (await loadPipeline()).find((r) => r.id === id)!.status;
      finish(0);
    }
    // The confirmation screenshot is a ~1.3 MB full-page PNG and it only ever
    // has to be readable as "this is the confirmation page". Re-encode it to a
    // half-scale JPEG before the confirmation text names it, so the archive
    // never accumulates the PNG. A failure here is noted, never fatal: the send
    // already happened and the confirmation record matters more than the size.
    if (result.screenshotPath && /\.png$/i.test(result.screenshotPath) && (await exists(result.screenshotPath))) {
      try {
        const [converted] = await reencodeScreenshots([result.screenshotPath]);
        if (converted) {
          summary.notes.push(`screenshot re-encoded to jpeg (${Math.round(converted.before / 1024)}KB → ${Math.round(converted.after / 1024)}KB)`);
          result.screenshotPath = converted.jpeg;
          summary.screenshotPath = converted.jpeg;
        }
      } catch (e: any) {
        summary.notes.push(`screenshot re-encode failed, PNG kept: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }

    const jobId = row!.channel === "seek" ? seekJobId(row!.url) : null;
    const now = new Date().toISOString();
    const sha = sha256Text(letterText);
    const confirmation = [
      `${adapterLabel} application submitted unattended (autopilot).`,
      "",
      `Opportunity: ${id}`,
      `Role: ${row!.title}`,
      `Advertiser: ${row!.company}`,
      `Channel: ${row!.channel}`,
      jobId ? `SEEK job ID: ${jobId}` : `Ad URL: ${row!.url}`,
      `Submitted at: ${now}`,
      `Run: ${runId}`,
      `Confirmation text: ${result.confirmationRef ?? "(none captured)"}`,
      `Screenshot: ${result.screenshotPath ?? "(none)"}`,
      `Resume: ${path.basename(resume!.docx)} (${resume!.source})`,
      `Cover letter: cover-letter.md sha256 ${sha}`,
      `Letter-critic: pass at ${critic!.checked_at} (${warns} warn)`,
      `Elapsed: ${elapsedS}s`,
    ].join("\n") + "\n";
    await fs.writeFile(path.join(archiveDir, "confirmation.txt"), confirmation);

    const r3 = (await loadPipeline()).find((r) => r.id === id)!;
    await patchPipeline(id, {
      resumeId: r3.resumeId ?? row!.classification?.matched_resume_id ?? undefined,
      draftDir: `${archiveDir}/`,
    }, "autopilot", `submitted via ${adapterLabel}`);
    await setStatus(id, "submitted", `autopilot ${runId}: ${adapterLabel} confirmed`, {
      actor: "autopilot",
      details: { run_id: runId, confirmation_ref: result.confirmationRef, screenshot: result.screenshotPath, resume: path.basename(resume!.docx), letter_sha256: sha, elapsed_s: elapsedS, seek_job_id: jobId, user_saved: row!.userSaved === true },
    });
    summary.notes.push("status → submitted");
    summary.outcome = "submitted";
    summary.status = "submitted";

    if (row!.channel === "seek" && row!.userSaved && jobId) {
      try {
        const { stdout } = await exec("npm", ["run", "-s", "seek:unsave", "--", "--job", jobId], { cwd: repoPath("."), env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" } });
        summary.unsaved = stdout.trim().slice(0, 200) || "ok";
      } catch (e: any) {
        summary.unsaved = `failed: ${String(e?.stderr ?? e?.message ?? e).slice(0, 200)}`;
        summary.notes.push(`seek:unsave failed for job ${jobId}; unsave it by hand`);
        const r4 = (await loadPipeline()).find((r) => r.id === id)!;
        await patchPipeline(id, {
          notes: `${r4.notes ? r4.notes + "\n" : ""}[autopilot ${runId}] submitted but seek:unsave failed; unsave job ${jobId} by hand`,
        }, "autopilot", "seek:unsave failed");
      }
    }
    finish(0);
  }

  // Failure paths.
  if (result.submissionUnconfirmed && !dryRun) {
    summary.outcome = "submission_unconfirmed";
    summary.reason = result.reason;
    const current = (await loadPipeline()).find((r) => r.id === id)!;
    await patchPipeline(id, { notes: [current.notes, `[autopilot ${runId}] ${result.reason}`].filter(Boolean).join("\n") }, "autopilot", "submission outcome requires reconciliation");
    summary.status = current.status;
    finish(1);
  }
  if (result.channelVerificationRequired && !dryRun) {
    summary.outcome = "channel_verification_required";
    summary.reason = result.reason;
    summary.status = await deferForChannelVerification(id, result.reason, runId);
    if (row!.channel === "seek") await markSeekVerificationRequired(runId);
    finish(1);
  }
  // This signal is emitted only from LinkedIn's explicit closed-advert notice,
  // before Easy Apply is opened. It is terminal, unlike a screening question,
  // login failure or external ATS redirect. Keep the audited row under Closed.
  if (result.advertClosed && !dryRun) {
    const reason = `${result.reason}; no application form was opened`;
    summary.outcome = "advert_expired";
    summary.reason = reason;
    summary.status = await closeAdvertAfterAdapterNotice(id, result.reason, runId);
    finish(1);
  }
  if (result.newScreeningQuestion) {
    const appended = await appendUnknownQuestion(row!, result.newScreeningQuestion);
    await auditLog({
      event_type: "screening_q_paused", role_id: id, actor: "autopilot", channel: row!.channel,
      details: { company: row!.company, title: row!.title, question: result.newScreeningQuestion.text, run_id: runId },
      provenance: { url: row!.url, channel: row!.channel },
    });
    summary.outcome = "new_screening_question";
    summary.reason = `unknown screening question: "${result.newScreeningQuestion.text}" (${appended ? "appended to" : "already in"} screening-answers.yaml unknown_questions)`;
  } else if (result.needsManual) {
    summary.outcome = "needs_manual";
    summary.reason = result.reason;
  } else {
    summary.outcome = "adapter_failed";
    summary.reason = result.reason;
    await auditLog({
      event_type: "submission_failed", role_id: id, actor: "autopilot", channel: row!.channel,
      details: { company: row!.company, title: row!.title, reason: result.reason, run_id: runId, elapsed_s: elapsedS },
      provenance: { url: row!.url, channel: row!.channel },
    });
  }
  summary.status = dryRun ? (await loadPipeline()).find((r) => r.id === id)!.status : await park(id, summary.reason!, runId, summary.notes, true);
  finish(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[autopilot-submit] ERROR: ${e?.message ?? e}`); process.exit(2); });
}
