#!/usr/bin/env tsx
/**
 * critic-apply.ts — persist a resume-critic review and apply its proposed edits.
 *
 * WHY
 * ---
 * The deterministic gates (`resume:audit`, `resume:term-grounding`,
 * `editorial-bans`) decide mechanical facts. They cannot see that two adjacent
 * bullets say the same thing with a different prefix, that the summary claims
 * six years and a bullet claims four, or that a phrase is technically allowed
 * and still reads wrong. That judgement belongs to `agents/resume-critic.md`,
 * an isolated reviewer spawned by `.claude/skills/resume-critique/SKILL.md`.
 *
 * A review that lives only in chat is not a review. This module is the durable
 * half:
 *   - `--record-only` writes / extends `<prefix>.critic.json`: one entry per
 *     round with the verdict, findings, generated_at and the composition hash
 *     the round LEFT ON DISK (identical to the reviewed hash when the round
 *     changed nothing, which is every record-only round).
 *   - the default mode does that AND applies every finding that carries an
 *     exact `proposed_edit`, appending an `applied` / `skipped` outcome per
 *     finding into the same file, so the file is the whole review trail.
 *   - both modes stamp `critic: {verdict, round, at, composition_hash}` into
 *     the resume's `metadata.json`, which is what `resume:approve` gates on.
 *   - findings of kind `rule`, `register` or `duplicate` that recur across two
 *     or more resumes are appended to the profile's
 *     `resume-editorial-rules.md` under a dated "Learned from review" heading,
 *     so the next composition never has to be told twice.
 *
 * A findings file is a plan against ONE composition, so a unit path is a hint
 * and the finding's `quote` is the identity: every finding is resolved by
 * matching the live text against its quote before anything is written, and a
 * finding whose quote is gone is skipped rather than aimed at a shifted index.
 * A run in which nothing applied because everything was already applied is not
 * a round and appends nothing.
 *
 * Deletions of benchable units route through `lib/fit-ops.ts` so the provenance
 * sidecar is pruned in step (flat lists — highlights, credentials — are spliced
 * here, sidecar entry included), and every write goes through `lib/composition-io.ts` so the sidecar
 * split is honoured. This tool never invents text: it only writes the exact
 * `proposed_edit` the critic supplied, and it never writes `editorial-bans.yaml`
 * (a machine ban is a user decision; it only prints the suggestion).
 *
 * CLI:
 *   npm run resume:critic:apply -- --composition <path> --findings <json>
 *   npm run resume:critic:apply -- --composition <path> --findings <json> --record-only
 *   npm run resume:critic:apply -- --composition <path> --findings <json> --round 2 --dry-run
 */

import { readJsonIfExists } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResumeContent, ResumeSourceProvenance, ExperienceFeatured, ExperienceMentioned } from "../../templates/resume/_interface.ts";
import { loadComposition, writeComposition, compositionContentHash, compositionHash } from "./lib/composition-io.ts";
import { applyFitOps, benchKeyForExperience, type FitOp } from "./lib/fit-ops.ts";

/* ----------------------------------------------------------------- types */

export type CriticKind = "duplicate" | "contradiction" | "inconsistency" | "unsupported" | "register" | "clarity" | "rule";
export type CriticVerdict = "pass" | "revise" | "block";

export type CriticFinding = {
  id: string;
  kind: CriticKind;
  severity: "fail" | "warn";
  /** Either form is accepted; `unit_paths` wins when both are present. */
  unit_path?: string;
  unit_paths?: string[];
  quote?: string;
  quotes?: string[];
  why: string;
  /** Exact replacement text, or the literal "delete". Absent = judgement only. */
  proposed_edit?: string;
  source_lines?: unknown;
  /** Optional: the critic may name a literal phrase/regex worth banning. */
  forbidden_pattern?: string;
};

export type CriticReport = {
  resume: string;
  verdict: CriticVerdict;
  findings: CriticFinding[];
  summary_sentence: string;
};

/**
 * The plain shape an agent writes when it just wants to change some words.
 *
 * A critic finding is a *review artefact*: an id, a kind, a severity, the quote
 * it is identified by, a justification. Demanding all of that to replace one
 * sentence made the cheapest edit in the system the most expensive to express,
 * so agents hand-built findings JSON (and got the quote wrong, which silently
 * skipped the edit). An edit names the unit and the new text; everything else
 * is derived, and the quote is read from the live composition so it cannot be
 * stale by construction.
 */
export type SimpleEdit = {
  /** `experiences[2].bullets[0]`, `summary`, `highlights[1]`, `skills[0].bullets[2]`, … */
  path: string;
  /** The replacement text, or the literal `"delete"`. */
  text: string;
  why?: string;
  source_lines?: string[];
  id?: string;
  kind?: CriticKind;
  severity?: "fail" | "warn";
};

/** `--edits` / `--findings` accepts any of these. */
export type EditInput =
  | CriticReport
  | { edits: SimpleEdit[]; ops?: FitOp[]; resume?: string; summary?: string }
  | SimpleEdit[];

export type CriticOutcome = {
  id: string;
  status: "applied" | "skipped";
  unit_path: string | null;
  op: "replace" | "delete" | null;
  reason: string | null;
  /**
   * What the apply did BESIDES writing the text — the sidecar surgery a reader
   * would otherwise have to diff two files to notice: a spliced provenance
   * evidence list, a renamed evidence / bench key. Absent when there was none.
   */
  note?: string;
};

