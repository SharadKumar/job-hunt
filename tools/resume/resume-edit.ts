#!/usr/bin/env tsx
/**
 * resume-edit.ts — change some words in a CV and get the whole truth back, once.
 *
 * WHY
 * ---
 * Changing one sentence used to cost four cold processes in sequence:
 *
 *     npm run resume:critic:apply -- --composition <p> --findings <hand-built.json>
 *     npm run resume:provenance   -- --content-json <p> --reanchor --write
 *     npm run resume:audit        -- --content-json <p> --resume <id> --out-dir <dir>
 *     npm run resume:fit-apply    -- --composition <p> --plan <ops.json>   (sometimes)
 *
 * Four Node starts, three re-reads of the same composition, one Chromium launch
 * at the end — and before any of it the agent had to hand-write a critic
 * findings file with ids, kinds, severities and an EXACT quote of the text it
 * was replacing. Getting that quote wrong by a comma does not error: the
 * finding is skipped as "quote not found" and the agent reports success over an
 * edit that never landed.
 *
 * So this command takes the plain thing instead:
 *
 *     { "edits": [ { "path": "experiences[2].bullets[0]", "text": "New words." } ] }
 *
 * and reads the quote off the live composition itself (see `normaliseEditInput`
 * in critic-apply.ts). The full critic-report shape is still accepted verbatim,
 * because the critic still produces it.
 *
 * THE SEQUENCE, in one process, and STRICTLY in this order:
 *   1. fit ops (`drop_bullet`, `restore_mention`, …) via `runFitApplyPlan` — give
 *      an op its `text` and re-running the same file is a no-op; without it the
 *      op means "whatever is at that index now"
 *   1a. RE-READ the composition. Ops move indices and `restore_bullet` creates
 *      units, so every edit path in the same file is resolved — and its quote
 *      read — against the document the ops LEFT, never the one they were given.
 *      Normalising the edits first (as this did until it ate a neighbouring
 *      bullet) aims each edit at whatever has since moved into its slot.
 *   2. text edits via `runCriticApply` — which writes the composition, appends
 *      a round to `<prefix>.critic.json` and stamps `metadata.json`
 *   3. `reanchor` with apply, writing the provenance sidecar when anything moved
 *   4. `runAudit` with strict line units, in place, so every artefact matches
 *
 * and prints ONE compact JSON object: what applied, what was skipped and WHY,
 * what the audit now says, and a short `next` list naming the actual next move.
 *
 * WHAT THIS IS NOT: it is not an approval, and it never invents text. It writes
 * exactly the strings it was given. `--record-only` records a critic round
 * without applying anything, which is what the resume-critic itself uses.
 *
 * CLI:
 *   npm run resume:edit -- --resume <id> --edits <file>
 *   npm run resume:edit -- --resume <id> --edits <file> --auto-fit --dry-run
 *   npm run resume:edit -- --composition <path> --template classic --edits <file>
 */

import { exists } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractOps, normaliseEditInput, runCriticApply, type CriticOutcome } from "./critic-apply.ts";
import { loadComposition } from "./lib/composition-io.ts";
import type { FitOp } from "./lib/fit-ops.ts";
import { runFitApplyPlan } from "./resume-fit-apply.ts";
import { reanchor, loadSources } from "./resume-reanchor.ts";
import { runAudit, type AuditArgs } from "./resume-audit.ts";
import { resolveProfileContext } from "../profile-context.ts";

/* ------------------------------------------------------------------ types */

export type ResumeEditArgs = {
  resume?: string;
  profile?: string;
  template?: string;
  composition?: string;
  edits: string;
  recordOnly?: boolean;
  reanchor?: boolean;
  audit?: boolean;
  autoFit?: boolean;
  dryRun?: boolean;
  forceDrops?: boolean;
  images?: boolean;
  dpi?: number;
  keywordPlan?: string;
  round?: number;
  /** Test hook: injectable browser launch, forwarded to the audit. */
  launch?: AuditArgs["launch"];
};

export type ResumeEditResult = {
  resume: string;
  composition: string;
  applied: Array<{ id: string; op: string | null; unit_path: string | null }>;
  skipped: Array<{ id: string; unit_path: string | null; reason: string | null }>;
  ops_applied: number;
  reanchor: { moves: number; refreshes: number; widenings: number; unresolved: number } | null;
  audit: {
    verdict: string;
    pages: { count: number | null; fills: number[]; last_page_fill_pct: number | null } | null;
    fit: { verdict: string; lines_to_remove: number; lines_to_add: number } | null;
    failing_units: Array<Record<string, unknown>>;
    issues: unknown[];
    gates: Record<string, unknown>;
    auto_fit?: unknown;
  } | null;
  critic: { round: number; composition_hash: string | null; verdict: string };
  next: string[];
};

