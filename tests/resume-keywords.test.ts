#!/usr/bin/env tsx
/**
 * resume-keywords.test.ts — keyword planner + term-grounding plan integration.
 *
 * Uses a synthetic corpus / taxonomy / ledger so nothing personal is asserted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildKeywordPlan, applyComposition, extractCandidates, segmentJd, classifyTerm, summarise,
  computeAtsComposite, wholeWordHit, sourceHasCredentials, ATS_WEIGHTS,
  QUESTION_OPTIONS, type KeywordContext,
} from "../tools/resume/resume-keywords.ts";
import { runTermGrounding } from "../tools/resume/resume-term-grounding.ts";
import { renderableTerms, termForms, type KeywordPlan } from "../tools/resume/keyword-lexicon.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";

const jd = readFileSync(path.join("tests", "fixtures", "sample-jd-architect.md"), "utf8");

const cvSource = `# Candidate Name
**Contact:** hidden

## Professional Summary
Solutions architect across government and banking programmes.

## Professional Experience

### 2022-01 – present — Solution Architect, Example Agency (Sydney)
_Digital transformation programme for a state government department._
- Led end-to-end solution design across ServiceNow ESM and Mulesoft integration.
- Presented designs at the architecture review board and coached delivery teams.
- Ran agile ceremonies with two squads; Jira for backlog.

### 2018-03 – 2021-12 — Senior Consultant, Example Bank (Sydney)
- Delivered Microsoft 365 and SharePoint intranet migration for 4,000 staff.
- Managed vendor relationships and cyber review sign-off.

## Skills
- Technology and Design: ServiceNow, Mulesoft, Microsoft 365, SharePoint
`;

const profileMd = `---
name: Candidate Name
---
Principal-level solution architect.
`;

const taxonomy = {
  categories: {
    platforms: {
      servicenow: { synonyms: ["ServiceNow", "SNow", "ServiceNow ESM", "Now Platform"], seniority: "expert" as const },
      salesforce: { synonyms: ["Salesforce", "SFDC", "Sales Cloud"], seniority: "expert" as const },
      microsoft365: { synonyms: ["Microsoft 365", "M365", "Office 365", "SharePoint"], seniority: "expert" as const },
      mulesoft: { synonyms: ["MuleSoft", "Mulesoft", "Anypoint"], seniority: "practitioner" as const },
      atlassian: { synonyms: ["Jira", "Confluence"], seniority: "practitioner" as const },
    },
    practice_areas: {
      enterprise_architecture: { synonyms: ["Enterprise Architecture", "TOGAF"], seniority: "familiar" as const },
    },
  },
};

function ctx(overrides: Partial<KeywordContext> = {}): KeywordContext {
  const headings: Array<{ line: number; text: string }> = [];
  cvSource.split("\n").forEach((l, i) => { const m = l.match(/^###\s+(.+)$/); if (m) headings.push({ line: i + 1, text: m[1] }); });
  return {
    resumeId: "solution-architect",
    profileId: null,
    cvSource,
    profileMd,
    taxonomy,
    confirmations: [],
    marketLens: {
      must_signal: ["architecture governance", "commercial applied-AI delivery model"],
      keyword_aliases: { "architecture governance": { acceptable_if_source_mentions: ["architecture review board"] } },
      clouds: [{ id: "programme-delivery", weight: 5 }],
    },
    clouds: [{
      id: "programme-delivery",
      kind: "capability" as const,
      label: "Programme delivery",
      weight: 5,
      must_have_min: null,
      refreshed_at: "2026-09-01",
      age_days: 9,
      stale: false,
      terms: [
        { term: "Lean", tier: "preppable" as const, category: "methodology" as const, why: "asked in most delivery JDs" },
        { term: "ITIL", tier: "confirm" as const, category: "methodology" as const, why: "appears in 60% of architect JDs" },
      ],
    }],
    searchKeywords: ["Solution Architect", "Solutions Architect"],
    roleHeadings: headings,
    ...overrides,
  };
}

// --- segmentation -----------------------------------------------------------
{
  const flat = "Overview: Lead delivery. About You To succeed you will bring: Strong knowledge of Jira. Experience with Salesforce (specifically Sales Cloud).";
  const lines = segmentJd(flat);
  assert.ok(lines.some((l) => /^About You$/.test(l)), "section phrase becomes its own heading line");
  assert.ok(lines.some((l) => l.startsWith("Strong knowledge of Jira")), "sentences split after the heading");
}

// --- extraction + classification on the fixture JD -----------------------------
const plan = buildKeywordPlan({ ctx: ctx(), jdText: jd, jdTitle: "Solutions Architect", opportunityId: "test-opp", now: new Date("2026-09-10T00:00:00Z") });
const byTerm = new Map(plan.terms.map((t) => [t.term.toLowerCase(), t]));
const status = (term: string) => byTerm.get(term.toLowerCase())?.status;

assert.equal(plan.mode, "jd");
assert.equal(plan.opportunity_id, "test-opp");
assert.equal(status("ServiceNow"), "grounded", "exact corpus term");
assert.equal(status("Mulesoft"), "grounded");
assert.equal(status("Salesforce"), "needs_confirmation", "must-have tool absent from corpus is asked, not faked");
assert.equal(status("Microsoft 365"), "grounded");
assert.equal(status("Agile"), "grounded", "lowercase methodology found via stem");
assert.equal(status("ITIL"), "needs_confirmation", "cloud confirm tier");
assert.equal(status("Lean"), "preppable", "cloud preppable tier");
assert.equal(byTerm.get("itil")?.cloud_id, "programme-delivery", "cloud terms carry their cloud id");
assert.equal(byTerm.get("itil")?.cloud_kind, "capability");
assert.ok(byTerm.get("servicenow esm"), "multi-word taxonomy synonym extracted");
assert.equal(status("ServiceNow ESM"), "grounded");

// must-have detection from the "You bring" section
assert.equal(byTerm.get("salesforce")?.must_have, true);
assert.equal(byTerm.get("servicenow esm")?.must_have, true);

// alias grounding: corpus says "Microsoft 365"; JD says "M365" style aliasing via taxonomy acronym pair
{
  const t = classifyTerm({ term: "M365", category: "platform", must_have: true, jd_context: "M365" }, ctx(), { norm: ` ${cvSource.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `, stems: new Set() } as any);
  assert.equal(t.status, "alias_grounded");
  assert.equal(t.corpus_form, "Microsoft 365");
  assert.equal(t.jd_form, "M365");
  assert.equal(t.render_both_forms, true, "acronym pair renders both forms");
}

// taxonomy siblings that are different products never alias-ground each other
{
  const t = classifyTerm({ term: "Confluence", category: "platform", must_have: true, jd_context: "Jira, Confluence" }, ctx(), { norm: ` ${cvSource.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `, stems: new Set() } as any);
  assert.notEqual(t.status, "alias_grounded", "Confluence must not be grounded by Jira");
  assert.equal(t.status, "needs_confirmation");
}

// keyword_aliases evidence patterns ground a market signal
{
  const t = classifyTerm({ term: "architecture governance", category: "domain", must_have: true, jd_context: null }, ctx(), { norm: ` ${cvSource.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `, stems: new Set() } as any);
  assert.equal(t.status, "alias_grounded");
  assert.equal(t.corpus_form, "architecture review board");
}

// certifications: exact only, never alias-matched, asked when must-have
{
  const c = ctx();
  const idx = { norm: ` ${cvSource.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `, stems: new Set<string>() } as any;
  const t = classifyTerm({ term: "TOGAF", category: "certification", must_have: true, jd_context: "TOGAF certified" }, c, idx);
  assert.equal(t.status, "needs_confirmation", "taxonomy sibling 'Enterprise Architecture' must not ground a certification");
  assert.match(t.proposed_phrasing ?? "", /certified/);
}

// ledger suppression and confirmation
{
  const declined = ctx({ confirmations: [{ resume_id: "solution-architect", kind: "keyword", signal: "Salesforce", status: "declined" }] });
  const p = buildKeywordPlan({ ctx: declined, jdText: jd });
  assert.equal(p.terms.find((t) => t.term === "Salesforce")?.status, "declined");
  assert.ok(!p.questions.some((q) => q.term === "Salesforce"), "declined terms are never re-asked");

  const confirmed = ctx({ confirmations: [{ resume_id: "solution-architect", kind: "keyword", signal: "Salesforce", status: "confirmed", source_ref: "cv-source.md:12" }] });
  const p2 = buildKeywordPlan({ ctx: confirmed, jdText: jd });
  const sf = p2.terms.find((t) => t.term === "Salesforce")!;
  assert.equal(sf.status, "confirmed");
  assert.equal(sf.source_update_required, true, "confirmed but not yet in source cannot render");
  assert.ok(!renderableTerms(p2).some((t) => t.term === "Salesforce"));

  const pending = ctx({ confirmations: [{ resume_id: "solution-architect", kind: "keyword", signal: "Salesforce", status: "pending" }] });
  const p3 = buildKeywordPlan({ ctx: pending, jdText: jd });
  assert.equal(p3.terms.find((t) => t.term === "Salesforce")?.status, "pending");
  assert.ok(!p3.questions.some((q) => q.term === "Salesforce"), "pending terms are outstanding, not re-asked");

  // "Bring in as familiarity": not delivered, but preppable and speakable.
  const familiar = ctx({ confirmations: [{ resume_id: "solution-architect", kind: "keyword", signal: "Salesforce", status: "familiarity" }] });
  const p4 = buildKeywordPlan({ ctx: familiar, jdText: jd });
  const fam = p4.terms.find((t) => t.term === "Salesforce")!;
  assert.equal(fam.status, "preppable", "a familiarity answer is tier-2, not a delivered-work claim");
  assert.equal(fam.render_as, "familiarity");
  assert.ok(!p4.questions.some((q) => q.term === "Salesforce"), "familiarity terms are answered and never re-asked");
  assert.ok(!renderableTerms(p4).some((t) => t.term === "Salesforce"), "term-grounding still requires familiarity framing");
  assert.ok(p4.coverage.familiarity_total >= 1, "coverage counts it as renderable-with-framing");
  assert.ok(p4.coverage.must_have_familiarity >= 1, "and names how many of the must-haves that covers");
  assert.ok(p4.coverage.must_have_renderable > buildKeywordPlan({ ctx: ctx(), jdText: jd }).coverage.must_have_renderable,
    "a familiarity answer improves renderable coverage rather than reading as a gap");
}

// person-scope: keyword answers cross positionings, market_signal answers do not
{
  // Recorded while working the applied-ai positioning; this ctx is solution-architect.
  const otherResume = ctx({ confirmations: [{ resume_id: "applied-ai", kind: "keyword", scope: "person", signal: "Salesforce", status: "not_applicable" }] });
  const p = buildKeywordPlan({ ctx: otherResume, jdText: jd });
  assert.equal(p.terms.find((t) => t.term === "Salesforce")?.status, "declined",
    "an answer given under another positioning is a fact about the person");
  assert.ok(!p.questions.some((q) => q.term === "Salesforce"), "and is never re-asked here");

  // Same, for an alias form of the same fact: the user answered "SFDC".
  const aliasAnswer = ctx({ confirmations: [{ resume_id: "applied-ai", kind: "keyword", signal: "SFDC", term: "SFDC", status: "familiarity" }] });
  const p2 = buildKeywordPlan({ ctx: aliasAnswer, jdText: jd });
  const sf = p2.terms.find((t) => t.term === "Salesforce")!;
  assert.equal(sf.status, "preppable", "alias forms of one fact share the answer");
  assert.equal(sf.render_as, "familiarity");
  assert.ok(!p2.questions.some((q) => q.term === "Salesforce"));

  // A stale pending row under this resume must not resurrect an answered question.
  const stale = ctx({ confirmations: [
    { resume_id: "solution-architect", kind: "keyword", signal: "Salesforce", status: "pending" },
    { resume_id: "applied-ai", kind: "keyword", scope: "person", signal: "Salesforce", status: "confirmed", source_ref: "cv-source.md:12" },
  ] });
  assert.equal(buildKeywordPlan({ ctx: stale, jdText: jd }).terms.find((t) => t.term === "Salesforce")?.status, "confirmed",
    "an answer anywhere beats an unanswered row here");

  // A market_signal row stays positioning-scoped: the same phrase can mean
  // different things under two lenses, so it never crosses.
  const lensRow = ctx({ confirmations: [{ resume_id: "applied-ai", signal: "Salesforce", status: "not_applicable" }] });
  const p3 = buildKeywordPlan({ ctx: lensRow, jdText: jd });
  assert.equal(p3.terms.find((t) => t.term === "Salesforce")?.status, "needs_confirmation");
  assert.ok(p3.questions.some((q) => q.term === "Salesforce"), "a market_signal answer under another resume does not suppress");
}

// questions follow the evidence-interview rule
{
  const q = plan.questions.find((q) => q.term === "Salesforce")!;
  assert.ok(q, "must-have unknown term produces a question");
  assert.deepEqual(q.options, [...QUESTION_OPTIONS]);
  assert.ok(q.options.includes("Bring in as familiarity"), "the evidence interview offers the familiarity answer");
  assert.equal(q.options.length, 4);
  assert.match(q.question, /Salesforce/);
  assert.match(q.question, /Plausible:/);
  assert.match(q.question, /Why it matters:/);
  assert.match(q.question, /Proposed line:/);
  assert.ok(q.evidence_hint?.startsWith("cv-source.md:"));
}

// title alignment
assert.equal(plan.title.title_family, "Solutions Architect");
assert.equal(plan.title.alignment, "supported");
{
  const p = buildKeywordPlan({ ctx: ctx(), jdText: jd, jdTitle: "Chief Solutions Architect" });
  assert.equal(p.title.alignment, "unsupported", "unevidenced seniority word blocks headline alignment");
}

// coverage in plan mode
assert.ok(plan.coverage.must_have_total >= 3);
assert.equal(plan.coverage.surfaced_pct, 0, "no composition yet");

// --- composition mode ------------------------------------------------------------
const composition: ResumeContent = {
  frontmatter: { name: "Candidate Name", email: "", phone: "", citizenship: "", location: "" },
  headline: "Solutions Architect",
  summary: "Solutions Architect who has led ServiceNow ESM and Mulesoft programmes for government.",
  highlights: ["Delivered a Microsoft 365 migration for 4,000 staff."],
  skills: [
    { name: "Core competencies", role: "screener", bullets: ["ServiceNow ESM, Mulesoft, Microsoft 365, Agile delivery"] },
    { name: "Technology and Design", bullets: ["ServiceNow", "Mulesoft"] },
  ],
  experiences: [
    { placement: "feature", title: "Solution Architect", company: "Example Agency", start: "2022-01", end: "present", bullets: ["Led solution design across ServiceNow ESM and Mulesoft."] } as any,
  ],
  resumeId: "solution-architect",
} as any;

const withComp = applyComposition(structuredClone(plan), composition);
assert.equal(withComp.screener_surface.screener_block_present, true);
assert.equal(withComp.screener_surface.headline_aligned, true);
assert.ok(withComp.terms.find((t) => t.term === "ServiceNow ESM")!.surfaced_in.length > 0);
assert.ok(withComp.coverage.surfaced_pct >= 85, `surfaced ${withComp.coverage.surfaced_pct}`);
const summary = summarise(withComp);
assert.ok(Array.isArray((summary as any).questions));

{
  const bare = applyComposition(structuredClone(plan), { ...composition, headline: undefined, skills: [{ name: "Skills", bullets: ["ServiceNow"] }] } as any);
  assert.equal(bare.screener_surface.screener_block_present, false);
  assert.ok(bare.warnings.some((w) => /screener/.test(w)));
  assert.ok(bare.warnings.some((w) => /headline/.test(w)));
  assert.equal(bare.verdict, "warn");
}

// --- ATS composite (secondary signal) ---------------------------------------------
{
  // weights are the documented blend and sum to 1
  assert.equal(ATS_WEIGHTS.keyword_match + ATS_WEIGHTS.skills_coverage + ATS_WEIGHTS.section_completeness, 1);

  const ats = withComp.ats_composite!;
  assert.ok(ats, "composition mode attaches an ats_composite block");
  for (const v of [ats.keyword_match, ats.skills_coverage, ats.section_completeness, ats.score]) {
    assert.ok(v >= 0 && v <= 100, `component out of 0-100 range: ${v}`);
  }
  const expected = Math.round(
    ATS_WEIGHTS.keyword_match * ats.keyword_match
    + ATS_WEIGHTS.skills_coverage * ats.skills_coverage
    + ATS_WEIGHTS.section_completeness * ats.section_completeness,
  );
  assert.equal(ats.score, expected, "score is the weighted blend of the three components");
  assert.ok(ats.notes.length > 0, "notes explain what dragged the score");
  assert.equal((summarise(withComp) as any).ats_composite, ats, "summary printout carries the composite");
  assert.equal(plan.ats_composite ?? null, null, "plan mode has no composite");

  // it is a SECONDARY signal: it is derived from the finalised plan and the
  // questions/verdict are exactly what the coverage gates produced.
  assert.deepEqual(withComp.questions.map((q) => q.term), plan.questions.map((q) => q.term));
  assert.deepEqual(computeAtsComposite(withComp, composition), ats, "recomputing changes nothing about the plan");

  assert.equal(sourceHasCredentials(cvSource), false, "this corpus has no education/credentials heading");
  assert.equal(sourceHasCredentials(`${cvSource}\n## Education\n- BSc\n`), true);

  // whole-word matching never accepts a substring
  assert.equal(wholeWordHit("Java", "Built a JavaScript front end"), false, "'Java' is not matched by 'JavaScript'");
  assert.equal(wholeWordHit("Java", "Built services in Java 17"), true);
  assert.equal(wholeWordHit("SA", "Delivered with SAFe at scale"), false, "'SA' is not matched by 'SAFe'");
  assert.equal(wholeWordHit("Microsoft 365", "Migrated Microsoft  365 tenants"), true, "internal whitespace may vary");
  assert.equal(wholeWordHit("C++", "Wrote C++ modules"), true, "regex metacharacters are escaped");

  // section_completeness reacts to structure, and the rubric bound applies when known
  const fat = applyComposition(structuredClone(plan), {
    ...composition,
    highlights: ["Delivered a Microsoft 365 migration.", "Led ServiceNow ESM design.", "Ran Mulesoft integration."],
    skills: [
      { name: "Core competencies", role: "screener", bullets: ["ServiceNow ESM, Mulesoft, Microsoft 365, Agile delivery"] },
      { name: "Technology and Design", bullets: ["ServiceNow", "Mulesoft"] },
      { name: "Delivery", bullets: ["Agile"] },
    ],
    experiences: [
      { placement: "feature", title: "Solution Architect", company: "Example Agency", start: "2022-01", end: "present",
        bullets: ["Led ServiceNow ESM design.", "Ran Mulesoft integration.", "Coached delivery teams."] } as any,
    ],
  } as any);
  assert.equal(fat.ats_composite!.section_completeness, 100, "a structurally complete composition passes every applicable check");
  assert.ok(fat.ats_composite!.notes.every((n) => !/section_completeness/.test(n)));

  const thin = applyComposition(structuredClone(plan), {
    ...composition, highlights: [], skills: [{ name: "Skills", bullets: ["ServiceNow"] }],
  } as any);
  assert.ok(thin.ats_composite!.section_completeness < fat.ats_composite!.section_completeness, "missing highlights/blocks drag completeness");
  assert.ok(thin.ats_composite!.notes.some((n) => /highlight/.test(n)));

  const rubbed = applyComposition(structuredClone(plan), composition, { rubric: { summary_min_chars: 5000 } });
  assert.ok(rubbed.ats_composite!.notes.some((n) => /outside the rubric/.test(n)), "summary shorter than the rubric minimum is noted");

  const credited = applyComposition(structuredClone(plan), composition, { sourceHasCredentials: true });
  assert.ok(credited.ats_composite!.notes.some((n) => /credentials/.test(n)), "source credentials absent from the composition are noted");

  // skills_coverage looks at the skills blocks specifically, not prose
  const proseOnly = applyComposition(structuredClone(plan), { ...composition, skills: [] } as any);
  assert.equal(proseOnly.ats_composite!.skills_coverage, 0, "no skills blocks means no skills coverage");
  assert.ok(proseOnly.ats_composite!.keyword_match > 0, "prose still counts toward keyword_match");
}

// --- proactive mode ---------------------------------------------------------------
{
  const p = buildKeywordPlan({ ctx: ctx(), proactive: true, now: new Date("2026-11-01T00:00:00Z") });
  assert.equal(p.mode, "proactive");
  assert.ok(p.terms.some((t) => t.term === "architecture governance" && !t.must_have && t.status === "alias_grounded"),
    "a keyword_aliases key still enters terms[], but must_signal no longer forces must-have weight on it");
  assert.ok(p.terms.some((t) => t.term === "ITIL" && t.status === "needs_confirmation"));
  assert.ok(p.warnings.some((w) => /cloud "programme-delivery" \(weight 5\) was refreshed \d+ days ago/.test(w)),
    "a load-bearing cloud past the staleness limit warns");
  assert.ok(!p.terms.some((t) => t.term === "Enterprise Architecture"), "familiar-tier taxonomy entries are not proactive candidates");

  // a must_signal that is pure positioning is a signal, never a term and never a question
  const positioning = "commercial applied-AI delivery model";
  assert.ok(!p.terms.some((t) => t.term === positioning), "positioning must_signal is not a term candidate");
  assert.ok(!p.questions.some((q) => q.question.includes(positioning)), "positioning must_signal never raises a question");
  const sig = p.signals.find((s) => s.signal === positioning)!;
  assert.ok(sig, "positioning must_signal appears under signals[]");
  assert.equal(sig.status, "missing", "absent from the corpus, reported as missing evidence");
  assert.equal(sig.also_a_term, false);

  // a must_signal that IS screener vocabulary stays a term AND reports its evidence
  const governance = p.signals.find((s) => s.signal === "architecture governance")!;
  assert.equal(governance.status, "implicit", "keyword_aliases evidence grounds the signal");
  assert.deepEqual(governance.matched_terms, ["architecture review board"]);
  assert.ok(governance.evidence_lines.length > 0);
  assert.equal(governance.also_a_term, true, "it is also a keyword_aliases key, so it stays in terms[]");

  // only taxonomy / lexicon / keyword_aliases vocabulary may ask
  const askable = new Set(["ITIL", "Salesforce", "SFDC", "Sales Cloud", "Jira", "Confluence", "SNow", "Now Platform", "Anypoint", "M365", "Office 365", "SharePoint", "architecture governance"]);
  for (const q of p.questions) assert.ok(askable.has(q.term), `proactive question from unexpected vocabulary: ${q.term}`);
}

// --- curated taxonomy synonyms are ONE fact; bucket entries keep the guard ----------
{
  const aiCv = `# Candidate Name

## Professional Experience

### 2022-01 – present — AI Engineer, Example Lab (Sydney)
- Built retrieval pipelines and agent workflows for a regulated lender.
- Ran the delivery backlog in Jira across two squads.
`;
  const aiHeadings: Array<{ line: number; text: string }> = [];
  aiCv.split("\n").forEach((l, i) => { const m = l.match(/^###\s+(.+)$/); if (m) aiHeadings.push({ line: i + 1, text: m[1] }); });
  const aiTaxonomy = {
    categories: {
      ai_genai: {
        // curated one-fact entry: every synonym is a surface form of the entry name
        retrieval_augmented_generation: {
          synonyms: ["RAG", "retrieval augmented generation", "retrieval-augmented generation", "retrieval pipeline"],
          seniority: "practitioner" as const,
        },
        ai_evaluation: { synonyms: ["AI evaluation", "evals"], seniority: "practitioner" as const },
      },
      // bucket entries: one vendor name over two distinct products
      platforms: {
        atlassian: { synonyms: ["Jira", "Confluence"], seniority: "practitioner" as const },
        salesforce: { synonyms: ["Salesforce", "SFDC"], seniority: "expert" as const },
      },
    },
  };
  const aiCtx = ctx({
    resumeId: "ai-developer", cvSource: aiCv, taxonomy: aiTaxonomy as any, roleHeadings: aiHeadings,
    marketLens: undefined, searchKeywords: ["AI Developer"],
  });
  const p = buildKeywordPlan({ ctx: aiCtx, proactive: true });

  // 1. curated synonyms alias unconditionally, and plural corpus wording still grounds
  const rag = p.terms.find((t) => t.term === "RAG")!;
  assert.equal(rag.status, "alias_grounded", "RAG grounds through a curated taxonomy synonym");
  assert.equal(rag.corpus_form, "retrieval pipeline", "'retrieval pipelines' in the corpus grounds 'retrieval pipeline'");
  assert.ok(rag.corpus_lines.length > 0, "the inflected corpus line is still cited as evidence");
  assert.equal(rag.render_both_forms, true, "the entry has an acronym and an expansion");
  assert.ok(rag.aliases.includes("retrieval-augmented generation"), "hyphen variant is carried as an alias");

  // 2. a bucket entry keeps the sibling guard: Jira must never ground Confluence
  const idx = { norm: ` ${aiCv.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `, stems: new Set<string>() } as any;
  const conf = classifyTerm({ term: "Confluence", category: "platform", must_have: true, jd_context: null }, aiCtx, idx);
  assert.notEqual(conf.status, "alias_grounded", "Confluence is not grounded by its taxonomy sibling Jira");
  assert.ok(!conf.aliases.includes("Jira"), "distinct products under one vendor bucket are not aliases");

  // 3. a taxonomy term relevant to this positioning but absent from the corpus is ASKED
  const evals = p.terms.find((t) => t.term === "AI evaluation")!;
  assert.equal(evals.status, "needs_confirmation", "relevant-but-absent taxonomy term is a question, not a silent drop");
  assert.match(evals.why ?? "", /listed in your skills taxonomy for this positioning/);
  const q = p.questions.find((x) => x.term === "AI evaluation")!;
  assert.ok(q, "the relevant-but-absent term reaches questions[]");
  assert.match(q.question, /Plausible:/);
  assert.match(q.question, /Why it matters:/);
  assert.ok(q.proposed_phrasing, "the question proposes a line the user can confirm");
  assert.ok(q.evidence_hint?.startsWith("cv-source.md:"));

  // 4. a taxonomy term irrelevant to this positioning stays foreign but is never silent
  const sf = p.terms.find((t) => t.term === "Salesforce")!;
  assert.equal(sf.status, "foreign", "platforms is not mapped to the ai-developer positioning");
  const gap = p.gaps.find((g) => g.term === "Salesforce")!;
  assert.ok(gap, "an irrelevant absent taxonomy term is listed in gaps[]");
  assert.equal(gap.source, "taxonomy");
  assert.equal(gap.taxonomy_group, "platforms");
  assert.match(gap.reason, /not relevant to the ai-developer positioning/);
  assert.ok(((summarise(p) as any).gaps as string[]).some((g) => g.startsWith("Salesforce")), "gaps are printed in the summary");
  assert.ok(!p.questions.some((x) => x.term === "Salesforce"), "an irrelevant absent term is reported, not asked");

  // 5. the SAME absent entry is asked for a positioning its group is mapped to
  const saPlan = buildKeywordPlan({ ctx: ctx({ ...aiCtx, resumeId: "solution-architect" }), proactive: true });
  assert.equal(saPlan.terms.find((t) => t.term === "Salesforce")?.status, "needs_confirmation",
    "platforms IS mapped to solution-architect, so the same absent entry becomes a question");
  assert.ok(!saPlan.gaps.some((g) => g.term === "Salesforce"), "and it leaves the gap list");
}

// --- term-grounding honours the plan -----------------------------------------------
{
  const content: ResumeContent = {
    ...composition,
    skills: [
      { name: "Core competencies", role: "screener", bullets: ["M365, ServiceNow ESM, Mulesoft"] },
      { name: "Methods", bullets: ["Familiar with Lean delivery practices", "Delivered ITIL service transition"] },
    ],
    experiences: [
      { placement: "feature", title: "Solution Architect", company: "Example Agency", start: "2022-01", end: "present", bullets: ["Delivered Salesforce Sales Cloud rollout across two squads."] } as any,
    ],
  } as any;
  const jdText = "Must have Salesforce Sales Cloud, M365, ServiceNow ESM, ITIL, Lean.";
  const noPlan = runTermGrounding({ content, cvSource, profileMd, jdText });
  assert.ok(noPlan.stats.jd_injected_terms.includes("m365"), "without a plan, the JD's acronym form of a corpus fact is (wrongly) flagged");

  const p: KeywordPlan = buildKeywordPlan({ ctx: ctx(), jdText });
  const m365 = p.terms.find((t) => t.term === "M365")!;
  assert.equal(m365.status, "alias_grounded");
  assert.ok(termForms(m365).includes("m365"));

  const withPlan = runTermGrounding({ content, cvSource, profileMd, jdText, plan: p, planPath: "/tmp/plan.json" });
  assert.ok(!withPlan.stats.jd_injected_terms.includes("m365"), "plan whitelists the JD form of an alias-grounded fact");
  assert.ok(withPlan.stats.allowed_by_plan.includes("M365"));
  assert.ok(withPlan.stats.unconfirmed_terms.some((t) => /salesforce/.test(t)), "needs_confirmation term rendered as a claim hard-fails");
  assert.ok(withPlan.stats.unconfirmed_terms.includes("itil"), "preppable/confirm term outside familiarity framing fails");
  assert.ok(withPlan.stats.familiarity_framed_terms.includes("lean"), "preppable term under familiarity framing is a warn");
  assert.ok(!withPlan.stats.unconfirmed_terms.includes("lean"));
  assert.equal(withPlan.verdict, "fail");

  // a `render_as: "familiarity"` term is accepted in a familiarity-framed skills
  // item ("Prepared on ..." included), and hard-fails as a delivered-work bullet
  const famPlan: KeywordPlan = buildKeywordPlan({
    ctx: ctx({ confirmations: [{ resume_id: "solution-architect", kind: "keyword", signal: "Salesforce", status: "familiarity" }] }),
    jdText: jdText,
  });
  assert.equal(famPlan.terms.find((t) => t.term === "Salesforce")!.render_as, "familiarity");
  const framedContent: ResumeContent = {
    ...content,
    skills: [
      { name: "Core competencies", role: "screener", bullets: ["M365, ServiceNow ESM, Mulesoft"] },
      { name: "Methods", bullets: ["Familiar with Lean delivery practices", "Prepared on Salesforce Sales Cloud"] },
    ],
    experiences: [
      { placement: "feature", title: "Solution Architect", company: "Example Agency", start: "2022-01", end: "present", bullets: ["Led ServiceNow ESM design."] } as any,
    ],
  } as any;
  const framed = runTermGrounding({ content: framedContent, cvSource, profileMd, jdText, plan: famPlan });
  assert.ok(framed.stats.familiarity_framed_terms.includes("salesforce"), "\"Prepared on ...\" is familiarity framing");
  assert.ok(!framed.stats.unconfirmed_terms.includes("salesforce"));
  assert.ok(framed.flags.filter((f) => f.term === "salesforce").every((f) => f.severity === "warn"));

  const asWork = runTermGrounding({
    content: { ...framedContent, skills: [{ name: "Methods", bullets: ["Delivered Salesforce Sales Cloud rollout"] }] } as any,
    cvSource, profileMd, jdText, plan: famPlan,
  });
  assert.ok(asWork.stats.unconfirmed_terms.includes("salesforce"), "the same term as delivered work still hard-fails");
  assert.equal(asWork.verdict, "fail");
}

// --- alias groups: an acronym and its expansion are ONE question ---------------------
{
  const bpmJd = `# Process Architect — Sydney

**You bring:**
- Deep Business Process Management (BPM) delivery experience in government.
- BPM tooling ownership and BPM governance across programmes.
`;
  const p = buildKeywordPlan({ ctx: ctx(), jdText: bpmJd, jdTitle: "Process Architect" });
  const acr = p.terms.find((t) => t.term === "BPM")!;
  const exp = p.terms.find((t) => t.term === "Business Process Management")!;
  assert.ok(acr && exp, "both forms stay in terms[] so each is individually classifiable");
  assert.ok(acr.alias_group, "acronym carries an alias_group id");
  assert.equal(acr.alias_group, exp.alias_group, "expansion shares the acronym's alias_group");
  assert.ok(acr.aliases.map((a) => a.toLowerCase()).includes("business process management"));
  assert.ok(exp.aliases.map((a) => a.toLowerCase()).includes("bpm"));

  const asked = p.questions.filter((q) => q.alias_group === acr.alias_group);
  assert.equal(asked.length, 1, "one question for the pair, not one per form");
  const q = asked[0];
  assert.equal(q.term, "BPM", "the JD's primary (most-used) form leads the question");
  assert.deepEqual(q.aliases, ["Business Process Management"]);
  assert.match(q.question, /BPM \(Business Process Management\)/, "question covers both forms");
  assert.match(q.proposed_phrasing ?? "", /BPM \(Business Process Management\)/, "proposed line covers both forms");
  assert.ok(!p.questions.some((x) => x !== q && x.alias_group === acr.alias_group));

  // the pair is one must-have, not two
  const ids = new Set(p.terms.filter((t) => t.must_have).map((t) => t.alias_group ?? t.term.toLowerCase()));
  assert.equal(p.coverage.must_have_total, ids.size);
  assert.ok(acr.must_have && exp.must_have, "both forms are still must-haves individually");
  const ungrouped = buildKeywordPlan({ ctx: ctx(), jdText: bpmJd, jdTitle: "Process Architect" })
    .terms.filter((t) => t.must_have).length;
  assert.ok(p.coverage.must_have_total < ungrouped, "grouping collapses the double count");
}

// --- alias groups: taxonomy synonyms (Salesforce / SFDC) merge too ---------------------
{
  const sfJd = `# Platform Architect

**You bring:**
- Strong Salesforce delivery across regulated clients.
- SFDC configuration and release ownership.
`;
  const p = buildKeywordPlan({ ctx: ctx(), jdText: sfJd, jdTitle: "Platform Architect" });
  const sf = p.terms.find((t) => t.term === "Salesforce")!;
  const sfdc = p.terms.find((t) => t.term === "SFDC")!;
  assert.equal(sf.status, "needs_confirmation");
  assert.equal(sfdc.status, "needs_confirmation");
  assert.ok(sf.alias_group && sf.alias_group === sfdc.alias_group, "taxonomy synonyms share an alias_group");
  const asked = p.questions.filter((q) => q.alias_group === sf.alias_group);
  assert.equal(asked.length, 1, "one question for the taxonomy synonym pair");
  assert.ok(asked[0].aliases.length >= 1);
  assert.match(asked[0].question, /Salesforce/);
  assert.match(asked[0].question, /SFDC/);
}

// terms outside any alias group keep a null alias_group and their own question
{
  assert.equal(byTerm.get("salesforce")?.alias_group, null);
  assert.ok(plan.questions.some((q) => q.term === "Salesforce" && q.aliases.length === 0));
}

// extractCandidates ignores markdown title line + noise spans
{
  const cands = extractCandidates("# Solutions Architect — Agency\n\nPayrate: $1000\nWorking Arrangements: Hybrid\n", ctx());
  assert.ok(!cands.some((c) => /Working Arrangements|Payrate/i.test(c.term)));
}

console.log("resume-keywords tests passed");
