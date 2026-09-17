#!/usr/bin/env tsx
/**
 * resume-reanchor.ts — citation SUPPORT scoring and re-anchoring.
 *
 * WHY
 * ---
 * `resume-provenance.ts` only proves that a cited `[start, end]` range EXISTS in
 * the current source. That is a liveness check, not a support check: edit
 * `cv-source.md` (insert a role, delete a bullet) and every citation below the
 * edit still "exists" while silently pointing at the wrong text.
 *
 * This module adds the missing half:
 *
 *   1. SCORING — for every cited unit (summary sentences, highlights, skill
 *      blocks, credentials, experience summaries / bullets / one-liners) it
 *      measures how much of the unit's DISTINCTIVE vocabulary actually appears
 *      in the cited lines. Below `WEAK_SCORE` that is a `weak_citation` warn.
 *      A number in the unit ("68", "12.9TB", "$50M") that appears nowhere in the
 *      cited lines is a much harder signal and reports `number_unsupported` as a
 *      fail — a moved range can be re-anchored, an unsupported metric cannot.
 *
 *   2. RE-ANCHORING (`--reanchor`) — for each weak citation it searches the
 *      source for the best-scoring window (`###` experience blocks, paragraphs,
 *      single lines) and rewrites the citation when the new window beats the old
 *      one by `MIN_GAIN`. Experience units only ever search inside blocks whose
 *      company / start date match the composition's experience key, so a bullet
 *      can never be re-anchored into somebody else's role.
 *
 *   3. NUMBER WIDENING (`--reanchor`) — a `number_unsupported` token is often a
 *      real corpus fact stated OUTSIDE the unit's cited ranges (the writer cited
 *      the sentence carrying the claim, not the line carrying the figure). For
 *      each missing number the corpus is searched — experience units inside
 *      their own role's block(s) only, other units preferring the narrative
 *      sections — and a citation for the line carrying the figure is appended.
 *      What survives that search is reported as `number_absent_from_corpus`: the
 *      figure exists nowhere the unit may legitimately draw from, which is a
 *      fabrication candidate and is never silently downgraded.
 *
 * Composition TEXT is never touched — only `<prefix>.provenance.json` line
 * ranges and appended references, and only with `--write`.
 *
 * A citation that stays weak after re-anchoring is the interesting output: the
 * source genuinely does not carry that claim anywhere, which makes it a
 * candidate `unsupported_claims` entry for a human to adjudicate.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProfileContext } from "../profile-context.ts";
import type { ResumeContent, ResumeSourceProvenance, SourceReference } from "../../templates/resume/_interface.ts";
import { loadComposition, provenanceSidecarPath } from "./lib/composition-io.ts";
import { STOPWORDS, normalise, stem, tokenInText, phraseInText, buildStemSet, candidateTerms, parseArgs } from "./keyword-lexicon.ts";

/** Below this share of distinctive tokens found in the cited lines, a citation is weak. */
export const WEAK_SCORE = 0.35;
/** A re-anchor only happens when the new window beats the old by at least this much. */
export const MIN_GAIN = 0.2;

export type ScoredRef = {
  /** Unit path, e.g. `experiences['Delivery Manager @ …'].bullets[2]`. */
  unit: string;
  /** Index of this reference within the unit's reference list. */
  refIndex: number;
  ref: SourceReference;
  /** Support of the ref's anchor text (its `quote` when it has one, else the unit text). */
  score: number;
  /** Support of the whole unit text against the UNION of the unit's cited lines. */
  unitScore: number;
  /** The cached `quote` no longer appears in the ref's current lines. */
  staleQuote: boolean;
  weak: boolean;
};

export type UnitAnalysis = {
  unit: string;
  text: string;
  refs: SourceReference[];
  /** Experience key in `evidence.experiences`, when the unit belongs to one. */
  experienceKey?: string;
  /** Composition experience this unit belongs to, for block-restricted search. */
  experience?: { title: string; company: string; start: string; end: string };
  unitScore: number;
  scored: ScoredRef[];
  /** Numbers in the unit text absent from every cited line. */
  missingNumbers: string[];
};

export type CitationReport = {
  units: UnitAnalysis[];
  weak: ScoredRef[];
  numberUnsupported: Array<{ unit: string; text: string; numbers: string[]; refs: SourceReference[] }>;
};

// ---------------------------------------------------------------------------
// text primitives
// ---------------------------------------------------------------------------

/**
 * Numeric claims, normalised for comparison: `$50M` → `50m`, `A$6.3B+` → `6.3b`,
 * `12.9 TB` → `12.9tb`, `150K users` → `150k`, `20%` → `20%`, `2.x million` → `2m`.
 *
 * Both sides of every comparison — a composition unit and a raw corpus line —
 * run through this one regex, so surface differences that carry no meaning
 * (currency prefix, trailing `+`, thousands separators, a space between the
 * digits and the unit, a spelled-out magnitude) normalise away identically.
 *
 * The unit suffix is a CLOSED set. Allowing any short word after a space would
 * turn "4 in Manila" into `4in` and make it un-matchable against a unit that
 * says "4"; allowing any short word glued to the digits would turn "24hr" into
 * a unit claim. Anything outside the set is simply not part of the number.
 */
const CURRENCY = String.raw`(?:a\$|au\$|us\$|nz\$|usd|aud|nzd|\$)`;
const MAGNITUDE_WORD = String.raw`(thousand|million|billion|trillion)`;
const UNIT_SUFFIX = String.raw`(bn|mn|kb|mb|gb|tb|pb|k|m|b|%|x)`;
const NUMBER_SOURCE = `${CURRENCY}?\\s*(\\d[\\d,]*(?:\\.(?:\\d+|x+))?)\\s*(?:${MAGNITUDE_WORD}\\b|${UNIT_SUFFIX}(?![a-z0-9]))?`;
const NUMBER_RE = new RegExp(NUMBER_SOURCE, "gi");