/* ------------------------------------------------------------- resolution */

/**
 * Where the composition for `--resume <id>` actually lives.
 *
 * `metadata.json` is the authority (it is what the renderer wrote and what
 * `resume:approve` reads), but a resume directory mid-render may not have one,
 * so a single `*.composition.json` in the directory is accepted as the obvious
 * answer. Two of them is ambiguous and says so rather than guessing.
 */
export async function resolveCompositionPath(args: { resume?: string; profile?: string; composition?: string }): Promise<string> {
  if (args.composition) return path.resolve(args.composition);
  if (!args.resume) throw new Error("resume:edit: one of --resume <id> or --composition <path> is required");

  const dir = path.join(resolveProfileContext(args.profile).renderedResumesDir, args.resume);
  const metadata = await fs.readFile(path.join(dir, "metadata.json"), "utf8").then((s) => JSON.parse(s)).catch(() => null);
  const fromMetadata = metadata?.artefacts?.composition_json;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    const resolved = path.resolve(fromMetadata);
    if (await exists(resolved)) return resolved;
  }

  const entries = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".composition.json"));
  if (entries.length === 1) return path.resolve(path.join(dir, entries[0]));
  if (entries.length === 0) throw new Error(`resume:edit: no composition found in ${dir} (render the resume first)`);
  throw new Error(`resume:edit: ${entries.length} compositions in ${dir}; name one with --composition`);
}

/* ---------------------------------------------------------------- hinting */

const FILL_RULES = /fill|target/;

/**
 * The short list of things worth doing next. Written as sentences an agent can
 * act on without re-reading the audit: a count plus where to look plus, when
 * there is one, the exact command.
 */
function nextSteps(input: {
  resumeId: string;
  skipped: ResumeEditResult["skipped"];
  audit: ResumeEditResult["audit"];
  opsApplied: number;
  /** Ops CARRIED BY THE INPUT, applied or not: the ordering hint is about them. */
  opsPresent: number;
}): string[] {
  const next: string[] = [];
  if (input.skipped.length) {
    next.push(`${input.skipped.length} edit(s) skipped and NOT applied: see skipped[].reason before reporting success`);
  }

  const beforeOpsHints = next.length;
  if (input.opsApplied) {
    next.push(`${input.opsApplied} fit op(s) applied; benched material is recoverable with restore_bullet / restore_mention`);
  }
  if (input.opsPresent) {
    next.push("ops ran BEFORE the text edits and the composition was re-read between them, so every edit path was resolved against the post-op document");
  }
  // The ops hints describe what happened, not what is wrong, so they do not
  // count towards "is there anything to report?" below.
  const opsHints = next.length - beforeOpsHints;

  const audit = input.audit;
  if (!audit) {
    next.push("audit skipped (--no-audit): nothing here has been measured against the page");
    return next;
  }

  const shortUnits = audit.failing_units.filter((u) => FILL_RULES.test(String(u.rule ?? "")));
  if (shortUnits.length) {
    next.push(`${shortUnits.length} single-line unit(s) under the fill floor: see audit.failing_units`);
  }
  const otherUnits = audit.failing_units.length - shortUnits.length;
  if (otherUnits > 0) next.push(`${otherUnits} other failing unit(s): see audit.failing_units`);

  if (audit.fit && audit.fit.lines_to_remove > 0) {
    next.push(`over budget by ${audit.fit.lines_to_remove} line(s); run with --auto-fit --dry-run to see the ladder's plan`);
  }
  if (audit.fit && audit.fit.lines_to_add > 0) {
    next.push(`${audit.fit.lines_to_add} line(s) short of filling the last page; see audit.fit`);
  }

  for (const [gate, value] of Object.entries(audit.gates)) {
    if (value === "fail") next.push(`gate ${gate} FAILED: see audit.issues and re-run the gate's own tool for detail`);
  }

  if (next.length - opsHints === 0) {
    next.push(
      audit.verdict === "pass"
        ? `clean: run \`npm run resume:approve -- --resume ${input.resumeId}\` after a critic round`
        : `audit warns with no failing units or skipped edits; read audit.issues, then \`npm run resume:approve -- --resume ${input.resumeId}\``,
    );
  }
  return next;
}

