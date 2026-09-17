#!/usr/bin/env tsx
/**
 * resume-fit-apply.ts — apply page-fit ops to a composition.
 *
 * Two modes:
 *   --plan <ops.json>  apply an explicit, path-addressed op list (the model's
 *                      batch plan), then write the composition + sidecar back.
 *   --auto             run the ladder in `lib/fit-ops.ts` against a live audit,
 *                      re-auditing inside ONE browser session, ≤6 passes.
 *
 * The ladder is text-first: when the measured ragged tails already carry the
 * whole over-budget deficit it stops with `text_edits_would_suffice` and hands
 * back the shave targets rather than dropping authored content. `--force-drops`
 * overrides that. It never drops from a role the positioning protects, never
 * drops a mention when `content_policy.experiences.mentioned.keep_all` is set,
 * and never restores what it dropped in the same run. `--dry-run` plans the
 * whole ladder against scratch copies and writes nothing.
 *
 * The tool never writes or rewrites prose. Every op moves a whole authored unit
 * between the rendered content and `content.bench`. What stays with the model:
 * shaving ragged tails, over-long units, summary length, demotion without a
 * prepared one-liner, and term-grounding remediation.
 *
 * Usage:
 *   npm run resume:fit-apply -- --composition <path> --plan ops.json
 *   npm run resume:fit-apply -- --composition <path> --auto (--resume <id> | --template <name>) [--out-dir <dir>] [--max-passes 6]
 *
 * ops.json is either `[{...}]` or `{ "ops": [{...}] }`, each op one of:
 *   {"op":"drop_bullet","path":"experiences[2].bullets[4]"}
 *   {"op":"restore_bullet","path":"experiences[0]"}          // highest-priority bench bullet
 *   {"op":"drop_mention","path":"experiences[7]"}
 *   {"op":"restore_mention","text":"Title @ Company"}
 *   {"op":"demote","path":"experiences[3]"}                   // needs a bench one-liner
 *   {"op":"add_skill_item","path":"skills[1]"}
 *   {"op":"drop_skill_item","path":"skills[1].bullets[3]"}
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeContent, ResumeSourceProvenance } from "../../templates/resume/_interface.ts";
import { getResume } from "../resumes.ts";
import { loadComposition, writeComposition } from "./lib/composition-io.ts";
import { applyFitOps, planAutoOps, protectedExperienceIndices, type AppliedOp, type FitOp, type SkippedOp } from "./lib/fit-ops.ts";

export const DEFAULT_MAX_PASSES = 6;

/** A ragged tail the writer could shave, carried through to the caller so an
 * over-budget run can be answered with an edit instead of a drop. */
export type ShaveTarget = {
  unit_path: string;
  kind: string;
  lines: number;
  last_line_fill_pct: number;
  shave_chars: number;
};

export type FitSnapshot = {
  fit: { verdict: string; lines_to_remove: number; lines_to_add: number } | null;
  /** unit_path → measured rendered line count. */
  unitLines: Record<string, number>;
  /** Whole rendered lines recoverable by shaving ragged tails — text edits, no content lost. */
  shaveableLines: number;
  shaveTargets: ShaveTarget[];
  verdict?: string;
};

/**
 * The ladder's editorial constraints for one resume: which roles the
 * positioning protects, whether every mention must stay, and the per-role
 * bullet floor. Read from `resumes.yaml` so the ladder cannot contradict the
 * positioning that authored the composition.
 */
export type LadderPolicy = {
  protectedExperiences: number[];
  keepAllMentions: boolean;
  minBulletsPerFeature?: number;
};

export async function ladderPolicyFor(args: { content: ResumeContent; resume?: string; profile?: string }): Promise<LadderPolicy> {
  if (!args.resume) return { protectedExperiences: [], keepAllMentions: false };
  const resume = await getResume(args.resume, { profileId: args.profile }).catch(() => null);
  if (!resume) return { protectedExperiences: [], keepAllMentions: false };
  const experiences = resume.content_policy?.experiences;
  return {
    protectedExperiences: protectedExperienceIndices(args.content, resume.evidence_strategy),
    keepAllMentions: experiences?.mentioned?.keep_all === true,
    minBulletsPerFeature: experiences?.featured?.bullets_per_featured?.min,
  };
}

