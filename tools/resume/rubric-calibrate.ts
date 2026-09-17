#!/usr/bin/env tsx
/**
 * rubric-calibrate.ts — recalibrate a template rubric's `line_units` char bands
 * from measured render data instead of guessed numbers.
 *
 *   npm run resume:rubric:calibrate -- --template classic [--write] [--json]
 *                                      [--audit <path> ...] [--audit-dir <dir>]
 *
 * Why: the hand-written `desired_chars` bands understated real line capacity
 * (classic bullets actually fit ~106-113 chars per rendered line against a
 * stated 78-96), so writers authored short units, the audit reported ragged
 * tails, and every render burned extra iterations. The audit sidecars
 * (`*.audit.json`, the `line_units` block written by resume-audit) already
 * carry per-unit `chars` / `lines` / `last_line_fill_pct`, which is enough to
 * recover the true per-line capacity of every unit kind.
 *
 * Capacity estimator: for a unit whose LAST rendered line is at least
 * SATURATED_FILL_PCT full, the unit occupies `lines - 1 + lastFill` line-widths
 * of text, so `chars / (lines - 1 + lastFill/100)` estimates chars per full
 * line. The kind's capacity is the median of those estimates. Kinds with too
 * few saturated samples, or whose estimates disagree wildly (shrink-to-fit
 * inline units such as `skill_summary` always report 100% fill and therefore
 * measure nothing), fall back to the template-wide pooled capacity or are
 * skipped entirely.
 *
 * Writing is conservative: `desired_chars` is advisory prose (consumed by
 * resume:context and fit-core guidance) so its numbers are rewritten freely,
 * while the ENFORCED caps (`summary.min_chars` / `max_chars`,
 * `bullets.max_chars`, `skills.max_chars_per_item`,
 * `skills.additional_summary.max_chars`) are clamped so they can never
 * invalidate a unit that the measured corpus already renders.
 *
 * Read-only without `--write`. Uses YAML.parseDocument so comments, key order
 * and every other key in the rubric survive the edit.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { repoPath } from "../repo-root.ts";

/** A unit as persisted in the `line_units` block of a `*.audit.json`. */
export type MeasuredUnit = {
  kind: string;
  chars: number;
  lines: number;
  last_line_fill_pct: number;
};

export type Bands = {
  /** [min, max] chars for a unit that should occupy exactly one rendered line. */
  single: [number, number];
  /** [min, max] chars for a balanced two-line unit. */
  two: [number, number];
  /** [min, max] chars for a balanced three-line unit; null unless max_lines >= 3. */
  three: [number, number] | null;
  /** [min, max] chars per rendered line for full-width prose (no max_lines). */
  perLine: [number, number];
};

export type KindCalibration = {
  kind: string;
  samples: number;
  saturated: number;
  /** Chars per full rendered line. */
  capacity: number | null;
  /** p90 of the per-unit capacity estimates; used for the enforced caps. */
  capacityP90: number | null;
  source: "measured" | "pooled" | "none";
  /** max(estimate) / min(estimate) for this kind; > SPREAD_MAX_RATIO means unreliable. */
  spreadRatio: number | null;
  /** Why the kind fell back or was skipped. */
  note: string | null;
  maxLines: number | null;
  observedMinChars: number | null;
  observedMaxChars: number | null;
  bands: Bands | null;
};

export type TemplateCalibration = {
  template: string;
  pooledCapacity: number | null;
  pooledCapacityP90: number | null;
  kinds: KindCalibration[];
};

export const SATURATED_FILL_PCT = 90;
export const MIN_SAMPLES = 3;
/** max/min of a kind's capacity estimates above this means the measurement is degenerate. */
export const SPREAD_MAX_RATIO = 1.3;

const SINGLE_MIN_FACTOR = 0.90;
const SINGLE_MAX_FACTOR = 0.98;
const TWO_MIN_FACTOR = 1.75;
const TWO_MAX_FACTOR = 1.95;
const THREE_MIN_FACTOR = 2.75;
const THREE_MAX_FACTOR = 2.95;
const PER_LINE_MIN_FACTOR = 0.88;
const PER_LINE_MAX_FACTOR = 1.0;
/**
 * Summary prose is authored as this many well-filled lines. The floor is
 * deliberately below three whole lines: `min_chars` only has to catch a summary
 * that is too thin to be a paragraph, not enforce the desired_chars band.
 */
