#!/usr/bin/env tsx
/**
 * resume-term-grounding.ts — deterministic guard against JD-term injection.
 *
 * The sibling resume-provenance.ts proves a claim *cites* a valid source range.
 * It does NOT prove the cited text *supports* the claim — so a tailored bullet
 * can borrow a feature word straight from the job description ("quote generation",
 * "underwriting threshold"), cite an unrelated-but-valid line, and pass.
 *
 * This tool closes that gap mechanically. It extracts the distinctive terms a
 * rendered CV actually asserts, then checks each against the candidate's real
 * source corpus (cv-source.md + profile.md). Two buckets:
 *
 *   jd_injected  — term IS in the target JD but is ABSENT from the corpus.
 *                  This is the high-precision fabrication signal: a word pulled
 *                  from the JD into the CV that the candidate's history doesn't
 *                  support. Severity: fail (in claim-bearing fields).
 *   ungrounded   — distinctive term absent from corpus and (no JD given) not
 *                  obviously generic. Severity: warn (a worklist to resolve).
 *
 * This is a MECHANICAL check (does this term occur in the source text?), the
 * kind that belongs in a deterministic tool. It does not judge meaning; a human
 * / resume-writer still classifies each flag as: corpus-backed (cite it),
 * preppable domain knowledge (reframe as familiarity + log for interview prep),
 * or remove. Its job is to make sure no injected term passes SILENTLY.
 *
 * Usage:
 *   tsx tools/resume/resume-term-grounding.ts --content-json <path> [--jd <path>] [--profile <id>] [--keyword-plan <path>]
 *
 * --keyword-plan (2026-09-10): a plan from `npm run resume:keywords` whitelists
 * terms it classified as grounded / alias_grounded / confirmed-in-source (so the
 * JD's exact spelling of a corpus-backed fact no longer trips jd_injected),
 * permits `preppable` terms only inside familiarity-framed fields (bucket
 * `familiarity_framed`, warn) — including terms answered "Bring in as
 * familiarity" in the evidence interview, which the plan marks `preppable` with
 * `render_as: "familiarity"` — and hard-fails any term the plan left as
 * needs_confirmation / pending / foreign / declined (bucket `unconfirmed_term`).
 */

import { promises as fs } from "node:fs";
import { resolveProfileContext } from "../profile-context.ts";
import type { ResumeContent } from "../../templates/resume/_interface.ts";
import {
  STOPWORDS, parseArgs, normalise, tokenInText, phraseInText, buildStemSet, claimFields, candidateTerms,
  renderableTerms, termForms, FAMILIARITY_FRAMING, type KeywordPlan,
} from "./keyword-lexicon.ts";

type Severity = "warn" | "fail";
export type TermFlag = {
  severity: Severity;
  bucket: "jd_injected" | "ungrounded" | "familiarity_framed" | "unconfirmed_term";
  term: string;
  field: string;
  excerpt: string;
};

export type TermGroundingResult = {
  verdict: "pass" | "warn" | "fail";
  jd_supplied: boolean;
  keyword_plan: string | null;
  flags: TermFlag[];
  stats: {
    fail_count: number;
    warn_count: number;
    jd_injected_terms: string[];
    ungrounded_terms: string[];
    familiarity_framed_terms: string[];
    unconfirmed_terms: string[];
    allowed_by_plan: string[];
  };
};

export type TermGroundingOptions = {
  content: ResumeContent;
  cvSource: string;
  profileMd: string;
  jdText?: string;
  plan?: KeywordPlan | null;
  planPath?: string | null;
};

type PlanIndex = {
  allowed: Set<string>;        // normalised forms that never flag
  preppable: Set<string>;      // allowed only under familiarity framing
  unconfirmed: Set<string>;    // hard fail wherever they appear
  allowedLabels: string[];
};

/**
 * Forms that may only ever SUPPRESS a flag (`idx.allowed`) are also indexed by
 * their constituent tokens: if "retrieval augmented generation" is a grounded
 * fact, the word "retrieval" on its own is grounded too, and widening the
 * whitelist can only reduce false failures.
 */
function addAllowedForms(set: Set<string>, forms: string[]): void {
  for (const f of forms) {
    set.add(f);
    for (const tok of f.split(" ")) if (tok.length >= 3) set.add(tok);
  }
}

