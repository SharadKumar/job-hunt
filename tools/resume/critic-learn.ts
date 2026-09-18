#!/usr/bin/env tsx
/**
 * critic-learn.ts — turn recurring resume-critic findings into standing rules.
 *
 * WHY
 * ---
 * `critic-apply.ts` is the durable record of ONE review against ONE
 * composition. This module is the other half of the loop: it reads every
 * `<prefix>.critic.json` under a rendered-resumes directory and asks a
 * different question, across resumes and across rounds. A complaint the critic
 * raised on two or more separate positionings is not a one-off edit, it is a
 * standing editorial preference, and it belongs in the profile's prose rules so
 * the next composition never has to be told twice.
 *
 * It writes exactly one file, `resume-editorial-rules.md`, and only ever
 * appends to it. It never writes `editorial-bans.yaml`: a machine ban is a hard
 * gate on every future render and therefore a user decision, so
 * `suggestedBanRules` only prints the YAML a human may choose to paste in.
 *
 * `runCriticApply` calls straight into this module at the end of every recorded
 * round, so nothing about the `resume:critic:apply` flags changed when the code
 * moved here. The CLI below is the same pass on demand, over a whole resumes
 * directory, without applying anything:
 *
 *   npm run resume:critic:learn -- --resumes <state/resumes dir> [--rules <path>] [--dry-run]
 */

import { readJsonIfExists } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CriticFinding, CriticKind, CriticReviewFile } from "./critic-apply.ts";

/** Tolerant on purpose: a missing or corrupt sidecar means "no review", not a crash. */
async function readJson(file: string): Promise<any | null> {
  return readJsonIfExists(file).catch(() => null);
}

/**
 * Local copy of critic-apply's delete predicate. Deliberately not imported:
 * critic-apply imports THIS module at runtime, and a value import back would
 * close the cycle for the sake of one comparison.
 */
function isDelete(edit: string): boolean {
  return edit.trim().toLowerCase() === "delete";
}

/**
 * The comparison key for "the same complaint, twice". Punctuation, case and
 * whitespace vary between two renders of the same defect; the words do not.
 */