const SUMMARY_MIN_LINES = 2.5;
const SUMMARY_MAX_LINES = 4;
/** Lines a prose unit may occupy when the rubric declares no max_lines. */
const DEFAULT_PROSE_MAX_LINES = 2;
/** Lines the enforced `bullets.max_chars` budgets for. */
const BULLET_BUDGET_LINES = 2;

const MEASURED_SENTENCE = /\s*Measured capacity[^.]*\.(?=\s|$)/g;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** chars per full rendered line implied by one saturated unit. */
export function capacityEstimate(unit: MeasuredUnit): number | null {
  if (!unit.lines || unit.lines < 1 || !unit.chars) return null;
  if (unit.last_line_fill_pct < SATURATED_FILL_PCT) return null;
  const lineWidths = unit.lines - 1 + unit.last_line_fill_pct / 100;
  if (lineWidths <= 0) return null;
  return unit.chars / lineWidths;
}

export function bandsFor(capacity: number, maxLines: number | null): Bands {
  const at = (factor: number) => Math.round(capacity * factor);
  return {
    single: [at(SINGLE_MIN_FACTOR), at(SINGLE_MAX_FACTOR)],
    two: [at(TWO_MIN_FACTOR), at(TWO_MAX_FACTOR)],
    three: maxLines != null && maxLines >= 3 ? [at(THREE_MIN_FACTOR), at(THREE_MAX_FACTOR)] : null,
    perLine: [at(PER_LINE_MIN_FACTOR), at(PER_LINE_MAX_FACTOR)],
  };
}

/**
 * Compute the measured capacity and derived bands for every unit kind the
 * rubric declares (plus any kind present in the measurements).
 */
export function calibrateTemplate(
  template: string,
  units: MeasuredUnit[],
  rubric: { line_units?: Record<string, { max_lines?: number }> } | null,
): TemplateCalibration {
  const byKind = new Map<string, MeasuredUnit[]>();
  for (const unit of units) {
    if (!byKind.has(unit.kind)) byKind.set(unit.kind, []);
    byKind.get(unit.kind)!.push(unit);
  }
  const declared = Object.keys(rubric?.line_units ?? {});
  const kinds = [...new Set([...declared, ...byKind.keys()])].sort();

  // Pass 1: per-kind estimates, and the pool of estimates from reliable kinds.
  const estimatesByKind = new Map<string, number[]>();
  const pool: number[] = [];
  for (const kind of kinds) {
    const sample = byKind.get(kind) ?? [];
    const estimates = sample.map(capacityEstimate).filter((v): v is number => v != null);
    estimatesByKind.set(kind, estimates);
    if (estimates.length >= MIN_SAMPLES && spreadRatio(estimates) <= SPREAD_MAX_RATIO) pool.push(...estimates);
  }
  const pooledCapacity = pool.length ? round1(median(pool)) : null;
  const pooledCapacityP90 = pool.length ? round1(percentile(pool, 90)) : null;

  const out: KindCalibration[] = kinds.map((kind) => {
    const sample = byKind.get(kind) ?? [];
    const estimates = estimatesByKind.get(kind) ?? [];
    const maxLines = rubric?.line_units?.[kind]?.max_lines ?? null;
    const spread = estimates.length ? round1(spreadRatio(estimates)) : null;
    const observedMinChars = sample.length ? Math.min(...sample.map((u) => u.chars)) : null;
    const observedMaxChars = sample.length ? Math.max(...sample.map((u) => u.chars)) : null;

    let capacity: number | null = null;
    let capacityP90: number | null = null;
    let source: KindCalibration["source"] = "none";
    let note: string | null = null;

    if (estimates.length >= MIN_SAMPLES && spreadRatio(estimates) <= SPREAD_MAX_RATIO) {
      capacity = round1(median(estimates));
      capacityP90 = round1(percentile(estimates, 90));
      source = "measured";
    } else if (pooledCapacity != null && sample.length > 0) {
      capacity = pooledCapacity;
      capacityP90 = pooledCapacityP90;
      source = "pooled";
      note = estimates.length < MIN_SAMPLES
        ? `only ${estimates.length} saturated sample(s) (< ${MIN_SAMPLES}); using template pooled capacity`
        : `estimates disagree (spread ${spread}x > ${SPREAD_MAX_RATIO}x, likely shrink-to-fit); using template pooled capacity`;
    } else {
      note = sample.length
        ? `no usable samples (${estimates.length} saturated of ${sample.length}) and no pooled capacity`
        : "kind never rendered in the measured corpus; left as authored";
    }

    return {
      kind,
      samples: sample.length,
      saturated: estimates.length,
      capacity,
      capacityP90,
      source,
      spreadRatio: spread,
      note,
      maxLines,
      observedMinChars,
      observedMaxChars,
      bands: capacity == null ? null : bandsFor(capacity, maxLines),
    };
  });

  return { template, pooledCapacity, pooledCapacityP90, kinds: out };
}