/** Spelled-out magnitudes fold onto their one-letter suffix so `6.3 billion` and `A$6.3B+` are one token. */
const MAGNITUDE_LETTER: Record<string, string> = { thousand: "k", million: "m", billion: "b", trillion: "t" };

export type NumberMatch = {
  /** Normalised form: digits (commas stripped) plus a lower-case suffix. */
  token: string;
  /** Offset of the first digit inside the scanned text. */
  index: number;
};

/**
 * Every number in `text`, normalised, with the offset of its first digit.
 *
 * Digits with a LETTER immediately in front of them are not numbers at all —
 * they are part of one word: PRINCE2, ISO27001, M365, O365, S3, Next.js14,
 * Log4j, SHA256. Emitting "2" for "PRINCE2 delivery governance" made the
 * provenance gate demand a cited line carrying the figure 2, which no corpus
 * line ever does, so every such certification or product name became a bogus
 * `number_unsupported` fail.
 *
 * The rule is strictly "letter GLUED to the digits". Digits separated by a
 * space are still numbers: "ISO 42001" yields `42001`, "Microsoft 365" yields
 * `365`. Those are genuine numeric tokens and are excused — correctly and
 * visibly — by the product-name guard in `numberSupportedInUnit`, which
 * supports them when the cited text names the product ("ISO 42001",
 * "Microsoft 365", or even just "ISO" / "Microsoft"). Suppressing them here
 * instead would also suppress real metrics ("A$ 50 million", "68 controls").
 */
export function numberMatches(text: string): NumberMatch[] {
  const out: NumberMatch[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const digitIndex = (m.index ?? 0) + m[0].indexOf(m[1]);
    if (/[a-z]/i.test(text[digitIndex - 1] ?? "")) continue;
    // `2.x million` is an approximation, not a decimal: drop the placeholder so
    // it normalises to the same token as a cited "2 million".
    const digits = m[1].replace(/,/g, "").toLowerCase().replace(/\.x+$/, "");
    const word = m[2]?.toLowerCase();
    const suffix = word ? MAGNITUDE_LETTER[word] : (m[3]?.toLowerCase() ?? "");
    out.push({ token: `${digits}${suffix}`, index: digitIndex });
  }
  return out;
}

export function numberTokens(text: string): string[] {
  return numberMatches(text).map((m) => m.token);
}

/** Spelled-out and suffixed magnitudes. `tb`, `gb`, `%` are UNITS, not magnitudes, and stay literal. */
const MAGNITUDES: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  trillion: 1e12,
};

/**
 * Numeric value of a magnitude token: `20k` → 20000, `6.3b` → 6.3e9, `9000` →
 * 9000. `null` for anything carrying a non-magnitude unit (`12.9tb`, `20%`),
 * where only the literal form may be compared.
 */
export function numberValue(token: string): number | null {
  const m = /^(\d[\d,]*(?:\.[\dx]+)?)\s*([a-z]*)$/.exec(token.trim().toLowerCase());
  if (!m) return null;
  const digits = Number(m[1].replace(/,/g, "").replace(/\.x+$/, ""));
  if (!Number.isFinite(digits)) return null;
  if (!m[2]) return digits;
  const mult = MAGNITUDES[m[2]];
  return mult === undefined ? null : digits * mult;
}

/**
 * Comparison key for a normalised token: numeric VALUE plus unit. Magnitudes
 * fold into the value (`20k` → `20000|`, `6.3b` → `6300000000|`), real units
 * stay attached (`12.9tb` → `12.9|tb`, `20%` → `20|%`).
 *
 * This is what keeps magnitude-strictness: `20k` keys to `20000|` and a bare
 * `20` keys to `20|`, so a "$50M" claim can never anchor onto a "$50" ceiling.
 */
export function numberKey(token: string): string | null {
  const m = /^(\d[\d,]*(?:\.(?:\d+|x+))?)([a-z%]*)$/.exec(token.trim().toLowerCase());
  if (!m) return null;
  const digits = Number(m[1].replace(/,/g, "").replace(/\.x+$/, ""));
  if (!Number.isFinite(digits)) return null;
  const suffix = m[2];
  const mult = MAGNITUDES[suffix];
  if (suffix && mult === undefined) return `${digits}|${suffix}`;
  return `${digits * (mult ?? 1)}|`;
}

/** A number is supported when a number of the same value AND unit appears in the cited text. */
export function numberSupported(token: string, citedNumbers: string[]): boolean {
  if (citedNumbers.includes(token)) return true;
  const key = numberKey(token);
  if (key === null) return false;
  return citedNumbers.some((c) => numberKey(c) === key);
}

/**
 * A "version-like" token is bare digits and dots — `365`, `3.0`, `2019`, `19`.
 * Magnitudes (`50m`, `6.3b`, `20k`, `12.9tb`) and percentages carry a unit and
 * are therefore always metric claims, never product names or date labels.
 */
export function versionLikeToken(token: string): boolean {
  return /^\d[\d.]*$/.test(token);
}

/** Word characters that can be part of a product name: "Tech.Ed", "C++", "SharePoint". */
const PRODUCT_WORD_RE = /([A-Za-z][A-Za-z.+]*)[\s\-/]*$/;

