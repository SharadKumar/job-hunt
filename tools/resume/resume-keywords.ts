#!/usr/bin/env tsx
/**
 * resume-keywords.ts — screener-aware keyword planner.
 *
 * AI/ATS screeners reward the JD's exact vocabulary. The harness's honesty rule
 * says JD vocabulary can never CREATE a fact (see resume-term-grounding.ts).
 * This tool reconciles the two: it extracts the terms a JD (or, proactively, a
 * resume type's market lens + domain lexicon) expects, then classifies each one
 * against the candidate's real corpus so the writer knows which terms it may
 * surface, in which spelling, and which must go to the user as a question.
 *
 * The JD may dictate SPELLING and PLACEMENT of corpus-backed facts. It may not
 * dictate facts. Certifications are exact-match only (never alias-matched).
 *
 * Ledger answers are person-scoped: a `kind: keyword` row answered under any
 * positioning classifies the term (and its alias forms) in every plan, because
 * "have you delivered X?" is a fact about the person, not about the pitch.
 *
 * Classification order (first match wins):
 *   declined            ledger says declined / not_applicable → never render, never ask
 *   grounded            exact form present in cv-source.md / profile.md
 *   alias_grounded      a synonym (taxonomy / lexicon aliases / keyword_aliases
 *                       evidence patterns) is in the corpus → render the JD form, cite the line
 *   confirmed           ledger confirmed (source_update_required if corpus still lacks it)
 *   pending             ledger pending → outstanding, not re-asked
 *   familiarity         ledger familiarity → `preppable` with `render_as: "familiarity"`;
 *                       renderable WITH framing only, and never re-asked
 *   preppable           lexicon tier `preppable` → familiarity framing only
 *   needs_confirmation  lexicon tier `confirm`, or an unknown must-have
 *   foreign             everything else → report only
 *
 * `market_lens.must_signal` entries are NOT term candidates by default. They are
 * positioning concepts the writer signals through market-lens classification
 * ("commercial applied-AI delivery model"), not vocabulary a screener matches,
 * so they report corpus evidence in `signals[]` and never raise a question. A
 * must_signal phrase re-enters `terms[]` only when it is also real screener
 * vocabulary: a taxonomy synonym, a domain-lexicon term/alias, a
 * `keyword_aliases` key, or (JD mode) a phrase present verbatim in the JD.
 *
 * Usage:
 *   tsx tools/resume/resume-keywords.ts --resume <id> [--profile <id>]
 *       (--jd <path> [--opportunity <opp-id>] | --proactive)
 *       [--composition <composition.json>] [--rubric <template rubric.yaml>]
 *       [--out <plan.json> | --out -] [--quiet]
 *
 * Exit: 0 in plan mode. With --composition: 1 when coverage warns, else 0.
 *       2 on usage error.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveProfileContext } from "../profile-context.ts";
import { loadResolvedResumes, type ResolvedResume, type MarketLens, type DomainLexiconTerm } from "../resumes.ts";
import {
  CLOUD_STALE_DAYS,
  cloudAgeDays,
  loadKeywordClouds,
  resolveCloudsForType,
  type CloudTerm,
  type ResolvedCloud,
} from "../keyword-clouds.ts";
import { loadTaxonomy, type SkillTaxonomy } from "../score.ts";
import { readConfirmations, matchingConfirmation, lineNumbersFor, type MarketConfirmation } from "./market-lens-audit.ts";
import type { ResumeContent } from "../../templates/resume/_interface.ts";
import {
  STOPWORDS, parseArgs, normalise, stem, buildStemSet, tokenInText, phraseInText, phraseInTextLoose,
  claimFields, lineNumbersContaining, lineNumbersMatchingLoose,
  type KeywordPlan, type KeywordTerm, type KeywordQuestion, type KeywordCategory, type KeywordStatus,
  type KeywordSignal, type AtsComposite, type KeywordGap,
  type KeywordCloudKind,
  type KeywordPlanCloud,
} from "./keyword-lexicon.ts";

/**
 * The evidence interview's reusable answers. "Bring in as familiarity" is for a
 * term the user did not deliver but can credibly prepare and speak to: it is
 * recorded as a `familiarity` ledger row, classified `preppable` with
 * `render_as: "familiarity"`, and rendered only under familiarity framing.
 */
export const QUESTION_OPTIONS = ["Confirm and update source", "Not applicable", "Bring in as familiarity", "Unsure / keep pending"] as const;
export const COVERAGE_SURFACED_WARN_PCT = 85;
export const COVERAGE_RENDERABLE_WARN_PCT = 60;
const LEXICON_STALE_DAYS = 30;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type KeywordContext = {
  resumeId: string;
  profileId: string | null;
  cvSource: string;
  profileMd: string;
  taxonomy: SkillTaxonomy;
  confirmations: MarketConfirmation[];
  marketLens: MarketLens | undefined;
  /** the positioning's keyword clouds, heaviest first (state/org/keyword-clouds.yaml) */
  clouds: ResolvedCloud[];
  searchKeywords: string[];
  /** experience headings of cv-source.md: line number + heading text */
  roleHeadings: Array<{ line: number; text: string }>;
};

export type Candidate = {
  term: string;              // display form as seen in JD / lens
  /** extra aliases the JD itself establishes, e.g. "Business Process Management (BPM)" */
  jd_aliases?: string[];
  /** added from a known vocabulary list, so generic-word pruning must not drop it */
  forced?: boolean;
  category: KeywordCategory;
  must_have: boolean;
  jd_context: string | null;
  jd_frequency?: number;
  why?: string | null;
  lexicon?: DomainLexiconTerm;
  /** keyword cloud the term came from, when it came from one */
  cloud_id?: string | null;
  cloud_kind?: KeywordCloudKind | null;
  /** the positioning's weight for `cloud_id` (0 when the term has no cloud) */
  cloud_weight?: number;
  /** where the candidate entered the plan from (proactive mode); JD mode is "jd" */
  source?: KeywordGap["source"];
  /** taxonomy category the candidate came from, when source is "taxonomy" */
  taxonomy_group?: string | null;
  /**
   * Proactive mode only: this curated taxonomy entry belongs to THIS resume's
   * positioning, so its absence from the corpus is a question, not a shrug.
   */
  type_relevant?: boolean;
  /** why the entry counts as relevant to this positioning (for the question text) */
  relevance_reason?: string | null;
};

const REQUIREMENT_HEADING = /(requirement|about you|what you.?ll bring|what you bring|you bring|you will bring|skills|essential|desirable|must have|qualification|experience required|key criteria|selection criteria|ideal candidate|you have|we.?re looking for|looking for)/i;
const MUST_CUE = /\b(must|required|require|essential|mandatory|minimum|non-negotiable|critical|need to have|you will have|you have|proven|demonstrated|strong)\b/i;
const NICE_CUE = /\b(desirable|preferred|bonus|advantage|nice to have|ideally|highly regarded|a plus|beneficial)\b/i;
const TRIGGER = /\b(?:experience (?:with|in|of|across|using)|knowledge of|proficien(?:t|cy) (?:in|with)|expertise in|hands-on (?:with|in)|background in|exposure to|skilled in|familiarity with|certified in|certification in|understanding of)\s+([^.;:()\n]{3,80})/gi;
const CERT_PATTERN = /\b(TOGAF|PMP|PRINCE2|PRINCE 2|SAFe|ITIL|CISSP|CISM|CBAP|CSM|PSM|PMI-ACP|CKA|CKAD|AZ-\d{3}|AWS Certified[^,.;\n]*|Azure Solutions Architect Expert|Azure Architect Expert|Google Cloud Professional [A-Za-z ]*Architect|ServiceNow Certified[^,.;\n]*|CIS-[A-Z]{2,5}|Salesforce Certified[^,.;\n]*|Microsoft Certified[^,.;\n]*|Certified Scrum ?Master|Certified Kubernetes [A-Za-z]+|Certified Solutions? Architect[^,.;\n]*|Lean Six Sigma|Six Sigma(?: Black Belt| Green Belt)?)\b/g;
const CERT_WORD = /certif|togaf|\bpmp\b|prince|itil|\bsafe\b|cissp|cism|cbap|\bcsm\b|\bpsm\b|cis-|az-\d|\bcka\b|six sigma/i;
const METHODOLOGY_WORDS = new Set(["agile", "scrum", "kanban", "safe", "scaled agile", "itil", "togaf", "prince2", "lean", "devops", "devsecops", "ci/cd", "ci cd", "continuous integration", "continuous delivery", "continuous deployment", "tdd", "bdd", "design thinking", "waterfall", "mlops", "llmops", "domain driven design", "event driven architecture", "microservices", "zero trust", "site reliability engineering", "sre"]);
const TITLE_WORDS = /\b(architect|manager|lead|engineer|consultant|director|head|principal|specialist|analyst|owner|cto|cio)\b/i;
const GENERIC_CAP_SPAN = /^(the|our|we|you|your|this|a|an|in|on|at|for|to|with|and|or|of)$/i;

