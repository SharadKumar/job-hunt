#!/usr/bin/env tsx
/**
 * keyword-confirm.ts — deterministic writer for the keyword half of
 * `<profile-dir>/market-confirmations.yaml`, plus the cv-source.md patch that
 * turns a confirmed answer into renderable evidence.
 *
 * Why a tool: the approval loop (plan → ask → confirm → patch → re-plan) is run
 * by skills (`/apply` 2b, `/resume-render` 1.5, `/resume-review`,
 * `/review-drafts`, `/daily`). Skills must not hand-edit YAML or splice markdown
 * by eye — the ledger is load-bearing for suppression (`declined`), for the
 * `source_update_required` gate, and for `/refresh-cv` drift detection. So every
 * write goes through here.
 *
 * The honesty contract is unchanged: a ledger row NEVER authorises rendering.
 * A term renders only once `cv-source.md` carries the fact, which is exactly
 * what `apply-patch` records (`source_patch`, `source_update_required: false`).
 *
 * `familiarity` is the one deliberate exception, and it is not a loophole: it is
 * the fourth evidence-interview answer for a term the user did NOT deliver but
 * can credibly prepare and speak to. It authorises tier-2 framing only — the
 * plan classifies the term `preppable` with `render_as: "familiarity"`, so it may
 * appear once in a familiarity-framed skills line ("Familiar with …", "Working
 * knowledge of …", "Prepared on …") and never as delivered work. It also closes
 * the question: a familiarity row is answered and is never re-asked.
 *
 * Subcommands
 *   record      --plan <keyword-plan.json> --term <t>
 *               --status confirmed|declined|not_applicable|familiarity|pending
 *               [--opportunity <id>] [--origin attended|daily] [--notes "..."]
 *   queue       --plan <keyword-plan.json> [--origin daily]
 *               Records every plan question as `pending` without asking. Never
 *               downgrades an existing answered row.
 *   pending     [--resume <id>] [--group-by term] [--limit N]
 *               Read-only. Lists outstanding `kind: keyword` rows, one per term
 *               across resumes (keyword answers are person-scoped).
 *   apply-patch --term <t> --resume <id> --bullet "<text>"
 *               (--role-heading "<cv-source heading substring>" | --skills [--role-heading "<skills subsection>"])
 *               [--sub-heading "<bold sub-block substring>"]
 *               Inserts one bullet into that block in cv-source.md: by default
 *               after the role's own top-level bullet list (i.e. before the
 *               first `**bold**` sub-block, so a fact is never silently
 *               reattributed to a client sub-engagement), or at the end of the
 *               named sub-block with --sub-heading. Records `source_patch`,
 *               clears `source_update_required`.
 *
 * Common flags: --profile <id>, --ledger <path>, --cv-source <path>, --dry-run.
 *
 * Never contacts anything external. Exit: 0 ok, 1 refused / not found, 2 usage.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import { resolveProfileContext } from "../profile-context.ts";
import { parseArgs, normalise, type KeywordPlan, type KeywordTerm } from "./keyword-lexicon.ts";
import { isPersonScoped, type MarketConfirmation } from "./market-lens-audit.ts";

export type KeywordConfirmStatus = "confirmed" | "declined" | "not_applicable" | "familiarity" | "pending";
const STATUSES: readonly KeywordConfirmStatus[] = ["confirmed", "declined", "not_applicable", "familiarity", "pending"];
/** Answered statuses are terminal for `queue`: an unattended run never reopens them. */
const ANSWERED: ReadonlySet<string> = new Set(["confirmed", "declined", "not_applicable", "familiarity"]);

const today = (): string => new Date().toISOString().slice(0, 10);
const key = (s: string): string => normalise(s).trim();

// ---------------------------------------------------------------------------
// Ledger IO
// ---------------------------------------------------------------------------