/**
 * The proper-noun word glued to a number inside `text`, one entry per occurrence:
 * "Microsoft 365" → `Microsoft`, "SharePoint Services 3.0" → `Services`,
 * "amid Covid-19" → `Covid`, "(Oct 2019)" → `Oct`.
 *
 * Capitalisation is the discriminator that keeps the product guard away from
 * genuine metrics: "68 controls", "a 10-person team" and "for 4 engineers" are
 * all preceded by lowercase words (or nothing) and never produce a phrase.
 */
export function productPhrases(text: string, token: string): Array<{ phrase: string; product: string }> {
  const out: Array<{ phrase: string; product: string }> = [];
  const key = numberKey(token);
  for (const m of numberMatches(text)) {
    if (m.token !== token && (key === null || numberKey(m.token) !== key)) continue;
    const before = PRODUCT_WORD_RE.exec(text.slice(0, m.index));
    if (!before) continue;
    const product = before[1];
    if (!/^[A-Z]/.test(product)) continue;
    out.push({ phrase: `${product} ${m.token}`, product });
  }
  return out;
}

/**
 * Whether a number claimed by `unitText` is carried by `cited`.
 *
 * Beyond the literal number, a version-like token is also supported when the
 * PRODUCT NAME it is glued to appears in the cited text: "Dynamics 365" cited
 * against a line that says "Dynamics 365" or just "Dynamics" is a product
 * reference, not an unsupported metric. Same for date labels ("Oct 2019") and
 * event names ("Covid-19"). Metric tokens never take this path.
 */
export function numberSupportedInUnit(token: string, unitText: string, cited: string): boolean {
  // Value-and-unit equality, so a cited "~20,000 users" carries a unit's "20K"
  // and a cited "12.9 TB" carries a unit's "12.9TB".
  if (numberSupported(token, numberTokens(cited))) return true;
  if (!versionLikeToken(token)) return false;
  const norm = normalise(cited);
  const stems = buildStemSet(norm);
  return productPhrases(unitText, token).some(
    ({ phrase, product }) => phraseInText(normalise(phrase).trim(), norm) || tokenInText(product.toLowerCase(), norm, stems),
  );
}

export type Distinctive = { words: string[]; acronyms: string[]; numbers: string[]; total: number };

/**
 * The tokens that make a unit identifiable: words of 4+ characters that are not
 * generic resume vocabulary (`STOPWORDS`), plus acronyms and numeric claims.
 */
export function distinctiveTokens(text: string): Distinctive {
  const { tokens, acronyms } = candidateTerms(text);
  const words = [...new Set(tokens.map(stem))].filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const acr = [...new Set(acronyms)].filter((a) => a.length >= 2 && !STOPWORDS.has(a));
  const numbers = [...new Set(numberTokens(text))];
  const wordSet = new Set(words);
  const uniqueAcr = acr.filter((a) => !wordSet.has(stem(a)));
  return { words, acronyms: uniqueAcr, numbers, total: words.length + uniqueAcr.length + numbers.length };
}

/** Share of `text`'s distinctive tokens present in `cited`. Returns 1 when there is nothing distinctive to check. */
export function supportScore(text: string, cited: string): number {
  const d = distinctiveTokens(text);
  if (!d.total) return 1;
  return matchedCount(d, cited) / d.total;
}

function matchedCount(d: Distinctive, cited: string): number {
  const norm = normalise(cited);
  const stems = buildStemSet(norm);
  const citedNumbers = numberTokens(cited);
  let hit = 0;
  for (const w of d.words) if (tokenInText(w, norm, stems)) hit++;
  for (const a of d.acronyms) if (tokenInText(a, norm, stems)) hit++;
  for (const n of d.numbers) if (numberSupported(n, citedNumbers)) hit++;
  return hit;
}

/**
 * A cached `quote` is STALE when the text it was copied from no longer sits in
 * the ref's current lines — the source was rewritten under a still-correct line
 * range. Scoring such a ref against its quote measures the OLD source, so the
 * citation reads weak forever and `--reanchor` keeps hunting for a window that
 * matches text the corpus no longer contains. Comparison is on the normalised
 * forms so punctuation, casing and line wrapping do not count as a rewrite.
 */
export function quoteIsStale(quote: string | undefined, citedText: string): boolean {
  if (!quote || !quote.trim()) return false;
  const needle = normalise(quote).trim();
  if (!needle) return false;
  return !normalise(citedText).includes(` ${needle} `);
}

export function sliceLines(lines: string[], range: [number, number] | undefined): string {
  if (!range) return "";
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "";
  return lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join("\n");
}

// ---------------------------------------------------------------------------
// unit enumeration
// ---------------------------------------------------------------------------

function experienceKeyCandidates(xp: ResumeContent["experiences"][number]): string[] {
  return [
    `${xp.title}|${xp.company}|${xp.start}|${xp.end}`,
    `${xp.title} @ ${xp.company} (${xp.start}–${xp.end})`,
    `${xp.title}, ${xp.company}`,
    xp.title,
  ];
}

type RawUnit = Pick<UnitAnalysis, "unit" | "text" | "refs" | "experienceKey" | "experience">;