/** Renders + measures a candidate composition. The caller owns the browser session. */
export type AutoFitAudit = (content: ResumeContent, provenance: ResumeSourceProvenance | null, pass: number) => Promise<FitSnapshot>;

export type AutoFitStop =
  | "converged"
  | "no_candidate_ops"
  | "no_applicable_ops"
  | "max_passes"
  | "no_fit_data"
  | "text_edits_would_suffice"
  | "oscillation";

export type AutoFitResult = {
  content: ResumeContent;
  provenance: ResumeSourceProvenance | null;
  applied: AppliedOp[];
  skipped: SkippedOp[];
  passes: number;
  fit_verdicts: string[];
  stopped_because: AutoFitStop;
  /** Set when the ladder stopped for text edits: shave these, do not drop. */
  shave_targets?: ShaveTarget[];
};

/** Drop-side ops. Everything else puts content back on the page. */
const DROP_OPS = new Set(["drop_bullet", "drop_mention", "drop_skill_item", "demote"]);

/** The unit an op addresses, as a key that a drop and its matching restore share. */
function opKey(op: { path?: string; text?: string }): string {
  return op.text ?? op.path ?? "";
}

/**
 * The ladder loop. Each pass: plan from the CURRENT measurement, apply, re-audit.
 * Stops as soon as fit converges, the ladder runs out of candidates, or the pass
 * budget is spent — whichever comes first.
 *
 * Three stops beyond arithmetic, all of them observed failing on real resumes:
 *
 * - **text first**: when shaving the measured ragged tails would recover the
 *   whole deficit, the ladder refuses to drop anything and hands the targets
 *   back. Dropping an authored bullet to save a line that a few words of editing
 *   would have saved is a loss the page never needed to take.
 * - **protected roles**: bullets in the roles the positioning magnifies or uses
 *   as support are not budget. Enforced in `planAutoOps`.
 * - **oscillation**: a drop pass that under-fills, whose next pass restores what
 *   it just dropped, is a loop, not convergence. Nothing dropped in a run may be
 *   restored in that run, and vice versa; a pass with nothing else left to do
 *   stops.
 */
export async function runAutoFit(args: {
  content: ResumeContent;
  provenance?: ResumeSourceProvenance | null;
  audit: AutoFitAudit;
  /** Measurement of the unmodified composition, when the caller already has it. */
  initial?: FitSnapshot;
  maxPasses?: number;
  minBulletsPerFeature?: number;
  /** Experience indices the positioning protects, against the INPUT composition. */
  protectedExperiences?: number[];
  keepAllMentions?: boolean;
  /** Default true. `--force-drops` sets it false and lets the ladder drop anyway. */
  textFirst?: boolean;
}): Promise<AutoFitResult> {
  const maxPasses = args.maxPasses ?? DEFAULT_MAX_PASSES;
  let content = args.content;
  let provenance = args.provenance ?? content.source_provenance ?? null;
  const applied: AppliedOp[] = [];
  const skipped: SkippedOp[] = [];
  const fitVerdicts: string[] = [];
  const droppedThisRun = new Set<string>();
  const restoredThisRun = new Set<string>();

  // Protection travels by identity, not slot: a drop elsewhere in the array
  // shifts indices, and a protected role must stay protected when it moves.
  const protectedIds = new Set(
    (args.protectedExperiences ?? [])
      .map((i) => args.content.experiences?.[i])
      .filter(Boolean)
      .map((xp) => `${xp!.title}|${xp!.company}`),
  );
  const protectedNow = (c: ResumeContent): number[] =>
    (c.experiences ?? []).flatMap((xp, i) => (protectedIds.has(`${xp.title}|${xp.company}`) ? [i] : []));

  let snapshot = args.initial ?? (await args.audit(content, provenance, 0));
  if (snapshot.fit) fitVerdicts.push(snapshot.fit.verdict);

  let passes = 0;
  let stopped: AutoFitStop = "max_passes";
  let shaveTargets: ShaveTarget[] | undefined;
  while (passes < maxPasses) {
    if (!snapshot.fit) { stopped = "no_fit_data"; break; }
    if (snapshot.fit.verdict === "converged") { stopped = "converged"; break; }

    // Text first: an over-budget page whose ragged tails already carry the whole
    // deficit is an editing job, not a dropping job.
    if (
      args.textFirst !== false
      && snapshot.fit.verdict === "over_budget"
      && snapshot.fit.lines_to_remove > 0
      && (snapshot.shaveableLines ?? 0) >= snapshot.fit.lines_to_remove
    ) {
      stopped = "text_edits_would_suffice";
      shaveTargets = snapshot.shaveTargets ?? [];
      break;
    }

    const planned = planAutoOps({
      content,
      fit: snapshot.fit,
      unitLines: snapshot.unitLines,
      minBulletsPerFeature: args.minBulletsPerFeature,
      protectedExperiences: protectedNow(content),
      keepAllMentions: args.keepAllMentions,
    });
    if (!planned.length) { stopped = "no_candidate_ops"; break; }

    const ops = planned.filter((op) => {
      const key = opKey(op);
      return DROP_OPS.has(op.op) ? !restoredThisRun.has(key) : !droppedThisRun.has(key);
    });
    if (!ops.length) { stopped = "oscillation"; break; }

    const result = applyFitOps({ content, provenance }, ops);
    skipped.push(...result.skipped);
    if (!result.applied.length) { stopped = "no_applicable_ops"; break; }

    for (const op of result.applied) (DROP_OPS.has(op.op) ? droppedThisRun : restoredThisRun).add(opKey(op));
    content = result.content;
    provenance = result.provenance;
    applied.push(...result.applied);
    passes += 1;
    snapshot = await args.audit(content, provenance, passes);
    if (snapshot.fit) fitVerdicts.push(snapshot.fit.verdict);
  }

  return {
    content,
    provenance,
    applied,
    skipped,
    passes,
    fit_verdicts: fitVerdicts,
    stopped_because: stopped,
    ...(shaveTargets ? { shave_targets: shaveTargets } : {}),
  };
}