/**
 * A form that carries no distinctive content — every token in it is generic
 * resume/English vocabulary ("and", "for", "management", "architecture").
 *
 * Such a form may never drive a FLAG. It would fire on ordinary delivery
 * English anywhere in the CV, which is exactly the 150-200 false
 * `unconfirmed_term` / `jd_injected` failures this guard exists to prevent.
 */
function isGenericForm(form: string): boolean {
  const tokens = form.split(" ").filter(Boolean);
  return tokens.length === 0 || tokens.every((tok) => STOPWORDS.has(tok));
}

/**
 * Index a keyword plan into three sets with deliberately ASYMMETRIC matching:
 *
 *   allowed      — whole normalised forms PLUS their ≥3-char constituent tokens.
 *                  Only ever suppresses a flag, so over-matching is safe.
 *   preppable    — whole normalised forms + aliases ONLY, matched as whole
 *   unconfirmed    phrases. These DRIVE hard failures, so splitting them into
 *                  tokens would hard-fail every bullet containing "and", "for",
 *                  "code", "architecture" or "management" — ordinary delivery
 *                  English that a multi-word foreign / preppable phrase happens
 *                  to contain ("Teams voice or endpoint management specialist",
 *                  "eval rubrics and golden datasets").
 *
 * Any flag-driving form that is entirely generic vocabulary is dropped outright.
 */
function indexPlan(plan: KeywordPlan | null | undefined): PlanIndex {
  const idx: PlanIndex = { allowed: new Set(), preppable: new Set(), unconfirmed: new Set(), allowedLabels: [] };
  if (!plan) return idx;
  for (const t of renderableTerms(plan)) { addAllowedForms(idx.allowed, termForms(t)); idx.allowedLabels.push(t.term); }
  const addFlagging = (set: Set<string>, forms: string[]) => {
    for (const f of forms) if (!isGenericForm(f)) set.add(f);
  };
  for (const t of plan.terms) {
    // `preppable` covers both the lexicon's tier-2 terms and the ones the user
    // answered "Bring in as familiarity" (`render_as: "familiarity"`). Both are
    // legal ONLY inside a familiarity-framed field — "Familiar with …",
    // "Working knowledge of …", "Prepared on …" (see FAMILIARITY_FRAMING).
    if (t.status === "preppable") addFlagging(idx.preppable, termForms(t));
    if (t.status === "needs_confirmation" || t.status === "pending" || t.status === "foreign" || t.status === "declined") {
      addFlagging(idx.unconfirmed, termForms(t));
    }
  }
  // allowed wins over unconfirmed if a form is somehow in both
  for (const f of idx.allowed) idx.unconfirmed.delete(f);
  return idx;
}

