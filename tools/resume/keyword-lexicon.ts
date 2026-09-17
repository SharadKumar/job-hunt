/**
 * keyword-lexicon.ts — shared text primitives for the resume keyword tools.
 *
 * Owns the normalisation, naive stemming, membership tests, generic-vocabulary
 * STOPWORDS, and claim-field harvesting that resume-term-grounding.ts and
 * resume-keywords.ts both rely on. Behaviour is byte-identical to the former
 * inline copies in resume-term-grounding.ts (moved 2026-09-10) so that the
 * fabrication gate and the keyword planner never disagree about what a term is.
 *
 * Also declares the keyword-plan schema (`KeywordPlan`) produced by
 * `npm run resume:keywords` and consumed by `resume:term-grounding --keyword-plan`.
 */

import type { ResumeContent } from "../../templates/resume/_interface.ts";

// Generic resume / technical / English vocabulary that is legitimately
// synthesisable and is never itself a domain-specific experiential claim.
// Kept deliberately broad: the JD-cross-reference path is the precise signal,
// so this only needs to damp noise in the (JD-less) "ungrounded" path.
export const STOPWORDS = new Set<string>([
  "the","and","for","with","that","this","from","into","across","over","under","within","their","they","them","then","than","your","our","its","has","have","had","was","were","are","not","but","all","any","via","per","off","out","per",
  "a","an","of","in","on","to","by","as","at","or","is","be","it","i",
  // generic resume / consulting / tech vocabulary (not domain claims)
  "architect","architecture","architects","architectural","solution","solutions","design","designed","designing","delivery","deliver","delivered","delivering","lead","leader","leading","led","manage","managed","management","manager","managing","team","teams","stakeholder","stakeholders","platform","platforms","system","systems","programme","program","programmes","programs","project","projects","technical","technology","technologies","engineering","engineer","engineers","development","develop","developer","developers","integration","integrate","integrated","integrating","data","business","enterprise","digital","service","services","portal","portals","application","applications","app","apps","workflow","workflows","governance","strategy","strategic","requirement","requirements","vendor","vendors","agile","cloud","deployment","deploy","scope","risk","timeline","experience","experienced","role","roles","work","working","worked","senior","principal","consultant","consulting","client","clients","customer","customers","member","members","user","users","build","built","building","ownership","owned","owning","review","reviews","quality","documentation","document","standards","standard","framework","frameworks","model","models","modelling","process","processes","capability","capabilities","outcome","outcomes","deliverable","deliverables","stream","streams","release","releases","migration","migrate","migrated","transformation","transform","modern","native","hands","full","stack","registration","onboarding","authentication","authorisation","authorization","permissions","permission","access","self","selfservice","api","apis","rest","soap","web","mobile","site","sites","backlog","sprint","scrum","kanban","portfolio","roadmap","roadmaps","testing","test","tests","defect","defects","uat","support","staff","schools","government","sector","public","financial","finance","insurance","superannuation","banking","bank","retail","pharma","media","domain","domains","sale","separation","records","record","policy","policies","regulatory","regulation","compliance","obligations","cover","life","group","corporate","global","regional","national",
  // candidate-identity nouns
  "director","specialist","technologist","architecting",
  // generic reporting / status / cadence vocabulary — pure delivery English that
  // co-occurs in any JD and any CV; never a fabricated feature-term, so must not
  // hard-fail the jd_injected path (see the STOPWORDS gate in the term loop).
  "update","updates","updated","updating","status","metric","metrics","provide","provided","providing","provision","regular","regularly","ongoing","progress","summary","summaries","brief","briefings","dashboard","dashboards","tracker","trackers","escalation","escalations","cadence","weekly","monthly","daily","periodic",
  // common English fillers / adverbs / connectives (reduce warn-bucket noise)
  "deep","depth","alongside","equally","comfortable","plus","four","five","three","two","spanning","directly","previously","throughout","after","onto","least","available","outside","include","including","held","history","ready","bringing","earlier","asia","pacific","precise","relying","controlled","comparable","complexity","demands","compliant","accountable","accuracy","completeness","visibility","structured","reusable","embedded","onboarded","institution","institutional","organisational","viable","evolving","constraints","maintained","division","appointed","credibility","extending","exposure","oversight","accountability","conceptualised","discipline","spanning","also","both","most","more","over","into","using","used","while","where","which","when","what","each","other","such","many","much","new","key","core","wide","strong","broad","high","large","major","multiple","several","various","range","number","level","levels","area","areas","part","parts",
]);