/* ------------------------------------------------------------------- main */

const say = (line: string) => console.error(`[resume:edit] ${line}`);

export async function runResumeEdit(args: ResumeEditArgs): Promise<ResumeEditResult> {
  const composition = await resolveCompositionPath(args);
  const dir = path.dirname(composition);
  const write = !args.dryRun;

  const raw = JSON.parse(await fs.readFile(args.edits, "utf8"));
  const ops = extractOps(raw);
  let loaded = await loadComposition(composition);

  // ---- 1. fit ops ---------------------------------------------------------
  // Ops run FIRST, and the composition is re-read afterwards, because an op
  // changes what the paths in `edits` address: `restore_bullet` creates the very
  // bullet an edit may be aimed at, and any drop/restore shifts every index
  // below it. `normaliseEditInput` reads each edit's identifying quote off the
  // LIVE composition, so normalising before the ops read the pre-op text and
  // aimed the edit at whatever had moved into that slot — the neighbour.
  let opsApplied = 0;
  if (ops.length) {
    const fit = await runFitApplyPlan({ composition, ops: ops as FitOp[], write });
    opsApplied = fit.applied.length;
    for (const op of fit.applied) say(`op      ${op.op} ${op.path}`);
    for (const s of fit.skipped) say(`op SKIPPED ${s.op.op} ${(s.op as { path?: string }).path ?? "-"}: ${s.reason}`);
    // On a dry run nothing was written, so this re-read is the pre-op document
    // and the edits are normalised against it: a dry run reports the edits as
    // they would land WITHOUT the ops.
    if (write && opsApplied) loaded = await loadComposition(composition);
  }

  // ---- 2. text edits + the critic round ----------------------------------
  // Quotes are read here, off the post-op composition, and never before it.
  const { report } = normaliseEditInput(raw, loaded.content);
  const resumeId = args.resume ?? report.resume ?? loaded.content.resumeId ?? path.basename(dir);

  const critic = await runCriticApply({
    composition,
    report,
    round: args.round,
    recordOnly: args.recordOnly,
    dryRun: args.dryRun,
  });
  for (const o of critic.applied) say(`applied ${o.id.padEnd(8)} ${o.op} ${o.unit_path}`);
  for (const o of critic.skipped) say(`skipped ${o.id.padEnd(8)} ${o.unit_path ?? "-"}: ${o.reason}`);
  if (critic.verdict === "block") say("critic verdict is BLOCK: do not approve this resume");

  // ---- 3. re-anchor provenance -------------------------------------------
  // Edited text drifts away from the corpus lines it was cited against. Doing
  // this here (rather than in a later process) means the audit below measures
  // the provenance this edit produced, not the one the last edit left behind.
  let reanchorCounts: ResumeEditResult["reanchor"] = null;
  if (args.reanchor !== false) {
    const after = await loadComposition(composition);
    if (!after.provenance) {
      say("no provenance sidecar: re-anchoring skipped");
    } else {
      const sources = await loadSources(args.profile);
      const result = reanchor({ content: after.content, provenance: after.provenance, sources, apply: true });
      reanchorCounts = {
        moves: result.moves.length,
        refreshes: result.refreshes.length,
        widenings: result.widenings.length,
        unresolved: result.unresolved.length,
      };
      const touched = result.moves.length + result.refreshes.length + result.widenings.length;
      if (touched && write) {
        const sidecar = after.provenancePath ?? composition.replace(/\.composition\.json$|\.json$/, ".provenance.json");
        await fs.writeFile(sidecar, `${JSON.stringify(after.provenance, null, 2)}\n`);
        say(`reanchored ${touched} citation(s) → ${path.basename(sidecar)}`);
      }
      for (const u of result.unresolved.slice(0, 10)) say(`provenance UNRESOLVED ${u.unit} (${u.score.toFixed(2)}): ${u.text.slice(0, 90)}`);
      if (result.unresolved.length > 10) say(`provenance UNRESOLVED … and ${result.unresolved.length - 10} more (see npm run resume:provenance)`);
    }
  }

  // ---- 4. audit -----------------------------------------------------------
  let audit: ResumeEditResult["audit"] = null;
  if (args.audit !== false) {
    const keywordPlan = args.keywordPlan ?? ((await exists(path.join(dir, "keyword-plan.json"))) ? path.join(dir, "keyword-plan.json") : undefined);
    say(`auditing ${path.basename(composition)} (strict line units, out-dir ${dir})`);
    // `forceDrops` / `dryRun` belong to the auto-fit ladder and are owned by
    // resume-audit.ts; cast so this file compiles either side of that change.
    const extra = { forceDrops: args.forceDrops, dryRun: args.dryRun } as unknown as Partial<AuditArgs>;
    const { compact, auto_fit } = await runAudit({
      contentJson: composition,
      resume: args.resume,
      template: args.template,
      profile: args.profile,
      outDir: dir,
      strictLineUnits: true,
      keywordPlan,
      images: args.images,
      dpi: args.dpi,
      autoFit: args.autoFit,
      writeComposition: write,
      writeAuditJson: write,
      launch: args.launch,
      ...extra,
    });
    audit = {
      verdict: compact.verdict,
      pages: compact.pages
        ? { count: compact.pages.count, fills: compact.pages.fills, last_page_fill_pct: compact.pages.last_page_fill_pct }
        : null,
      fit: compact.fit
        ? { verdict: compact.fit.verdict, lines_to_remove: compact.fit.lines_to_remove, lines_to_add: compact.fit.lines_to_add }
        : null,
      failing_units: compact.failing_units.map((u) => ({
        unit_path: u.unit_path,
        rule: u.rule,
        severity: u.severity,
        page: u.page,
        lines: u.lines,
        last_line_fill_pct: u.last_line_fill_pct,
      })),
      issues: compact.issues,
      gates: {
        evaluate: compact.gates.evaluate,
        provenance: compact.gates.provenance.verdict,
        ats: compact.gates.ats?.verdict ?? null,
        term_grounding: compact.gates.term_grounding.verdict,
        preserve: compact.gates.preserve.verdict,
        editorial: compact.gates.editorial.verdict,
        clouds: compact.gates.clouds.verdict,
      },
      ...(auto_fit ? { auto_fit } : {}),
    };
  }

  const applied = critic.applied.map((o: CriticOutcome) => ({ id: o.id, op: o.op, unit_path: o.unit_path }));
  const skipped = critic.skipped.map((o: CriticOutcome) => ({ id: o.id, unit_path: o.unit_path, reason: o.reason }));

  return {
    resume: resumeId,
    composition,
    applied,
    skipped,
    ops_applied: opsApplied,
    reanchor: reanchorCounts,
    audit,
    critic: { round: critic.round, composition_hash: critic.composition_hash, verdict: critic.verdict },
    next: nextSteps({ resumeId, skipped, audit, opsApplied, opsPresent: ops.length }),
  };
}

