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
 *   record      --file <answers.yaml> [--origin attended|daily]
 *               Batch form. The file maps term -> one of the four fixed answers
 *               ("Confirm and update source" | "Not applicable" |
 *               "Bring in as familiarity" | "Unsure / keep pending", or the
 *               aliases confirm|na|familiarity|pending), optionally with a
 *               `note`. Every pending keyword row matching the term is recorded
 *               in one pass, across resumes. Idempotent: a row already at the
 *               requested status is reported, not rewritten. No plan needed.
 *   queue       --plan <keyword-plan.json> [--origin daily]
 *               Records every plan question as `pending` without asking. Never
 *               downgrades an existing answered row. Runs the deterministic
 *               keyword triage first: a term a named reject rule refuses (ad
 *               furniture, a recruiter name, a date, clearance wording, a cut
 *               word) is appended to `keyword-rejects.jsonl` instead of
 *               entering the ledger, and is counted as `rejected_by_triage`.
 *   pending     [--resume <id>] [--group-by term] [--limit N] [--format json|table]
 *               Read-only. Lists outstanding `kind: keyword` rows, one per term
 *               across resumes (keyword answers are person-scoped).
 *               `--format table` (with `--group-by term`) prints the compact
 *               aligned drain sheet the review skills ask from.
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
import path from "node:path";
import YAML from "yaml";
import { resolveProfileContext } from "../profile-context.ts";
import { parseArgs, normalise, type KeywordPlan, type KeywordTerm } from "./keyword-lexicon.ts";
import { isPersonScoped, type MarketConfirmation } from "./market-lens-audit.ts";
import { loadTriageContext, triageRows, type TriageRow } from "./keyword-triage.ts";

export type KeywordConfirmStatus = "confirmed" | "declined" | "not_applicable" | "familiarity" | "pending";
/** Who answered. `triage` is `keyword-triage.ts`, which only ever answers a reject. */
export type KeywordOrigin = "attended" | "daily" | "triage";
const STATUSES: readonly KeywordConfirmStatus[] = ["confirmed", "declined", "not_applicable", "familiarity", "pending"];
/** Answered statuses are terminal for `queue`: an unattended run never reopens them. */
const ANSWERED: ReadonlySet<string> = new Set(["confirmed", "declined", "not_applicable", "familiarity"]);

const today = (): string => new Date().toISOString().slice(0, 10);
const key = (s: string): string => normalise(s).trim();

/**
 * The four fixed answers of the evidence interview (AGENTS.md section 9), plus
 * the short aliases a batch file may use. Keys are `key()`-normalised, so
 * "Unsure / keep pending", "unsure_keep_pending" and "pending" all land here.
 * Nothing else is accepted: an unrecognised answer is a usage error naming the
 * term, never a silent downgrade to `pending`.
 */
export const ANSWER_LABELS: Readonly<Record<string, KeywordConfirmStatus>> = {
  "confirm and update source": "confirmed",
  confirm: "confirmed",
  confirmed: "confirmed",
  "not applicable": "not_applicable",
  na: "not_applicable",
  "n a": "not_applicable",
  "bring in as familiarity": "familiarity",
  familiarity: "familiarity",
  familiar: "familiarity",
  "unsure keep pending": "pending",
  unsure: "pending",
  pending: "pending",
};

export function answerToStatus(answer: string): KeywordConfirmStatus | null {
  return ANSWER_LABELS[key(answer)] ?? null;
}

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
  opts: { status: KeywordConfirmStatus; opportunityId?: string | null; origin?: KeywordOrigin; notes?: string | null },
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

export type AnswerEntry = { term: string; answer: string; status: KeywordConfirmStatus | null; note: string | null };

/**
 * A batch answer file. Either a plain map, or the same map under `answers:`,
 * or a list of `{term, answer, note}`. The value may be the answer string or
 * an object carrying `answer`/`status` and `note`/`notes`.
 */
