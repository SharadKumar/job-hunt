/**
 * resume-term-grounding.test.ts — the keyword-plan index must never hard-fail
 * on ordinary delivery English.
 *
 * Regression (2026-09-11): multi-word plan terms with status preppable /
 * needs_confirmation / pending / foreign / declined were split into >=3-char
 * tokens, so "and", "for", "code", "architecture" and "management" landed in
 * the hard-fail sets and produced 150-200 false `unconfirmed_term` /
 * `jd_injected` flags on a single CV.
 *
 * Contract now: token-splitting applies ONLY to `allowed` (grounded / alias /
 * confirmed forms, which can only SUPPRESS a flag). The preppable and
 * unconfirmed indexes hold whole normalised forms plus aliases, matched as
 * whole phrases, and never fire on a STOPWORDS token.
 */

import assert from "node:assert/strict";
import { runTermGrounding } from "../tools/resume/resume-term-grounding.ts";
import type { KeywordPlan, KeywordTerm } from "../tools/resume/keyword-lexicon.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";

const term = (over: Partial<KeywordTerm> & { term: string; status: KeywordTerm["status"] }): KeywordTerm => ({
  jd_form: over.term,
  corpus_form: null,
  aliases: [],
  category: "concept",
  must_have: false,
  render_as: null,
  ...over,
}) as KeywordTerm;

const plan: KeywordPlan = {
  terms: [
    term({ term: "Teams voice or endpoint management specialist", status: "foreign" }),
    term({ term: "eval rubrics and golden datasets", status: "preppable" }),
  ],
} as KeywordPlan;

const CORPUS = `
Led delivery of claims platforms and managed vendor architecture for insurers.
Built evaluation harnesses with rubrics for model scoring.
`;

const content = (bullets: string[], summary = "Delivery lead."): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  summary,
  highlights: bullets,
  skills: [],
  credentials: [],
  experiences: [],
  resumeId: "test",
}) as ResumeContent;

const run = (c: ResumeContent) =>
  runTermGrounding({ content: c, cvSource: CORPUS, profileMd: "", plan, planPath: "plan.json" });

// ---- constituent tokens of a flagging term never flag ---------------------
const innocuous = run(
  content([
    "Ran delivery and vendor management across the claims architecture.",
    "Published rubrics for the quarterly review.",
    "Owned the code review standards for the platform team.",
  ]),
);
// (The generic `ungrounded` warn path is unchanged and out of scope here; the
// defect was single tokens reaching the HARD-FAIL buckets.)
const badTokens = innocuous.flags.filter(
  (f) => f.severity === "fail" &&
    ["and", "for", "code", "architecture", "management", "rubrics", "teams", "specialist", "voice", "endpoint", "eval", "golden", "datasets"].includes(f.term),
);
assert.deepEqual(badTokens, [], `no single token of a plan phrase may hard-fail: ${JSON.stringify(badTokens)}`);
assert.equal(
  innocuous.stats.unconfirmed_terms.length,
  0,
  `ordinary delivery English produced unconfirmed_term flags: ${JSON.stringify(innocuous.stats.unconfirmed_terms)}`,
);
console.log("  ✓ constituent tokens of preppable / foreign phrases never hard-fail");

// ---- the whole foreign phrase in a claim field still fails ----------------
const foreign = run(content(["Teams voice or endpoint management specialist for a national insurer."]));
assert.equal(foreign.verdict, "fail", "the whole foreign phrase must still fail");
assert.ok(
  foreign.flags.some((f) => f.bucket === "unconfirmed_term" && f.term === "teams voice or endpoint management specialist"),
  `expected the whole foreign phrase to be flagged: ${JSON.stringify(foreign.flags)}`,
);
console.log("  ✓ the whole foreign phrase is still an unconfirmed_term fail");

// ---- preppable: fails unframed, warns under familiarity framing -----------
const unframed = run(content(["Built eval rubrics and golden datasets for the agent platform."]));
assert.equal(unframed.verdict, "fail", "a preppable phrase in a claim field must fail");
assert.ok(
  unframed.flags.some((f) => f.bucket === "unconfirmed_term" && f.term === "eval rubrics and golden datasets"),
  "the preppable phrase fails when it is not familiarity-framed",
);

const framed = run(content(["Working knowledge of eval rubrics and golden datasets."]));
assert.ok(
  framed.flags.some((f) => f.bucket === "familiarity_framed" && f.severity === "warn"),
  "a familiarity-framed preppable phrase is a warn, not a fail",
);
assert.ok(
  !framed.flags.some((f) => f.severity === "fail" && f.term === "eval rubrics and golden datasets"),
  "a familiarity-framed preppable phrase must not hard-fail",
);
console.log("  ✓ preppable phrases fail unframed and warn when familiarity-framed");

// ---- a plan term that is pure generic vocabulary can never flag -----------
const genericPlan: KeywordPlan = { terms: [term({ term: "delivery management", status: "needs_confirmation" })] } as KeywordPlan;
const generic = runTermGrounding({
  content: content(["Owned delivery management for the claims programme."]),
  cvSource: CORPUS,
  profileMd: "",
  plan: genericPlan,
  planPath: "plan.json",
});
assert.equal(
  generic.stats.unconfirmed_terms.length,
  0,
  "a plan form made entirely of STOPWORDS vocabulary must never drive a flag",
);
console.log("  ✓ an all-stopword plan form never drives a flag");

console.log("resume-term-grounding: OK");