function spreadRatio(estimates: number[]): number {
  const min = Math.min(...estimates);
  const max = Math.max(...estimates);
  return min > 0 ? max / min : Infinity;
}

/** The ordered bands a kind's `desired_chars` prose talks about, widest-last. */
function bandSequence(cal: KindCalibration): Array<[number, number]> {
  const bands = cal.bands!;
  if (cal.maxLines === 1) return [bands.single];
  if (cal.maxLines == null) return [bands.perLine];
  const seq: Array<[number, number]> = [bands.single, bands.two];
  if (bands.three) seq.push(bands.three);
  return seq;
}

function describe(cal: KindCalibration): string {
  const bands = cal.bands!;
  if (cal.maxLines === 1) return `target ${bands.single[0]}-${bands.single[1]} chars on the single rendered line`;
  if (cal.maxLines == null) return `target ${bands.perLine[0]}-${bands.perLine[1]} chars per rendered line`;
  const parts = [`target ${bands.single[0]}-${bands.single[1]} chars on one line`, `${bands.two[0]}-${bands.two[1]} chars across two balanced lines`];
  if (bands.three) parts.push(`${bands.three[0]}-${bands.three[1]} chars across three`);
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/**
 * Rewrite the numeric ranges inside a `desired_chars` prose string in place,
 * preserving the sentence's wording. Strings that carry no range get a
 * "Measured capacity …" sentence appended (replaced, not duplicated, on re-run).
 */
export function rewriteDesiredChars(text: string, cal: KindCalibration): string {
  if (!cal.bands) return text;
  const base = text.replace(MEASURED_SENTENCE, "").trimEnd();
  const seq = bandSequence(cal);
  let index = 0;
  const rewritten = base.replace(/(\d+)\s*-\s*(\d+)(\s*chars)/g, (_match, _a, _b, tail) => {
    const band = seq[index] ?? seq[seq.length - 1];
    index += 1;
    return `${band[0]}-${band[1]}${tail}`;
  });
  if (index > 0) return rewritten;
  return `${rewritten} Measured capacity ~${cal.capacity} chars per rendered line: ${describe(cal)}.`;
}

type CapEdit = { path: string; from: unknown; to: number; clampedBy?: string };

/** Clamp so a recalibrated cap can never reject something the corpus already renders. */
function clampMax(candidate: number, observedMax: number | null): { value: number; clamped: boolean } {
  if (observedMax != null && candidate < observedMax) return { value: observedMax, clamped: true };
  return { value: candidate, clamped: false };
}

function clampMin(candidate: number, observedMin: number | null): { value: number; clamped: boolean } {
  if (observedMin != null && candidate > observedMin) return { value: observedMin, clamped: true };
  return { value: candidate, clamped: false };
}

/**
 * Apply the calibration to a parsed rubric document. Mutates `doc`; returns the
 * list of edits made (empty when nothing moved).
 */
export function applyCalibration(doc: YAML.Document.Parsed, cal: TemplateCalibration): { desired: Array<{ kind: string; from: string; to: string }>; caps: CapEdit[] } {
  const desired: Array<{ kind: string; from: string; to: string }> = [];
  const caps: CapEdit[] = [];

  for (const kind of cal.kinds) {
    if (!kind.bands) continue;
    const keyPath = ["line_units", kind.kind, "desired_chars"];
    const current = doc.getIn(keyPath);
    if (typeof current !== "string") continue;
    const next = rewriteDesiredChars(current, kind);
    if (next !== current) {
      doc.setIn(keyPath, next);
      desired.push({ kind: kind.kind, from: current, to: next });
    }
  }

  const byKind = new Map(cal.kinds.map((k) => [k.kind, k]));
  const setCap = (keyPath: string[], candidate: number, clamp: { value: number; clamped: boolean }, clampNote: string) => {
    const current = doc.getIn(keyPath);
    if (current === undefined) return;
    const value = clamp.value;
    if (current === value) return;
    doc.setIn(keyPath, value);
    caps.push({ path: keyPath.join("."), from: current, to: value, clampedBy: clamp.clamped ? `${clampNote} (uncapped ${candidate})` : undefined });
  };

  const summary = byKind.get("summary");
  if (summary?.capacity != null) {
    const minCandidate = Math.round(summary.capacity * SUMMARY_MIN_LINES);
    const maxCandidate = Math.round((summary.capacityP90 ?? summary.capacity) * SUMMARY_MAX_LINES);
    setCap(["summary", "min_chars"], minCandidate, clampMin(minCandidate, summary.observedMinChars), "observed shortest rendered summary");
    setCap(["summary", "max_chars"], maxCandidate, clampMax(maxCandidate, summary.observedMaxChars), "observed longest rendered summary");
  }

  const bullet = byKind.get("experience_bullet");
  if (bullet?.capacity != null) {
    // Budget two lines even where max_lines is 3: a third line is an allowed
    // exception, not the authoring target, and a 3-line cap makes the warn inert.
    const lines = Math.min(bullet.maxLines ?? BULLET_BUDGET_LINES, BULLET_BUDGET_LINES);
    const candidate = Math.round((bullet.capacityP90 ?? bullet.capacity) * lines);
    const observed = Math.max(bullet.observedMaxChars ?? 0, byKind.get("impact_bullet")?.observedMaxChars ?? 0) || null;
    setCap(["bullets", "max_chars"], candidate, clampMax(candidate, observed), "observed longest rendered bullet");
  }

  const skillItem = byKind.get("skill_item");
  if (skillItem?.capacity != null) {
    const lines = skillItem.maxLines ?? 1;
    const candidate = Math.round((skillItem.capacityP90 ?? skillItem.capacity) * lines);
    setCap(["skills", "max_chars_per_item"], candidate, clampMax(candidate, skillItem.observedMaxChars), "observed longest rendered skill item");
  }

  const additional = byKind.get("additional_skills_summary");
  if (additional?.capacity != null) {
    const lines = additional.maxLines ?? DEFAULT_PROSE_MAX_LINES;
    const candidate = Math.round((additional.capacityP90 ?? additional.capacity) * lines);
    setCap(["skills", "additional_summary", "max_chars"], candidate, clampMax(candidate, additional.observedMaxChars), "observed longest rendered skills paragraph");
  }

  return { desired, caps };
}

/* ------------------------------- CLI ---------------------------------- */

function parseArgs(argv: string[]): { template?: string; write?: boolean; json?: boolean; auditDir?: string; audits: string[] } {
  const args: { template?: string; write?: boolean; json?: boolean; auditDir?: string; audits: string[] } = { audits: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const next = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (flag === "--template") args.template = next;
    else if (flag === "--write") args.write = next !== "false";
    else if (flag === "--json") args.json = next !== "false";
    else if (flag === "--audit-dir") args.auditDir = next;
    else if (flag === "--audit") args.audits.push(next);
  }
  return args;
}

async function findAuditFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".audit.json"))
    .map((e) => path.join(e.parentPath ?? dir, e.name))
    // Archived renders are historical layouts; calibrate only against live artefacts.
    .filter((f) => !path.relative(dir, f).split(path.sep).some((segment) => /^_?archive/i.test(segment)))
    .sort();
}