const TAXONOMY_CATEGORY: Record<string, KeywordCategory> = {
  platforms: "platform", engineering_stack: "tool", ai_genai: "tool", practice_areas: "domain", industries: "domain",
};

/**
 * Which resume positionings a taxonomy GROUP (the top-level key in
 * skills-taxonomy.yaml `categories`) speaks for.
 *
 * Deliberately a small, explicit, hand-maintained table rather than a fuzzy
 * match: it decides whether a curated taxonomy entry that the corpus does not
 * yet carry is worth asking the user about for this resume, or is simply out of
 * scope for the positioning. Add a row when a new group or resume id appears;
 * an unmapped group is treated as "not relevant to any positioning by group",
 * and its entries can still be relevant through the per-resume vocabulary
 * (search_keywords / must_signal / keyword_aliases / domain_lexicon).
 *
 * Group → positioning rationale:
 *   ai_genai          AI / agentic vocabulary → the two AI positionings
 *   engineering_stack hands-on build stack → the hands-on AI build positioning
 *   platforms         enterprise product platforms (M365 et al) → the Microsoft
 *                     consultant and the solution architect who designs on them
 *   practice_areas    architecture + delivery practice → those two positionings
 *   industries        sector nouns; never screener vocabulary for a positioning
 */
export const TAXONOMY_GROUP_POSITIONINGS: Record<string, readonly string[]> = {
  ai_genai: ["applied-ai", "ai-developer"],
  engineering_stack: ["ai-developer"],
  platforms: ["microsoft-consultant", "solution-architect"],
  practice_areas: ["solution-architect", "delivery-manager", "fractional-cto"],
  industries: [],
};

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordRe(s: string): RegExp { return new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, "i"); }
function sha(text: string): string { return createHash("sha256").update(text).digest("hex").slice(0, 16); }
function key(term: string): string { return normalise(term).trim(); }
function isAcronymish(s: string): boolean { return /^[A-Z0-9][A-Z0-9/.+-]{1,7}$/.test(s) && /[A-Z]/.test(s); }