/** Every cited unit of a composition, paired with the LIVE reference array from the sidecar. */
export function citedUnits(content: ResumeContent, provenance: ResumeSourceProvenance): RawUnit[] {
  const out: RawUnit[] = [];
  const evidence = provenance.evidence;
  if (!evidence) return out;
  const push = (unit: string, text: string | undefined, refs: SourceReference[] | undefined, extra?: Partial<RawUnit>) => {
    if (!text || !refs?.length) return;
    out.push({ unit, text, refs, ...extra });
  };

  push("summary", content.summary, evidence.summary);
  (content.highlights ?? []).forEach((h, i) => push(`highlights[${i}]`, h, evidence.highlights?.[i]));
  for (const skill of content.skills ?? []) {
    const text = [skill.summary ?? "", ...(skill.bullets ?? [])].filter(Boolean).join(" ");
    push(`skills['${skill.name}']`, text, evidence.skills?.[skill.name]);
  }
  push("additional_skills_summary", content.additional_skills_summary, evidence.additional_skills_summary);
  (content.credentials ?? []).forEach((c, i) => push(`credentials[${i}]`, c, evidence.credentials?.[i]));

  for (const xp of content.experiences ?? []) {
    const key = experienceKeyCandidates(xp).find((candidate) => evidence.experiences?.[candidate]);
    if (!key) continue;
    const xpEvidence = evidence.experiences[key];
    const tag = `experiences['${key}']`;
    const extra = { experienceKey: key, experience: { title: xp.title, company: xp.company, start: xp.start, end: xp.end } };
    if (xp.placement === "feature") {
      push(`${tag}.summary`, xp.summary, xpEvidence.summary, extra);
      (xp.bullets ?? []).forEach((b, i) => push(`${tag}.bullets[${i}]`, b, xpEvidence.bullets?.[i], extra));
    } else {
      push(`${tag}.one_liner`, xp.one_liner, xpEvidence.one_liner, extra);
    }
  }
  return out;
}

export type SourceFiles = Map<string, string>;

function textFor(sources: SourceFiles, file: string): string | null {
  if (sources.has(file)) return sources.get(file)!;
  const base = path.basename(file);
  for (const [key, value] of sources) if (path.basename(key) === base) return value;
  return null;
}

/**
 * Score every citation of a composition.
 *
 * A reference is scored against its ANCHOR text: the short `quote` the writer
 * copied out of the source when it has one, otherwise the whole unit text. That
 * is the honest question for a single reference in a multi-reference unit —
 * "does this range still contain the thing it was pointing at?" — where scoring
 * a four-reference summary sentence against each range in isolation would flag
 * every correctly-cited unit. `unitScore` keeps the whole-unit reading, measured
 * against the union of the unit's cited lines.
 */
export function analyseCitations(args: { content: ResumeContent; provenance: ResumeSourceProvenance; sources: SourceFiles }): CitationReport {
  const { content, provenance, sources } = args;
  const linesByFile = new Map<string, string[]>();
  const linesOf = (file: string): string[] => {
    if (!linesByFile.has(file)) {
      const text = textFor(sources, file);
      linesByFile.set(file, text === null ? [] : text.split(/\r?\n/));
    }
    return linesByFile.get(file)!;
  };

  const units: UnitAnalysis[] = [];
  for (const raw of citedUnits(content, provenance)) {
    const citedTexts = raw.refs.map((ref) => sliceLines(linesOf(ref.file), ref.lines));
    const union = citedTexts.join("\n");
    const unitScore = supportScore(raw.text, union);

    const scored: ScoredRef[] = raw.refs.map((ref, refIndex) => {
      const cited = citedTexts[refIndex];
      // A stale quote describes text that is gone, so it is no evidence either
      // way about the CURRENT lines. Fall back to the unit text: lines that
      // still carry the claim then score honestly (and `--reanchor` refreshes
      // the quote), lines that do not stay weak and get re-anchored.
      const staleQuote = quoteIsStale(ref.quote, cited);
      const anchor = ref.quote && !staleQuote && distinctiveTokens(ref.quote).total ? ref.quote : raw.text;
      const score = supportScore(anchor, cited);
      return { unit: raw.unit, refIndex, ref, score, unitScore, staleQuote, weak: score < WEAK_SCORE };
    });

    const missingNumbers = [...new Set(numberTokens(raw.text))].filter((n) => !numberSupportedInUnit(n, raw.text, union));
    units.push({ ...raw, unitScore, scored, missingNumbers });
  }

  return {
    units,
    weak: units.flatMap((u) => u.scored.filter((s) => s.weak)),
    numberUnsupported: units
      .filter((u) => u.missingNumbers.length)
      .map((u) => ({ unit: u.unit, text: u.text, numbers: u.missingNumbers, refs: u.refs })),
  };
}

// ---------------------------------------------------------------------------
// candidate windows in the source
// ---------------------------------------------------------------------------

export type Window = { lines: [number, number]; text: string; kind: "block" | "para" | "line"; block: number | null };

type Block = { index: number; heading: string; start: number; end: number };

/** `### ` experience blocks, each running to the line before the next `#`-`###` heading. */
export function sourceBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const starts: Array<{ line: number; heading: string; depth: number }> = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) starts.push({ line: i + 1, heading: m[2], depth: m[1].length });
  });
  const blocks: Block[] = [];
  starts.forEach((s) => {
    if (s.depth !== 3) return;
    const next = starts.find((o) => o.line > s.line && o.depth <= 3);
    blocks.push({ index: blocks.length, heading: s.heading, start: s.line, end: (next ? next.line - 1 : lines.length) });
  });
  return blocks;
}