/**
 * 0 clean, 1 "read this before you claim success", 2 hard stop.
 *
 * A skipped edit is a 1 and not a 0 on purpose: the most expensive failure this
 * command has is an agent reporting an edit it never made.
 */
export function exitCodeFor(result: ResumeEditResult): number {
  if (result.audit?.verdict === "fail" || result.critic.verdict === "block") return 2;
  if (result.skipped.length) return 1;
  if (result.audit?.verdict === "warn" && result.audit.failing_units.length) return 1;
  return 0;
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
  if (!a.edits || (!a.resume && !a.composition)) {
    console.error(
      "Usage: npm run resume:edit -- --resume <id> --edits <file>\n" +
        "  [--profile <p>] [--composition <path>] [--template <name>] [--record-only]\n" +
        "  [--no-reanchor] [--no-audit] [--auto-fit] [--dry-run] [--force-drops]\n" +
        "  [--images] [--dpi N] [--keyword-plan <path>] [--round N]\n\n" +
        '  --edits takes { "edits": [ { "path": "experiences[2].bullets[0]", "text": "New words." } ] },\n' +
        '  a bare array of those, or a full critic report. "text": "delete" removes the unit.',
    );
    process.exit(2);
  }

  const result = await runResumeEdit({
    resume: a.resume,
    profile: a.profile,
    template: a.template,
    composition: a.composition,
    edits: a.edits,
    recordOnly: a["record-only"] === "true",
    reanchor: a["no-reanchor"] !== "true",
    audit: a["no-audit"] !== "true",
    autoFit: a["auto-fit"] === "true",
    dryRun: a["dry-run"] === "true",
    forceDrops: a["force-drops"] === "true",
    images: a.images === "true",
    dpi: a.dpi ? Number(a.dpi) : undefined,
    keywordPlan: a["keyword-plan"],
    round: a.round ? Number(a.round) : undefined,
  });

  for (const hint of result.next) say(`next: ${hint}`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCodeFor(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(3); });
}