export function parseArgs(argv: string[] = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

/** Lowercase, collapse every non-alphanumeric run to a single space. */
export function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** Naive stem: strip the longest common inflectional suffix (min stem length 3). */
export function stem(token: string): string {
  for (const suffix of ["ing", "edly", "ed", "es", "s"]) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Source membership for a single token, tolerant of simple inflection. */
export function tokenInText(token: string, normText: string, stemmedTokens: Set<string>): boolean {
  if (normText.includes(` ${token} `)) return true;
  const s = stem(token);
  return stemmedTokens.has(s) || normText.includes(` ${s}`);
}

/** Source membership for a multi-word phrase (substring on normalised text). */
export function phraseInText(phrase: string, normText: string): boolean {
  return normText.includes(` ${phrase} `);
}

/**
 * Inflectional tail a naive stem may have eaten or the corpus may have added.
 * Deliberately suffix-only: it never lets one word match a different word, it
 * only lets "retrieval pipeline" meet "retrieval pipelines" (and the reverse).
 */
const INFLECTION = "(?:e|es|s|ies|ing|ed)?";

/** Regex source for one phrase token, tolerant of simple inflection both ways. */
function looseTokenSource(token: string): string {
  return `${stem(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${INFLECTION}`;
}

/**
 * Phrase membership tolerant of plural / singular and hyphenation variants.
 *
 * `normalise` already folds hyphens to spaces, so "retrieval-augmented" and
 * "retrieval augmented" are the same string here; this adds the inflection
 * tolerance that `tokenInText` gives single tokens but `phraseInText` does not.
 * Whole-word anchored at both ends — never a substring match.
 */
export function phraseInTextLoose(phrase: string, normText: string): boolean {
  if (phraseInText(phrase, normText)) return true;
  const tokens = phrase.trim().split(" ").filter(Boolean);
  if (tokens.length < 2) return false;
  return new RegExp(`(?<= )${tokens.map(looseTokenSource).join(" ")}(?= )`).test(normText);
}

/**
 * 1-based line numbers whose content carries `needle`, tolerating the same
 * plural / hyphen variance as `phraseInTextLoose` so an inflected corpus line
 * still yields an evidence citation.
 */
export function lineNumbersMatchingLoose(text: string, needle: string): number[] {
  const exact = lineNumbersContaining(text, needle);
  if (exact.length) return exact;
  const tokens = normalise(needle).trim().split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const re = new RegExp(`(?<= )${tokens.map(looseTokenSource).join(" ")}(?= )`);
  const out: number[] = [];
  text.split("\n").forEach((line, i) => { if (re.test(normalise(line))) out.push(i + 1); });
  return out;
}

export function buildStemSet(normText: string): Set<string> {
  return new Set(normText.trim().split(" ").filter(Boolean).map(stem));
}

/** Collect every claim-bearing string from a rendered CV, tagged by field. */
export function claimFields(content: ResumeContent): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  if (content.summary) out.push({ field: "summary", text: content.summary });
  (content.highlights ?? []).forEach((h, i) => out.push({ field: `highlight[${i}]`, text: h }));
  for (const sk of content.skills ?? []) {
    if (sk.summary) out.push({ field: `skill['${sk.name}'].summary`, text: sk.summary });
    (sk.bullets ?? []).forEach((b, i) => out.push({ field: `skill['${sk.name}'][${i}]`, text: b }));
  }
  if (content.additional_skills_summary) out.push({ field: "additional_skills_summary", text: content.additional_skills_summary });
  (content.credentials ?? []).forEach((c, i) => out.push({ field: `credential[${i}]`, text: c }));
  for (const xp of content.experiences ?? []) {
    const tag = `${xp.title} @ ${xp.company}`;
    if (xp.placement === "feature") {
      if (xp.summary) out.push({ field: `${tag} summary`, text: xp.summary });
      (xp.bullets ?? []).forEach((b, i) => out.push({ field: `${tag} bullet[${i}]`, text: b }));
    } else {
      if (xp.one_liner) out.push({ field: `${tag} one_liner`, text: xp.one_liner });
    }
  }
  return out;
}

/** Significant single tokens + 2-word phrases worth grounding from one claim. */
export function candidateTerms(text: string): { tokens: string[]; phrases: string[]; acronyms: string[] } {
  const acronyms = [...text.matchAll(/\b([A-Z]{2,}(?:\/[A-Z]{2,})*)\b/g)].flatMap((m) => m[1].split("/"));
  const norm = normalise(text).trim();
  const words = norm.split(" ").filter(Boolean);
  const significant = words.filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (a.length < 3 || b.length < 3) continue;
    if (STOPWORDS.has(a) && STOPWORDS.has(b)) continue;
    phrases.push(`${a} ${b}`);
  }
  return { tokens: [...new Set(significant)], phrases: [...new Set(phrases)], acronyms: [...new Set(acronyms.map((a) => a.toLowerCase()))] };
}