export function normaliseQuotePattern(quote: string): string {
  return String(quote ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kinds that describe a durable editorial preference rather than a one-off. */
export const LEARNABLE_KINDS = new Set<CriticKind>(["rule", "register", "duplicate"]);

export type RecurringFinding = {
  kind: CriticKind;
  pattern: string;
  resumes: string[];
  why: string;
  proposed_edit: string | null;
  example_quote: string;
};

/**
 * A finding recurs when the same kind and the same normalised quote pattern
 * turn up on two or more DISTINCT resumes. One resume complaining twice is a
 * render loop, not a rule.
 */
export function findRecurringFindings(
  reviews: Array<{ resume: string; findings: CriticFinding[] }>,
  minResumes = 2,
): RecurringFinding[] {
  const groups = new Map<string, RecurringFinding & { resumeSet: Set<string> }>();
  for (const review of reviews) {
    const resume = String(review?.resume ?? "").trim();
    if (!resume) continue;
    for (const finding of review.findings ?? []) {
      if (!LEARNABLE_KINDS.has(finding?.kind as CriticKind)) continue;
      const quote = finding.quotes?.[0] ?? finding.quote ?? "";
      const pattern = normaliseQuotePattern(quote);
      if (!pattern) continue;
      const key = `${finding.kind}::${pattern}`;
      const existing = groups.get(key);
      if (existing) { existing.resumeSet.add(resume); continue; }
      groups.set(key, {
        kind: finding.kind,
        pattern,
        resumes: [],
        resumeSet: new Set([resume]),
        why: String(finding.why ?? "").trim(),
        proposed_edit: typeof finding.proposed_edit === "string" ? finding.proposed_edit : null,
        example_quote: String(quote).trim(),
      });
    }
  }
  return [...groups.values()]
    .filter((g) => g.resumeSet.size >= minResumes)
    .map(({ resumeSet, ...rest }) => ({ ...rest, resumes: [...resumeSet].sort() }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** Every `<prefix>.critic.json` under a rendered-resumes directory. */
export async function collectReviews(resumesDir: string): Promise<Array<{ resume: string; findings: CriticFinding[] }>> {
  const entries = await fs.readdir(resumesDir, { withFileTypes: true }).catch(() => []);
  const out: Array<{ resume: string; findings: CriticFinding[] }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(resumesDir, entry.name);
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".critic.json"));
    for (const file of files) {
      const review = (await readJson(path.join(dir, file))) as CriticReviewFile | null;
      if (!review) continue;
      const findings = (review.rounds ?? []).flatMap((r) => r.findings ?? []);
      out.push({ resume: String(review.resume || entry.name), findings: findings.length ? findings : review.findings ?? [] });
    }
  }
  return out;
}

const LEARNED_HEADING = "Learned from review";

/**
 * Append recurring findings to the profile's prose editorial rules. Appending
 * is the point: the file is append-only by contract, and a rule already in the
 * file is never restated.
 */
export async function appendLearnedRules(rulesPath: string, recurring: RecurringFinding[], today = new Date()): Promise<RecurringFinding[]> {
  if (!recurring.length) return [];
  const existing = await fs.readFile(rulesPath, "utf8").catch(() => null);
  if (existing === null) return [];
  const fresh = recurring.filter((r) => !existing.includes(`pattern: \`${r.pattern}\``));
  if (!fresh.length) return [];
  const date = today.toISOString().slice(0, 10);
  const lines = [
    "",
    `## ${date} - ${LEARNED_HEADING}`,
    "",
    "Appended by `npm run resume:critic:apply`. Each entry is a finding the resume-critic raised on two or more separate positionings, so it is a standing preference rather than a one-off edit.",
    "",
  ];
  for (const r of fresh) {
    lines.push(`- **${r.kind}** on ${r.resumes.join(", ")}: ${r.why || "recurring review finding"}`);
    lines.push(`  - pattern: \`${r.pattern}\``);
    lines.push(`  - example: "${r.example_quote}"`);
    if (r.proposed_edit) lines.push(`  - preferred wording: ${r.proposed_edit === "delete" ? "remove the unit" : `"${r.proposed_edit}"`}`);
  }
  lines.push("");
  await fs.writeFile(rulesPath, `${existing.replace(/\s*$/, "")}\n${lines.join("\n")}`);
  return fresh;
}

/**
 * A suggestion only. Writing `editorial-bans.yaml` is a user decision: a ban is
 * a hard gate on every future render, and the critic does not get to install
 * one on its own say-so.
 */
export function suggestedBanRules(findings: CriticFinding[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings ?? []) {
    if (!LEARNABLE_KINDS.has(finding?.kind as CriticKind)) continue;
    const literal = finding.forbidden_pattern?.trim()
      || (finding.proposed_edit && isDelete(finding.proposed_edit) ? (finding.quotes?.[0] ?? finding.quote ?? "").trim() : "");
    if (!literal) continue;
    // Only a plain phrase is bannable from the text alone; a sentence is judgement.
    if (literal.length > 60 || literal.split(/\s+/).length > 8 || /[.!?]$/.test(literal)) continue;
    const id = `critic-${normaliseQuotePattern(literal).replace(/\s+/g, "-").slice(0, 40) || "phrase"}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([
      `  - id: ${id}`,
      `    note: suggested by resume-critic finding ${finding.id}: ${finding.why}`,
      `    scope: { field: any }`,
      `    forbidden_phrases: ["${literal.replace(/"/g, '\\"')}"]`,
      `    severity: warn`,
    ].join("\n"));
  }
  return out;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(): Record<string, string> {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

export type CriticLearnResult = {
  resumes_dir: string;
  rules_md: string;
  reviews: number;
  recurring: RecurringFinding[];
  /** The subset actually appended; empty on --dry-run or when the file already says it. */
  learned: RecurringFinding[];
};

/**
 * The recurrence pass on demand. `rules` defaults to the profile directory that
 * owns the resumes directory, which is the same path `runCriticApply` uses:
 * `<profile>/resumes/<id>/` → `<profile>/resume-editorial-rules.md`.
 */
export async function runCriticLearn(args: {
  resumesDir: string;
  rules?: string;
  dryRun?: boolean;
  minResumes?: number;
  today?: Date;
}): Promise<CriticLearnResult> {
  const resumesDir = path.resolve(args.resumesDir);
  const rulesPath = args.rules
    ? path.resolve(args.rules)
    : path.join(path.dirname(resumesDir), "resume-editorial-rules.md");
  const reviews = await collectReviews(resumesDir);
  const recurring = findRecurringFindings(reviews, args.minResumes);
  const learned = args.dryRun ? [] : await appendLearnedRules(rulesPath, recurring, args.today);
  return { resumes_dir: resumesDir, rules_md: rulesPath, reviews: reviews.length, recurring, learned };
}

async function main() {
  const a = parseArgs();
  if (!a.resumes) {
    console.error("Usage: tsx tools/resume/critic-learn.ts --resumes <rendered resumes dir> [--rules <resume-editorial-rules.md>] [--dry-run]");
    process.exit(2);
  }
  const result = await runCriticLearn({
    resumesDir: a.resumes,
    rules: a.rules,
    dryRun: a["dry-run"] === "true",
  });
  for (const r of result.learned) console.error(`[critic-learn] learned rule from ${r.resumes.join(" + ")}: ${r.kind} "${r.example_quote}"`);
  if (!result.learned.length) console.error(`[critic-learn] ${result.recurring.length} recurring finding(s), nothing new to append`);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
