#!/usr/bin/env tsx
/**
 * keyword-triage.ts: the deterministic first pass over pending keyword rows.
 *
 * Why this exists. Keywords are for two things only: positioning a resume and
 * matching an opportunity (AGENTS.md section 3 principle 5). So a keyword must
 * be a skill, a tool, a platform, a methodology, a certification or a domain
 * concept. The JD extractor is deliberately greedy, and what it hands the
 * ledger is mostly not that: recruiter names, ad furniture ("Apply Now", "Key
 * Skills"), EEO wording, dates, clearance and logistics wording, employer and
 * program names, and half-words the scraper cut mid-token. Every one of those
 * becomes a `pending` row, and the drain skills then put it to a human as
 * "did you use or deliver <junk> in any role?". A human question costs
 * attention, so a question that cannot be about a skill must never be asked.
 *
 * This tool answers the mechanical half. Each pending term is decided `keep` or
 * `reject` by a NAMED rule, and each rule is a small pure function unit-tested
 * against its own examples (AGENTS.md section 3 principle 7: deterministic
 * tools decide mechanical facts, agents decide semantics). Nothing here judges
 * whether the person HAS a skill: a reject only says "this string is not a
 * skill question", and it lands as `not_applicable`, which is reversible and
 * only stops the resume claiming the term. The semantic half (is this real
 * skill evidenced, adjacent, or absent?) belongs to the `keyword-triage` skill,
 * which runs after this tool and reads cv-source.md.
 *
 * Subcommands / flags
 *   (default)                    dry run: print the verdicts, write nothing
 *   --apply                      record every reject as not_applicable,
 *                                origin `triage`, notes `triage: <rule>`
 *   --ledger <path>              ledger override (default: profile ledger)
 *   --profile <id>               team-mode profile id
 *   --format json|table          default json
 *   --cv-source / --taxonomy / --clouds / --boilerplate   path overrides
 *   --limit N                    cap the rows printed (never the rows applied)
 *
 * Exit: 0 ok, 2 usage / unreadable stoplist.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { repoPath } from "../repo-root.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { loadTaxonomy, type SkillTaxonomy } from "../score.ts";
import { loadKeywordClouds } from "../keyword-clouds.ts";
import { STOPWORDS, normalise, stem, phraseInTextLoose, parseArgs } from "./keyword-lexicon.ts";
import { readLedger, applyAnswerEntries, type AnswerEntry, type AppliedAnswers } from "./keyword-confirm.ts";
import type { MarketConfirmation } from "./market-lens-audit.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const REJECT_RULES = [
  "jd_boilerplate",
  "eeo_or_diversity",
  "clearance_or_logistics",
  "date_or_number",
  "person_name",
  "truncated_fragment",
  "employer_or_program",
  "generic_phrase",
] as const;

export type RejectRule = (typeof REJECT_RULES)[number];

export type KeepRule = "taxonomy_synonym" | "cloud_term" | "acronym_shape" | "category" | "in_cv_source" | "residue";

/** The minimum a rule needs to see. Ledger rows and plan terms both map onto it. */
export type TriageRow = {
  term: string;
  category?: string | null;
  question?: string | null;
  jd_context?: string | null;
  evidence_hint?: string | null;
  opportunity_id?: string | null;
  resume_id?: string | null;
};

export type TriageVerdict =
  | { decision: "reject"; rule: RejectRule; evidence: string; term: string; category: string | null }
  | { decision: "keep"; rule: KeepRule; evidence: string; term: string; category: string | null };

export type Boilerplate = {
  jd_boilerplate: { phrases: string[]; prefixes: string[]; heading_leads: string[]; heading_tails: string[] };
  eeo_or_diversity: string[];
  clearance_or_logistics: { phrases: string[]; exact: string[] };
  employer_words: string[];
  recruiter_words: string[];
  qualifiers: string[];
  verbs: string[];
  sentence_tails: string[];
  trailing_words: string[];
};