export function parseAnswerFile(text: string): AnswerEntry[] {
  const parsed = YAML.parse(text) as unknown;
  const body = (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "answers" in (parsed as Record<string, unknown>)
    ? (parsed as Record<string, unknown>).answers
    : parsed) as unknown;
  const pairs: { term: string; value: unknown }[] = [];
  if (Array.isArray(body)) {
    for (const item of body) {
      const row = item as Record<string, unknown>;
      const term = String(row?.term ?? "").trim();
      if (term) pairs.push({ term, value: row });
    }
  } else if (body && typeof body === "object") {
    for (const [term, value] of Object.entries(body as Record<string, unknown>)) if (term.trim()) pairs.push({ term: term.trim(), value });
  } else {
    throw new Error("Answer file must be a term -> answer map, an `answers:` map, or a list of {term, answer}.");
  }
  return pairs.map(({ term, value }) => {
    const object = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    const answer = String((object ? object.answer ?? object.status : value) ?? "").trim();
    const note = object ? String(object.note ?? object.notes ?? "").trim() || null : null;
    return { term, answer, status: answerToStatus(answer), note };
  });
}

export type RecordedAnswer = { term: string; status: KeywordConfirmStatus; rows: number; resumes: string[] };

export type AppliedAnswers = {
  recorded: RecordedAnswer[];
  skipped_already_answered: { term: string; status: string }[];
  unmatched: string[];
};

/**
 * Land a batch of validated answers in the ledger. Extracted from
 * `cmdRecordFile` so a caller that already has the answers in memory (the
 * local web UI's POST /api/keywords/record) writes them through exactly this
 * path rather than round-tripping a temp YAML through the CLI. Entries whose
 * `status` is null are the caller's to reject first; this function trusts it.
 *
 * Only `pending` rows move, and the ledger is written once, at the end.
 */
export async function applyAnswerEntries(
  entries: AnswerEntry[],
  opts: { ledger: string; origin?: KeywordOrigin; dryRun?: boolean },
): Promise<AppliedAnswers> {
  const rows = await readLedger(opts.ledger);
  const origin: KeywordOrigin = opts.origin ?? "attended";
  const recorded: RecordedAnswer[] = [];
  const skipped: { term: string; status: string }[] = [];
  const unmatched: string[] = [];
  for (const entry of entries) {
    const wanted = key(entry.term);
    const matches = rows.filter((r) => r.kind === "keyword" && (key(r.term ?? "") === wanted || key(r.signal ?? "") === wanted));
    if (!matches.length) { unmatched.push(entry.term); continue; }
    const targets = matches.filter((r) => r.status === "pending" && r.status !== entry.status);
    if (!targets.length) { skipped.push({ term: entry.term, status: matches[0].status }); continue; }
    for (const row of targets) {
      row.status = entry.status!;
      row.origin = origin;
      row.asked_at ??= today();
      row.updated_at = today();
      if (entry.status === "confirmed") row.source_update_required = true;
      else delete row.source_update_required;
      if (entry.note) row.notes = entry.note;
    }
    recorded.push({
      term: entry.term,
      status: entry.status!,
      rows: targets.length,
      resumes: [...new Set(targets.map((r) => r.resume_id).filter((id): id is string => Boolean(id)))],
    });
  }
  if (recorded.length && !opts.dryRun) await writeLedger(opts.ledger, rows);
  return { recorded, skipped_already_answered: skipped, unmatched };
}

/** The one line a batch owes the reader afterwards: a confirmed term is still unrenderable. */
export function recordNextStep(recorded: RecordedAnswer[]): string | null {
  return recorded.some((r) => r.status === "confirmed")
    ? "Confirmed terms authorise nothing yet. Run `keyword-confirm apply-patch` per confirmed term; the term stays unrenderable until cv-source.md carries the fact."
    : null;
}

/**
 * Batch record. The drain loop asks 4 terms per structured question, writes the
 * answers to one temp YAML and lands them here in a single pass, because 200+
 * pending terms is never going to be drained one CLI call per term.
 *
 * Only `pending` rows move. A row already answered (or already at the requested
 * status, which is what "Unsure / keep pending" means) is reported under
 * `skipped_already_answered`, so a second run of the same file is a no-op.
 */