/** Every window worth scoring: whole `###` blocks, contiguous paragraphs, and single lines. */
export function sourceWindows(text: string): Window[] {
  const lines = text.split(/\r?\n/);
  const blocks = sourceBlocks(text);
  const blockOf = (line: number): number | null => blocks.find((b) => line >= b.start && line <= b.end)?.index ?? null;

  const out: Window[] = blocks.map((b) => ({
    lines: [b.start, b.end] as [number, number],
    text: lines.slice(b.start - 1, b.end).join("\n"),
    kind: "block" as const,
    block: b.index,
  }));

  let paraStart = 0;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || !lines[i].trim();
    if (!blank) {
      if (!paraStart) paraStart = i + 1;
      out.push({ lines: [i + 1, i + 1], text: lines[i], kind: "line", block: blockOf(i + 1) });
      continue;
    }
    if (paraStart && i > paraStart) {
      out.push({ lines: [paraStart, i], text: lines.slice(paraStart - 1, i).join("\n"), kind: "para", block: blockOf(paraStart) });
    }
    paraStart = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fuzzy company / date matching (local, simple token overlap)
// ---------------------------------------------------------------------------

const GENERIC_COMPANY_TOKENS = new Set(["the", "group", "limited", "ltd", "pty", "inc", "corp", "corporation", "company", "co", "holdings", "australia", "australian", "services", "service", "department", "dept", "of", "and", "nsw"]);

function tokensOf(value: string): string[] {
  return normalise(value).trim().split(" ").filter(Boolean);
}

/**
 * Readings of one employer name: without parentheticals, verbatim, the part
 * before a dash tail ("Scentre Group – Owner of Westfields"), and each
 * parenthetical on its own ("Australian Professional Leagues (APL)" → "APL").
 */
function companyForms(value: string): string[][] {
  const parenthetical = [...value.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const stripped = value.replace(/\([^()]*\)/g, " ");
  const beforeDash = value.split(/\s[–—-]\s/)[0];
  return [stripped, value, beforeDash, ...parenthetical].map(tokensOf).filter((t) => t.length > 0);
}

/** True when two employer names plausibly name the same organisation. */
export function companyOverlap(a: string, b: string): boolean {
  return companyForms(a).some((x) => companyForms(b).some((y) => formsMatch(x, y)));
}

function formsMatch(x: string[], y: string[]): boolean {
  if (!x.length || !y.length) return false;
  const jx = x.join("");
  const jy = y.join("");
  if (jx === jy) return true;
  const [short, long] = jx.length <= jy.length ? [jx, jy] : [jy, jx];
  if (short.length >= 4 && long.includes(short)) return true;
  const distinctiveX = x.filter((w) => w.length >= 4 && !GENERIC_COMPANY_TOKENS.has(w));
  if (distinctiveX.some((w) => y.includes(w))) return true;
  const initials = (parts: string[]) => parts.map((p) => p[0]).join("");
  if (x.length === 1 && x[0].length >= 2 && x[0] === initials(y)) return true;
  if (y.length === 1 && y[0].length >= 2 && y[0] === initials(x)) return true;
  return false;
}

function headingStart(heading: string): string {
  const m = heading.match(/\b((?:19|20)\d{2})[-/](\d{1,2})\b/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  const year = heading.match(/\b((?:19|20)\d{2})\b/);
  return year ? year[1] : "";
}

function startMatches(a: string | undefined, headingText: string): boolean {
  if (!a) return false;
  const hs = headingStart(headingText);
  if (!hs) return false;
  const norm = (v: string) => {
    const m = v.match(/\b((?:19|20)\d{2})(?:[-/](\d{1,2}))?/);
    return m ? (m[2] ? `${m[1]}-${m[2].padStart(2, "0")}` : m[1]) : "";
  };
  const na = norm(a);
  if (!na) return false;
  return na === hs || na.slice(0, 4) === hs.slice(0, 4);
}

/**
 * Company named by a `### <dates> — <title>, <company>` heading. Matching the
 * whole heading instead would let a title word ("Professional") stand in for an
 * employer.
 */
export function headingCompany(heading: string): string {
  const sep = heading.lastIndexOf(" — ") >= 0 ? " — " : heading.lastIndexOf(" – ") >= 0 ? " – " : null;
  const at = sep ? heading.lastIndexOf(sep) : -1;
  const rolePart = (at >= 0 ? heading.slice(at + sep!.length) : heading).trim();
  const withoutTail = rolePart.replace(/\s*\([^()]*\)\s*$/, "").replace(/[,\s]+$/, "");
  const comma = withoutTail.lastIndexOf(",");
  return comma > 0 ? withoutTail.slice(comma + 1).trim() : withoutTail.trim();
}

/** Blocks that plausibly belong to a composition experience (company match, or start-date match). */
export function blocksForExperience(text: string, experience: { company: string; start: string }): Block[] {
  const blocks = sourceBlocks(text);
  const byCompany = blocks.filter((b) => companyOverlap(headingCompany(b.heading), experience.company));
  const exact = byCompany.filter((b) => startMatches(experience.start, b.heading));
  if (exact.length) return exact;
  if (byCompany.length) return byCompany;
  return blocks.filter((b) => startMatches(experience.start, b.heading));
}

// ---------------------------------------------------------------------------
// number widening
// ---------------------------------------------------------------------------

/**
 * Top-level sections a non-experience unit (summary, highlight, skill block,
 * credential) should be searched FIRST for a missing number: those units are
 * composed from the narrative sections, so an experience block that happens to
 * repeat the digits is the less honest anchor.
 */
const PREFERRED_SECTION_RE = /summary|highlight|skill|education|certification|credential|qualification|award|profile/i;

/**
 * Line numbers of `text` in search TIERS: lines inside a preferred `#`/`##`
 * section first, then everything else. Tiers are searched in order and the
 * later tier is only consulted when the earlier one carries no match at all,
 * so an experience block that happens to repeat a figure can never outrank the
 * narrative section the unit was actually composed from.
 */
export function preferredLineTiers(text: string): number[][] {
  const lines = text.split(/\r?\n/);
  const heads: Array<{ line: number; heading: string; depth: number }> = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) heads.push({ line: i + 1, heading: m[2], depth: m[1].length });
  });
  const tops = heads.filter((h) => h.depth <= 2);
  const preferred = new Set<number>();
  tops.forEach((h, i) => {
    if (!PREFERRED_SECTION_RE.test(h.heading)) return;
    const end = tops[i + 1] ? tops[i + 1].line - 1 : lines.length;
    for (let l = h.line; l <= end; l++) preferred.add(l);
  });
  const all = lines.map((_, i) => i + 1);
  return [all.filter((l) => preferred.has(l)), all.filter((l) => !preferred.has(l))].filter((tier) => tier.length > 0);
}