export async function readLedger(file: string): Promise<MarketConfirmation[]> {
  try {
    const parsed = YAML.parse(await fs.readFile(file, "utf8")) as { confirmations?: MarketConfirmation[] } | null;
    return parsed?.confirmations ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeLedger(file: string, rows: MarketConfirmation[]): Promise<void> {
  await fs.writeFile(file, YAML.stringify({ confirmations: rows }, { lineWidth: 0 }));
}

/**
 * Rows are keyed by signal/term, deliberately across kinds: a `market_signal`
 * row already answering the same signal must not be shadowed by a second
 * `keyword` row, or `declined` would stop suppressing the term.
 *
 * Keyword rows are person-scoped, so the lookup crosses resumes: the ledger
 * holds ONE row per term for the whole person, and the asking positioning's
 * resume_id is just provenance. A positioning-scoped (`market_signal`) row
 * still only matches its own resume.
 */
export function findRow(rows: MarketConfirmation[], resumeId: string, term: string): MarketConfirmation | null {
  const wanted = key(term);
  const matches = rows.filter((r) => {
    if (key(r.signal ?? "") !== wanted && key(r.term ?? "") !== wanted) return false;
    return isPersonScoped(r) || !r.resume_id || r.resume_id === resumeId;
  });
  return matches.find((r) => r.resume_id === resumeId) ?? matches[0] ?? null;
}

export function upsertKeywordRow(
  rows: MarketConfirmation[],
  patch: MarketConfirmation & { resume_id: string; signal: string },
): { rows: MarketConfirmation[]; created: boolean } {
  const existing = findRow(rows, patch.resume_id, patch.signal);
  if (!existing) {
    const row: MarketConfirmation = { kind: "keyword", asked_at: today(), updated_at: today(), ...patch };
    return { rows: [...rows, row], created: true };
  }
  Object.assign(existing, { kind: "keyword", ...patch, asked_at: existing.asked_at ?? patch.asked_at ?? today(), updated_at: today() });
  for (const [k, v] of Object.entries(existing)) if (v === undefined || v === null || v === "") delete (existing as Record<string, unknown>)[k];
  return { rows, created: false };
}

// ---------------------------------------------------------------------------
// Plan lookup
// ---------------------------------------------------------------------------

export async function readPlan(file: string): Promise<KeywordPlan> {
  return JSON.parse(await fs.readFile(file, "utf8")) as KeywordPlan;
}

export function findPlanTerm(plan: KeywordPlan, term: string): KeywordTerm | null {
  const wanted = key(term);
  return plan.terms.find((t) => key(t.term) === wanted || key(t.jd_form) === wanted || (t.aliases ?? []).some((a) => key(a) === wanted)) ?? null;
}

/** Build the ledger patch for one plan term. Pure — callers do the write. */
export function rowFromPlanTerm(
  plan: KeywordPlan,
  term: KeywordTerm,
  opts: { status: KeywordConfirmStatus; opportunityId?: string | null; origin?: "attended" | "daily"; notes?: string | null },
): MarketConfirmation & { resume_id: string; signal: string } {
  const question = term.question ?? plan.questions.find((q) => key(q.term) === key(term.term))?.question;
  return {
    // resume_id is the asking positioning (provenance). `scope: person` is the
    // load-bearing part: the answer is a fact about the candidate, so it holds
    // for every other positioning and the question is never re-asked there.
    resume_id: plan.resume_id,
    kind: "keyword",
    scope: "person",
    signal: term.term,
    term: term.jd_form || term.term,
    category: term.category,
    opportunity_id: opts.opportunityId ?? plan.opportunity_id ?? undefined,
    question: question ?? undefined,
    proposed_phrasing: term.proposed_phrasing ?? undefined,
    evidence_hint: term.evidence_hint ?? undefined,
    origin: opts.origin ?? "attended",
    status: opts.status,
    // A confirmed term is not renderable until cv-source.md carries it; only
    // `apply-patch` clears this.
    source_update_required: opts.status === "confirmed" ? true : undefined,
    notes: opts.notes ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// cv-source.md patching
// ---------------------------------------------------------------------------

export class PatchRefusal extends Error {}

function unifiedDiff(before: string[], after: string[], at: number, file: string): string {
  const ctx = 3;
  const start = Math.max(0, at - ctx);
  const beforeEnd = Math.min(before.length, at + ctx);
  const head = before.slice(start, at);
  const tail = before.slice(at, beforeEnd);
  const added = after.slice(at, after.length - (before.length - at));
  const lines = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start + 1},${head.length + tail.length} +${start + 1},${head.length + added.length + tail.length} @@`,
    ...head.map((l) => ` ${l}`),
    ...added.map((l) => `+${l}`),
    ...tail.map((l) => ` ${l}`),
  ];
  return lines.join("\n");
}

/** A bold-only line inside a role block, e.g. `**Sideline Labs, the open framework**`. */
const SUB_HEADING = /^\s*\*\*(.+?)\*\*\s*$/;

/**
 * Sub-heading starts within `[from, to)`, in document order. A role block whose
 * narrative splits into bold sub-blocks (framework work, then a named client
 * engagement) must not have a new fact appended at the very end of the block —
 * that silently reattributes it to whichever sub-block happens to be last.
 */
function subHeadingIndexes(lines: string[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (SUB_HEADING.test(lines[i])) out.push(i);
  return out;
}

/** Last `- ` bullet in `[from, to)`, else the end of the range with blanks trimmed. */
function insertPoint(lines: string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (/^\s*-\s+/.test(lines[i])) return i + 1;
  let end = to;
  while (end > from && lines[end - 1].trim() === "") end--;
  return end;
}

export function insertBullet(
  source: string,
  opts: { bullet: string; roleHeading?: string | null; subHeading?: string | null; skills?: boolean; file?: string },
): { text: string; diff: string; heading: string; line: number } {
  const bullet = opts.bullet.trim().replace(/^-\s+/, "");
  if (!bullet) throw new PatchRefusal("Empty bullet text.");
  if (key(source).includes(key(bullet))) throw new PatchRefusal("cv-source.md already contains this bullet text — nothing to patch.");

  const lines = source.split("\n");
  let searchStart = 0;
  let searchEnd = lines.length;
  if (opts.skills) {
    const skillsIdx = lines.findIndex((l) => /^##\s+Skills\b/i.test(l));
    if (skillsIdx < 0) throw new PatchRefusal("No `## Skills` section in cv-source.md.");
    searchStart = skillsIdx + 1;
    const nextTop = lines.findIndex((l, i) => i > skillsIdx && /^##\s+/.test(l) && !/^###/.test(l));
    searchEnd = nextTop < 0 ? lines.length : nextTop;
  }

  const wanted = opts.roleHeading ? key(opts.roleHeading) : null;
  const matches: number[] = [];
  for (let i = searchStart; i < searchEnd; i++) {
    if (!/^###\s+/.test(lines[i])) continue;
    if (!wanted || key(lines[i]).includes(wanted)) matches.push(i);
  }
  if (!matches.length) throw new PatchRefusal(`No heading in cv-source.md matching ${JSON.stringify(opts.roleHeading ?? "(any)")}${opts.skills ? " under `## Skills`" : ""}.`);
  if (matches.length > 1 && wanted) throw new PatchRefusal(`Heading substring ${JSON.stringify(opts.roleHeading)} matches ${matches.length} headings: ${matches.map((i) => lines[i].replace(/^###\s+/, "")).join(" | ")}. Narrow it.`);
  const headingIdx = matches[0];

  let blockEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##/.test(lines[i])) { blockEnd = i; break; }
  }

  const subs = subHeadingIndexes(lines, headingIdx + 1, blockEnd);
  let insertAt: number;
  if (opts.subHeading) {
    const wantedSub = key(opts.subHeading);
    const subMatches = subs.filter((i) => key(lines[i]).includes(wantedSub));
    if (!subMatches.length) {
      throw new PatchRefusal(`No sub-heading under ${JSON.stringify(lines[headingIdx].replace(/^###\s+/, "").trim())} matching ${JSON.stringify(opts.subHeading)}.${subs.length ? ` Known: ${subs.map((i) => lines[i].trim().replace(/^\*\*|\*\*$/g, "")).join(" | ")}` : " That block has no sub-headings."}`);
    }
    if (subMatches.length > 1) {
      throw new PatchRefusal(`Sub-heading substring ${JSON.stringify(opts.subHeading)} matches ${subMatches.length} sub-headings: ${subMatches.map((i) => lines[i].trim().replace(/^\*\*|\*\*$/g, "")).join(" | ")}. Narrow it.`);
    }
    const subIdx = subMatches[0];
    const subEnd = subs.find((i) => i > subIdx) ?? blockEnd;
    insertAt = insertPoint(lines, subIdx + 1, subEnd);
  } else {
    // Default target is the role's OWN top-level bullet list, which ends where
    // the first sub-block begins. Blocks without sub-headings are unchanged.
    insertAt = insertPoint(lines, headingIdx + 1, subs.length ? subs[0] : blockEnd);
  }

  const after = [...lines.slice(0, insertAt), `- ${bullet}`, ...lines.slice(insertAt)];
  return {
    text: after.join("\n"),
    diff: unifiedDiff(lines, after, insertAt, opts.file ?? "cv-source.md"),
    heading: lines[headingIdx].replace(/^###\s+/, "").trim(),
    line: insertAt + 1,
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

type Paths = { ledger: string; cvSource: string };

function resolvePaths(args: Record<string, string>): Paths {
  const ctx = resolveProfileContext(args.profile);
  return { ledger: args.ledger ?? ctx.marketConfirmationsPath, cvSource: args["cv-source"] ?? ctx.cvSourcePath };
}

export async function cmdRecord(args: Record<string, string>): Promise<number> {
  const status = args.status as KeywordConfirmStatus;
  if (!args.plan || !args.term || !STATUSES.includes(status)) {
    console.error("Usage: keyword-confirm record --plan <keyword-plan.json> --term <t> --status confirmed|declined|not_applicable|familiarity|pending [--opportunity <id>] [--origin attended|daily] [--notes ..]");
    return 2;
  }
  const paths = resolvePaths(args);
  const plan = await readPlan(args.plan);
  const term = findPlanTerm(plan, args.term);
  if (!term) {
    console.error(`Term ${JSON.stringify(args.term)} is not in ${args.plan}. Known question terms: ${plan.questions.map((q) => q.term).join(", ") || "(none)"}`);
    return 1;
  }
  const rows = await readLedger(paths.ledger);
  const patch = rowFromPlanTerm(plan, term, {
    status,
    opportunityId: args.opportunity ?? null,
    origin: args.origin === "daily" ? "daily" : "attended",
    notes: args.notes ?? null,
  });
  const { rows: next, created } = upsertKeywordRow(rows, patch);
  if (args["dry-run"] !== "true") await writeLedger(paths.ledger, next);
  console.log(JSON.stringify({
    action: created ? "created" : "updated",
    ledger: paths.ledger,
    resume_id: plan.resume_id,
    term: term.term,
    status,
    source_update_required: status === "confirmed",
    next_step: status === "confirmed" ? "Run `keyword-confirm apply-patch` — the term stays unrenderable until cv-source.md carries the fact."
      : status === "familiarity" ? "No source patch. The plan will classify this term `preppable` with `render_as: \"familiarity\"`: one familiarity-framed skills line, never a delivered-work bullet, and it is listed under interview_prep_terms."
      : null,
  }, null, 2));
  return 0;
}

export async function cmdQueue(args: Record<string, string>): Promise<number> {
  if (!args.plan) {
    console.error("Usage: keyword-confirm queue --plan <keyword-plan.json> [--origin daily]");
    return 2;
  }
  const paths = resolvePaths(args);
  const plan = await readPlan(args.plan);
  let rows = await readLedger(paths.ledger);
  const queued: string[] = [];
  const skipped: string[] = [];
  for (const question of plan.questions) {
    const term = findPlanTerm(plan, question.term);
    if (!term) continue;
    const existing = findRow(rows, plan.resume_id, term.term);
    if (existing && ANSWERED.has(existing.status)) { skipped.push(term.term); continue; }
    if (existing && existing.status === "pending") { skipped.push(term.term); continue; }
    rows = upsertKeywordRow(rows, rowFromPlanTerm(plan, term, {
      status: "pending",
      opportunityId: args.opportunity ?? null,
      origin: args.origin === "attended" ? "attended" : "daily",
    })).rows;
    queued.push(term.term);
  }
  if (queued.length && args["dry-run"] !== "true") await writeLedger(paths.ledger, rows);
  console.log(JSON.stringify({
    action: "queue",
    ledger: paths.ledger,
    resume_id: plan.resume_id,
    opportunity_id: plan.opportunity_id,
    queued_count: queued.length,
    queued,
    already_recorded: skipped,
    coverage: plan.coverage,
  }, null, 2));
  return 0;
}

export type PendingGroup = {
  term: string;
  category?: string;
  count: number;
  resumes: string[];
  opportunities: string[];
  question: string | null;
  evidence_hint: string | null;
  proposed_phrasing: string | null;
};

/**
 * Grouped by term ACROSS resumes: keyword rows are person-scoped, so the same
 * term pending under two positionings is one outstanding question, not two.
 * `--resume` therefore narrows to rows that are either this positioning's own
 * or person-scoped — otherwise a term asked under another resume would look
 * unasked here while `queue` silently refuses to re-ask it.
 */
export function groupPending(rows: MarketConfirmation[], resumeId?: string | null): PendingGroup[] {
  const pending = rows.filter((r) => r.kind === "keyword" && r.status === "pending"
    && (!resumeId || r.resume_id === resumeId || isPersonScoped(r)));
  const groups = new Map<string, PendingGroup>();
  for (const row of pending) {
    const name = row.term ?? row.signal;
    const k = key(name);
    const group = groups.get(k) ?? { term: name, category: row.category, count: 0, resumes: [], opportunities: [], question: null, evidence_hint: null, proposed_phrasing: null };
    group.count += 1;
    if (row.resume_id && !group.resumes.includes(row.resume_id)) group.resumes.push(row.resume_id);
    if (row.opportunity_id && !group.opportunities.includes(row.opportunity_id)) group.opportunities.push(row.opportunity_id);
    group.question ??= row.question ?? null;
    group.evidence_hint ??= row.evidence_hint ?? null;
    group.proposed_phrasing ??= row.proposed_phrasing ?? null;
    groups.set(k, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

/** One row per term (person-scoped answers are one question), asking resume first. */
function dedupeByTerm(rows: MarketConfirmation[], resumeId: string | null): MarketConfirmation[] {
  const byTerm = new Map<string, MarketConfirmation>();
  for (const row of rows) {
    const k = key(row.term ?? row.signal ?? "");
    const seen = byTerm.get(k);
    if (!seen || (resumeId && row.resume_id === resumeId && seen.resume_id !== resumeId)) byTerm.set(k, row);
  }
  return [...byTerm.values()];
}

export async function cmdPending(args: Record<string, string>): Promise<number> {
  const paths = resolvePaths(args);
  const rows = await readLedger(paths.ledger);
  const limit = Number(args.limit ?? 20);
  if (args["group-by"] === "term") {
    const groups = groupPending(rows, args.resume ?? null);
    console.log(JSON.stringify({ ledger: paths.ledger, pending_total: groups.reduce((n, g) => n + g.count, 0), group_count: groups.length, shown: Math.min(limit, groups.length), groups: groups.slice(0, limit) }, null, 2));
    return 0;
  }
  const pending = dedupeByTerm(
    rows.filter((r) => r.kind === "keyword" && r.status === "pending" && (!args.resume || r.resume_id === args.resume || isPersonScoped(r))),
    args.resume ?? null,
  );
  console.log(JSON.stringify({
    ledger: paths.ledger,
    pending_total: pending.length,
    rows: pending.slice(0, limit).map((r) => ({ resume_id: r.resume_id, term: r.term ?? r.signal, category: r.category, opportunity_id: r.opportunity_id, question: r.question, evidence_hint: r.evidence_hint, proposed_phrasing: r.proposed_phrasing, origin: r.origin, asked_at: r.asked_at })),
  }, null, 2));
  return 0;
}

export async function cmdApplyPatch(args: Record<string, string>): Promise<number> {
  const skills = args.skills === "true";
  if (!args.term || !args.resume || !args.bullet || (!args["role-heading"] && !skills)) {
    console.error('Usage: keyword-confirm apply-patch --term <t> --resume <id> --bullet "<text>" (--role-heading "<heading substring>" | --skills [--role-heading "<skills subsection>"]) [--sub-heading "<bold sub-block substring>"]');
    return 2;
  }
  const paths = resolvePaths(args);
  const source = await fs.readFile(paths.cvSource, "utf8");
  let patched: ReturnType<typeof insertBullet>;
  try {
    patched = insertBullet(source, { bullet: args.bullet, roleHeading: args["role-heading"] ?? null, subHeading: args["sub-heading"] ?? null, skills, file: paths.cvSource });
  } catch (error) {
    if (error instanceof PatchRefusal) {
      console.error(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
  const rows = await readLedger(paths.ledger);
  const existing = findRow(rows, args.resume, args.term);
  const { rows: next } = upsertKeywordRow(rows, {
    resume_id: args.resume,
    kind: "keyword",
    scope: "person",
    signal: existing?.signal ?? args.term,
    term: existing?.term ?? args.term,
    category: args.category ?? existing?.category,
    opportunity_id: args.opportunity ?? existing?.opportunity_id,
    question: existing?.question,
    proposed_phrasing: existing?.proposed_phrasing,
    evidence_hint: existing?.evidence_hint,
    origin: (args.origin === "daily" ? "daily" : existing?.origin) ?? "attended",
    status: "confirmed",
    source_update_required: false,
    source_patch: `- ${args.bullet.trim().replace(/^-\s+/, "")}`,
    source_ref: `${paths.cvSource} (${patched.heading})`,
    notes: args.notes ?? existing?.notes,
  });
  if (args["dry-run"] !== "true") {
    await fs.writeFile(paths.cvSource, patched.text);
    await writeLedger(paths.ledger, next);
  }
  console.log(patched.diff);
  console.log(JSON.stringify({
    action: "apply-patch",
    dry_run: args["dry-run"] === "true",
    cv_source: paths.cvSource,
    heading: patched.heading,
    line: patched.line,
    ledger: paths.ledger,
    resume_id: args.resume,
    term: args.term,
    status: "confirmed",
    source_update_required: false,
    reminder: "The master .docx must carry the same fact, or /refresh-cv will drop it on the next re-parse.",
  }, null, 2));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: Record<string, string>) => Promise<number>> = {
  record: cmdRecord,
  queue: cmdQueue,
  pending: cmdPending,
  "apply-patch": cmdApplyPatch,
};

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const handler = sub ? COMMANDS[sub] : undefined;
  if (!handler) {
    console.error(`Usage: tsx tools/resume/keyword-confirm.ts <${Object.keys(COMMANDS).join("|")}> [flags]`);
    process.exit(2);
  }
  process.exit(await handler(parseArgs(rest)));
}

if (process.argv[1] && /keyword-confirm\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(3);
  });
}