export type CriticRound = CriticReport & {
  round: number;
  generated_at: string;
  /**
   * Hash of the composition this round LEFT ON DISK (provenance excluded), i.e.
   * what `resume:approve` will hash when it checks the stamp. Stamping the
   * pre-apply hash instead would mark every applying round instantly stale.
   */
  composition_hash: string | null;
  outcomes: CriticOutcome[];
};

/** `<prefix>.critic.json` — the durable review trail beside the composition. */
export type CriticReviewFile = {
  resume: string;
  verdict: CriticVerdict;
  round: number;
  generated_at: string;
  composition_hash: string | null;
  summary_sentence: string;
  /** The latest round's findings, so a reader does not have to walk `rounds`. */
  findings: CriticFinding[];
  rounds: CriticRound[];
};

/* ------------------------------------------------------------- io paths */

/** `<prefix>.composition.json` → `<prefix>.critic.json`. */
export function criticSidecarPath(compositionPath: string): string {
  if (compositionPath.endsWith(".composition.json")) return compositionPath.replace(/\.composition\.json$/, ".critic.json");
  return compositionPath.replace(/\.json$/, "") + ".critic.json";
}

/** Tolerant on purpose: a missing or corrupt sidecar means "no review", not a crash. */
async function readJson(file: string): Promise<any | null> {
  return readJsonIfExists(file).catch(() => null);
}

export async function loadCriticReview(compositionPath: string): Promise<CriticReviewFile | null> {
  return (await readJson(criticSidecarPath(compositionPath))) as CriticReviewFile | null;
}

/* --------------------------------------------------------- unit address */

type TextSlot = { read: () => string | undefined; write: (value: string) => void };

/**
 * Resolve a composition unit path to a readable/writable text slot. Covers
 * every authored text field the critic can quote, which is a wider surface
 * than the fit ladder's four movable unit kinds.
 */
export function textSlot(content: ResumeContent, unitPath: string): TextSlot | null {
  const asFeatured = (i: number): ExperienceFeatured | null => {
    const xp = content.experiences?.[i];
    return xp && xp.placement === "feature" ? xp : null;
  };
  const asMention = (i: number): ExperienceMentioned | null => {
    const xp = content.experiences?.[i];
    return xp && xp.placement === "mention" ? xp : null;
  };

  if (unitPath === "summary") return { read: () => content.summary, write: (v) => { content.summary = v; } };
  if (unitPath === "headline") return { read: () => content.headline, write: (v) => { content.headline = v; } };
  if (unitPath === "additional_skills_summary") {
    return { read: () => content.additional_skills_summary, write: (v) => { content.additional_skills_summary = v; } };
  }

  // Index-addressed and placement-dependent paths resolve eagerly: a path that
  // does not address live text right now is `null`, not a slot that silently
  // reads undefined. The caller can then say WHY it skipped the finding.
  let m = unitPath.match(/^highlights\[(\d+)\]$/);
  if (m) {
    const i = Number(m[1]);
    if (content.highlights?.[i] === undefined) return null;
    return { read: () => content.highlights[i], write: (v) => { content.highlights[i] = v; } };
  }

  m = unitPath.match(/^credentials\[(\d+)\]$/);
  if (m) {
    const i = Number(m[1]);
    if (content.credentials?.[i] === undefined) return null;
    return { read: () => content.credentials![i], write: (v) => { content.credentials![i] = v; } };
  }

  m = unitPath.match(/^skills\[(\d+)\]\.bullets\[(\d+)\]$/);
  if (m) {
    const [i, j] = [Number(m[1]), Number(m[2])];
    if (content.skills?.[i]?.bullets?.[j] === undefined) return null;
    return { read: () => content.skills[i].bullets[j], write: (v) => { content.skills[i].bullets[j] = v; } };
  }
  m = unitPath.match(/^skills\[(\d+)\]\.(name|summary)$/);
  if (m) {
    const i = Number(m[1]); const field = m[2] as "name" | "summary";
    if (content.skills?.[i]?.[field] === undefined) return null;
    return { read: () => content.skills[i][field], write: (v) => { (content.skills[i] as any)[field] = v; } };
  }

  m = unitPath.match(/^experiences\[(\d+)\]\.bullets\[(\d+)\]$/);
  if (m) {
    const [i, j] = [Number(m[1]), Number(m[2])];
    if (asFeatured(i)?.bullets?.[j] === undefined) return null;
    return { read: () => asFeatured(i)!.bullets[j], write: (v) => { asFeatured(i)!.bullets[j] = v; } };
  }
  m = unitPath.match(/^experiences\[(\d+)\]\.summary$/);
  if (m) {
    const i = Number(m[1]);
    if (asFeatured(i)?.summary === undefined) return null;
    return { read: () => asFeatured(i)!.summary, write: (v) => { asFeatured(i)!.summary = v; } };
  }
  m = unitPath.match(/^experiences\[(\d+)\]\.one_liner$/);
  if (m) {
    const i = Number(m[1]);
    if (asMention(i)?.one_liner === undefined) return null;
    return { read: () => asMention(i)!.one_liner, write: (v) => { asMention(i)!.one_liner = v; } };
  }
  m = unitPath.match(/^experiences\[(\d+)\]\.(title|company)$/);
  if (m) {
    const i = Number(m[1]); const field = m[2] as "title" | "company";
    if (content.experiences?.[i]?.[field] === undefined) return null;
    return { read: () => content.experiences[i][field], write: (v) => { (content.experiences[i] as any)[field] = v; } };
  }
  // Location is optional prose in the heading; an absent one reads as "" so a
  // finding can set it, and "" written clears it.
  m = unitPath.match(/^experiences\[(\d+)\]\.location$/);
  if (m) {
    const i = Number(m[1]);
    if (!content.experiences?.[i]) return null;
    return { read: () => content.experiences[i].location ?? "", write: (v) => { (content.experiences[i] as any).location = v; } };
  }

  return null;
}