/** Read every audit sidecar for `template` and flatten its measured line units. */
export async function loadUnits(files: string[], template: string): Promise<{ units: MeasuredUnit[]; used: string[] }> {
  const units: MeasuredUnit[] = [];
  const used: string[] = [];
  for (const file of files) {
    let doc: any;
    try {
      doc = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (doc?.template !== template || !Array.isArray(doc.line_units)) continue;
    used.push(file);
    for (const unit of doc.line_units) {
      if (typeof unit?.kind !== "string" || typeof unit?.chars !== "number" || typeof unit?.lines !== "number") continue;
      units.push({ kind: unit.kind, chars: unit.chars, lines: unit.lines, last_line_fill_pct: Number(unit.last_line_fill_pct ?? 0) });
    }
  }
  return { units, used };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.template) {
    console.error("Usage: npm run resume:rubric:calibrate -- --template <name> [--write] [--json] [--audit-dir <dir>] [--audit <file> ...]");
    process.exit(1);
  }
  const rubricPath = repoPath(path.join("templates/resume", args.template, "rubric.yaml"));
  const raw = await fs.readFile(rubricPath, "utf8").catch(() => null);
  if (raw == null) {
    console.error(`No rubric at ${rubricPath}`);
    process.exit(1);
  }
  const doc = YAML.parseDocument(raw);
  const rubric = doc.toJS() as { line_units?: Record<string, { max_lines?: number }> };

  const dir = args.auditDir ? path.resolve(args.auditDir) : repoPath("state/profile/resumes");
  const files = args.audits.length ? args.audits.map((f) => path.resolve(f)) : await findAuditFiles(dir).catch(() => []);
  const { units, used } = await loadUnits(files, args.template);
  const cal = calibrateTemplate(args.template, units, rubric);

  if (args.json) {
    console.log(JSON.stringify({ ...cal, sources: used }, null, 2));
  } else {
    console.log(`template: ${args.template}   sources: ${used.length} audit file(s)   units: ${units.length}   pooled capacity: ${cal.pooledCapacity ?? "—"} chars/line`);
    console.log("kind                        n  sat  capacity  source    single       two-line     three-line");
    for (const k of cal.kinds) {
      const b = k.bands;
      const fmt = (band: [number, number] | null) => (band ? `${band[0]}-${band[1]}` : "—");
      const single = b ? (k.maxLines == null ? `${b.perLine[0]}-${b.perLine[1]}/ln` : fmt(b.single)) : "—";
      console.log(
        `${k.kind.padEnd(26)} ${String(k.samples).padStart(3)} ${String(k.saturated).padStart(4)} ${String(k.capacity ?? "—").padStart(9)}  ${k.source.padEnd(9)} ${single.padEnd(12)} ${fmt(b?.two ?? null).padEnd(12)} ${fmt(b?.three ?? null)}`,
      );
      if (k.note) console.log(`  ↳ ${k.note}`);
    }
  }

  const edits = applyCalibration(doc, cal);
  if (!args.json) {
    console.log(`\n${edits.desired.length} desired_chars band(s) and ${edits.caps.length} enforced cap(s) would change.`);
    for (const e of edits.desired) console.log(`  ${e.kind}:\n    - ${e.from}\n    + ${e.to}`);
    for (const c of edits.caps) console.log(`  ${c.path}: ${c.from} -> ${c.to}${c.clampedBy ? `  [clamped to ${c.clampedBy}]` : ""}`);
  }

  if (args.write) {
    if (!edits.desired.length && !edits.caps.length) {
      console.log(`\nNo change; ${rubricPath} left alone.`);
      return;
    }
    await fs.writeFile(rubricPath, doc.toString({ lineWidth: 0 }));
    console.log(`\nWrote ${rubricPath}`);
  } else if (!args.json) {
    console.log("\n(dry run — pass --write to update the rubric)");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