/** Read an ops plan file: either a bare array or `{ ops: [...] }`. */
export async function loadOpsPlan(planPath: string): Promise<FitOp[]> {
  const parsed = JSON.parse(await fs.readFile(planPath, "utf8"));
  const ops = Array.isArray(parsed) ? parsed : parsed?.ops;
  if (!Array.isArray(ops)) throw new Error(`${planPath}: expected an array of ops or { "ops": [...] }`);
  return ops as FitOp[];
}

export type FitApplyResult = {
  composition: string;
  provenance_json: string | null;
  applied: AppliedOp[];
  skipped: SkippedOp[];
  passes?: number;
  fit_verdicts?: string[];
  stopped_because?: string;
  /** Dry run: nothing on disk was touched and `applied` is what WOULD apply. */
  dry_run?: boolean;
  planned_ops?: AppliedOp[];
  shave_targets?: ShaveTarget[];
};

/** `--plan` mode: apply an explicit op list to a composition on disk. */
export async function runFitApplyPlan(args: { composition: string; ops: FitOp[]; write?: boolean }): Promise<FitApplyResult> {
  const loaded = await loadComposition(args.composition);
  const result = applyFitOps({ content: loaded.content, provenance: loaded.provenance }, args.ops);
  let provenancePath: string | null = loaded.provenancePath;
  if (args.write !== false) {
    const written = await writeComposition(args.composition, result.content, { provenance: result.provenance });
    provenancePath = written.provenancePath;
  }
  return { composition: args.composition, provenance_json: provenancePath, applied: result.applied, skipped: result.skipped };
}

/**
 * `--auto` mode from the CLI. The audit is imported lazily so that
 * resume-audit.ts can import THIS module for `--auto-fit` without a cycle.
 */