export function runTermGrounding(opts: TermGroundingOptions): TermGroundingResult {
  const { content } = opts;
  const corpus = normalise(`${opts.cvSource}\n${opts.profileMd}`);
  const corpusStems = buildStemSet(corpus);
  const jdRaw = opts.jdText ?? "";
  const jd = jdRaw ? normalise(jdRaw) : "";
  const jdStems = jdRaw ? buildStemSet(jd) : new Set<string>();
  const plan = indexPlan(opts.plan);

  const inCorpusToken = (t: string) => tokenInText(t, corpus, corpusStems);
  const inCorpusPhrase = (p: string) => phraseInText(p, corpus);
  const inJdToken = (t: string) => jdRaw ? tokenInText(t, jd, jdStems) : false;
  const inJdPhrase = (p: string) => jdRaw ? phraseInText(p, jd) : false;

  const flags: TermFlag[] = [];
  const seen = new Set<string>();
  const excerpt = (text: string) => text.length > 110 ? `${text.slice(0, 107)}...` : text;
  const push = (severity: Severity, bucket: TermFlag["bucket"], term: string, field: string, text: string) => {
    const key = `${field}::${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({ severity, bucket, term, field, excerpt: excerpt(text) });
  };

  for (const { field, text } of claimFields(content)) {
    const framed = FAMILIARITY_FRAMING.test(text);
    const { tokens, phrases, acronyms } = candidateTerms(text);
    const singles = [...tokens, ...acronyms];
    const normText = normalise(text);

    // Plan-driven pass first: unconfirmed terms fail regardless of corpus/JD status,
    // preppable terms are legal only under familiarity framing.
    // Defence in depth: `indexPlan` already drops generic forms, so a flag can
    // never originate from a STOPWORDS token even if a plan is hand-edited.
    for (const form of plan.unconfirmed) {
      if (isGenericForm(form)) continue;
      if (phraseInText(form, normText)) push("fail", "unconfirmed_term", form, field, text);
    }
    for (const form of plan.preppable) {
      if (isGenericForm(form)) continue;
      if (!phraseInText(form, normText)) continue;
      if (framed) push("warn", "familiarity_framed", form, field, text);
      else push("fail", "unconfirmed_term", form, field, text);
    }

    for (const term of singles) {
      // Generic resume/English vocabulary is never an experiential claim — skip it
      // in BOTH buckets. Critically this now gates the jd_injected (fail) path too:
      // a JD and a CV share the same generic delivery English, so a corpus-absent
      // common word ("updates", "status", "regular") trivially co-occurs in both
      // without being a fabricated feature-term. Only distinctive, claim-bearing
      // terms should reach the hard-fail decision.
      if (STOPWORDS.has(term)) continue;
      if (plan.allowed.has(term)) continue;
      if (plan.preppable.has(term) || plan.unconfirmed.has(term)) continue; // already judged above
      if (inCorpusToken(term)) continue;
      if (inJdToken(term)) push("fail", "jd_injected", term, field, text);
      else push("warn", "ungrounded", term, field, text);
    }
    for (const phrase of phrases) {
      if (plan.allowed.has(phrase)) continue;
      if (plan.preppable.has(phrase) || plan.unconfirmed.has(phrase)) continue;
      if (inCorpusPhrase(phrase)) continue;
      // only surface a phrase the JD actually uses (high-precision); skip generic ungrounded bigrams (token pass covers those)
      if (inJdPhrase(phrase)) push("fail", "jd_injected", phrase, field, text);
    }
  }

  const failCount = flags.filter((f) => f.severity === "fail").length;
  const warnCount = flags.filter((f) => f.severity === "warn").length;
  const verdict = failCount ? "fail" : warnCount ? "warn" : "pass";
  const terms = (bucket: TermFlag["bucket"]) => [...new Set(flags.filter((f) => f.bucket === bucket).map((f) => f.term))];
  return {
    verdict,
    jd_supplied: Boolean(jdRaw),
    keyword_plan: opts.planPath ?? null,
    flags,
    stats: {
      fail_count: failCount,
      warn_count: warnCount,
      jd_injected_terms: terms("jd_injected"),
      ungrounded_terms: terms("ungrounded"),
      familiarity_framed_terms: terms("familiarity_framed"),
      unconfirmed_terms: terms("unconfirmed_term"),
      allowed_by_plan: plan.allowedLabels,
    },
  };
}

export async function runTermGroundingFromFiles(args: { contentJson: string; jd?: string; profile?: string; keywordPlan?: string }): Promise<TermGroundingResult> {
  const content = JSON.parse(await fs.readFile(args.contentJson, "utf8")) as ResumeContent;
  const ctx = resolveProfileContext(args.profile);
  const cvSource = await fs.readFile(ctx.cvSourcePath, "utf8").catch(() => "");
  const profileMd = await fs.readFile(ctx.profileMdPath, "utf8").catch(() => "");
  const jdText = args.jd ? await fs.readFile(args.jd, "utf8").catch(() => "") : "";
  const plan = args.keywordPlan ? JSON.parse(await fs.readFile(args.keywordPlan, "utf8")) as KeywordPlan : null;
  return runTermGrounding({ content, cvSource, profileMd, jdText, plan, planPath: args.keywordPlan ?? null });
}

async function main() {
  const args = parseArgs();
  const contentPath = args["content-json"];
  if (!contentPath) {
    console.error("Usage: tsx tools/resume/resume-term-grounding.ts --content-json <path> [--jd <path>] [--profile <id>] [--keyword-plan <path>]");
    process.exit(2);
  }
  const result = await runTermGroundingFromFiles({ contentJson: contentPath, jd: args.jd, profile: args.profile, keywordPlan: args["keyword-plan"] });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "warn" ? 1 : 2);
}

if (process.argv[1] && /resume-term-grounding\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(3);
  });
}