/**
 * Whether `line` genuinely carries `token`.
 *
 * Same normalisation as `numberTokens` on both sides, compared by VALUE plus
 * unit: `20k` = `20,000` = `20 thousand`, `12.9tb` = `12.9 TB`, `50m` =
 * `approximately $50M` = `$50 million`. Magnitude-strict, so "$50M" never
 * anchors onto a "$50 hard stop" and `20k` never onto a bare `20`.
 */
export function numberFoundInLine(token: string, line: string): boolean {
  return numberSupported(token, numberTokens(line));
}

/** A number found elsewhere in the corpus and appended to a unit's citations. */
export type Widening = {
  unit: string;
  token: string;
  file: string;
  line: number;
  note: string;
  /** The corpus line the number was found on, for the operator to eyeball. */
  sourceLine: string;
};

/** A number the corpus does not carry anywhere it is allowed to look. */
export type AbsentNumber = { unit: string; text: string; token: string; searched: string };

function widenToken(args: {
  token: string;
  unit: UnitAnalysis;
  text: string;
}): { line: number; sourceLine: string } | null {
  const { token, unit, text } = args;
  const lines = text.split(/\r?\n/);

  let tiers: number[][];
  if (unit.experience) {
    // An experience unit may only widen inside its OWN role's block(s) — a
    // metric borrowed from a different employer is exactly the fabrication this
    // tool exists to catch.
    const blocks = blocksForExperience(text, unit.experience);
    if (!blocks.length) return null;
    tiers = [blocks.flatMap((b) => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i))];
  } else {
    tiers = preferredLineTiers(text);
  }

  for (const tier of tiers) {
    // Within a tier, the best-supporting line wins: a date heading and a real
    // sentence can both contain "10", and the sentence is the honest anchor.
    let best: { line: number; sourceLine: string; score: number } | null = null;
    for (const line of tier) {
      const raw = lines[line - 1];
      if (!raw?.trim()) continue;
      // Headings only ever carry the role's dates. Anchoring "a 3-stage pipeline"
      // onto the "2026-03" in a `### ` heading would launder a fabricated metric
      // into a date, so headings are never a widening target.
      if (/^#{1,6}\s/.test(raw)) continue;
      if (!numberFoundInLine(token, raw)) continue;
      const score = supportScore(unit.text, raw);
      if (!best || score > best.score) best = { line, sourceLine: raw.trim(), score };
    }
    if (best) return { line: best.line, sourceLine: best.sourceLine };
  }
  return null;
}

/**
 * Whether an already-widened reference still lands on text carrying its token.
 * A missing file or an out-of-range line counts as stale, not as support.
 */
function widenedRefStillSupports(ref: SourceReference, token: string, sources: SourceFiles): boolean {
  const text = textFor(sources, ref.file);
  if (text === null) return false;
  const lines = text.split(/\r?\n/);
  const [from, to] = ref.lines ?? [0, 0];
  for (let l = from; l <= to; l++) {
    const raw = lines[l - 1];
    if (raw !== undefined && numberFoundInLine(token, raw)) return true;
  }
  return false;
}

/**
 * Append a citation for every `number_unsupported` token that the corpus does
 * carry somewhere the unit is allowed to look. Mutates the unit's LIVE
 * reference array when `apply` is true.
 */