export type TriageContext = {
  boilerplate: Boilerplate;
  /** exact normalised phrases from the taxonomy and the clouds: curated vocabulary */
  curated: Set<string>;
  /** single tokens (and their stems) known from the taxonomy, clouds, cv-source and STOPWORDS */
  vocabulary: Set<string>;
  /** normalised cv-source text, for the "already in the corpus" keep rule */
  cvSourceNorm: string;
  /** every other term in the same batch, normalised: powers the peer-prefix test */
  peers: Set<string>;
  /** company on the row's opportunity, when the caller can resolve one */
  companyOf: (opportunityId: string | null | undefined) => string | null;
};

export const DEFAULT_BOILERPLATE_PATH = repoPath(".claude/skills/keyword-triage/references/boilerplate.yaml");

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

const key = (s: string): string => normalise(s).trim();
const pad = (s: string): string => ` ${s} `;
const tokensOf = (term: string): string[] => term.trim().split(/\s+/).filter(Boolean);
const hasPhrase = (k: string, phrase: string): boolean => pad(k).includes(pad(key(phrase)));

/** Every text the row carries that a rule may read for context. */
function contextText(row: TriageRow): string {
  return [row.question ?? "", row.jd_context ?? "", row.evidence_hint ?? ""].join(" ");
}

// ---------------------------------------------------------------------------
// Stoplist
// ---------------------------------------------------------------------------

const EMPTY_BOILERPLATE: Boilerplate = {
  jd_boilerplate: { phrases: [], prefixes: [], heading_leads: [], heading_tails: [] },
  eeo_or_diversity: [],
  clearance_or_logistics: { phrases: [], exact: [] },
  employer_words: [],
  recruiter_words: [],
  qualifiers: [],
  verbs: [],
  sentence_tails: [],
  trailing_words: [],
};

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => key(String(v))).filter(Boolean) : []);

export function parseBoilerplate(text: string): Boilerplate {
  const raw = (YAML.parse(text) ?? {}) as Record<string, any>;
  return {
    jd_boilerplate: {
      phrases: list(raw.jd_boilerplate?.phrases),
      prefixes: list(raw.jd_boilerplate?.prefixes),
      heading_leads: list(raw.jd_boilerplate?.heading_leads),
      heading_tails: list(raw.jd_boilerplate?.heading_tails),
    },
    eeo_or_diversity: list(raw.eeo_or_diversity),
    clearance_or_logistics: {
      phrases: list(raw.clearance_or_logistics?.phrases),
      exact: list(raw.clearance_or_logistics?.exact),
    },
    employer_words: list(raw.employer_words),
    recruiter_words: list(raw.recruiter_words),
    qualifiers: list(raw.qualifiers),
    verbs: list(raw.verbs),
    sentence_tails: list(raw.sentence_tails),
    trailing_words: list(raw.trailing_words),
  };
}