/** 1-based line numbers in `text` whose lowercase content contains `needle`. */
export function lineNumbersContaining(text: string, needle: string): number[] {
  const n = needle.toLowerCase();
  if (!n) return [];
  const out: number[] = [];
  text.split("\n").forEach((line, i) => { if (line.toLowerCase().includes(n)) out.push(i + 1); });
  return out;
}

/**
 * Familiarity framing that legitimises a tier-2 (preppable) term, including one
 * the user answered "Bring in as familiarity" in the evidence interview
 * (`render_as: "familiarity"`). "Prepared on" is accepted because that is what a
 * deliberately prepped term honestly is.
 */
export const FAMILIARITY_FRAMING = /^\s*(familiar with|working knowledge of|exposure to|prepared on)\b/i;

// ---------------------------------------------------------------------------
// Keyword plan schema (produced by resume-keywords.ts)
// ---------------------------------------------------------------------------

export type KeywordStatus =
  | "grounded" | "alias_grounded" | "confirmed" | "pending"
  | "preppable" | "needs_confirmation" | "foreign" | "declined";

export type KeywordCategory = "tool" | "platform" | "methodology" | "certification" | "title" | "domain" | "concept";

export type KeywordTerm = {
  term: string;
  jd_form: string;
  corpus_form: string | null;
  aliases: string[];
  category: KeywordCategory;
  must_have: boolean;
  status: KeywordStatus;
  /**
   * How this term may be rendered when it is not a plain delivered-work claim.
   * `"familiarity"` (status `preppable`, set by a `familiarity` ledger row) means
   * exactly one familiarity-framed skills item — never a bullet, never a claim of
   * delivery — and the term is listed under `interview_prep_terms`.
   */
  render_as: "familiarity" | null;
  /**
   * Id shared by every surface form of one underlying fact (an acronym and its
   * expansion, or several synonyms of one taxonomy / lexicon entry). Members stay
   * individually classifiable and surfaced-checked, but coverage counts a group
   * once and the plan asks the user about it once.
   */
  alias_group: string | null;
  render_both_forms: boolean;
  corpus_lines: number[];
  source_update_required: boolean;
  jd_context: string | null;
  evidence_hint: string | null;
  why: string | null;
  question: string | null;
  proposed_phrasing: string | null;
  surfaced_in: string[];
  jd_frequency?: number;
  /** Keyword cloud this term came from; null for JD-only or deprecated-lexicon terms. */
  cloud_id: string | null;
  cloud_kind: KeywordCloudKind | null;
};

export type KeywordCloudKind = "capability" | "domain" | "tooling";

/**
 * Per-cloud readout on a plan: how much of one cloud's vocabulary this
 * positioning can actually carry. Ordered by the type's weight for the cloud,
 * so the heaviest cloud is the first thing a reader (or the writer subagent)
 * sees.
 */
export type KeywordPlanCloud = {
  id: string;
  kind: KeywordCloudKind;
  label: string;
  /** the positioning's weight for this cloud, 1-5 */
  weight: number;
  /** plan terms sourced from this cloud */
  total: number;
  /** of those, terms the writer may put on the page (incl. familiarity framing) */
  renderable: number;
  /** of those, terms actually on the page (composition mode only) */
  surfaced: number;
  familiarity: number;
  /** open evidence-interview questions from this cloud */
  questions: number;
};

export type KeywordQuestion = {
  term: string;
  /** other surface forms of the same fact, merged into this one question */
  aliases: string[];
  alias_group: string | null;
  category: KeywordCategory;
  question: string;
  options: string[];
  evidence_hint: string | null;
  proposed_phrasing: string | null;
  why: string | null;
  /** cloud this question belongs to; questions are grouped and ordered by it */
  cloud_id: string | null;
  cloud_kind: KeywordCloudKind | null;
  /** the positioning's weight for `cloud_id`, 0 when the term has no cloud */
  cloud_weight: number;
};

/**
 * Corpus-evidence state of a market-lens positioning signal.
 * Deliberately narrower than `KeywordStatus`: a signal is never asked about, so
 * it has no ledger/preppable/needs_confirmation states.
 */
export type KeywordSignalStatus = "explicit" | "implicit" | "missing";

/**
 * A `market_lens.must_signal` phrase.
 *
 * These are POSITIONING concepts ("commercial applied-AI delivery model") that
 * the writer signals through framing and selection, not vocabulary a screener
 * string-matches. They therefore report corpus evidence and never raise a
 * question — asking "did you use or deliver <positioning concept> in any role?"
 * is meaningless. A must_signal phrase only becomes a `KeywordTerm` when it is
 * ALSO real screener vocabulary (a taxonomy synonym, a domain-lexicon term or
 * alias, a `keyword_aliases` key, or — in JD mode — present verbatim in the JD).
 */