export async function runFitApplyAuto(args: {
  composition: string;
  resume?: string;
  template?: string;
  profile?: string;
  format?: string;
  outDir?: string;
  filenamePrefix?: string;
  maxPasses?: number;
  write?: boolean;
  /** Plan only: every render goes to a scratch dir, nothing on disk is touched. */
  dryRun?: boolean;
  /** Let the ladder drop even when shaving the ragged tails would have sufficed. */
  forceDrops?: boolean;
}): Promise<FitApplyResult> {
  const { runAuditOnce } = await import("./resume-audit.ts");
  const { openBrowserSession, closeBrowserSession } = await import("./lib/browser-session.ts");
  const loaded = await loadComposition(args.composition);
  const dryRun = args.dryRun === true;
  // A dry run must not overwrite the artefacts or the audit.json beside the real
  // composition, so its renders land in a throwaway directory instead.
  const outDir = dryRun
    ? await fs.mkdtemp(path.join(os.tmpdir(), "resume-fit-dry-"))
    : args.outDir ?? path.dirname(args.composition);
  await fs.mkdir(outDir, { recursive: true });
  const scratch = path.join(outDir, `${path.basename(args.composition, ".json")}.fit-candidate.json`);
  const policy = await ladderPolicyFor({ content: loaded.content, resume: args.resume, profile: args.profile });

  const session = await openBrowserSession();
  try {
    const audit: AutoFitAudit = async (content, provenance) => {
      await writeComposition(scratch, content, { provenance });
      const { full } = await runAuditOnce({
        contentJson: scratch,
        resume: args.resume,
        template: args.template,
        profile: args.profile,
        format: args.format,
        outDir,
        filenamePrefix: args.filenamePrefix,
        writeComposition: false,
        writeAuditJson: !dryRun,
        session,
      });
      return snapshotFromAudit(full);
    };
    const result = await runAutoFit({
      content: loaded.content,
      provenance: loaded.provenance,
      audit,
      maxPasses: args.maxPasses,
      textFirst: !args.forceDrops,
      ...policy,
    });
    let provenancePath: string | null = loaded.provenancePath;
    if (!dryRun && args.write !== false) {
      const written = await writeComposition(args.composition, result.content, { provenance: result.provenance });
      provenancePath = written.provenancePath;
    }
    await fs.rm(scratch, { force: true }).catch(() => undefined);
    await fs.rm(scratch.replace(/\.json$/, ".provenance.json"), { force: true }).catch(() => undefined);
    if (dryRun) await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      composition: args.composition,
      provenance_json: provenancePath,
      applied: dryRun ? [] : result.applied,
      skipped: result.skipped,
      passes: result.passes,
      fit_verdicts: result.fit_verdicts,
      stopped_because: result.stopped_because,
      ...(dryRun ? { dry_run: true, planned_ops: result.applied } : {}),
      ...(result.shave_targets ? { shave_targets: result.shave_targets } : {}),
    };
  } finally {
    await closeBrowserSession(session);
  }
}

/** Turn a full audit report into the measurement the ladder needs. */
export function snapshotFromAudit(full: any): FitSnapshot {
  const unitLines: Record<string, number> = {};
  for (const u of full?.line_units ?? []) {
    if (u?.unit_path) unitLines[u.unit_path] = u.lines ?? 1;
  }
  const fit = full?.fit_full
    ? {
        verdict: full.fit_full.verdict as string,
        lines_to_remove: full.fit_full.delta?.lines_to_remove ?? 0,
        lines_to_add: full.fit_full.delta?.lines_to_add ?? 0,
      }
    : null;
  // Ragged tails are the text-edit budget: how many whole rendered lines the
  // writer could recover without losing a single authored unit.
  const tails: any[] = full?.fit_full?.candidates?.ragged_tails_shave_to_save_a_line ?? [];
  const shaveTargets: ShaveTarget[] = tails.map((t) => ({
    unit_path: t.unit_path,
    kind: t.kind,
    lines: t.lines,
    last_line_fill_pct: t.last_line_fill_pct,
    shave_chars: t.shave_chars,
  }));
  const shaveableLines = tails.reduce((sum, t) => sum + (t.saves_lines ?? 0), 0);
  return { fit, unitLines, shaveableLines, shaveTargets, verdict: full?.verdict };
}

function parseArgs(): Record<string, string> {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

async function main() {
  const a = parseArgs();
  if (!a.composition || (!a.plan && a.auto !== "true")) {
    console.error("Usage: tsx tools/resume/resume-fit-apply.ts --composition <path> (--plan <ops.json> | --auto [--resume <id> | --template <name>] [--out-dir <dir>] [--max-passes 6] [--dry-run] [--force-drops])");
    process.exit(2);
  }
  const result = a.plan
    ? await runFitApplyPlan({ composition: a.composition, ops: await loadOpsPlan(a.plan), write: a["dry-run"] !== "true" })
    : await runFitApplyAuto({
        composition: a.composition,
        resume: a.resume,
        template: a.template,
        profile: a.profile,
        format: a.format,
        outDir: a["out-dir"],
        filenamePrefix: a["filename-prefix"],
        maxPasses: a["max-passes"] ? Number(a["max-passes"]) : undefined,
        write: a["dry-run"] !== "true",
        dryRun: a["dry-run"] === "true",
        forceDrops: a["force-drops"] === "true",
      });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
