#!/usr/bin/env tsx
/**
 * ats-composite.ts — the screener-style composite score for a composition.
 *
 * Lifted out of `resume-keywords.ts` unchanged. It belongs on its own because
 * it shares nothing with the extraction half of the planner: it reads a
 * FINISHED plan and a composition and returns three percentages and a blend.
 * No corpus, no taxonomy, no ledger, no JD.
 *
 * CONTRACT — this is a SECONDARY signal. Nothing here may change a plan's
 * verdict, questions, warnings or the planner's exit code; those stay owned by
 * the coverage gates in `resume-keywords.ts`. See `computeAtsComposite`.
 *
 * `resume-keywords.ts` re-exports every symbol below, so importers may take
 * them from either module.
 */

import { claimFields, type AtsComposite, type KeywordCategory, type KeywordPlan, type KeywordTerm } from "./keyword-lexicon.ts";
import type { ResumeContent } from "../../templates/resume/_interface.ts";

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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