export type KeywordSignal = {
  signal: string;
  status: KeywordSignalStatus;
  /** signal itself when explicit; matched `keyword_aliases` evidence patterns when implicit */
  matched_terms: string[];
  evidence_lines: number[];
  reason: string;
  /** the phrase also appears in terms[] because it is genuine screener vocabulary */
  also_a_term: boolean;
};

/**
 * ATS-style composite readout of a composition against its keyword plan.
 *
 * SECONDARY SIGNAL ONLY. Inspired by srbhr/Resume-Matcher's ats scoring and
 * Paramchoudhary/ResumeSkills' job-description analyser: a single legible
 * number a human can eyeball. It never gates anything — see the contract in
 * resume-keywords.ts `computeAtsComposite`.
 *
 * All three components and `score` are 0-100. Matching is always whole-word.
 */
export type AtsComposite = {
  /** share of plan terms whose jd_form or corpus_form appears in the claim fields */
  keyword_match: number;
  /** share of tool/platform/methodology/certification plan terms present in the skills blocks */
  skills_coverage: number;
  /** share of the applicable structural section checks that passed */
  section_completeness: number;
  /** 0.55*keyword_match + 0.25*skills_coverage + 0.20*section_completeness */
  score: number;
  /** short human-readable list of what dragged the score down */
  notes: string[];
};

/**
 * A term the plan could not render and did not ask about.
 *
 * `foreign` used to be a silent bucket: a term with no corpus evidence and no
 * question simply vanished from every human-readable surface. `gaps[]` makes
 * that bucket explicit — every foreign term is listed with the reason it was
 * neither grounded nor asked, so a dropped term is always a visible decision.
 */
export type KeywordGap = {
  term: string;
  category: KeywordCategory;
  /** where the term entered the plan from ("lexicon" = deprecated flat block) */
  source: "taxonomy" | "cloud" | "lexicon" | "keyword_aliases" | "market_lens" | "jd";
  /** taxonomy category (group) the term came from, when source is "taxonomy" */
  taxonomy_group: string | null;
  reason: string;
};

export type KeywordPlan = {
  version: 1;
  resume_id: string;
  profile_id: string | null;
  opportunity_id: string | null;
  mode: "jd" | "proactive";
  jd_hash: string | null;
  cv_source_hash: string;
  generated_at: string;
  title: { jd_title: string | null; title_family: string | null; alignment: "supported" | "unsupported" | "unknown"; reason: string };
  terms: KeywordTerm[];
  /** per-cloud coverage, heaviest cloud first */
  clouds: KeywordPlanCloud[];
  /** market-lens positioning signals: evidence report only, never questions */
  signals: KeywordSignal[];
  coverage: {
    must_have_total: number;
    /** includes familiarity terms: they are renderable, with framing */
    must_have_renderable: number;
    must_have_surfaced: number;
    /** must-haves inside `must_have_renderable` that are renderable only as familiarity */
    must_have_familiarity: number;
    renderable_pct: number;
    surfaced_pct: number;
    renderable_total: number;
    surfaced_total: number;
    /** every `render_as: "familiarity"` term, must-have or not */
    familiarity_total: number;
  };
  questions: KeywordQuestion[];
  /** every `foreign` term, with why it was neither rendered nor asked */
  gaps: KeywordGap[];
  screener_surface: { headline_aligned: boolean | null; screener_block_present: boolean | null };
  /**
   * Present only in composition mode. Advisory readout; never affects
   * `verdict`, `questions`, `warnings` or the tool's exit code.
   */
  ats_composite?: AtsComposite | null;
  warnings: string[];
  verdict: "pass" | "warn";
};

export const RENDERABLE_STATUSES: ReadonlySet<KeywordStatus> = new Set(["grounded", "alias_grounded", "confirmed"]);

/** Terms a plan authorises for rendering (confirmed only once the source carries them). */
export function renderableTerms(plan: KeywordPlan): KeywordTerm[] {
  return plan.terms.filter((t) => RENDERABLE_STATUSES.has(t.status) && !(t.status === "confirmed" && t.source_update_required));
}

/** Every normalised surface form (term, jd_form, corpus_form, aliases) of a plan term. */
export function termForms(t: KeywordTerm): string[] {
  const forms = [t.term, t.jd_form, t.corpus_form ?? "", ...(t.aliases ?? [])].map((f) => normalise(f).trim()).filter(Boolean);
  return [...new Set(forms)];
}