/** The primary unit path a finding addresses. */
export function primaryUnitPath(finding: CriticFinding): string | null {
  const first = finding.unit_paths?.[0] ?? finding.unit_path;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

function isDelete(edit: string): boolean {
  return edit.trim().toLowerCase() === "delete";
}

/* ------------------------------------------------- quote-verified resolve */

/**
 * WHY THIS EXISTS
 * ---------------
 * A findings file is a plan against ONE composition. A unit path is an index,
 * and an index is only true of the composition the critic read. Re-running the
 * same findings file against an already-edited composition used to re-apply
 * every `delete` at its now-shifted index, quietly removing a different unit
 * each time. So a path is a hint, never an address: the finding's `quote` is
 * the identity of the unit, and a finding whose quote no longer exists has
 * already been applied (or its unit changed) and must be a no-op.
 */
export const REASON_ALREADY_APPLIED = "already applied";
export const REASON_QUOTE_NOT_FOUND = "quote not found (already applied or unit changed)";

/** Whitespace is a rendering detail; the words are the identity. */
export function normaliseForMatch(text: string | undefined | null): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** The quote a finding identifies its unit by, normalised, or null if it gave none. */
export function findingQuote(finding: CriticFinding): string | null {
  const raw = finding?.quotes?.[0] ?? finding?.quote;
  return normaliseForMatch(raw) || null;
}

/**
 * The live text a unit path addresses. Wider than `textSlot` by one case: a
 * bare `experiences[i]` (what a `drop_mention` deletion names) has no text
 * slot, but it does have identifying prose.
 */
export function readUnit(content: ResumeContent, unitPath: string): string | undefined {
  const m = unitPath.match(/^experiences\[(\d+)\]$/);
  if (m) {
    const xp = content.experiences?.[Number(m[1])];
    if (!xp) return undefined;
    return xp.placement === "mention" ? xp.one_liner : xp.summary;
  }
  return textSlot(content, unitPath)?.read();
}

/* ------------------------------------------------------ simple edit input */

/**
 * Normalise whatever the caller handed us into (a) a critic report and (b) a
 * list of fit ops.
 *
 * Three accepted shapes:
 *   1. a full critic report (it has `findings`) — passed through untouched, so
 *      the resume-critic's own output keeps working byte for byte;
 *   2. `{ edits: [...], ops?: [...], resume?, summary? }`;
 *   3. a bare array of edits.
 *
 * Every synthesised finding takes its `quote` from the LIVE composition rather
 * than from the caller, which is the whole point: a quote the caller typed can
 * disagree with the document by a comma and be skipped as "quote not found",
 * and that failure mode is invisible in a chat transcript.
 */
/**
 * The fit ops carried by an input file, WITHOUT looking at the composition.
 *
 * `normaliseEditInput` reads each edit's identifying quote off the live
 * composition, so it can only run once the ops have landed (an op that restores
 * or drops a bullet moves every index below it, and creates units the edits may
 * be aimed at). The ops themselves need no composition to be read out, so
 * `resume:edit` pulls them with this first, runs them, reloads, and only then
 * normalises the edits. See the ordering note in resume-edit.ts.
 */
export function extractOps(raw: unknown): FitOp[] {
  const bag: any = Array.isArray(raw) ? { edits: raw } : raw;
  return bag && typeof bag === "object" && Array.isArray(bag.ops) ? (bag.ops as FitOp[]) : [];
}

export function normaliseEditInput(raw: unknown, content: ResumeContent): { report: CriticReport; ops: FitOp[] } {
  const bag: any = Array.isArray(raw) ? { edits: raw } : raw;
  if (!bag || typeof bag !== "object") {
    throw new Error('edits: expected a critic report, { "edits": [...] }, or an array of edits');
  }
  if (Array.isArray(bag.findings)) {
    return { report: bag as CriticReport, ops: Array.isArray(bag.ops) ? (bag.ops as FitOp[]) : [] };
  }
  if (!Array.isArray(bag.edits)) {
    throw new Error('edits: expected a critic report (with "findings"), { "edits": [...] }, or an array of edits');
  }

  const findings: CriticFinding[] = (bag.edits as SimpleEdit[]).map((edit, i) => {
    const where = `edits[${i}]`;
    const unitPath = typeof edit?.path === "string" ? edit.path.trim() : "";
    if (!unitPath) throw new Error(`${where}: missing "path"`);
    const text = typeof edit?.text === "string" ? edit.text : "";
    if (!text.trim()) throw new Error(`${where} (${unitPath}): missing "text" — use "delete" to remove the unit`);
    const quote = readUnit(content, unitPath);
    if (quote === undefined) {
      throw new Error(`${where}: "${unitPath}" does not resolve to a unit in this composition`);
    }
    return {
      id: edit.id?.trim() || `e${i + 1}`,
      kind: edit.kind ?? "clarity",
      severity: edit.severity ?? "warn",
      unit_path: unitPath,
      quote,
      why: edit.why ?? "edit",
      proposed_edit: text,
      ...(edit.source_lines ? { source_lines: edit.source_lines } : {}),
    };
  });

  return {
    report: {
      resume: String(bag.resume ?? content.resumeId ?? ""),
      verdict: "revise",
      findings,
      summary_sentence: String(bag.summary ?? `${findings.length} edits applied via resume:edit`),
    },
    ops: Array.isArray(bag.ops) ? (bag.ops as FitOp[]) : [],
  };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/**
 * Sibling paths to search when a quote does not match at the named path:
 * `block` is the finding's own owning block (the experience, the skills block,
 * the highlights list), `wide` is every unit of the same kind in the document.
 * The block is searched first because that is where an index shift lands it;
 * the wide sweep is a last resort and only counts when it is unambiguous.
 */
function candidatePaths(content: ResumeContent, unitPath: string): { block: string[]; wide: string[] } {
  const experiences = content.experiences ?? [];
  const bulletCount = (i: number): number => {
    const xp = experiences[i];
    return xp && xp.placement === "feature" && Array.isArray(xp.bullets) ? xp.bullets.length : 0;
  };
  const skillBulletCount = (i: number): number => (Array.isArray(content.skills?.[i]?.bullets) ? content.skills[i].bullets.length : 0);

  let m = unitPath.match(/^experiences\[(\d+)\]\.bullets\[\d+\]$/);
  if (m) {
    const i = Number(m[1]);
    return {
      block: range(bulletCount(i)).map((j) => `experiences[${i}].bullets[${j}]`),
      wide: range(experiences.length).flatMap((k) => range(bulletCount(k)).map((j) => `experiences[${k}].bullets[${j}]`)),
    };
  }
  m = unitPath.match(/^skills\[(\d+)\]\.bullets\[\d+\]$/);
  if (m) {
    const i = Number(m[1]);
    return {
      block: range(skillBulletCount(i)).map((j) => `skills[${i}].bullets[${j}]`),
      wide: range(content.skills?.length ?? 0).flatMap((k) => range(skillBulletCount(k)).map((j) => `skills[${k}].bullets[${j}]`)),
    };
  }
  if (/^highlights\[\d+\]$/.test(unitPath)) {
    const paths = range(content.highlights?.length ?? 0).map((i) => `highlights[${i}]`);
    return { block: paths, wide: paths };
  }
  if (/^credentials\[\d+\]$/.test(unitPath)) {
    const paths = range(content.credentials?.length ?? 0).map((i) => `credentials[${i}]`);
    return { block: paths, wide: paths };
  }
  m = unitPath.match(/^(experiences)\[\d+\]\.(summary|one_liner|title)$/);
  if (m) {
    const paths = range(experiences.length).map((i) => `experiences[${i}].${m![2]}`);
    return { block: paths, wide: paths };
  }
  m = unitPath.match(/^skills\[\d+\]\.(name|summary)$/);
  if (m) {
    const paths = range(content.skills?.length ?? 0).map((i) => `skills[${i}].${m![1]}`);
    return { block: paths, wide: paths };
  }
  if (/^experiences\[\d+\]$/.test(unitPath)) {
    const paths = range(experiences.length).map((i) => `experiences[${i}]`);
    return { block: paths, wide: paths };
  }
  // summary, headline, additional_skills_summary: one unit, no siblings.
  return { block: [], wide: [] };
}

function matchingPaths(content: ResumeContent, paths: string[], normalisedText: string): string[] {
  return paths.filter((p) => {
    const text = readUnit(content, p);
    return text !== undefined && normaliseForMatch(text) === normalisedText;
  });
}

/**
 * Resolve the unit a finding actually means. The named path wins when its text
 * still matches the quote; otherwise the owning block is searched, then the
 * document, and an ambiguous wide match resolves to nothing rather than to a
 * guess.
 */
export function resolveUnitPath(content: ResumeContent, unitPath: string, normalisedQuote: string): string | null {
  const atPath = readUnit(content, unitPath);
  if (atPath !== undefined && normaliseForMatch(atPath) === normalisedQuote) return unitPath;
  const { block, wide } = candidatePaths(content, unitPath);
  const inBlock = matchingPaths(content, block, normalisedQuote);
  if (inBlock.length) return inBlock[0];
  const elsewhere = matchingPaths(content, wide.filter((p) => !block.includes(p)), normalisedQuote);
  return elsewhere.length === 1 ? elsewhere[0] : null;
}

/**
 * Has this deletion already happened in an earlier round? Returns that round
 * number, or null.
 *
 * WHY THIS EXISTS
 * ---------------
 * Replay safety normally comes for free: a critic's finding carries the quote
 * of the text it reviewed, so re-running the file finds nothing to match and
 * skips. A SIMPLE edit (`{ path, text: "delete" }`) has no quote of its own —
 * `normaliseEditInput` reads it off the LIVE composition — so on a second run
 * the same path yields the text of whatever moved up into that slot, and the
 * delete would happily remove a bullet nobody asked about.
 *
 * The review trail already knows better. If an earlier round applied a delete
 * at this path, and the text that round recorded is nowhere in the composition
 * now, the deletion landed and this is a replay.
 */
export function deleteAlreadyApplied(rounds: CriticRound[], unitPath: string, content: ResumeContent): number | null {
  for (const round of rounds) {
    for (const outcome of round?.outcomes ?? []) {
      if (outcome.op !== "delete" || outcome.status !== "applied" || outcome.unit_path !== unitPath) continue;
      const quote = findingQuote((round.findings ?? []).find((f) => f.id === outcome.id) as CriticFinding);
      if (quote && !resolveUnitPath(content, unitPath, quote)) return round.round;
    }
  }
  return null;
}

/* --------------------------------------------------------- key renaming */

/** Rewrite one key of a record in place, keeping the record's key order. */
function renameKey<T>(record: Record<string, T> | undefined, from: string, to: string): boolean {
  if (!record || !(from in record) || from === to) return false;
  const entries = Object.entries(record).map(([k, v]) => [k === from ? to : k, v] as const);
  for (const k of Object.keys(record)) delete record[k];
  for (const [k, v] of entries) record[k] = v as T;
  return true;
}

/**
 * A skills block is keyed by its NAME, not its slot: the provenance sidecar
 * stores its evidence under `evidence.skills[<name>]` and the fit ladder parks
 * its benched items under `bench.skill_items[<name>]` (see `benchKeyForSkill`).
 *
 * So renaming a block — a perfectly ordinary `skills[i].name` replacement —
 * orphans both: the provenance gate then reports `skills['<new name>']: no
 * source references` for a block whose evidence is sitting right there under
 * the old name. Rename the keys in the same apply, and say so in the outcome.
 */
export function renameSkillBlockKeys(
  content: ResumeContent,
  provenance: ResumeSourceProvenance | null,
  from: string,
  to: string,
): string | null {
  const moved: string[] = [];
  if (renameKey(provenance?.evidence?.skills as Record<string, unknown> | undefined, from, to)) {
    moved.push(`provenance.evidence.skills['${from}'] → ['${to}']`);
  }
  if (renameKey(content.bench?.skill_items as Record<string, unknown> | undefined, from, to)) {
    moved.push(`bench.skill_items['${from}'] → ['${to}']`);
  }
  return moved.length ? `renamed ${moved.join(" and ")}` : null;
}

/**
 * An experience's title and company are part of its key in the provenance
 * sidecar (`title|company|start|end`) and on the bench (`bench.bullets`).
 * Renaming either has to carry both keys, or the evidence is orphaned.
 */
export function renameExperienceKeys(
  content: ResumeContent,
  provenance: ResumeSourceProvenance | null,
  from: string,
  to: string,
): string | null {
  const moved: string[] = [];
  if (renameKey(provenance?.evidence?.experiences as Record<string, unknown> | undefined, from, to)) {
    moved.push(`provenance.evidence.experiences['${from}'] → ['${to}']`);
  }
  if (renameKey(content.bench?.bullets as Record<string, unknown> | undefined, from, to)) {
    moved.push(`bench.bullets['${from}'] → ['${to}']`);
  }
  return moved.length ? `renamed ${moved.join(" and ")}` : null;
}

/* ------------------------------------------------------------- applying */

export type ApplyResult = {
  content: ResumeContent;
  provenance: ResumeSourceProvenance | null;
  outcomes: CriticOutcome[];
};

/**
 * Apply every finding that carries an exact `proposed_edit`.
 *
 * Order matters: in-place replacements run first (they never move an index),
 * then deletions run as ONE `applyFitOps` batch, which pins each op to the
 * pre-plan composition, so a plan naming two bullets cannot delete the wrong
 * one. Highlights and credentials have no fit op (nothing benches them), so
 * they are spliced here in descending index order with their parallel
 * provenance evidence entry pruned alongside.
 *
 * A replacement on `skills[i].name` also renames that block's keys in the
 * provenance sidecar and on the bench — see `renameSkillBlockKeys`.
 *
 * Every finding that carries a quote is resolved by quote, not by index (see
 * `resolveUnitPath`), so re-running the same findings file is a no-op instead
 * of a second, differently-aimed edit. Deletions resolve after the
 * replacements have landed, against the text as it then stands.
 */
export function applyCriticFindings(input: {
  content: ResumeContent;
  provenance?: ResumeSourceProvenance | null;
  findings: CriticFinding[];
  /**
   * Earlier rounds from `<prefix>.critic.json`, used only to recognise a
   * deletion that has already happened. See `deleteAlreadyApplied`.
   */
  priorRounds?: CriticRound[];
}): ApplyResult {
  const outcomes: CriticOutcome[] = [];
  let content: ResumeContent = JSON.parse(JSON.stringify(input.content));
  let provenance: ResumeSourceProvenance | null = input.provenance === undefined
    ? input.content.source_provenance ?? null
    : input.provenance;
  if (provenance) provenance = JSON.parse(JSON.stringify(provenance));

  const deletions: Array<{ finding: CriticFinding; unitPath: string }> = [];

  for (const finding of input.findings ?? []) {
    const id = String(finding?.id ?? "(unnamed)");
    const unitPath = primaryUnitPath(finding);
    const edit = typeof finding?.proposed_edit === "string" ? finding.proposed_edit : "";

    if (!edit.trim()) {
      outcomes.push({ id, status: "skipped", unit_path: unitPath, op: null, reason: "no exact proposed_edit" });
      continue;
    }
    if (!unitPath) {
      outcomes.push({ id, status: "skipped", unit_path: null, op: null, reason: "no unit_path" });
      continue;
    }
    if (isDelete(edit)) { deletions.push({ finding, unitPath }); continue; }

    const quote = findingQuote(finding);
    const normalisedEdit = normaliseForMatch(edit);

    // "Already applied" is decided before anything else: a replacement whose
    // text is already in place is a no-op whatever its path now points at.
    const atPath = readUnit(content, unitPath);
    if (atPath !== undefined && normaliseForMatch(atPath) === normalisedEdit) {
      outcomes.push({ id, status: "skipped", unit_path: unitPath, op: "replace", reason: REASON_ALREADY_APPLIED });
      continue;
    }

    let targetPath = unitPath;
    if (quote) {
      const resolved = resolveUnitPath(content, unitPath, quote);
      if (!resolved) {
        const alreadyEdited = resolveUnitPath(content, unitPath, normalisedEdit);
        outcomes.push({
          id, status: "skipped", unit_path: unitPath, op: "replace",
          reason: alreadyEdited ? REASON_ALREADY_APPLIED : REASON_QUOTE_NOT_FOUND,
        });
        continue;
      }
      targetPath = resolved;
    }

    const slot = textSlot(content, targetPath);
    if (!slot) {
      outcomes.push({ id, status: "skipped", unit_path: targetPath, op: "replace", reason: "unit_path does not address a text unit" });
      continue;
    }
    const current = slot.read();
    if (current === undefined) {
      outcomes.push({ id, status: "skipped", unit_path: targetPath, op: "replace", reason: "unit_path resolves to nothing in this composition" });
      continue;
    }
    if (normaliseForMatch(current) === normalisedEdit) {
      outcomes.push({ id, status: "skipped", unit_path: targetPath, op: "replace", reason: REASON_ALREADY_APPLIED });
      continue;
    }
    const xpKeyMatch = targetPath.match(/^experiences\[(\d+)\]\.(title|company)$/);
    const xpKeyBefore = xpKeyMatch ? benchKeyForExperience(content.experiences[Number(xpKeyMatch[1])]) : null;
    slot.write(edit);
    // A skills block's name, and an experience's title or company, are keys in
    // the sidecars; renaming them has to carry the keys, or the evidence is
    // orphaned under the old name.
    const renamedNote = /^skills\[\d+\]\.name$/.test(targetPath)
      ? renameSkillBlockKeys(content, provenance, String(current), edit)
      : xpKeyMatch && xpKeyBefore
        ? renameExperienceKeys(content, provenance, xpKeyBefore, benchKeyForExperience(content.experiences[Number(xpKeyMatch[1])]))
        : null;
    outcomes.push({
      id, status: "applied", unit_path: targetPath, op: "replace", reason: null,
      ...(renamedNote ? { note: renamedNote } : {}),
    });
  }

  // --- deletions: flat lists by hand, everything else through the fit ladder.
  const listDeletes: Array<{ finding: CriticFinding; list: "highlights" | "credentials"; index: number }> = [];
  const ops: FitOp[] = [];
  const opFindings: CriticFinding[] = [];

  for (const { finding, unitPath: namedPath } of deletions) {
    const id = String(finding?.id ?? "(unnamed)");
    const quote = findingQuote(finding);
    let unitPath = namedPath;
    if (quote) {
      const resolved = resolveUnitPath(content, namedPath, quote);
      if (!resolved) {
        outcomes.push({ id, status: "skipped", unit_path: namedPath, op: "delete", reason: REASON_QUOTE_NOT_FOUND });
        continue;
      }
      unitPath = resolved;
    }
    // The quote resolved, so this deletion is about to remove something. Ask
    // the review trail whether it already did — see `deleteAlreadyApplied`.
    if (deleteAlreadyApplied(input.priorRounds ?? [], namedPath, content) !== null) {
      outcomes.push({ id, status: "skipped", unit_path: namedPath, op: "delete", reason: REASON_ALREADY_APPLIED });
      continue;
    }
    const flat = unitPath.match(/^(highlights|credentials)\[(\d+)\]$/);
    if (flat) { listDeletes.push({ finding, list: flat[1] as "highlights" | "credentials", index: Number(flat[2]) }); continue; }
    if (/^experiences\[\d+\]\.bullets\[\d+\]$/.test(unitPath)) { ops.push({ op: "drop_bullet", path: unitPath }); opFindings.push(finding); continue; }
    if (/^skills\[\d+\]\.bullets\[\d+\]$/.test(unitPath)) { ops.push({ op: "drop_skill_item", path: unitPath }); opFindings.push(finding); continue; }
    if (/^experiences\[\d+\]$/.test(unitPath)) { ops.push({ op: "drop_mention", path: unitPath }); opFindings.push(finding); continue; }
    outcomes.push({ id, status: "skipped", unit_path: unitPath, op: "delete", reason: "delete is not supported for this unit kind" });
  }

  if (ops.length) {
    const result = applyFitOps({ content, provenance }, ops);
    content = result.content;
    provenance = result.provenance;
    const skippedReason = new Map<string, string>();
    for (const s of result.skipped) skippedReason.set(`${s.op.op}:${(s.op as { path?: string }).path ?? ""}`, s.reason);
    for (let i = 0; i < ops.length; i += 1) {
      const key = `${ops[i].op}:${(ops[i] as { path?: string }).path ?? ""}`;
      const reason = skippedReason.get(key);
      const id = String(opFindings[i]?.id ?? "(unnamed)");
      outcomes.push(reason
        ? { id, status: "skipped", unit_path: ops[i].path ?? null, op: "delete", reason }
        : { id, status: "applied", unit_path: ops[i].path ?? null, op: "delete", reason: null });
    }
  }

  // Highlights and credentials are flat string lists with a parallel list of
  // evidence refs and no bench (nothing in the fit ladder moves them), so the
  // deletion is a plain splice of both lists, in descending index order so an
  // earlier splice cannot shift a later one. Losing the ref silently would leave
  // the sidecar one entry long and mis-pair every credential below the hole.
  for (const { finding, list, index } of listDeletes.sort((a, b) => b.index - a.index)) {
    const id = String(finding?.id ?? "(unnamed)");
    const unitPath = `${list}[${index}]`;
    const items = content[list];
    if (!Array.isArray(items) || items[index] === undefined) {
      outcomes.push({ id, status: "skipped", unit_path: unitPath, op: "delete", reason: `${list} index is not in this composition` });
      continue;
    }
    items.splice(index, 1);
    const refs = provenance?.evidence?.[list];
    const pruned = Array.isArray(refs) && refs.length > index;
    if (pruned) refs!.splice(index, 1);
    outcomes.push({
      id, status: "applied", unit_path: unitPath, op: "delete", reason: null,
      note: pruned
        ? `spliced provenance.evidence.${list}[${index}] with it`
        : `no provenance.evidence.${list}[${index}] to splice`,
    });
  }

  if (content.source_provenance && provenance) content.source_provenance = provenance;
  return { content, provenance, outcomes };
}

/* ------------------------------------------------------- recurrence rule */

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

/* ------------------------------------------------------------ recording */

/**
 * A replay — the same findings file run a second time — changed nothing and is
 * not a round. It is recognised by its outcomes: every finding that could have
 * edited something (an `op` was chosen for it) was skipped because its text is
 * already in place or its quote no longer exists. A review with no actionable
 * findings at all is NOT a replay: a judgement-only "revise", or a "pass" with
 * an empty findings list, is a real round and must be recorded, because
 * `resume:approve` gates on that record.
 */
export function isNoopReplay(outcomes: CriticOutcome[]): boolean {
  const actionable = outcomes.filter((o) => o.op !== null);
  if (!actionable.length) return false;
  return actionable.every((o) => o.status === "skipped"
    && (o.reason === REASON_ALREADY_APPLIED || o.reason === REASON_QUOTE_NOT_FOUND));
}

function nextRound(review: CriticReviewFile | null, explicit?: number): number {
  if (Number.isFinite(explicit)) return Number(explicit);
  const highest = (review?.rounds ?? []).reduce((max, r) => Math.max(max, Number(r?.round) || 0), 0);
  return highest + 1;
}

export function mergeRound(review: CriticReviewFile | null, round: CriticRound): CriticReviewFile {
  const rounds = (review?.rounds ?? []).filter((r) => Number(r?.round) !== round.round);
  rounds.push(round);
  rounds.sort((a, b) => Number(a.round) - Number(b.round));
  return {
    resume: round.resume,
    verdict: round.verdict,
    round: round.round,
    generated_at: round.generated_at,
    composition_hash: round.composition_hash,
    summary_sentence: round.summary_sentence,
    findings: round.findings,
    rounds,
  };
}

/** Stamp the critic verdict into the resume's metadata.json, if one exists. */
export async function stampMetadata(dir: string, round: CriticRound): Promise<string | null> {
  const metaPath = path.join(dir, "metadata.json");
  const meta = await readJson(metaPath);
  if (!meta) return null;
  meta.critic = {
    verdict: round.verdict,
    round: round.round,
    at: round.generated_at,
    composition_hash: round.composition_hash,
  };
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return metaPath;
}

/* ------------------------------------------------------------------ CLI */

export type CriticApplyResult = {
  composition: string;
  critic_json: string;
  provenance_json: string | null;
  metadata_json: string | null;
  /** False when the run was a replay of an already-applied findings file. */
  recorded: boolean;
  resume: string;
  verdict: CriticVerdict;
  round: number;
  composition_hash: string | null;
  applied: CriticOutcome[];
  skipped: CriticOutcome[];
  learned_rules: RecurringFinding[];
  suggested_bans: string[];
  summary_sentence: string;
  /**
   * Fit ops carried by the input. `resume:critic:apply` does NOT apply them —
   * `resume:edit` does — so they are reported rather than silently dropped.
   */
  ops: FitOp[];
};

export async function runCriticApply(args: {
  composition: string;
  /** Path to a critic report / edits file. One of `findings` or `report` is required. */
  findings?: string;
  /** An already-normalised report (what `resume:edit` hands over in-process). */
  report?: CriticReport;
  round?: number;
  recordOnly?: boolean;
  dryRun?: boolean;
  today?: Date;
}): Promise<CriticApplyResult> {
  const loaded = await loadComposition(args.composition);

  let report: CriticReport;
  let ops: FitOp[] = [];
  if (args.report) {
    report = args.report;
  } else {
    if (!args.findings) throw new Error("runCriticApply: one of `findings` (a path) or `report` is required");
    const raw = await readJson(args.findings);
    if (!raw) throw new Error(`${args.findings}: not readable as JSON`);
    const normalised = normaliseEditInput(raw, loaded.content);
    report = normalised.report;
    ops = normalised.ops;
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];

  const dir = path.dirname(path.resolve(args.composition));
  const criticPath = criticSidecarPath(args.composition);
  const existing = (await readJson(criticPath)) as CriticReviewFile | null;

  const applyResult = args.recordOnly
    ? { content: loaded.content, provenance: loaded.provenance, outcomes: findings.map((f): CriticOutcome => ({
        id: String(f?.id ?? "(unnamed)"), status: "skipped", unit_path: primaryUnitPath(f), op: null, reason: "record-only run",
      })) }
    : applyCriticFindings({ content: loaded.content, provenance: loaded.provenance, findings, priorRounds: existing?.rounds ?? [] });

  let provenancePath: string | null = loaded.provenancePath;
  let metadataPath: string | null = null;
  const appliedCount = applyResult.outcomes.filter((o) => o.status === "applied").length;
  const noop = isNoopReplay(args.recordOnly ? [] : applyResult.outcomes);
  const edits = !args.recordOnly && appliedCount > 0;

  // Write the composition BEFORE stamping, then hash what landed. The stamp has
  // to describe the composition `resume:approve` will hash, and this round's
  // own edits are part of that composition; hashing before the write recorded a
  // state that no longer existed the moment the round finished.
  if (!args.dryRun && !noop && edits) {
    const written = await writeComposition(args.composition, applyResult.content, { provenance: applyResult.provenance });
    provenancePath = written.provenancePath;
  }
  const stampedHash = !args.dryRun && !noop
    ? await compositionContentHash(args.composition)
    : compositionHash(edits ? applyResult.content : loaded.content);

  const round: CriticRound = {
    resume: String(report.resume || loaded.content.resumeId || path.basename(dir)),
    verdict: (report.verdict as CriticVerdict) ?? "revise",
    summary_sentence: String(report.summary_sentence ?? ""),
    findings,
    round: nextRound(existing, args.round),
    generated_at: new Date().toISOString(),
    composition_hash: stampedHash,
    outcomes: applyResult.outcomes,
  };
  const review = mergeRound(existing, round);

  if (!args.dryRun && !noop) {
    await fs.writeFile(criticPath, `${JSON.stringify(review, null, 2)}\n`);
    metadataPath = await stampMetadata(dir, round);
  }

  // Durability into rules: only after the round is on disk, so recurrence sees it.
  let learned: RecurringFinding[] = [];
  const resumesDir = path.dirname(dir);
  const rulesPath = path.join(path.dirname(resumesDir), "resume-editorial-rules.md");
  if (!args.dryRun && !noop) {
    const recurring = findRecurringFindings(await collectReviews(resumesDir));
    learned = await appendLearnedRules(rulesPath, recurring, args.today);
  }

  return {
    composition: path.resolve(args.composition),
    critic_json: criticPath,
    provenance_json: provenancePath,
    metadata_json: metadataPath,
    recorded: !args.dryRun && !noop,
    resume: round.resume,
    verdict: round.verdict,
    round: noop ? existing?.round ?? round.round : round.round,
    composition_hash: stampedHash,
    applied: applyResult.outcomes.filter((o) => o.status === "applied"),
    skipped: applyResult.outcomes.filter((o) => o.status === "skipped"),
    learned_rules: learned,
    suggested_bans: suggestedBanRules(findings),
    summary_sentence: round.summary_sentence,
    ops,
  };
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
  if (!a.composition || !a.findings) {
    console.error("Usage: tsx tools/resume/critic-apply.ts --composition <path> --findings <critic.json | edits.json> [--round N] [--record-only] [--dry-run]");
    process.exit(2);
  }
  const result = await runCriticApply({
    composition: a.composition,
    findings: a.findings,
    round: a.round ? Number(a.round) : undefined,
    recordOnly: a["record-only"] === "true",
    dryRun: a["dry-run"] === "true",
  });

  if (!result.recorded && !a["dry-run"]) console.error("[critic-apply] no-op: every finding was already applied; nothing written, no round appended");
  if (result.ops.length) {
    console.error(`[critic-apply] ${result.ops.length} fit op(s) in the input were NOT applied; run \`npm run resume:edit\` to apply ops, critic:apply only edits text`);
  }
  for (const o of result.applied) console.error(`[critic-apply] applied  ${o.id.padEnd(10)} ${o.op} ${o.unit_path}`);
  for (const o of result.skipped) console.error(`[critic-apply] skipped  ${o.id.padEnd(10)} ${o.unit_path ?? "-"}: ${o.reason}`);
  for (const r of result.learned_rules) console.error(`[critic-apply] learned rule from ${r.resumes.join(" + ")}: ${r.kind} "${r.example_quote}"`);
  if (result.suggested_bans.length) {
    console.error(`[critic-apply] suggested editorial-bans.yaml rules (review and add by hand, nothing was written):`);
    for (const rule of result.suggested_bans) console.error(rule);
  }

  console.log(JSON.stringify(result, null, 2));
  // A blocking verdict is a non-zero exit so a skill cannot walk past it.
  process.exit(result.verdict === "block" ? 2 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