export async function loadBoilerplate(file = DEFAULT_BOILERPLATE_PATH): Promise<Boilerplate> {
  return parseBoilerplate(await fs.readFile(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function taxonomyPhrases(taxonomy: SkillTaxonomy): string[] {
  const out: string[] = [];
  for (const entries of Object.values(taxonomy.categories ?? {})) {
    for (const def of Object.values(entries)) for (const syn of def.synonyms ?? []) out.push(syn);
  }
  return out;
}

export type BuildContextInput = {
  boilerplate?: Boilerplate;
  taxonomy?: SkillTaxonomy;
  cloudPhrases?: string[];
  cvSource?: string;
  peers?: string[];
  companyOf?: (opportunityId: string | null | undefined) => string | null;
};

/** Pure context builder: everything already read from disk. */
export function buildTriageContext(input: BuildContextInput): TriageContext {
  const curated = new Set<string>();
  for (const phrase of [...taxonomyPhrases(input.taxonomy ?? { categories: {} }), ...(input.cloudPhrases ?? [])]) {
    const k = key(phrase);
    if (k) curated.add(k);
  }
  const cvSourceNorm = normalise(input.cvSource ?? "");
  const vocabulary = new Set<string>();
  for (const word of STOPWORDS) { vocabulary.add(word); vocabulary.add(stem(word)); }
  for (const k of curated) for (const token of k.split(" ")) if (token) { vocabulary.add(token); vocabulary.add(stem(token)); }
  for (const token of cvSourceNorm.trim().split(" ")) if (token) { vocabulary.add(token); vocabulary.add(stem(token)); }
  return {
    boilerplate: input.boilerplate ?? EMPTY_BOILERPLATE,
    curated,
    vocabulary,
    cvSourceNorm,
    peers: new Set((input.peers ?? []).map(key).filter(Boolean)),
    companyOf: input.companyOf ?? (() => null),
  };
}

export type LoadContextOptions = {
  profile?: string | null;
  cvSource?: string;
  taxonomy?: string;
  clouds?: string;
  boilerplate?: string;
  peers?: string[];
  companyOf?: (opportunityId: string | null | undefined) => string | null;
};

/** Read the taxonomy, the clouds, cv-source.md and the stoplist, then build the context. */
export async function loadTriageContext(opts: LoadContextOptions = {}): Promise<TriageContext> {
  const ctx = resolveProfileContext(opts.profile);
  const taxonomy = await loadTaxonomy(opts.taxonomy ?? path.join(ctx.profileDir, "skills-taxonomy.yaml"));
  const cloudsFile = await loadKeywordClouds(opts.clouds);
  const cloudPhrases: string[] = [];
  for (const cloud of cloudsFile.clouds ?? []) {
    for (const term of cloud.terms ?? []) {
      cloudPhrases.push(term.term);
      for (const alias of term.aliases ?? []) cloudPhrases.push(alias);
    }
  }
  const cvSource = await fs.readFile(opts.cvSource ?? ctx.cvSourcePath, "utf8").catch(() => "");
  return buildTriageContext({
    boilerplate: await loadBoilerplate(opts.boilerplate),
    taxonomy,
    cloudPhrases,
    cvSource,
    peers: opts.peers,
    companyOf: opts.companyOf,
  });
}

// ---------------------------------------------------------------------------
// Reject rules: each one pure, each one named in the ledger note it writes
// ---------------------------------------------------------------------------

type Rule = (row: TriageRow, ctx: TriageContext) => string | null;

const MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

export const jdBoilerplate: Rule = (row, ctx) => {
  const k = key(row.term);
  const bp = ctx.boilerplate.jd_boilerplate;
  if (bp.phrases.includes(k)) return `stoplist phrase "${k}"`;
  for (const prefix of bp.prefixes) {
    if (k === prefix || k.startsWith(`${prefix} `)) return `ad-furniture prefix "${prefix}"`;
  }
  const tokens = k.split(" ");
  if (tokens.length >= 2 && tokens.length <= 3) {
    const tail = tokens[tokens.length - 1].replace(/\d+$/, "");
    if (bp.heading_leads.includes(tokens[0]) && bp.heading_tails.includes(tail)) {
      return `JD section-heading shape "${tokens[0]} ... ${tail}"`;
    }
  }
  return null;
};

export const eeoOrDiversity: Rule = (row, ctx) => {
  const k = key(row.term);
  for (const phrase of ctx.boilerplate.eeo_or_diversity) if (hasPhrase(k, phrase)) return `EEO / diversity wording "${phrase}"`;
  return null;
};

export const clearanceOrLogistics: Rule = (row, ctx) => {
  const k = key(row.term);
  const cl = ctx.boilerplate.clearance_or_logistics;
  if (cl.exact.includes(k)) return `logistics wording "${k}" (a profile fact, not a keyword)`;
  for (const phrase of cl.phrases) if (hasPhrase(k, phrase)) return `clearance / logistics wording "${phrase}"`;
  return null;
};

export const dateOrNumber: Rule = (row) => {
  const term = row.term.trim();
  const k = key(term);
  if (MONTHS.test(term)) return "names a month";
  if (/\b(19|20)\d{2}\b/.test(term)) return "carries a calendar year";
  if (/^(initial|minimum|maximum|at least|up to|approx|approximately|circa)\s+\d+/.test(k)) return "a duration or a count, not a skill";
  if (/^p\s?\d+$/.test(k)) return "a priority or phase code with no noun";
  if (k.split(" ").every((t) => /^\d+$/.test(t))) return "numerals only";
  return null;
};

const NAME_TOKEN = /^[A-Z][a-z]{2,}$/;

export const personName: Rule = (row, ctx) => {
  const tokens = tokensOf(row.term);
  if (tokens.length < 2 || tokens.length > 3) return null;
  if (!tokens.every((t) => NAME_TOKEN.test(t))) return null;
  const known = tokens.filter((t) => ctx.vocabulary.has(t.toLowerCase()) || ctx.vocabulary.has(stem(t.toLowerCase())));
  if (known.length) return null;
  const context = key(contextText(row));
  const recruiter = ctx.boilerplate.recruiter_words.find((w) => hasPhrase(context, w));
  return recruiter
    ? `name-shaped tokens, none known to the taxonomy, the clouds or cv-source, and the question reads as contact wording ("${recruiter}")`
    : "name-shaped tokens, none known to the taxonomy, the clouds or cv-source, and nothing skill-like in the question";
};

/** A lowercase token that is a strict prefix of a word the corpus or the vocabularies know. */
function prefixOfKnownWord(token: string, ctx: TriageContext): string | null {
  // The stem test is what keeps a real word out of this rule: "maintain" is a
  // prefix of "maintained", but they share a stem, so it is one word inflected
  // and not a cut one. "principl" and "principles" do not share a stem.
  if (token.length < 5 || ctx.vocabulary.has(token) || ctx.vocabulary.has(stem(token))) return null;
  for (const word of ctx.vocabulary) {
    if (word.length - token.length >= 2 && word.startsWith(token)) return word;
  }
  return null;
}

export const truncatedFragment: Rule = (row, ctx) => {
  const tokens = tokensOf(row.term);
  const k = key(row.term);
  const last = tokens[tokens.length - 1] ?? "";
  const tails = ctx.boilerplate.sentence_tails;

  if (tokens.length > 1 && last.length === 1) return `ends on the single letter "${last}"`;
  if (tokens.length > 1 && last.length === 2 && last === last.toLowerCase()) return `ends on the part-word "${last}"`;
  if (tokens.length > 1 && ctx.boilerplate.trailing_words.includes(last.toLowerCase())) return `ends on the function word "${last}"`;

  for (const token of tokens) {
    const breaks = [...token.matchAll(/(?<=[a-z.])([A-Z][a-z]+)/g)];
    for (const m of breaks) {
      const tail = m[1];
      // Only a SENTENCE word counts as glue. Camel-cased product names
      // ("IntegrationHub", "LlamaIndex", "ServiceNow") are how vendors write
      // real tools, so token length alone must never condemn one.
      if (tails.includes(tail.toLowerCase())) return `two sentences glued together at "${tail}" in "${token}"`;
    }
  }

  if (tokens.length > 1 && last === last.toLowerCase()) {
    const whole = prefixOfKnownWord(last, ctx);
    if (whole) return `"${last}" is a cut form of "${whole}"`;
  }

  for (const peer of ctx.peers) {
    if (peer === k) continue;
    if (!peer.startsWith(k)) continue;
    const extension = peer.slice(k.length);
    if (/^[a-z]{2,}/.test(extension)) return `a cut prefix of the pending term "${peer}"`;
  }

  const context = contextText(row);
  if (k && new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]{2,}`, "i").test(normalise(context))) {
    return "appears in its own context as the prefix of a longer word";
  }
  return null;
};

export const employerOrProgram: Rule = (row, ctx) => {
  const k = key(row.term);
  if (/^asx\s?\d+$/.test(k)) return "a market index band, not a capability";
  const company = ctx.companyOf(row.opportunity_id);
  if (company) {
    const ck = key(company);
    if (ck && (ck === k || hasPhrase(ck, k) || hasPhrase(k, ck))) return `the advertiser on ${row.opportunity_id}`;
  }
  const expansion = (row.question ?? "").match(/\(([^)]{4,})\)/)?.[1];
  if (expansion) {
    const word = ctx.boilerplate.employer_words.find((w) => hasPhrase(key(expansion), w));
    if (word) return `the question expands it to an organisation name ("${word}")`;
  }
  return null;
};

export const genericPhrase: Rule = (row, ctx) => {
  const tokens = key(row.term).split(" ").filter(Boolean);
  if (!tokens.length) return null;
  const { qualifiers, verbs } = ctx.boilerplate;
  const two = tokens.slice(0, 2).join(" ");
  const leadQualifier = qualifiers.find((q) => q === tokens[0] || q === two);
  if (leadQualifier && tokens.length > 1) return `a qualifier hung on a noun ("${leadQualifier} ..."), the bare noun is the keyword`;
  const leadVerb = verbs.find((v) => v === tokens[0]);
  if (leadVerb && tokens.length > 1) return `a responsibility line starting with "${leadVerb}", not a capability noun`;
  if (tokens.length > 3) {
    const filler = [...qualifiers, ...verbs].find((w) => hasPhrase(tokens.join(" "), w));
    const curatedNoun = [...ctx.curated].some((phrase) => hasPhrase(tokens.join(" "), phrase));
    if (filler && !curatedNoun) return `a long phrase built on "${filler}" with no tool, platform, method or certification in it`;
  }
  return null;
};

export const RULES: ReadonlyArray<{ rule: RejectRule; test: Rule }> = [
  { rule: "jd_boilerplate", test: jdBoilerplate },
  { rule: "eeo_or_diversity", test: eeoOrDiversity },
  { rule: "clearance_or_logistics", test: clearanceOrLogistics },
  { rule: "date_or_number", test: dateOrNumber },
  { rule: "person_name", test: personName },
  { rule: "truncated_fragment", test: truncatedFragment },
  { rule: "employer_or_program", test: employerOrProgram },
  { rule: "generic_phrase", test: genericPhrase },
];

// ---------------------------------------------------------------------------
// Keep rules and the verdict
// ---------------------------------------------------------------------------

const ACRONYM = /^[A-Z][A-Z0-9]{1,5}$/;
const KEEP_CATEGORIES: ReadonlySet<string> = new Set(["tool", "platform", "methodology", "certification"]);

function keepVerdict(row: TriageRow, ctx: TriageContext): { rule: KeepRule; evidence: string } {
  const k = key(row.term);
  if (ctx.curated.has(k)) {
    return { rule: "taxonomy_synonym", evidence: "an exact synonym in the skills taxonomy or a keyword cloud" };
  }
  if (row.category && KEEP_CATEGORIES.has(row.category)) {
    return { rule: "category", evidence: `the extractor categorised it ${row.category}` };
  }
  if (ACRONYM.test(row.term.trim())) {
    return { rule: "acronym_shape", evidence: "an acronym shape (2 to 6 capitals), which is how tools and standards are written" };
  }
  if (ctx.cvSourceNorm && phraseInTextLoose(k, ctx.cvSourceNorm)) {
    return { rule: "in_cv_source", evidence: "already appears in cv-source.md" };
  }
  return { rule: "residue", evidence: "no reject rule fired; the skill decides this one against the corpus" };
}

/**
 * The curated vocabularies win over every reject rule. A term the taxonomy or a
 * cloud names is, by construction, screener vocabulary the person's positionings
 * are written against, so no stoplist gets to throw it away.
 */
export function triageTerm(row: TriageRow, ctx: TriageContext): TriageVerdict {
  const category = row.category ?? null;
  const k = key(row.term);
  if (!k) return { decision: "reject", rule: "generic_phrase", evidence: "empty term", term: row.term, category };
  if (ctx.curated.has(k)) {
    return { decision: "keep", rule: "taxonomy_synonym", evidence: "an exact synonym in the skills taxonomy or a keyword cloud", term: row.term, category };
  }
  for (const { rule, test } of RULES) {
    const evidence = test(row, ctx);
    if (evidence) return { decision: "reject", rule, evidence, term: row.term, category };
  }
  const keep = keepVerdict(row, ctx);
  return { decision: "keep", rule: keep.rule, evidence: keep.evidence, term: row.term, category };
}

/** Triage a whole batch, with each row seeing the others as peers (prefix test). */
export function triageRows(rows: TriageRow[], ctx: TriageContext): TriageVerdict[] {
  const peers = new Set([...ctx.peers, ...rows.map((r) => key(r.term)).filter(Boolean)]);
  const batchCtx: TriageContext = { ...ctx, peers };
  return rows.map((row) => triageTerm(row, batchCtx));
}

// ---------------------------------------------------------------------------
// Ledger reading
// ---------------------------------------------------------------------------

/** One row per pending term, across resumes: keyword answers are person-scoped. */
export function pendingKeywordRows(rows: MarketConfirmation[]): TriageRow[] {
  const byTerm = new Map<string, TriageRow>();
  for (const row of rows) {
    if (row.kind !== "keyword" || row.status !== "pending") continue;
    const term = row.term ?? row.signal;
    const k = key(term ?? "");
    if (!k || byTerm.has(k)) continue;
    byTerm.set(k, {
      term,
      category: row.category ?? null,
      question: row.question ?? null,
      evidence_hint: row.evidence_hint ?? null,
      opportunity_id: row.opportunity_id ?? null,
      resume_id: row.resume_id ?? null,
    });
  }
  return [...byTerm.values()];
}

export type TriageReport = {
  ledger: string;
  dry_run: boolean;
  pending: number;
  keep: number;
  reject: number;
  by_rule: Record<string, number>;
  rejects: { term: string; rule: RejectRule; evidence: string }[];
  keeps: { term: string; category: string | null; evidence: string }[];
  applied?: AppliedAnswers;
};

export function buildReport(verdicts: TriageVerdict[], opts: { ledger: string; dryRun: boolean }): TriageReport {
  const rejects = verdicts.filter((v) => v.decision === "reject") as Extract<TriageVerdict, { decision: "reject" }>[];
  const keeps = verdicts.filter((v) => v.decision === "keep") as Extract<TriageVerdict, { decision: "keep" }>[];
  const by_rule: Record<string, number> = {};
  for (const v of rejects) by_rule[v.rule] = (by_rule[v.rule] ?? 0) + 1;
  return {
    ledger: opts.ledger,
    dry_run: opts.dryRun,
    pending: verdicts.length,
    keep: keeps.length,
    reject: rejects.length,
    by_rule,
    rejects: rejects.map((v) => ({ term: v.term, rule: v.rule, evidence: v.evidence })),
    keeps: keeps.map((v) => ({ term: v.term, category: v.category, evidence: v.evidence })),
  };
}

/** Answer entries for `applyAnswerEntries`: every reject becomes `not_applicable`. */
export function rejectAnswers(report: TriageReport): AnswerEntry[] {
  return report.rejects.map((r) => ({ term: r.term, answer: "na", status: "not_applicable" as const, note: `triage: ${r.rule}` }));
}

export function formatReport(report: TriageReport, limit: number): string {
  const lines: string[] = [`ledger: ${report.ledger}`, `${report.pending} pending, ${report.reject} reject, ${report.keep} keep${report.dry_run ? "  (dry run, nothing written)" : ""}`, ""];
  const rules = Object.entries(report.by_rule).sort((a, b) => b[1] - a[1]);
  if (rules.length) {
    const width = Math.max(...rules.map(([r]) => r.length));
    lines.push("BY RULE");
    for (const [rule, n] of rules) lines.push(`  ${rule.padEnd(width)}  ${n}`);
    lines.push("");
  }
  if (report.rejects.length) {
    const shown = report.rejects.slice(0, limit);
    const width = Math.min(40, Math.max(...shown.map((r) => r.term.length)));
    lines.push(`REJECT (${report.rejects.length})`);
    for (const r of shown) lines.push(`  ${r.term.padEnd(width)}  ${r.rule}  ${r.evidence}`);
    if (report.rejects.length > shown.length) lines.push(`  ... ${report.rejects.length - shown.length} more`);
    lines.push("");
  }
  if (report.keeps.length) {
    const shown = report.keeps.slice(0, limit);
    const width = Math.min(40, Math.max(...shown.map((r) => r.term.length)));
    lines.push(`KEEP (${report.keeps.length})`);
    for (const r of shown) lines.push(`  ${r.term.padEnd(width)}  ${r.category ?? "-"}  ${r.evidence}`);
    if (report.keeps.length > shown.length) lines.push(`  ... ${report.keeps.length - shown.length} more`);
    lines.push("");
  }
  lines.push(report.dry_run
    ? "Re-run with --apply to record every reject as not_applicable (reversible), then run the /keyword-triage skill on the residue."
    : "Rejects recorded. Now run the /keyword-triage skill on the residue before asking the person anything.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Best-effort advertiser lookup. The pipeline is optional: absent, no rule fires. */
async function companyLookup(rows: TriageRow[]): Promise<(id: string | null | undefined) => string | null> {
  const ids = [...new Set(rows.map((r) => r.opportunity_id).filter((id): id is string => Boolean(id)))];
  const byId = new Map<string, string>();
  if (ids.length) {
    try {
      const { get } = await import("../pipeline.ts");
      for (const id of ids) {
        const opportunity = await get(id).catch(() => null);
        if (opportunity?.company) byId.set(id, opportunity.company);
      }
    } catch {
      // No pipeline database on this machine: employer_or_program falls back to
      // the ASX and question-expansion tests only.
    }
  }
  return (id) => (id ? byId.get(id) ?? null : null);
}

export async function cmdTriage(args: Record<string, string>): Promise<number> {
  const profileCtx = resolveProfileContext(args.profile);
  const ledger = args.ledger ?? profileCtx.marketConfirmationsPath;
  const apply = args.apply === "true";
  const limit = Number(args.limit ?? 200);
  let ctx: TriageContext;
  const rows = pendingKeywordRows(await readLedger(ledger));
  try {
    ctx = await loadTriageContext({
      profile: args.profile,
      cvSource: args["cv-source"],
      taxonomy: args.taxonomy,
      clouds: args.clouds,
      boilerplate: args.boilerplate,
      companyOf: await companyLookup(rows),
    });
  } catch (error) {
    console.error(`Cannot read the triage stoplist: ${(error as Error).message}`);
    return 2;
  }
  const report = buildReport(triageRows(rows, ctx), { ledger, dryRun: !apply });
  if (apply && report.rejects.length) {
    report.applied = await applyAnswerEntries(rejectAnswers(report), { ledger, origin: "triage" });
  }
  if (args.format === "table") console.log(formatReport(report, limit));
  else console.log(JSON.stringify({ ...report, rejects: report.rejects.slice(0, limit), keeps: report.keeps.slice(0, limit) }, null, 2));
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.format && args.format !== "json" && args.format !== "table") {
    console.error("Usage: tsx tools/resume/keyword-triage.ts [--apply] [--ledger <path>] [--profile <id>] [--format json|table] [--limit N]");
    process.exit(2);
  }
  process.exit(await cmdTriage(args));
}

if (process.argv[1] && /keyword-triage\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(3);
  });
}