export function widenNumbers(args: {
  units: UnitAnalysis[];
  sources: SourceFiles;
  apply?: boolean;
  today?: string;
}): { widenings: Widening[]; absent: AbsentNumber[] } {
  const { units, sources, apply = false, today = new Date().toISOString().slice(0, 10) } = args;
  const widenings: Widening[] = [];
  const absent: AbsentNumber[] = [];

  for (const unit of units) {
    if (!unit.missingNumbers.length) continue;
    const files = [...new Set(unit.refs.map((r) => r.file))];
    for (const token of unit.missingNumbers) {
      let hit: { file: string; line: number; sourceLine: string } | null = null;
      for (const file of files) {
        const text = textFor(sources, file);
        if (text === null) continue;
        const found = widenToken({ token, unit, text });
        if (found) { hit = { file, ...found }; break; }
      }
      if (!hit) {
        absent.push({
          unit: unit.unit,
          text: unit.text,
          token,
          searched: unit.experience ? `${unit.experience.company} block(s) in ${files.join(", ")}` : files.join(", "),
        });
        continue;
      }
      const note = `number-widened ${today}: ${token}`;
      // Idempotent: a second `--reanchor --write` must not stack duplicate refs.
      const already = new RegExp(`^number-widened \\d{4}-\\d{2}-\\d{2}: ${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      const existing = unit.refs.find((r) => r.note && already.test(r.note));
      if (existing) {
        // A widened ref is a pointer at ONE line, and the corpus moves under it
        // (an edit above shifts every line number down). If the line it points
        // at no longer carries the token the ref is stale: re-point it in place
        // at the line that does, rather than skipping — skipping leaves a ref
        // whose quote and line disagree, and whose figure is unproven.
        if (widenedRefStillSupports(existing, token, sources)) continue;
        widenings.push({ unit: unit.unit, token, file: hit.file, line: hit.line, note, sourceLine: hit.sourceLine });
        if (apply) {
          existing.file = hit.file;
          existing.lines = [hit.line, hit.line];
          existing.quote = hit.sourceLine.slice(0, 240);
          existing.note = note;
        }
        continue;
      }
      widenings.push({ unit: unit.unit, token, file: hit.file, line: hit.line, note, sourceLine: hit.sourceLine });
      // The quote is the corpus line itself: it documents the figure inline for
      // a human reader, and it makes the ref score against the text it actually
      // points at rather than against the whole unit (which would read weak).
      if (apply) unit.refs.push({ file: hit.file, lines: [hit.line, hit.line], quote: hit.sourceLine.slice(0, 240), note });
    }
  }
  return { widenings, absent };
}

// ---------------------------------------------------------------------------
// re-anchoring
// ---------------------------------------------------------------------------

export type Move = {
  unit: string;
  refIndex: number;
  file: string;
  from: [number, number];
  to: [number, number];
  oldScore: number;
  newScore: number;
  kind: Window["kind"];
};

/** A cached `quote` rewritten in place because the live lines still support the unit. */
export type QuoteRefresh = {
  unit: string;
  refIndex: number;
  file: string;
  lines: [number, number];
  oldQuote: string;
  newQuote: string;
  /** Support of the unit text against the live cited lines. */
  score: number;
};

export type ReanchorResult = {
  report: CitationReport;
  moves: Move[];
  /** Stale quotes refreshed against live text the citation still points at. */
  refreshes: QuoteRefresh[];
  /** Citations appended so a `number_unsupported` token points at real corpus text. */
  widenings: Widening[];
  /** Numbers the corpus does not carry — real fabrication candidates, never hidden. */
  numberAbsent: AbsentNumber[];
  /** Weak citations no better window could be found for — candidate unsupported claims. */
  unresolved: Array<{ unit: string; text: string; file: string; lines: [number, number]; score: number; quote?: string }>;
};

/**
 * Find a better home for every weak citation. Mutates `provenance` in place when
 * `apply` is true (the caller decides whether that reaches disk). Composition
 * text is never touched.
 */
export function reanchor(args: {
  content: ResumeContent;
  provenance: ResumeSourceProvenance;
  sources: SourceFiles;
  apply?: boolean;
}): ReanchorResult {
  const { content, provenance, sources, apply = false } = args;
  const report = analyseCitations({ content, provenance, sources });
  const moves: Move[] = [];
  const refreshes: QuoteRefresh[] = [];
  const unresolved: ReanchorResult["unresolved"] = [];

  const linesByFile = new Map<string, string[]>();
  const linesOf = (file: string, text: string): string[] => {
    if (!linesByFile.has(file)) linesByFile.set(file, text.split(/\r?\n/));
    return linesByFile.get(file)!;
  };
  const windowsByFile = new Map<string, Window[]>();
  const windowsOf = (file: string): Window[] => {
    if (!windowsByFile.has(file)) {
      const text = textFor(sources, file);
      windowsByFile.set(file, text === null ? [] : sourceWindows(text));
    }
    return windowsByFile.get(file)!;
  };

  for (const unit of report.units) {
    for (const scored of unit.scored) {
      const ref = scored.ref;
      // A number-widened ref is a deliberate pointer at the line carrying one
      // FIGURE, so it scores badly against the whole unit text by construction.
      // Re-anchoring it to a better-scoring window would throw the figure away,
      // which is precisely what it was appended to prove.
      if (ref.note?.includes("number-widened")) continue;
      const sourceText = textFor(sources, ref.file);
      if (sourceText === null) continue;

      // The source was rewritten UNDER a citation that still points at the
      // right place: the cached quote is gone but the live lines still carry
      // the claim. Refresh the quote instead of hunting the corpus for text
      // that no longer exists — moving the citation would be the wrong repair.
      if (scored.staleQuote && ref.lines) {
        const live = sliceLines(linesOf(ref.file, sourceText), ref.lines);
        const liveScore = supportScore(unit.text, live);
        if (liveScore >= WEAK_SCORE) {
          const fresh = live.replace(/\s+/g, " ").trim().slice(0, 240);
          if (fresh) {
            refreshes.push({
              unit: unit.unit,
              refIndex: scored.refIndex,
              file: ref.file,
              lines: [ref.lines[0], ref.lines[1]],
              oldQuote: ref.quote ?? "",
              newQuote: fresh,
              score: liveScore,
            });
            if (apply) {
              const note = `quote refreshed ${new Date().toISOString().slice(0, 10)}`;
              ref.quote = fresh;
              ref.note = ref.note ? `${ref.note}; ${note}` : note;
            }
            continue;
          }
        }
      }

      if (!scored.weak) continue;
      const anchor = ref.quote && !scored.staleQuote && distinctiveTokens(ref.quote).total ? ref.quote : unit.text;

      let candidates = windowsOf(ref.file);
      if (unit.experience) {
        const allowed = new Set(blocksForExperience(sourceText, unit.experience).map((b) => b.index));
        if (allowed.size) candidates = candidates.filter((w) => w.block !== null && allowed.has(w.block));
      }

      // Ties are broken towards the window that is closest in size to the range
      // being replaced: a citation written against a whole `###` block stays a
      // block citation, a line citation stays a line.
      const oldSpan = (ref.lines?.[1] ?? 0) - (ref.lines?.[0] ?? 0);
      let best: { window: Window; score: number } | null = null;
      for (const window of candidates) {
        const score = supportScore(anchor, window.text);
        const span = window.lines[1] - window.lines[0];
        if (!best) { best = { window, score }; continue; }
        const bestSpan = best.window.lines[1] - best.window.lines[0];
        const better =
          score > best.score ||
          (score === best.score &&
            (Math.abs(span - oldSpan) < Math.abs(bestSpan - oldSpan) ||
              (Math.abs(span - oldSpan) === Math.abs(bestSpan - oldSpan) && span < bestSpan)));
        if (better) best = { window, score };
      }

      if (best && best.score >= scored.score + MIN_GAIN) {
        moves.push({
          unit: unit.unit,
          refIndex: scored.refIndex,
          file: ref.file,
          from: [ref.lines[0], ref.lines[1]],
          to: best.window.lines,
          oldScore: scored.score,
          newScore: best.score,
          kind: best.window.kind,
        });
        if (apply) {
          const note = `reanchored ${new Date().toISOString().slice(0, 10)} from L${ref.lines[0]}-${ref.lines[1]}`;
          ref.lines = [best.window.lines[0], best.window.lines[1]];
          ref.note = ref.note ? `${ref.note}; ${note}` : note;
        }
      } else {
        unresolved.push({ unit: unit.unit, text: unit.text, file: ref.file, lines: [ref.lines[0], ref.lines[1]], score: scored.score, quote: ref.quote });
      }
    }
  }
  const { widenings, absent } = widenNumbers({ units: report.units, sources, apply });
  return { report, moves, refreshes, widenings, numberAbsent: absent, unresolved };
}

/** cv-source.md + profile.md, keyed by both absolute and repo-relative path. */
export async function loadSources(profile?: string): Promise<SourceFiles> {
  const ctx = resolveProfileContext(profile);
  const cv = await fs.readFile(ctx.cvSourcePath, "utf8");
  const prof = await fs.readFile(ctx.profileMdPath, "utf8").catch(() => "");
  return new Map<string, string>([
    [ctx.cvSourcePath, cv],
    [ctx.profileMdPath, prof],
    ["state/profile/cv-source.md", cv],
    ["state/profile/profile.md", prof],
  ]);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

/** `--reanchor` entry point shared with resume-provenance.ts. */
export async function runReanchorCli(args: Record<string, string>): Promise<number> {
  const contentPath = args["content-json"];
  if (!contentPath) {
    console.error("Usage: tsx tools/resume/resume-reanchor.ts --content-json <path> [--write] [--profile <id>]");
    return 2;
  }
  const loaded = await loadComposition(contentPath);
  if (!loaded.provenance) {
    console.error(`No provenance for ${contentPath}`);
    return 2;
  }
  const sources = await loadSources(args.profile);
  const write = args.write === "true";
  const result = reanchor({ content: loaded.content, provenance: loaded.provenance, sources, apply: true });

  console.log(`\n${path.basename(contentPath)}  ${write ? "(WRITE)" : "(dry run)"}`);
  console.log(
    `  units ${result.report.units.length} · weak ${result.report.weak.length} · number_unsupported ${result.report.numberUnsupported.length} · ` +
      `moves ${result.moves.length} · quotes refreshed ${result.refreshes.length} · widened ${result.widenings.length} · absent ${result.numberAbsent.length} · unresolved ${result.unresolved.length}`,
  );
  if (result.moves.length) {
    console.log(`  ${pad("unit", 54)} ${pad("from", 12)} ${pad("to", 12)} ${pad("score", 14)} kind`);
    for (const m of result.moves) {
      console.log(
        `  ${pad(m.unit, 54)} ${pad(`${m.from[0]}-${m.from[1]}`, 12)} ${pad(`${m.to[0]}-${m.to[1]}`, 12)} ` +
          `${pad(`${m.oldScore.toFixed(2)} → ${m.newScore.toFixed(2)}`, 14)} ${m.kind}`,
      );
    }
  }
  if (result.refreshes.length) {
    console.log(`  ${pad("unit", 54)} ${pad("lines", 12)} ${pad("score", 8)} refreshed quote`);
    for (const r of result.refreshes) {
      console.log(`  ${pad(r.unit, 54)} ${pad(`${r.lines[0]}-${r.lines[1]}`, 12)} ${pad(r.score.toFixed(2), 8)} ${r.newQuote.slice(0, 80)}`);
    }
  }
  if (result.widenings.length) {
    console.log(`  ${pad("unit", 54)} ${pad("token", 10)} ${pad("line", 8)} source`);
    for (const w of result.widenings) {
      console.log(`  ${pad(w.unit, 54)} ${pad(w.token, 10)} ${pad(`L${w.line}`, 8)} ${w.sourceLine.slice(0, 90)}`);
    }
  }
  for (const a of result.numberAbsent) {
    console.log(`  NUMBER_ABSENT_FROM_CORPUS ${a.unit} :: ${a.token} (searched ${a.searched})`);
    console.log(`      ${a.text.slice(0, 200)}`);
  }
  for (const u of result.unresolved) {
    console.log(`  UNRESOLVED ${u.unit} (${u.score.toFixed(2)}) L${u.lines[0]}-${u.lines[1]}: ${u.text.slice(0, 120)}`);
  }

  if (write && (result.moves.length || result.refreshes.length || result.widenings.length)) {
    const sidecar = loaded.provenancePath ?? provenanceSidecarPath(contentPath);
    await fs.writeFile(sidecar, `${JSON.stringify(loaded.provenance, null, 2)}\n`);
    console.log(`  wrote ${sidecar}`);
  }
  return 0;
}

async function main() {
  process.exit(await runReanchorCli(parseArgs()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(3);
  });
}