function roleHeadingsOf(cvSource: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  cvSource.split("\n").forEach((line, i) => {
    const m = line.match(/^###\s+(.+)$/);
    if (m) out.push({ line: i + 1, text: m[1].trim() });
  });
  return out;
}

export async function loadKeywordContext(resumeId: string, profileId?: string | null): Promise<KeywordContext> {
  const ctx = resolveProfileContext(profileId);
  const cvSource = await fs.readFile(ctx.cvSourcePath, "utf8").catch(() => "");
  const profileMd = await fs.readFile(ctx.profileMdPath, "utf8").catch(() => "");
  const taxonomy = await loadTaxonomy(path.join(ctx.profileDir, "skills-taxonomy.yaml"));
  const confirmations = await readConfirmations(ctx.marketConfirmationsPath);
  const resumes = await loadResolvedResumes({ profileId: ctx.profileId });
  const resolved: ResolvedResume | undefined = resumes.find((r) => r.resume.id === resumeId);
  if (!resolved) throw new Error(`Unknown resume id "${resumeId}" (active resumes: ${resumes.map((r) => r.resume.id).join(", ")})`);
  return {
    resumeId, profileId: ctx.profileId, cvSource, profileMd, taxonomy, confirmations,
    marketLens: resolved.resume.market_lens,
    clouds: resolveCloudsForType(resolved.resume.market_lens, await loadKeywordClouds()),
    searchKeywords: resolved.resume.search_keywords ?? [],
    roleHeadings: roleHeadingsOf(cvSource),
  };
}

// ---------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------

function categoriseTerm(term: string, ctx: KeywordContext, hint?: KeywordCategory): KeywordCategory {
  if (hint) return hint;
  const k = key(term);
  if (CERT_WORD.test(term)) return "certification";
  if (METHODOLOGY_WORDS.has(k)) return "methodology";
  for (const [cat, entries] of Object.entries(ctx.taxonomy.categories)) {
    for (const def of Object.values(entries)) {
      if (def.synonyms.some((s) => key(s) === k)) return TAXONOMY_CATEGORY[cat] ?? "tool";
    }
  }
  if (ctx.searchKeywords.some((s) => key(s) === k) || (TITLE_WORDS.test(term) && term.split(/\s+/).length <= 4 && /^[A-Z]/.test(term))) return "title";
  if (isAcronymish(term)) return "tool";
  return "concept";
}

/** A cloud term carrying the cloud it belongs to, so every plan row is traceable. */
type SourcedTerm = CloudTerm & { cloud_id: string | null; cloud_kind: KeywordCloudKind | null; cloud_weight: number };

/**
 * Every vocabulary term this positioning is written against.
 *
 * Primary source is the type's weighted `market_lens.clouds`. The flat
 * `market_lens.domain_lexicon` is still read for one release (terms come
 * through with no cloud) so a type that has not been migrated still plans.
 */
function cloudTerms(ctx: KeywordContext): SourcedTerm[] {
  const out: SourcedTerm[] = [];
  for (const cloud of ctx.clouds ?? []) {
    for (const t of cloud.terms ?? []) out.push({ ...t, cloud_id: cloud.id, cloud_kind: cloud.kind, cloud_weight: cloud.weight });
  }
  if (!out.length) {
    for (const t of ctx.marketLens?.domain_lexicon?.terms ?? []) out.push({ ...t, cloud_id: null, cloud_kind: null, cloud_weight: 0 });
  }
  return out;
}

/**
 * Normalised keys of every phrase that counts as real screener vocabulary:
 * taxonomy synonyms plus domain-lexicon terms and aliases. A `must_signal`
 * phrase outside this set is positioning, not a term.
 *
 * `keyword_aliases` keys are deliberately NOT in this set. An alias entry only
 * says how to evidence a phrase if it ever needs rendering; it does not make a
 * positioning concept into vocabulary a screener matches. Such a phrase still
 * reaches `terms[]` through the keyword_aliases pass, but without must-have
 * weight, so it reports evidence instead of demanding a question.
 */
function screenerVocabulary(ctx: KeywordContext): Set<string> {
  const out = new Set<string>();
  for (const entries of Object.values(ctx.taxonomy.categories)) {
    for (const def of Object.values(entries)) for (const syn of def.synonyms) out.add(key(syn));
  }
  for (const lx of cloudTerms(ctx)) { out.add(key(lx.term)); for (const a of lx.aliases ?? []) out.add(key(a)); }
  return out;
}

const SECTION_PHRASES = /(Key Responsibilities|Responsibilities|About the Role|About You|About you|What you.?ll bring|What you bring|What we.?re looking for|Requirements|Essential|Desirable|Skills and Experience|Skills & Experience|Your Experience|Your Skills|Selection Criteria|Key Criteria|Qualifications|Nice to have|Overview|The Role|Benefits|How to Apply|To succeed in this role)(?=\s*:|\s+[A-Z])/g;
const NOISE_SPAN = /^(Key Responsibilities|About You|About the Role|Working Arrangements|Overview|Payrate|Pay Rate|Day Rate|Duration|Start Date|Employment type|Source|Location|Salary|Contract|Temp|Hybrid|Remote|Onsite)\b/i;

/** Scraped JDs are often one flat paragraph: re-segment into heading lines and sentences. */
export function segmentJd(jdText: string): string[] {
  const withHeadings = jdText.replace(SECTION_PHRASES, "\n$1\n");
  const out: string[] = [];
  for (const raw of withHeadings.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    for (const sentence of line.split(/(?<=[.!?:])\s+(?=[A-Z(])/)) if (sentence.trim()) out.push(sentence.trim());
  }
  return out;
}

/** Extract candidate terms from a JD, with must-have cues from section + line context. */
export function extractCandidates(jdText: string, ctx: KeywordContext): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const lines = segmentJd(jdText);
  let inRequirements = false;

  const add = (term: string, line: string, cat?: KeywordCategory, extra?: Partial<Candidate>, force = false) => {
    const clean = term.replace(/\s+/g, " ").replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "").trim();
    const k = key(clean);
    if (!k || k.length < 2) return;
    const toks = k.split(" ");
    if (!force && toks.every((t) => STOPWORDS.has(t) || t.length < 2)) return;
    if (toks.length > 5) return;
    const must = inRequirements ? !NICE_CUE.test(line) : MUST_CUE.test(line) && !NICE_CUE.test(line);
    const existing = byKey.get(k);
    if (existing) {
      existing.forced = existing.forced || force;
      existing.must_have = existing.must_have || must;
      existing.jd_frequency = (existing.jd_frequency ?? 1) + 1;
      if (!existing.jd_context && line) existing.jd_context = line.trim().slice(0, 160);
      return;
    }
    byKey.set(k, {
      term: clean, category: categoriseTerm(clean, ctx, cat), must_have: must, forced: force,
      jd_context: line.trim().slice(0, 160) || null, jd_frequency: 1, ...extra,
    });
  };

  // 1. Known vocabulary anywhere in the JD (taxonomy, lens, lexicon, titles)
  const known: Array<{ term: string; cat?: KeywordCategory; lex?: SourcedTerm }> = [];
  for (const [cat, entries] of Object.entries(ctx.taxonomy.categories)) {
    for (const def of Object.values(entries)) for (const syn of def.synonyms) known.push({ term: syn, cat: TAXONOMY_CATEGORY[cat] });
  }
  for (const s of ctx.marketLens?.must_signal ?? []) known.push({ term: s });
  for (const s of Object.keys(ctx.marketLens?.keyword_aliases ?? {})) known.push({ term: s });
  for (const lx of cloudTerms(ctx)) { known.push({ term: lx.term, cat: lx.category, lex: lx }); for (const a of lx.aliases ?? []) known.push({ term: a, cat: lx.category, lex: lx }); }
  for (const s of ctx.searchKeywords) known.push({ term: s, cat: "title" });

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const isHeading = /^(#{1,6}\s|\*\*.+\*\*:?$|[A-Z][A-Za-z ,'&/-]{2,60}:?$)/.test(line) && line.length < 80 && !/[.]$/.test(line);
    if (isHeading) { inRequirements = REQUIREMENT_HEADING.test(line); if (/^#\s/.test(line)) continue; }
    for (const kn of known) {
      if (wordRe(kn.term).test(line)) {
        add(kn.term, line, kn.cat, kn.lex
          ? { lexicon: kn.lex, why: kn.lex.why ?? null, cloud_id: kn.lex.cloud_id, cloud_kind: kn.lex.cloud_kind, cloud_weight: kn.lex.cloud_weight }
          : undefined, true);
      }
    }
    // 2. Certifications (exact)
    for (const m of line.matchAll(CERT_PATTERN)) add(m[1], line, "certification");
    // 3. Acronyms
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9]{1,7}(?:\/[A-Z0-9]{2,7})*)\b/g)) {
      if (METHODOLOGY_WORDS.has(key(m[1]).replace(" ", "/")) || METHODOLOGY_WORDS.has(m[1].toLowerCase())) continue; // "CI/CD" handled as a methodology
      for (const part of m[1].split("/")) if (part.length >= 2 && !/^(AND|OR|THE|ASAP|NSW|VIC|QLD|ACT|WA|SA|TAS|NT|AU|US|UK|EU|CBD|PLUS|ETC)$/.test(part)) add(part, line, undefined);
    }
    // 4. Capitalised spans (2-4 tokens), e.g. "Enterprise Architecture", "Power Platform"
    for (const m of line.matchAll(/\b((?:[A-Z][a-zA-Z0-9+.#-]+)(?:\s+(?:[A-Z][a-zA-Z0-9+.#-]+|\d+)){1,3})\b/g)) {
      const span = m[1];
      const toks = span.split(/\s+/);
      if (toks.some((t) => GENERIC_CAP_SPAN.test(t))) continue;
      if (/^(Day|Hybrid|Sydney|Melbourne|Brisbane|Canberra|Perth|Adelaide|Australian|Australia|Contract|Permanent|Full|Part|Monday|Friday|The|We|You|Our)\b/.test(span)) continue;
      if (NOISE_SPAN.test(span) || /\b(Duration|Payrate|Overview)\b/.test(span)) continue;
      add(span, line, undefined);
    }
    // 5. Trigger phrases: "experience with X, Y and Z"
    for (const m of line.matchAll(TRIGGER)) {
      const obj = m[1];
      for (const part of obj.split(/,|\band\b|\bor\b|\//)) {
        const p = part.trim().replace(/^(the|a|an|at least one of|one of|either)\s+/i, "");
        if (/^(at least one of|one of|the following|following|any of|some of|all of)$/i.test(p)) continue;
        if (p.split(/\s+/).length <= 4 && p.length >= 3 && !/^\d+\+?\s*years?/i.test(p)) add(p, line, undefined);
      }
    }
    // 6. Methodology words in lowercase
    for (const mw of METHODOLOGY_WORDS) {
      const m = line.match(wordRe(mw));
      if (m) add(m[0], line, "methodology", undefined, true);
    }
  }

  // JD-internal acronym expansions: "Business Process Management (BPM)" links both forms
  for (const m of jdText.matchAll(/((?:[A-Z][A-Za-z0-9+.#-]*)(?:\s+(?:[A-Za-z][A-Za-z0-9+.#-]*)){1,4})\s*\(([A-Z][A-Z0-9]{1,6})\)/g)) {
    const expansion = m[1].trim(), acronym = m[2];
    const expToks = expansion.split(/\s+/);
    // keep only the trailing capitalised run that spells the acronym
    const run = expToks.slice(-acronym.length).filter((t) => /^[A-Z]/.test(t));
    const exp = run.length === acronym.length ? run.join(" ") : expansion;
    const a = byKey.get(key(acronym));
    const e = byKey.get(key(exp));
    const line = m[0];
    if (!a) add(acronym, line, undefined, undefined, true);
    if (!e) add(exp, line, undefined, undefined, true);
    const ac = byKey.get(key(acronym)); const ec = byKey.get(key(exp));
    if (ac && ec) {
      ac.jd_aliases = [...new Set([...(ac.jd_aliases ?? []), exp])];
      ec.jd_aliases = [...new Set([...(ec.jd_aliases ?? []), acronym])];
      ac.must_have = ec.must_have = ac.must_have || ec.must_have;
      if (ac.category === "concept" || ac.category === "tool") ac.category = ec.category === "concept" ? "methodology" : ec.category;
      ec.category = ac.category;
    }
  }

  // Prune noisy single generic words
  return [...byKey.values()].filter((c) => {
    const k = key(c.term);
    if (!c.forced && k.split(" ").length === 1 && STOPWORDS.has(k)) return false;
    if (/^\d+$/.test(k)) return false;
    return true;
  });
}

/**
 * Every phrase this resume type itself names as vocabulary it cares about:
 * search keywords, market-lens must-signals, keyword-alias keys and their
 * evidence patterns, and the domain lexicon (terms + aliases).
 */
function typeVocabulary(ctx: KeywordContext): Set<string> {
  const out = new Set<string>();
  for (const s of ctx.searchKeywords) out.add(key(s));
  for (const s of ctx.marketLens?.must_signal ?? []) out.add(key(s));
  for (const [s, def] of Object.entries(ctx.marketLens?.keyword_aliases ?? {})) {
    out.add(key(s));
    for (const p of def.acceptable_if_source_mentions ?? []) out.add(key(p));
  }
  for (const lx of cloudTerms(ctx)) { out.add(key(lx.term)); for (const a of lx.aliases ?? []) out.add(key(a)); }
  return out;
}

/**
 * Is a curated taxonomy entry relevant to THIS resume's positioning?
 *
 * Two independent routes, both explicit:
 *  1. VOCABULARY — the entry's canonical name or any synonym is named by the
 *     resume type itself (search_keywords / must_signal / keyword_aliases keys
 *     or their acceptable_if_source_mentions / domain_lexicon).
 *  2. GROUP — the entry sits under a taxonomy group mapped to this resume id in
 *     `TAXONOMY_GROUP_POSITIONINGS`.
 *
 * Relevance decides what happens when the corpus does NOT carry the entry: a
 * relevant entry becomes a question (`needs_confirmation`), an irrelevant one
 * stays `foreign` and is listed in `gaps[]`. It never invents evidence.
 */
export function taxonomyRelevance(
  ctx: KeywordContext, group: string, canonical: string, synonyms: string[], vocabulary: Set<string>,
): { relevant: boolean; reason: string | null } {
  const named = [canonical.replace(/_/g, " "), ...synonyms].find((f) => vocabulary.has(key(f)));
  if (named) return { relevant: true, reason: `"${named}" is named in this resume type's own keyword vocabulary` };
  if ((TAXONOMY_GROUP_POSITIONINGS[group] ?? []).includes(ctx.resumeId)) {
    return { relevant: true, reason: `taxonomy group "${group}" is mapped to the ${ctx.resumeId} positioning` };
  }
  return { relevant: false, reason: null };
}

/** Proactive candidates: no JD; lens + lexicon + taxonomy vocabulary. */
export function proactiveCandidates(ctx: KeywordContext): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const k = key(c.term);
    if (!byKey.has(k)) { byKey.set(k, c); return; }
    const e = byKey.get(k)!;
    e.must_have = e.must_have || c.must_have;
    e.lexicon = e.lexicon ?? c.lexicon;
    e.cloud_id = e.cloud_id ?? c.cloud_id;
    e.cloud_kind = e.cloud_kind ?? c.cloud_kind;
    e.cloud_weight = Math.max(e.cloud_weight ?? 0, c.cloud_weight ?? 0);
    e.why = e.why ?? c.why;
    e.jd_frequency = Math.max(e.jd_frequency ?? 0, c.jd_frequency ?? 0);
    e.type_relevant = e.type_relevant || c.type_relevant;
    e.relevance_reason = e.relevance_reason ?? c.relevance_reason;
    e.taxonomy_group = e.taxonomy_group ?? c.taxonomy_group;
  };
  // must_signal alone never makes a term: only the phrases that are also real
  // screener vocabulary come through (and then carry the must-have weight).
  const vocabulary = screenerVocabulary(ctx);
  for (const s of ctx.marketLens?.must_signal ?? []) {
    if (!vocabulary.has(key(s))) continue;
    add({ term: s, category: categoriseTerm(s, ctx), must_have: true, jd_context: null, source: "market_lens", why: "listed as a must-signal in the resume type's market lens" });
  }
  for (const [s, def] of Object.entries(ctx.marketLens?.keyword_aliases ?? {})) add({ term: s, category: categoriseTerm(s, ctx), must_have: false, jd_context: null, source: "keyword_aliases", why: def.guidance ?? "listed in the resume type's keyword aliases" });
  for (const lx of cloudTerms(ctx)) {
    const must = lx.tier === "corpus" || lx.tier === "confirm" ? (lx.jd_frequency ?? 0) >= 3 : false;
    add({
      term: lx.term, category: lx.category ?? categoriseTerm(lx.term, ctx), must_have: must, jd_context: null,
      jd_frequency: lx.jd_frequency, source: lx.cloud_id ? "cloud" : "lexicon", why: lx.why ?? null, lexicon: lx,
      cloud_id: lx.cloud_id, cloud_kind: lx.cloud_kind, cloud_weight: lx.cloud_weight,
    });
  }
  const typeVocab = typeVocabulary(ctx);
  for (const [cat, entries] of Object.entries(ctx.taxonomy.categories)) {
    for (const [canonical, def] of Object.entries(entries)) {
      if (def.seniority === "familiar") continue;
      const term = def.synonyms[0] ?? canonical;
      const rel = taxonomyRelevance(ctx, cat, canonical, def.synonyms, typeVocab);
      add({
        term, category: TAXONOMY_CATEGORY[cat] ?? "tool", must_have: false, jd_context: null,
        source: "taxonomy", taxonomy_group: cat, type_relevant: rel.relevant, relevance_reason: rel.reason,
        why: `taxonomy marks the candidate ${def.seniority} in ${canonical}`,
      });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type CorpusIndex = { norm: string; stems: Set<string> };

function corpusIndex(ctx: KeywordContext): CorpusIndex {
  const norm = normalise(`${ctx.cvSource}\n${ctx.profileMd}`);
  return { norm, stems: buildStemSet(norm) };
}

function inCorpus(form: string, idx: CorpusIndex): boolean {
  const k = key(form);
  if (!k) return false;
  // Multi-word forms tolerate plural/singular and hyphen variance the same way
  // single tokens already do, so "retrieval pipelines" in the corpus grounds the
  // taxonomy's "retrieval pipeline".
  if (k.includes(" ")) return phraseInTextLoose(k, idx.norm);
  return tokenInText(k, idx.norm, idx.stems);
}

/** Evidence lines for a corpus form, tolerating the same inflection as `inCorpus`. */
function corpusLinesFor(form: string, ctx: KeywordContext): number[] {
  return lineNumbersMatchingLoose(ctx.cvSource, form);
}

/**
 * Corpus-evidence report for every `market_lens.must_signal` phrase.
 * Mirrors the market-lens audit's explicit / implicit / missing verdicts, and is
 * strictly report-only: signals never produce questions and never move coverage.
 */
export function buildSignals(ctx: KeywordContext, idx: CorpusIndex, termKeys: Set<string>): KeywordSignal[] {
  const keywordAliases = Object.entries(ctx.marketLens?.keyword_aliases ?? {});
  return (ctx.marketLens?.must_signal ?? []).map((signal): KeywordSignal => {
    const also_a_term = termKeys.has(key(signal));
    if (inCorpus(signal, idx)) {
      return {
        signal, status: "explicit", matched_terms: [signal], also_a_term,
        evidence_lines: lineNumbersFor(ctx.cvSource, signal),
        reason: "signal wording appears in the corpus",
      };
    }
    const patterns = keywordAliases.filter(([alias]) => key(alias) === key(signal)).flatMap(([, def]) => def.acceptable_if_source_mentions ?? []);
    const matched = patterns.filter((p) => inCorpus(p, idx));
    if (matched.length) {
      return {
        signal, status: "implicit", matched_terms: matched, also_a_term,
        evidence_lines: [...new Set(matched.flatMap((p) => lineNumbersFor(ctx.cvSource, p)))].sort((a, b) => a - b),
        reason: "corpus carries configured keyword-alias evidence, but not the signal wording",
      };
    }
    return {
      signal, status: "missing", matched_terms: [], evidence_lines: [], also_a_term,
      reason: "no corpus evidence; positioning must come from selection and framing, not injected vocabulary",
    };
  });
}

/**
 * The entry's own name, tokenised: `retrieval_augmented_generation` →
 * ["retrieval","augmented","generation"], `microsoft365` → ["microsoft","365"]
 * (letter/digit runs split so a spaced synonym still meets the entry name).
 */
function entryAnchor(canonical: string): { stems: Set<string>; initials: string } {
  const spaced = canonical.replace(/([a-zA-Z])(\d)/g, "$1 $2").replace(/(\d)([a-zA-Z])/g, "$1 $2");
  const tokens = normalise(spaced).trim().split(" ").filter(Boolean);
  return { stems: new Set(tokens.map(stem)), initials: tokens.map((t) => t[0]).join("") };
}

/**
 * Is this surface form a form of the taxonomy ENTRY itself (rather than one of
 * several distinct products the entry happens to bucket)?
 *
 * True when the form shares a stem token with the entry name, or spells the
 * entry name's initials ("RAG" for `retrieval_augmented_generation`). Two forms
 * that are both anchored this way are one fact by construction — the user
 * curated them under one name — so they alias each other unconditionally.
 * `atlassian: [Jira, Confluence]` anchors neither, which is exactly why Jira
 * must never ground Confluence.
 */
function isAnchoredToEntry(form: string, anchor: { stems: Set<string>; initials: string }): boolean {
  const k = key(form);
  if (!k) return false;
  const toks = k.split(" ").filter(Boolean);
  if (toks.some((t) => t.length >= 2 && !STOPWORDS.has(t) && anchor.stems.has(stem(t)))) return true;
  return isAcronymish(form) && k.replace(/[^a-z0-9]/g, "") === anchor.initials;
}

/** Synonym set for a term from taxonomy, lexicon aliases, and lens keyword_aliases. */
function synonymsFor(term: string, ctx: KeywordContext, lex?: CloudTerm): { aliases: string[]; evidencePatterns: string[]; hasAcronymPair: boolean } {
  const k = key(term);
  const aliases = new Set<string>();
  let hasAcronymPair = false;
  for (const entries of Object.values(ctx.taxonomy.categories)) {
    for (const [canonical, def] of Object.entries(entries)) {
      if (def.synonyms.some((s) => key(s) === k)) {
        // Two kinds of taxonomy entry live in one file:
        //  1. CURATED ONE-FACT entries, where every synonym is a surface form of
        //     the entry's own name (`retrieval_augmented_generation:
        //     [RAG, retrieval augmented generation, retrieval pipeline]`). The
        //     user declared those the same fact, so they alias unconditionally.
        //  2. BUCKET entries, where one name collects distinct products
        //     (`atlassian: [Jira, Confluence]`). There the heuristic guard
        //     stands: a sibling is the same fact only when it shares a token or
        //     forms an acronym/expansion pair, so Jira never grounds Confluence.
        const anchor = entryAnchor(canonical);
        const termAnchored = isAnchoredToEntry(term, anchor);
        const termToks = new Set(k.split(" "));
        for (const s of def.synonyms) {
          if (key(s) === k) continue;
          if (termAnchored && isAnchoredToEntry(s, anchor)) { aliases.add(s); continue; }
          const sk = key(s);
          const shared = sk.split(" ").some((t) => t.length >= 3 && termToks.has(t));
          const acronymPair = isAcronymish(term) !== isAcronymish(s) && (isAcronymish(term) || isAcronymish(s));
          if (shared || acronymPair) aliases.add(s);
        }
        const short = def.synonyms.filter((s) => isAcronymish(s) || /\d/.test(s));
        const long = def.synonyms.filter((s) => !isAcronymish(s) && s.includes(" "));
        if (short.length && long.length && (isAcronymish(term) || long.some((l) => key(l) === k) || short.some((sh) => key(sh) === k))) hasAcronymPair = true;
      }
    }
  }
  const lx = lex ?? cloudTerms(ctx).find((l) => key(l.term) === k || (l.aliases ?? []).some((a) => key(a) === k));
  if (lx) { for (const a of [lx.term, ...(lx.aliases ?? [])]) if (key(a) !== k) aliases.add(a); }
  const evidencePatterns: string[] = [];
  const ka = ctx.marketLens?.keyword_aliases ?? {};
  for (const [signal, def] of Object.entries(ka)) {
    if (key(signal) === k) for (const p of def.acceptable_if_source_mentions ?? []) evidencePatterns.push(p);
  }
  return { aliases: [...aliases], evidencePatterns, hasAcronymPair };
}

function plausibleRoles(term: string, aliases: string[], ctx: KeywordContext): Array<{ line: number; text: string }> {
  const forms = [term, ...aliases].map(key).filter(Boolean);
  const hits: Array<{ line: number; text: string }> = [];
  const lines = ctx.cvSource.split("\n");
  for (let i = 0; i < ctx.roleHeadings.length; i++) {
    const h = ctx.roleHeadings[i];
    const end = ctx.roleHeadings[i + 1]?.line ?? lines.length + 1;
    const block = normalise(lines.slice(h.line, end - 1).join("\n"));
    // loose relatedness: any constituent token of the term appears in the role block
    const toks = new Set(forms.flatMap((f) => f.split(" ")).filter((t) => t.length >= 4 && !STOPWORDS.has(t)));
    if ([...toks].some((t) => block.includes(` ${t}`))) hits.push(h);
  }
  return hits.length ? hits.slice(0, 3) : ctx.roleHeadings.slice(0, 2);
}

function evidenceHint(lines: number[], ctx: KeywordContext): string | null {
  if (!lines.length) return null;
  const first = lines[0];
  const heading = [...ctx.roleHeadings].reverse().find((h) => h.line <= first);
  return `cv-source.md:${lines.slice(0, 3).join(",")}${heading ? ` (${heading.text})` : ""}`;
}

function humaniseRole(text: string): string {
  // "2021-03 – 2023-06 — Title, Company (loc)" → "Title, Company"; take the part after the last em/en dash separator
  const parts = text.split(/\s+[—–]\s+/);
  const tail = parts.length > 1 ? parts[parts.length - 1] : text.replace(/^[\d-]+\s*[-]\s*(?:[\d-]+|present)\s*[-]\s*/i, "");
  return tail.replace(/\s*\(.*\)\s*$/, "").trim();
}

/**
 * One underlying fact carrying several surface forms (an acronym and its
 * expansion, or synonyms of one taxonomy / lexicon entry).
 * `members` is ordered: the JD's primary form first.
 */
export type AliasGroup = { id: string; members: string[]; primary: string };

/** Alias forms this candidate is linked to (vetted taxonomy/lexicon synonyms + JD-declared pairs). */
function aliasFormsOf(c: Candidate, ctx: KeywordContext): string[] {
  const syn = synonymsFor(c.term, ctx, c.lexicon);
  return [...syn.aliases, ...(c.jd_aliases ?? [])];
}

/** JD-primary ordering: most-used form first, expansion before acronym, then longest. */
function aliasPrimaryOrder(a: Candidate, b: Candidate): number {
  return (b.jd_frequency ?? 0) - (a.jd_frequency ?? 0)
    || Number(isAcronymish(a.term)) - Number(isAcronymish(b.term))
    || b.term.length - a.term.length
    || a.term.localeCompare(b.term);
}

/**
 * Union candidates that are alias forms of the same fact, so the plan asks once
 * and coverage counts once. Certifications only ever group with certifications
 * (a cert is an exact-match fact, never a rename of the practice around it).
 * Returns a map from each member's normalised key to its group.
 */
export function buildAliasGroups(candidates: Candidate[], ctx: KeywordContext): Map<string, AliasGroup> {
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const indexByKey = new Map<string, number>();
  candidates.forEach((c, i) => { if (!indexByKey.has(key(c.term))) indexByKey.set(key(c.term), i); });
  const isCert = (c: Candidate) => c.category === "certification";
  candidates.forEach((c, i) => {
    for (const alias of aliasFormsOf(c, ctx)) {
      const j = indexByKey.get(key(alias));
      if (j === undefined || j === i) continue;
      if (isCert(c) !== isCert(candidates[j])) continue;
      union(i, j);
    }
  });
  const buckets = new Map<number, number[]>();
  candidates.forEach((_, i) => {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(i); else buckets.set(root, [i]);
  });
  const out = new Map<string, AliasGroup>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const members = bucket.map((i) => candidates[i]).sort(aliasPrimaryOrder);
    const primary = members[0].term;
    const group: AliasGroup = { id: `ag:${key(primary).replace(/[^a-z0-9]+/g, "-")}`, members: members.map((m) => m.term), primary };
    for (const m of members) out.set(key(m.term), group);
  }
  return out;
}

export function classifyTerm(c: Candidate, ctx: KeywordContext, idx: CorpusIndex, group?: AliasGroup): KeywordTerm {
  const syn = synonymsFor(c.term, ctx, c.lexicon);
  const otherForms = (group?.members ?? []).filter((m) => key(m) !== key(c.term));
  const aliases = [...new Set([...syn.aliases, ...(c.jd_aliases ?? []), ...otherForms])];
  // Questions and proposed lines must cover every form the screener may look for.
  const displayTerm = otherForms.length ? `${c.term} (${otherForms.join(", ")})` : c.term;
  const { evidencePatterns } = syn;
  const hasAcronymPair = syn.hasAcronymPair || (c.jd_aliases ?? []).length > 0;
  // Ledger lookup is person-scoped for keyword rows and covers every alias form
  // of the same fact, so an answer given under one positioning suppresses the
  // question under all of them (see matchingConfirmation).
  const ledger = matchingConfirmation(ctx.confirmations, ctx.resumeId, c.term, null, { aliases });
  const isCert = c.category === "certification";
  const base: KeywordTerm = {
    term: c.term, jd_form: c.term, corpus_form: null, aliases, category: c.category, must_have: c.must_have,
    status: "foreign", render_as: null, render_both_forms: false, corpus_lines: [], source_update_required: false,
    jd_context: c.jd_context ?? null, evidence_hint: null, why: c.why ?? null, question: null, proposed_phrasing: null,
    surfaced_in: [], jd_frequency: c.jd_frequency, alias_group: group?.id ?? null,
    cloud_id: c.cloud_id ?? null, cloud_kind: c.cloud_kind ?? null,
  };

  if (ledger && (ledger.status === "declined" || ledger.status === "not_applicable")) return { ...base, status: "declined" };
  if (c.lexicon?.tier === "forbidden") return { ...base, status: "foreign", why: c.why ?? "the keyword cloud marks this term forbidden unless the source states it explicitly" };

  if (inCorpus(c.term, idx)) {
    const lines = corpusLinesFor(c.term, ctx);
    return { ...base, status: "grounded", corpus_form: c.term, corpus_lines: lines, evidence_hint: evidenceHint(lines, ctx), render_both_forms: hasAcronymPair };
  }
  if (!isCert) {
    for (const alias of aliases) {
      if (inCorpus(alias, idx)) {
        const lines = corpusLinesFor(alias, ctx);
        return { ...base, status: "alias_grounded", corpus_form: alias, corpus_lines: lines, evidence_hint: evidenceHint(lines, ctx), render_both_forms: hasAcronymPair };
      }
    }
    for (const pattern of evidencePatterns) {
      if (inCorpus(pattern, idx)) {
        const lines = corpusLinesFor(pattern, ctx);
        return { ...base, status: "alias_grounded", corpus_form: pattern, corpus_lines: lines, evidence_hint: evidenceHint(lines, ctx), render_both_forms: hasAcronymPair };
      }
    }
    for (const pattern of c.lexicon?.evidence_patterns ?? []) {
      if (inCorpus(pattern, idx)) {
        const lines = corpusLinesFor(pattern, ctx);
        return { ...base, status: "alias_grounded", corpus_form: pattern, corpus_lines: lines, evidence_hint: evidenceHint(lines, ctx), render_both_forms: hasAcronymPair };
      }
    }
  }
  if (ledger?.status === "confirmed") {
    return { ...base, status: "confirmed", source_update_required: true, evidence_hint: ledger.source_ref ?? ledger.evidence_hint ?? null, proposed_phrasing: ledger.proposed_phrasing ?? null };
  }
  if (ledger?.status === "familiarity") {
    // The user answered "Bring in as familiarity": not delivered, but credibly
    // preppable. Renderable with framing only, and the question is closed.
    return {
      ...base, status: "preppable", render_as: "familiarity",
      why: ledger.notes ?? "user answered the evidence interview with \"Bring in as familiarity\": preparable, not delivered",
      evidence_hint: ledger.evidence_hint ?? null, proposed_phrasing: ledger.proposed_phrasing ?? null,
    };
  }
  if (ledger?.status === "pending") {
    return { ...base, status: "pending", question: ledger.question ?? null, evidence_hint: ledger.evidence_hint ?? null, proposed_phrasing: ledger.proposed_phrasing ?? null };
  }
  if (c.lexicon?.tier === "preppable") return { ...base, status: "preppable" };

  // A curated taxonomy entry that belongs to this positioning but is absent from
  // the corpus is a genuine gap in the SOURCE, not a foreign term: ask about it
  // rather than dropping it silently.
  const askable = c.lexicon?.tier === "confirm" || (c.must_have && !isCert) || (isCert && c.must_have) || Boolean(c.type_relevant);
  if (askable) {
    const roles = plausibleRoles(c.term, aliases, ctx);
    const roleNames = roles.map((r) => humaniseRole(r.text));
    const hint = roles.length ? `cv-source.md:${roles.map((r) => r.line).join(",")} (${roleNames.join("; ")})` : null;
    const why = c.must_have ? c.why ?? `listed as a must-have in the JD${c.jd_context ? `: "${c.jd_context}"` : ""}`
      : c.lexicon?.tier === "confirm" ? c.why ?? "in the resume type's confirm-tier lexicon"
      : c.type_relevant ? `listed in your skills taxonomy for this positioning${c.relevance_reason ? ` (${c.relevance_reason})` : ""}`
      : c.why ?? "in the resume type's confirm-tier lexicon";
    const phrasing = isCert
      ? `${displayTerm} certified (state the year and issuing body)`
      : `Applied ${displayTerm} in ${roleNames[0] ?? "a recent role"} work (state the scope and outcome)`;
    const question = `${displayTerm}: did you use or deliver ${displayTerm} in any role? Plausible: ${roleNames.join("; ") || "none obvious"}. Why it matters: ${why}. Proposed line: "${phrasing}"`;
    return { ...base, status: "needs_confirmation", evidence_hint: hint, why, question, proposed_phrasing: phrasing };
  }
  return { ...base, status: "foreign" };
}

// ---------------------------------------------------------------------------
// Title alignment
// ---------------------------------------------------------------------------

function titleAlignment(jdTitle: string | null, ctx: KeywordContext, idx: CorpusIndex): KeywordPlan["title"] {
  if (!jdTitle) return { jd_title: null, title_family: null, alignment: "unknown", reason: "no JD title supplied" };
  const t = key(jdTitle);
  const family = ctx.searchKeywords.find((s) => t.includes(key(s))) ?? ctx.searchKeywords.find((s) => key(s).split(" ").every((w) => t.includes(w))) ?? null;
  if (!family) return { jd_title: jdTitle, title_family: null, alignment: "unknown", reason: "JD title does not match any of the resume's search keywords" };
  const familyInCorpus = inCorpus(family, idx) || ctx.roleHeadings.some((h) => key(h.text).includes(key(family)));
  const seniorityWords = t.match(/\b(principal|head|chief|director|senior|lead)\b/g) ?? [];
  const seniorityOk = seniorityWords.every((w) => idx.norm.includes(` ${w} `));
  if (familyInCorpus && seniorityOk) return { jd_title: jdTitle, title_family: family, alignment: "supported", reason: "title family and seniority both appear in the corpus" };
  return { jd_title: jdTitle, title_family: family, alignment: "unsupported", reason: familyInCorpus ? `seniority word(s) ${seniorityWords.join(", ")} not evidenced in the corpus` : "title family not evidenced in the corpus" };
}

// ---------------------------------------------------------------------------
// Composition coverage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ATS composite (secondary, advisory signal)
// ---------------------------------------------------------------------------

/** Component weights of the ATS composite; they sum to 1. */
export const ATS_WEIGHTS = { keyword_match: 0.55, skills_coverage: 0.25, section_completeness: 0.20 } as const;

/** Plan categories a screener expects to find in the SKILLS blocks specifically. */
const ATS_SKILL_CATEGORIES = new Set<KeywordCategory>(["tool", "platform", "methodology", "certification"]);

export type AtsCompositeOptions = {
  /** template rubric summary bounds, when known (`templates/resume/<t>/rubric.yaml`) */
  rubric?: { summary_min_chars?: number; summary_max_chars?: number } | null;
  /** whether cv-source.md itself carries credentials / education (null = unknown → check skipped) */
  sourceHasCredentials?: boolean | null;
};

/**
 * Whole-word, case-insensitive containment. Never a substring match: "Java"
 * must not be satisfied by "JavaScript", and "SA" must not be satisfied by
 * "SAFe". Internal whitespace is allowed to vary ("Microsoft  365").
 */
export function wholeWordHit(term: string, text: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(?<!\\w)${escapeRe(t).replace(/\s+/g, "\\s+")}(?!\\w)`, "i").test(text);
}

function anyFormHit(t: KeywordTerm, text: string): boolean {
  return [t.jd_form, t.corpus_form ?? ""].filter(Boolean).some((form) => wholeWordHit(form, text));
}

function pct(a: number, b: number): number {
  return b === 0 ? 100 : Math.round((a / b) * 100);
}

function sample(terms: string[]): string {
  return terms.slice(0, 5).join(", ") + (terms.length > 5 ? ", …" : "");
}

/**
 * Screener-style composite score for a composition against its keyword plan.
 *
 * ADOPTION NOTE: modelled on srbhr/Resume-Matcher `app/services/ats.py` and
 * Paramchoudhary/ResumeSkills' job-description analyser — a weighted blend of
 * keyword coverage, skills-section coverage, and structural completeness.
 *
 * CONTRACT — this is a SECONDARY signal. It must never change `plan.verdict`,
 * `plan.questions`, `plan.warnings`, or the tool's exit code; those stay owned
 * by the coverage gates in `finalise()`. It exists so a human (or the
 * resume-writer) can see at a glance how a composition would read to an ATS,
 * not so a threshold can fail a CV. Do not gate on it.
 */
export function computeAtsComposite(plan: KeywordPlan, content: ResumeContent, opts: AtsCompositeOptions = {}): AtsComposite {
  const notes: string[] = [];
  const claimText = claimFields(content).map((f) => f.text).join("\n");
  const allText = [content.headline ?? "", claimText].join("\n");

  // 1. keyword_match — any claim field carries the JD form or the corpus form.
  const missedKeywords = plan.terms.filter((t) => !anyFormHit(t, allText)).map((t) => t.jd_form);
  const keyword_match = pct(plan.terms.length - missedKeywords.length, plan.terms.length);
  if (missedKeywords.length) notes.push(`keyword_match ${keyword_match}: ${missedKeywords.length}/${plan.terms.length} plan terms absent from the composition (${sample(missedKeywords)})`);

  // 2. skills_coverage — hard vocabulary belongs in the skills blocks, not only in prose.
  const skillsText = (content.skills ?? [])
    .map((s) => [s.name, s.summary ?? "", ...(s.bullets ?? [])].join(" "))
    .concat(content.additional_skills_summary ?? "")
    .join("\n");
  const skillTerms = plan.terms.filter((t) => ATS_SKILL_CATEGORIES.has(t.category));
  const missedSkills = skillTerms.filter((t) => !anyFormHit(t, skillsText)).map((t) => t.jd_form);
  const skills_coverage = pct(skillTerms.length - missedSkills.length, skillTerms.length);
  if (missedSkills.length) notes.push(`skills_coverage ${skills_coverage}: ${missedSkills.length}/${skillTerms.length} tool/platform/methodology/certification terms missing from the skills blocks (${sample(missedSkills)})`);

  // 3. section_completeness — the structural shape a screener parses.
  const checks: Array<{ ok: boolean; note: string }> = [];
  const summary = (content.summary ?? "").trim();
  const min = opts.rubric?.summary_min_chars;
  const max = opts.rubric?.summary_max_chars;
  const withinRubric = (min == null || summary.length >= min) && (max == null || summary.length <= max);
  checks.push({
    ok: Boolean(summary) && withinRubric,
    note: !summary ? "no summary" : `summary is ${summary.length} chars, outside the rubric's ${min ?? "?"}-${max ?? "?"}`,
  });
  const highlights = (content.highlights ?? []).length;
  checks.push({ ok: highlights >= 3, note: `only ${highlights} highlight(s), screeners expect ≥3` });
  const blocks = (content.skills ?? []).length;
  checks.push({ ok: blocks >= 3, note: `only ${blocks} skill block(s), screeners expect ≥3` });
  const featured = (content.experiences ?? []).filter((x): x is Extract<typeof x, { placement: "feature" }> => x.placement === "feature");
  checks.push({ ok: featured.some((x) => (x.bullets ?? []).length >= 3), note: "no featured experience with ≥3 bullets" });
  if (opts.sourceHasCredentials) checks.push({ ok: (content.credentials ?? []).length > 0, note: "source carries credentials but the composition renders none" });
  const passed = checks.filter((c) => c.ok).length;
  const section_completeness = pct(passed, checks.length);
  for (const c of checks) if (!c.ok) notes.push(`section_completeness: ${c.note}`);

  const score = Math.round(
    ATS_WEIGHTS.keyword_match * keyword_match
    + ATS_WEIGHTS.skills_coverage * skills_coverage
    + ATS_WEIGHTS.section_completeness * section_completeness,
  );
  return { keyword_match, skills_coverage, section_completeness, score, notes };
}

export function applyComposition(plan: KeywordPlan, content: ResumeContent, atsOpts: AtsCompositeOptions = {}): KeywordPlan {
  const fields = claimFields(content);
  if (content.headline) fields.unshift({ field: "headline", text: content.headline });
  const normFields = fields.map((f) => ({ field: f.field, norm: normalise(f.text) }));
  for (const t of plan.terms) {
    const forms = [t.jd_form, t.corpus_form ?? ""].map(key).filter(Boolean);
    t.surfaced_in = normFields.filter((f) => forms.some((form) => phraseInText(form, f.norm))).map((f) => f.field);
  }
  const screener = (content.skills ?? []).find((s) => s.role === "screener");
  const screenerText = screener ? normalise([screener.summary ?? "", ...(screener.bullets ?? [])].join(" ")) : "";
  const screenerHits = screener ? plan.terms.filter((t) => phraseInText(key(t.jd_form), screenerText)).length : 0;
  plan.screener_surface = {
    headline_aligned: plan.title.title_family ? Boolean(content.headline && normalise(content.headline).includes(key(plan.title.title_family))) : null,
    screener_block_present: Boolean(screener) && screenerHits >= 3,
  };
  const finalised = finalise(plan, true);
  // Advisory only, and computed AFTER the verdict so it cannot influence it.
  finalised.ats_composite = computeAtsComposite(finalised, content, atsOpts);
  return finalised;
}

/** Coverage / question identity: one id per fact, so alias forms never double count. */
function factId(t: KeywordTerm): string {
  return t.alias_group ?? `t:${key(t.term)}`;
}

function countFacts(terms: KeywordTerm[]): number {
  return new Set(terms.map(factId)).size;
}

/** A term the user answered "Bring in as familiarity": renderable, but only under framing. */
const isFamiliarity = (t: KeywordTerm): boolean => t.status === "preppable" && t.render_as === "familiarity";

/**
 * Per-cloud coverage readout. Every cloud the positioning references appears,
 * including one that contributed nothing, because "this cloud is weighted 5 and
 * landed 0 terms" is exactly the signal a reader needs.
 */
function buildPlanClouds(plan: KeywordPlan, resolved: CloudHeader[], compositionMode: boolean): KeywordPlanCloud[] {
  const renderableStatus = (t: KeywordTerm) =>
    t.status === "grounded" || t.status === "alias_grounded" || (t.status === "confirmed" && !t.source_update_required) || isFamiliarity(t);
  return resolved.map((cloud) => {
    const mine = plan.terms.filter((t) => t.cloud_id === cloud.id);
    return {
      id: cloud.id,
      kind: cloud.kind,
      label: cloud.label,
      weight: cloud.weight,
      total: mine.length,
      renderable: mine.filter(renderableStatus).length,
      surfaced: compositionMode ? mine.filter((t) => t.surfaced_in.length > 0).length : 0,
      familiarity: mine.filter(isFamiliarity).length,
      questions: plan.questions.filter((q) => q.cloud_id === cloud.id).length,
    };
  });
}

/** Just the identity of a cloud: enough to report coverage without reloading it. */
type CloudHeader = { id: string; kind: KeywordCloudKind; label: string; weight: number };

function finalise(plan: KeywordPlan, compositionMode: boolean, clouds: ResolvedCloud[] = []): KeywordPlan {
  // On a re-finalise (composition mode) the plan already carries its cloud
  // headers, so the weights survive without reloading the clouds file.
  const resolved: CloudHeader[] = clouds.length
    ? clouds.map((c) => ({ id: c.id, kind: c.kind, label: c.label, weight: c.weight }))
    : plan.clouds ?? [];
  const cloudWeights = new Map(resolved.map((c) => [c.id, c.weight]));
  const freqByTerm = new Map(plan.terms.map((t) => [t.term, t.jd_frequency ?? 0]));
  const freqOf = (term: string) => freqByTerm.get(term) ?? 0;
  // Familiarity terms count as renderable-with-framing: the writer CAN put them on
  // the page (one familiarity-framed skills line), so treating them as coverage
  // gaps would under-report a term the user has already answered.
  const renderable = plan.terms.filter((t) => (t.status === "grounded" || t.status === "alias_grounded" || (t.status === "confirmed" && !t.source_update_required) || isFamiliarity(t)));
  const must = plan.terms.filter((t) => t.must_have);
  // A must-have on any form of a fact makes the whole fact a must-have, and any
  // renderable/surfaced form satisfies it.
  const mustIds = new Set(must.map(factId));
  const mustRenderable = renderable.filter((t) => mustIds.has(factId(t)));
  const mustSurfaced = mustRenderable.filter((t) => t.surfaced_in.length > 0);
  // An alias group is ONE must-have: "BPM" and "Business Process Management" are
  // one fact to evidence, and counting both would deflate every coverage ratio.
  const mustTotal = countFacts(must);
  const mustRenderableTotal = countFacts(mustRenderable);
  const mustSurfacedTotal = countFacts(mustSurfaced);
  const pct = (a: number, b: number) => (b === 0 ? 100 : Math.round((a / b) * 100));
  plan.coverage = {
    must_have_total: mustTotal,
    must_have_renderable: mustRenderableTotal,
    must_have_surfaced: mustSurfacedTotal,
    must_have_familiarity: countFacts(mustRenderable.filter(isFamiliarity)),
    renderable_pct: pct(mustRenderableTotal, mustTotal),
    surfaced_pct: compositionMode ? pct(mustSurfacedTotal, mustRenderableTotal) : 0,
    renderable_total: renderable.length,
    surfaced_total: compositionMode ? renderable.filter((t) => t.surfaced_in.length > 0).length : 0,
    familiarity_total: plan.terms.filter(isFamiliarity).length,
  };
  // One question per fact: the group's JD-primary form asks, the other forms ride
  // along as aliases so the user answers once and the answer covers every spelling.
  const asked = new Set<string>();
  const weightOf = (cloudId: string | null) => (cloudId ? cloudWeights.get(cloudId) ?? 0 : 0);
  plan.questions = plan.terms.filter((t) => t.status === "needs_confirmation" && t.question).flatMap<KeywordQuestion>((t) => {
    const id = factId(t);
    if (asked.has(id)) return [];
    asked.add(id);
    const aliases = t.alias_group
      ? plan.terms.filter((o) => o !== t && o.alias_group === t.alias_group).map((o) => o.term)
      : [];
    return [{
      term: t.term, aliases, alias_group: t.alias_group, category: t.category, question: t.question!,
      options: [...QUESTION_OPTIONS], evidence_hint: t.evidence_hint, proposed_phrasing: t.proposed_phrasing, why: t.why,
      cloud_id: t.cloud_id, cloud_kind: t.cloud_kind, cloud_weight: weightOf(t.cloud_id),
    }];
  });
  // The evidence interview runs cloud by cloud: heaviest cloud first, and inside
  // one cloud the term the market asks for most often leads. Cloudless terms
  // (JD-only, keyword_aliases, taxonomy) sort last, they have no owner to refresh.
  plan.questions.sort((a, b) =>
    b.cloud_weight - a.cloud_weight
    || (a.cloud_id ?? "\uffff").localeCompare(b.cloud_id ?? "\uffff")
    || (freqOf(b.term) - freqOf(a.term))
    || a.term.localeCompare(b.term));
  plan.clouds = buildPlanClouds(plan, resolved, compositionMode);
  let warn = false;
  if (mustTotal && plan.coverage.renderable_pct < COVERAGE_RENDERABLE_WARN_PCT) warn = true;
  if (compositionMode && mustRenderableTotal && plan.coverage.surfaced_pct < COVERAGE_SURFACED_WARN_PCT) warn = true;
  if (compositionMode && plan.screener_surface.screener_block_present === false) plan.warnings.push("no skills block with role \"screener\" containing ≥3 plan terms");
  if (compositionMode && plan.title.alignment === "supported" && plan.screener_surface.headline_aligned === false) plan.warnings.push(`headline does not carry the supported title family "${plan.title.title_family}"`);
  plan.verdict = warn ? "warn" : "pass";
  return plan;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export type BuildPlanOptions = {
  ctx: KeywordContext;
  jdText?: string | null;
  jdTitle?: string | null;
  opportunityId?: string | null;
  proactive?: boolean;
  now?: Date;
};

/**
 * Explain one `foreign` term. Every dropped term gets a line here so the plan
 * never loses a term silently — see `KeywordGap`.
 */
function gapFor(c: Candidate, t: KeywordTerm, ctx: KeywordContext): KeywordGap {
  const source = c.source ?? "jd";
  const base = { term: t.term, category: t.category, source, taxonomy_group: c.taxonomy_group ?? null };
  if (c.lexicon?.tier === "forbidden") {
    const owner = t.cloud_id ? `keyword cloud "${t.cloud_id}"` : "the deprecated domain lexicon";
    return { ...base, reason: `${owner} marks the term forbidden unless the source states it explicitly` };
  }
  if (source === "taxonomy") {
    return {
      ...base,
      reason: `absent from the corpus and not relevant to the ${ctx.resumeId} positioning: not named in its search keywords, market lens, keyword aliases or keyword clouds, and taxonomy group "${c.taxonomy_group}" is not mapped to this positioning`,
    };
  }
  return { ...base, reason: "absent from the corpus and not a must-have, so it is reported only and never rendered" };
}

export function buildKeywordPlan(opts: BuildPlanOptions): KeywordPlan {
  const { ctx } = opts;
  const idx = corpusIndex(ctx);
  const proactive = Boolean(opts.proactive) || !opts.jdText;
  const candidates = proactive ? proactiveCandidates(ctx) : extractCandidates(opts.jdText!, ctx);
  const groups = buildAliasGroups(candidates, ctx);
  const classified = candidates.map((c) => ({ c, t: classifyTerm(c, ctx, idx, groups.get(key(c.term))) }));
  const terms = classified.map((x) => x.t);
  const gaps = classified.filter((x) => x.t.status === "foreign").map(({ c, t }) => gapFor(c, t, ctx));
  const statusRank: Record<KeywordStatus, number> = { grounded: 0, alias_grounded: 1, confirmed: 2, needs_confirmation: 3, pending: 4, preppable: 5, foreign: 6, declined: 7 };
  const groupRank = (t: KeywordTerm) => (t.alias_group ? groups.get(key(t.term))?.members.indexOf(t.term) ?? 0 : 0);
  terms.sort((a, b) =>
    Number(b.must_have) - Number(a.must_have)
    || (b.jd_frequency ?? 0) - (a.jd_frequency ?? 0)
    || statusRank[a.status] - statusRank[b.status]
    // within one fact, the JD-primary form leads (it owns the merged question)
    || (a.alias_group && a.alias_group === b.alias_group ? groupRank(a) - groupRank(b) : 0)
    || a.term.localeCompare(b.term));
  const warnings: string[] = [];
  const lex = ctx.marketLens?.domain_lexicon;
  if (proactive) {
    const clouds = ctx.clouds ?? [];
    if (!clouds.length && !lex?.terms?.length) {
      warnings.push("resume type references no keyword clouds; run the cloud refresh in /resume-strategy (step 3b)");
    }
    // A cloud the positioning leans on must be current; a weight-1 aside may drift.
    // Age is recomputed against this run's clock, not the clock the clouds file
    // was resolved with, so a plan built "as of" a date reports staleness then.
    for (const cloud of clouds.filter((c) => c.weight >= 4)) {
      const age = cloudAgeDays(cloud, opts.now ?? new Date());
      if (age !== null && age <= CLOUD_STALE_DAYS) continue;
      const when = age === null ? "an unreadable refreshed_at" : `${age} days ago`;
      warnings.push(`cloud "${cloud.id}" (weight ${cloud.weight}) was refreshed ${when} (>${CLOUD_STALE_DAYS} days); refresh it`);
    }
    if (!clouds.length && lex?.refreshed_at) {
      const age = ((opts.now ?? new Date()).getTime() - new Date(lex.refreshed_at).getTime()) / 86_400_000;
      if (age > LEXICON_STALE_DAYS) warnings.push(`domain_lexicon refreshed ${Math.round(age)} days ago (>${LEXICON_STALE_DAYS}); refresh it`);
    }
  }
  const plan: KeywordPlan = {
    version: 1,
    resume_id: ctx.resumeId,
    profile_id: ctx.profileId,
    opportunity_id: opts.opportunityId ?? null,
    mode: proactive ? "proactive" : "jd",
    jd_hash: opts.jdText ? sha(opts.jdText) : null,
    cv_source_hash: sha(ctx.cvSource),
    generated_at: (opts.now ?? new Date()).toISOString(),
    title: titleAlignment(opts.jdTitle ?? null, ctx, idx),
    terms,
    clouds: [],
    signals: buildSignals(ctx, idx, new Set(terms.map((t) => key(t.term)))),
    coverage: { must_have_total: 0, must_have_renderable: 0, must_have_surfaced: 0, must_have_familiarity: 0, renderable_pct: 0, surfaced_pct: 0, renderable_total: 0, surfaced_total: 0, familiarity_total: 0 },
    questions: [],
    gaps,
    screener_surface: { headline_aligned: null, screener_block_present: null },
    warnings,
    verdict: "pass",
  };
  return finalise(plan, false, ctx.clouds ?? []);
}

/** Compact stdout summary; the full plan goes to the file. */
export function summarise(plan: KeywordPlan): Record<string, unknown> {
  const count = (s: KeywordStatus) => plan.terms.filter((t) => t.status === s).length;
  return {
    verdict: plan.verdict,
    mode: plan.mode,
    resume_id: plan.resume_id,
    opportunity_id: plan.opportunity_id,
    title: plan.title,
    coverage: plan.coverage,
    status_counts: {
      grounded: count("grounded"), alias_grounded: count("alias_grounded"), confirmed: count("confirmed"), pending: count("pending"),
      preppable: count("preppable"), needs_confirmation: count("needs_confirmation"), foreign: count("foreign"), declined: count("declined"),
      familiarity: plan.terms.filter(isFamiliarity).length,
    },
    must_have_unsurfaced: plan.terms.filter((t) => t.must_have && (t.status === "grounded" || t.status === "alias_grounded") && !t.surfaced_in.length).map((t) => t.jd_form),
    alias_grounded: plan.terms.filter((t) => t.status === "alias_grounded").map((t) => `${t.jd_form} (corpus: ${t.corpus_form})`),
    questions: plan.questions.map((q) => q.question),
    // dropped terms are never silent: every foreign term is named with its reason
    gaps: (plan.gaps ?? []).map((g) => `${g.term} [${g.source}${g.taxonomy_group ? `/${g.taxonomy_group}` : ""}]: ${g.reason}`),
    signals: plan.signals.map((s) => `${s.signal} [${s.status}]${s.matched_terms.length ? ` via ${s.matched_terms.join(", ")}` : ""}`),
    screener_surface: plan.screener_surface,
    // advisory readout; never a gate (see computeAtsComposite)
    ats_composite: plan.ats_composite ?? null,
    warnings: plan.warnings,
  };
}

/** Summary char bounds from a template rubric.yaml, when one was supplied. */
async function readRubricSummaryBounds(rubricPath: string | undefined): Promise<AtsCompositeOptions["rubric"]> {
  if (!rubricPath) return null;
  const raw = await fs.readFile(rubricPath, "utf8").catch(() => null);
  if (raw == null) return null;
  const parsed = YAML.parse(raw) as { summary?: { min_chars?: number; max_chars?: number } } | null;
  const s = parsed?.summary;
  if (!s || (s.min_chars == null && s.max_chars == null)) return null;
  return { summary_min_chars: s.min_chars, summary_max_chars: s.max_chars };
}

/** Does the corpus itself carry credentials / education worth rendering? */
export function sourceHasCredentials(cvSource: string): boolean {
  return /^#{2,}\s*(education|certifications?|credentials?|qualifications?)\b/im.test(cvSource);
}

async function readJdTitle(opportunityId: string | null, jdText: string | null): Promise<string | null> {
  if (opportunityId) {
    try {
      const raw = JSON.parse(await fs.readFile("state/pipeline/opportunities.json", "utf8"));
      const list: any[] = Array.isArray(raw) ? raw : raw.opportunities ?? Object.values(raw);
      const hit = list.find((o) => o?.id === opportunityId);
      if (hit?.title) return String(hit.title);
    } catch { /* fall through to JD heading */ }
  }
  const first = (jdText ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const heading = first.replace(/^#+\s*/, "").replace(/\*\*/g, "").split(/\s[—–-]\s|\(|\|/)[0].trim();
  return heading.length <= 80 ? heading : null;
}

async function main() {
  const args = parseArgs();
  const resumeId = args.resume;
  const proactive = args.proactive === "true";
  if (!resumeId || (!args.jd && !proactive)) {
    console.error("Usage: tsx tools/resume/resume-keywords.ts --resume <id> [--profile <id>] (--jd <path> [--opportunity <opp-id>] | --proactive) [--composition <json>] [--rubric <path>] [--out <path>|-] [--quiet]");
    process.exit(2);
  }
  const ctx = await loadKeywordContext(resumeId, args.profile);
  const jdText = args.jd ? await fs.readFile(args.jd, "utf8") : null;
  const opportunityId = args.opportunity ?? null;
  let plan = buildKeywordPlan({ ctx, jdText, jdTitle: await readJdTitle(opportunityId, jdText), opportunityId, proactive });
  if (args.composition) {
    const content = JSON.parse(await fs.readFile(args.composition, "utf8")) as ResumeContent;
    plan = applyComposition(plan, content, {
      rubric: await readRubricSummaryBounds(args.rubric),
      sourceHasCredentials: sourceHasCredentials(ctx.cvSource),
    });
  }
  const profileCtx = resolveProfileContext(args.profile);
  const outPath = args.out === "-" ? null
    : args.out ?? (opportunityId ? path.join("state", "pipeline", "archive", opportunityId, "keyword-plan.json") : path.join(profileCtx.renderedResumesDir, resumeId, "keyword-plan.json"));
  if (outPath) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`);
  }
  console.log(JSON.stringify({ plan_path: outPath, ...summarise(plan) }, null, args.quiet === "true" ? 0 : 2));
  process.exit(args.composition && plan.verdict === "warn" ? 1 : 0);
}

if (process.argv[1] && /resume-keywords\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(3);
  });
}