export async function cmdRecordFile(args: Record<string, string>): Promise<number> {
  const paths = resolvePaths(args);
  let entries: AnswerEntry[];
  try {
    entries = parseAnswerFile(await fs.readFile(args.file, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${args.file}: ${(error as Error).message}`);
    return 2;
  }
  const invalid = entries.filter((e) => !e.status).map((e) => ({ term: e.term, answer: e.answer }));
  if (invalid.length) {
    for (const bad of invalid) console.error(`Invalid answer for ${JSON.stringify(bad.term)}: ${JSON.stringify(bad.answer)}. Use one of: Confirm and update source | Not applicable | Bring in as familiarity | Unsure / keep pending (aliases: confirm|na|familiarity|pending).`);
    console.log(JSON.stringify({ ledger: paths.ledger, recorded: [], skipped_already_answered: [], unmatched: [], invalid }, null, 2));
    return 2;
  }
  const applied = await applyAnswerEntries(entries, {
    ledger: paths.ledger,
    origin: args.origin === "daily" ? "daily" : "attended",
    dryRun: args["dry-run"] === "true",
  });
  console.log(JSON.stringify({
    action: "record-file",
    ledger: paths.ledger,
    file: args.file,
    dry_run: args["dry-run"] === "true",
    recorded: applied.recorded,
    skipped_already_answered: applied.skipped_already_answered,
    unmatched: applied.unmatched,
    invalid,
    next_step: recordNextStep(applied.recorded),
  }, null, 2));
  return 0;
}

export async function cmdRecord(args: Record<string, string>): Promise<number> {
  if (args.file && args.file !== "true") return cmdRecordFile(args);
  const status = args.status as KeywordConfirmStatus;
  if (!args.plan || !args.term || !STATUSES.includes(status)) {
    console.error("Usage: keyword-confirm record --plan <keyword-plan.json> --term <t> --status confirmed|declined|not_applicable|familiarity|pending [--opportunity <id>] [--origin attended|daily] [--notes ..]");
    console.error("   or: keyword-confirm record --file <answers.yaml> [--origin attended|daily]");
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

/**
 * Where a term the triage refused is logged instead of the ledger. One JSON
 * object per line, append-only: it is a record that the term was SEEN and
 * mechanically refused, so the same junk never re-enters the question queue and
 * a wrong rule is auditable afterwards. Never read back as an answer.
 */
export function rejectsPathFor(ledger: string): string {
  return path.join(path.dirname(ledger), "keyword-rejects.jsonl");
}

export async function appendRejects(
  file: string,
  rows: { term: string; rule: string; opportunity_id?: string | null; resume_id?: string | null }[],
): Promise<void> {
  if (!rows.length) return;
  const at = new Date().toISOString();
  await fs.appendFile(file, rows.map((r) => JSON.stringify({ at, ...r })).join("\n") + "\n");
}

/**
 * Queue a plan's questions as `pending`, with the deterministic keyword triage
 * in front of the ledger.
 *
 * The extractor is greedy by design, so most of what a JD yields is not a skill
 * at all (ad furniture, recruiter names, dates, clearance wording, cut words).
 * Those terms used to land as `pending` rows and then be put to the person as
 * "did you use or deliver <junk> in any role?". They are now refused here by a
 * named rule and appended to `keyword-rejects.jsonl` instead, so the ledger
 * only ever carries questions that could be about a skill.
 */
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

  const candidates: { term: KeywordTerm; row: TriageRow }[] = [];
  for (const question of plan.questions) {
    const term = findPlanTerm(plan, question.term);
    if (!term) continue;
    const existing = findRow(rows, plan.resume_id, term.term);
    if (existing && (ANSWERED.has(existing.status) || existing.status === "pending")) { skipped.push(term.term); continue; }
    candidates.push({
      term,
      row: {
        term: term.term,
        category: term.category,
        question: term.question ?? question.question ?? null,
        jd_context: term.jd_context ?? null,
        evidence_hint: term.evidence_hint ?? null,
        opportunity_id: args.opportunity ?? plan.opportunity_id ?? null,
        resume_id: plan.resume_id,
      },
    });
  }

  const rejected: { term: string; rule: string; evidence: string }[] = [];
  if (candidates.length) {
    const triage = await loadTriageContext({
      profile: args.profile,
      cvSource: args["cv-source"],
      taxonomy: args.taxonomy,
      clouds: args.clouds,
      boilerplate: args.boilerplate,
    });
    const verdicts = triageRows(candidates.map((c) => c.row), triage);
    verdicts.forEach((verdict, i) => {
      const candidate = candidates[i];
      if (verdict.decision === "reject") {
        rejected.push({ term: candidate.term.term, rule: verdict.rule, evidence: verdict.evidence });
        return;
      }
      rows = upsertKeywordRow(rows, rowFromPlanTerm(plan, candidate.term, {
        status: "pending",
        opportunityId: args.opportunity ?? null,
        origin: args.origin === "attended" ? "attended" : "daily",
      })).rows;
      queued.push(candidate.term.term);
    });
  }

  const rejectsPath = rejectsPathFor(paths.ledger);
  if (args["dry-run"] !== "true") {
    if (queued.length) await writeLedger(paths.ledger, rows);
    await appendRejects(rejectsPath, rejected.map((r) => ({
      term: r.term,
      rule: r.rule,
      opportunity_id: args.opportunity ?? plan.opportunity_id ?? null,
      resume_id: plan.resume_id,
    })));
  }
  console.log(JSON.stringify({
    action: "queue",
    ledger: paths.ledger,
    resume_id: plan.resume_id,
    opportunity_id: plan.opportunity_id,
    queued_count: queued.length,
    queued,
    already_recorded: skipped,
    rejected_by_triage: rejected.length,
    rejected,
    rejects_log: rejected.length ? rejectsPath : null,
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

export const PENDING_TABLE_HEADER = ["TERM", "N", "RESUMES", "CONTEXT"] as const;

const clip = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`);

/** First JD or title context this term was asked against: the opportunity it came from, else the evidence line, else the question. */
export function groupContext(group: PendingGroup): string {
  if (group.opportunities.length) return group.opportunities.join(", ");
  const text = group.evidence_hint ?? group.question ?? "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The drain sheet. One line per term, aligned, so 20 outstanding questions fit
 * on one screen and the reader can pick the four to ask next. No verdict is
 * implied: the answer is the person's, the tool only lays out the question.
 */
export function formatPendingTable(groups: PendingGroup[], opts: { ledger: string; pendingTotal: number; groupCount: number }): string {
  const widths = { term: 36, resumes: 36, context: 44 };
  const cells = groups.map((g) => [
    clip(g.term, widths.term),
    String(g.count),
    clip(g.resumes.join(", "), widths.resumes),
    clip(groupContext(g), widths.context),
  ]);
  const header = [...PENDING_TABLE_HEADER];
  const pad = header.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length), 0));
  const line = (row: string[]): string => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(pad[i]))).join("  ").trimEnd();
  return [
    `ledger: ${opts.ledger}`,
    line(header),
    ...cells.map(line),
    "",
    `${groups.length} of ${opts.groupCount} terms shown, ${opts.pendingTotal} pending rows.`,
    'Answer in bundles of 4, then: keyword-confirm record --file <answers.yaml>  (term: confirm | na | familiarity | pending)',
  ].join("\n");
}

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
  const table = args.format === "table";
  if (args["group-by"] === "term") {
    const groups = groupPending(rows, args.resume ?? null);
    const pendingTotal = groups.reduce((n, g) => n + g.count, 0);
    if (table) {
      console.log(formatPendingTable(groups.slice(0, limit), { ledger: paths.ledger, pendingTotal, groupCount: groups.length }));
      return 0;
    }
    console.log(JSON.stringify({ ledger: paths.ledger, pending_total: pendingTotal, group_count: groups.length, shown: Math.min(limit, groups.length), groups: groups.slice(0, limit) }, null, 2));
    return 0;
  }
  if (table) {
    console.error("Usage: keyword-confirm pending --group-by term --format table [--limit N] [--resume <id>]. The table is the per-term drain sheet; the ungrouped list stays JSON.");
    return 2;
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
