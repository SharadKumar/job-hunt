#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Fixture repo in a temp dir. tools/repo-root.ts honours HARNESS_REPO_ROOT, and
// resumes.ts computes its default paths at import time, so set this BEFORE the
// dynamic imports below.
const root = mkdtempSync(path.join(tmpdir(), "resume-index-test-"));
process.env.HARNESS_REPO_ROOT = root;
delete process.env.HARNESS_PROFILE;

const profileDir = path.join(root, "state", "profile");
const resumesDir = path.join(profileDir, "resumes");

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

write("state/profile/profile.md", `---
name: Example Person
email: person@example.com
---

Body.
`);

write("state/profile/cv-source.md", "# CV source\n");
write("state/profile/editorial-bans.yaml", "bans: []\n");
write("state/journal/2026-01-02.md", "journal\n");

function resumeYamlEntry(id: string, label: string, active: boolean, template: string): string {
  return `  - id: ${id}
    label: ${label}
    active: ${active}
    template: ${template}
    page_policy:
      target_pages: 2
      hard_max: 2
    search_keywords: [alpha]
    should: [thing]
    could: [other]
    flagged: [nope]
    cover_letter_angle: An angle.
    rate_band:
      floor: 1
      target: 2
      ceiling: 3
      currency: AUD
      billing_unit: day
      gst_handling: excl
    preferred_channels: [seek]
`;
}

write("state/profile/resumes.yaml", `resumes:
${resumeYamlEntry("alpha-resume", "Alpha Positioning", true, "modern")}${resumeYamlEntry("beta-resume", "Beta Positioning", false, "classic")}${resumeYamlEntry("gamma-resume", "Gamma Positioning", false, "classic")}${resumeYamlEntry("delta-resume", "Delta Positioning", false, "classic")}${resumeYamlEntry("epsilon-resume", "Epsilon Positioning", false, "classic")}${resumeYamlEntry("zeta-resume", "Zeta Positioning", false, "classic")}`);

// --- alpha: fully rendered, audited, approved -------------------------------
const alphaPrefix = "Example-Person_Alpha-Positioning";
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.pdf`, "%PDF-1.4 fixture\n");
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.docx`, "docx fixture");
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.html`, "<html></html>");
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.md`, "# md fixture");
write(`state/profile/resumes/alpha-resume/${alphaPrefix}-page-1.png`, "png-1");
write(`state/profile/resumes/alpha-resume/${alphaPrefix}-page-2.png`, "png-2");
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.audit.json`, JSON.stringify({
  verdict: "warn",
  resume: "alpha-resume",
  template: "modern",
  timings_ms: { total: 1425 },
  pages: { count: 2, target: 2, fills: [88.1, 94.6], last_page_fill_pct: 94.6, min_last_page_fill_pct: 75 },
  failing_units: [],
  failing_units_total: 0,
  gates: {
    evaluate: "pass",
    provenance: { verdict: "pass", fail_count: 0 },
    ats: { verdict: "pass", issues: [] },
    term_grounding: { verdict: "warn", ungrounded_count: 7 },
  },
  keyword_coverage: {
    must_have_total: 10,
    must_have_renderable: 9,
    must_have_surfaced: 7,
    must_have_unsurfaced: [{ term: "kappa" }, { term: "lambda" }, { term: "mu" }],
    renderable_pct: 70,
    surfaced_pct: 100,
    verdict: "pass",
  },
  cycles: 3,
  ats_composite: 91,
  warnings: ["one warning"],
  generated_at: "2026-01-02T03:04:05.000Z",
}));
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.composition.json`, JSON.stringify({
  headline: "Alpha",
  experiences: [
    { placement: "feature", title: "A" },
    { placement: "feature", title: "B" },
    { placement: "mention", title: "C" },
  ],
  dropped_experiences: [{ title: "D" }],
}));
write(`state/profile/resumes/alpha-resume/${alphaPrefix}.provenance.json`, JSON.stringify({
  unsupported_claims: [{ claim: "one" }],
}));
write("state/profile/resumes/alpha-resume/keyword-plan.json", JSON.stringify({
  coverage: { surfaced_pct: 100, renderable_pct: 70 },
  questions: [{ term: "x" }, { term: "y" }],
  verdict: "pass",
}));
write("state/profile/resumes/alpha-resume/metadata.json", JSON.stringify({
  resume_id: "alpha-resume",
  template: "modern",
  content_hash: "hash-1",
  approved_hash: "hash-1",
  approved_at: "2026-01-03T00:00:00.000Z",
  approval_status: "approved",
}));

// --- beta: rendered but never audited, approval gone stale ------------------
const betaPrefix = "Example-Person_Beta-Positioning";
write(`state/profile/resumes/beta-resume/${betaPrefix}.pdf`, "%PDF-1.4 fixture beta\n");
write(`state/profile/resumes/beta-resume/${betaPrefix}.md`, "# beta md");
write("state/profile/resumes/beta-resume/metadata.json", JSON.stringify({
  resume_id: "beta-resume",
  content_hash: "hash-2",
  approved_hash: "hash-1",
  approved_at: "2025-12-01T00:00:00.000Z",
  approval_status: "approved",
}));

// --- gamma: rendered, never approved (no metadata.json at all) --------------
const gammaPrefix = "Example-Person_Gamma-Positioning";
write(`state/profile/resumes/gamma-resume/${gammaPrefix}.pdf`, "%PDF-1.4 fixture gamma\n");
write(`state/profile/resumes/gamma-resume/${gammaPrefix}-page-1.png`, "png-1");

write(`state/profile/resumes/gamma-resume/${gammaPrefix}.audit.json`, JSON.stringify({
  verdict: "warn",
  resume: "gamma-resume",
  pages: { count: 1, target: 2, fills: [96.2], last_page_fill_pct: 96.2, min_last_page_fill_pct: 75 },
  failing_units: [],
  failing_units_total: 0,
  // non-unit rubric issues: two rules, each raised twice
  issues: [
    { rule: "skills_bullets_per_block", severity: "warn", detail: "skill 'Delivery' bullets 6 above max 5" },
    { rule: "skills_bullets_per_block", severity: "warn", detail: "skill 'Vendors' bullets 6 above max 5" },
    { rule: "featured_bullet_count", severity: "warn", detail: "Delivery Manager bullets 8 above max 7" },
    { rule: "featured_bullet_count", severity: "warn", detail: "Principal Consultant bullets 8 above max 7" },
  ],
  gates: {
    evaluate: "warn",
    provenance: { verdict: "warn", fail_count: 0, missing: [] },
    ats: { verdict: "warn", issues: [{ rule: "date_format", detail: "two dates use a slash" }] },
    term_grounding: { verdict: "warn", ungrounded_count: 20, unconfirmed_terms: [{ term: "kappa" }, { term: "mu" }], jd_injected: [] },
    preserve: { verdict: "warn", fail_count: 0, warn_count: 1, issues: [], stats: { featured: 8, mentioned: 12, dropped_with_reason: 4, unaccounted: [{ title: "Q" }], unsourced: [] } },
    editorial: { verdict: "warn", fail_count: 0, warn_count: 1, issues: [{ rule: "banned_phrase", severity: "warn", detail: "spearheaded" }] },
  },
  // a proactive plan: nothing is a must-have, so coverage counts renderable terms
  keyword_coverage: {
    must_have_total: 0,
    must_have_renderable: 0,
    must_have_surfaced: 0,
    must_have_unsurfaced: [],
    renderable_total: 38,
    surfaced_total: 31,
    renderable_pct: 100,
    surfaced_pct: 100,
    verdict: "pass",
  },
  provenance: { verdict: "warn", issues: [], stats: { fail_count: 0, warn_count: 4, weak_citations: 4, number_unsupported: 2, unsupported_claims: 0 } },
  generated_at: "2026-01-04T00:00:00.000Z",
}));
// gamma has been reviewed and the reviewer wants changes: the eighth mark is a
// warn whose reason is the summary sentence, and the open findings get words.
write(`state/profile/resumes/gamma-resume/${gammaPrefix}.critic.json`, JSON.stringify({
  resume: "gamma-resume",
  verdict: "revise",
  round: 1,
  generated_at: "2026-01-02T03:04:05.000Z",
  composition_hash: "deadbeef",
  summary_sentence: "Two bullets in the current role say the same thing.",
  findings: [
    { id: "f1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", why: "second lap on the same fact", proposed_edit: "delete" },
    { id: "f2", kind: "register", severity: "warn", unit_path: "summary", why: "reads like a job advert", proposed_edit: "" },
  ],
  rounds: [],
}));

write("state/profile/resumes/gamma-resume/keyword-plan.json", JSON.stringify({
  coverage: { must_have_total: 0, renderable_total: 38, surfaced_total: 0, renderable_pct: 100, surfaced_pct: 0 },
  questions: [],
  verdict: "pass",
  // Two keyword clouds, heaviest first, so Coverage reads cloud by cloud.
  clouds: [
    { id: "tooling-cloud", kind: "tooling", label: "Tooling", weight: 3, total: 16, renderable: 13, surfaced: 6, familiarity: 0, questions: 0 },
    { id: "delivery-cloud", kind: "capability", label: "Delivery", weight: 5, total: 25, renderable: 25, surfaced: 25, familiarity: 0, questions: 0 },
  ],
  // 38 renderable terms (grounded / alias_grounded / confirmed) and 3 foreign ones;
  // 31 of them surfaced: all 25 in delivery-cloud, 6 of the 16 in tooling-cloud.
  terms: [
    ...Array.from({ length: 20 }, (_v, i) => ({ term: `grounded-${i}`, status: "grounded", cloud_id: "delivery-cloud", surfaced_in: ["summary"] })),
    ...Array.from({ length: 5 }, (_v, i) => ({ term: `alias-${i}`, status: "alias_grounded", cloud_id: "delivery-cloud", surfaced_in: ["summary"] })),
    ...Array.from({ length: 5 }, (_v, i) => ({ term: `alias-${i + 5}`, status: "alias_grounded", cloud_id: "tooling-cloud", surfaced_in: ["summary"] })),
    { term: "confirmed-0", status: "confirmed", cloud_id: "tooling-cloud", surfaced_in: ["summary"] },
    ...Array.from({ length: 7 }, (_v, i) => ({ term: `confirmed-${i + 1}`, status: "confirmed", cloud_id: "tooling-cloud", surfaced_in: [] })),
    ...Array.from({ length: 3 }, (_v, i) => ({ term: `foreign-${i}`, status: "foreign", cloud_id: "tooling-cloud", surfaced_in: [] })),
  ],
}));

// --- epsilon: approved once, rebuilt since, with one warn worth naming -------
const epsilonPrefix = "Example-Person_Epsilon-Positioning";
write(`state/profile/resumes/epsilon-resume/${epsilonPrefix}.pdf`, "%PDF-1.4 fixture epsilon\n");
write(`state/profile/resumes/epsilon-resume/${epsilonPrefix}-page-1.png`, "png-1");
write(`state/profile/resumes/epsilon-resume/${epsilonPrefix}.audit.json`, JSON.stringify({
  verdict: "warn",
  pages: { count: 1, target: 1, fills: [97.4], last_page_fill_pct: 97.4, min_last_page_fill_pct: 90 },
  failing_units: [],
  failing_units_total: 0,
  issues: [],
  gates: {
    evaluate: "pass",
    provenance: { verdict: "warn", fail_count: 0, missing: [], stats: { fail_count: 0, warn_count: 4, weak_citations: 4, number_unsupported: 0, unsupported_claims: 0 } },
    ats: { verdict: "pass", issues: [] },
  },
  generated_at: "2026-01-05T00:00:00.000Z",
}));
write("state/profile/resumes/epsilon-resume/metadata.json", JSON.stringify({
  resume_id: "epsilon-resume",
  content_hash: "hash-9",
  approved_hash: "hash-8",
  approved_at: "2025-12-01T00:00:00.000Z",
  approval_status: "approved",
}));

// --- zeta: a proactive plan beside the composition it was rendered into -----
// This is what `resume:keywords --proactive` actually leaves on disk: it runs
// BEFORE the render, so every term carries `surfaced_in: []` and every cloud a
// surfaced count of 0. The binder has to replay the plan against the
// composition, exactly as the audit does, or every count reads 0.
const zetaPrefix = "Example-Person_Zeta-Positioning";
write(`state/profile/resumes/zeta-resume/${zetaPrefix}.pdf`, "%PDF-1.4 fixture zeta\n");
write(`state/profile/resumes/zeta-resume/${zetaPrefix}-page-1.png`, "png-1");
write(`state/profile/resumes/zeta-resume/${zetaPrefix}.composition.json`, JSON.stringify({
  headline: "Zeta",
  summary: "Event streaming across the group.",
  highlights: ["Ran the platform.", "Cut the change lead time.", "Held the on-call."],
  skills: [
    { name: "Platform", role: "screener", summary: "Kubernetes estates and event streaming.", bullets: ["Kubernetes", "Event streaming", "Delivery"] },
    { name: "Delivery", bullets: ["Planning"] },
    { name: "Data", bullets: ["Modelling"] },
  ],
  experiences: [
    { placement: "feature", title: "Lead", company: "Acme", start: "2021-01", end: "current", summary: "Ran event streaming.", bullets: ["Ran Kubernetes clusters.", "Shipped weekly.", "Held the roadmap."] },
    { placement: "mention", title: "Consultant", company: "Beta Co", one_liner: "Advised on delivery." },
  ],
  dropped_experiences: [],
}));
const zetaTerm = (term: string, extra: Record<string, unknown>) => ({
  term, jd_form: term, corpus_form: term, aliases: [], category: "capability",
  must_have: false, status: "grounded", render_as: null, source_update_required: false,
  surfaced_in: [], alias_group: null, cloud_kind: "capability", ...extra,
});
write("state/profile/resumes/zeta-resume/keyword-plan.json", JSON.stringify({
  title: { jd_title: null, title_family: null, alignment: "unknown", reason: "no JD title supplied" },
  coverage: { must_have_total: 4, must_have_renderable: 4, must_have_surfaced: 0, renderable_total: 5, surfaced_total: 0, familiarity_total: 1, renderable_pct: 100, surfaced_pct: 0 },
  questions: [],
  warnings: [],
  screener_surface: {},
  verdict: "pass",
  clouds: [
    { id: "tooling", kind: "tooling", label: "Tooling", weight: 2, total: 3, renderable: 2, surfaced: 0, familiarity: 0, questions: 0 },
    { id: "platform", kind: "capability", label: "Platform", weight: 5, total: 4, renderable: 3, surfaced: 0, familiarity: 1, questions: 0 },
  ],
  terms: [
    zetaTerm("event streaming", { cloud_id: "platform", must_have: true }),
    zetaTerm("domain-driven design", { cloud_id: "platform", must_have: true }),
    zetaTerm("chaos engineering", { cloud_id: "platform", status: "preppable", render_as: "familiarity" }),
    zetaTerm("mainframe", { cloud_id: "platform", status: "foreign" }),
    zetaTerm("kubernetes", { cloud_id: "tooling", must_have: true }),
    zetaTerm("terraform", { cloud_id: "tooling", must_have: true }),
    zetaTerm("cobol", { cloud_id: "tooling", status: "foreign" }),
    // Taxonomy and lexicon rows belong to no cloud. They still have to be
    // counted, or the chip groups undercount the summary sentence.
    zetaTerm("roadmap", {}),
    zetaTerm("observability", {}),
    zetaTerm("cics", { status: "foreign" }),
    // Confirmed, but the source does not carry it yet: the plan does not count
    // this as renderable, so neither may the chips.
    zetaTerm("service mesh", { status: "confirmed", source_update_required: true }),
  ],
}));

// --- delta: declared in resumes.yaml, nothing rendered on disk --------------
// (no files at all)

// An approval is an approval of the artefacts as they stood: backdate alpha's
// audit and composition so they read as older than its approved_at, which is
// what a real approved render looks like.
const backdated = new Date("2026-01-02T00:00:00.000Z");
for (const rel of [
  `state/profile/resumes/alpha-resume/${alphaPrefix}.audit.json`,
  `state/profile/resumes/alpha-resume/${alphaPrefix}.composition.json`,
]) {
  utimesSync(path.join(root, rel), backdated, backdated);
}

const { buildResumeIndexModel, renderResumeIndexHtml, writeResumeIndex, relativeLink, pdfSrcFor, nextMove, summariseIssues } = await import("../tools/resume/resume-index.ts");

// unknown rule ids still say something: the id, in words
assert.equal(summariseIssues([{ rule: "heading_orphan", severity: "warn", detail: "" }]), "one heading orphan");
assert.equal(
  summariseIssues([{ rule: "featured_bullet_count", severity: "warn", detail: "X bullets 2 below min 3" }]),
  "one role one bullet under floor",
);

const model = await buildResumeIndexModel();
assert.equal(model.profileName, "Example Person");
assert.equal(model.cards.length, 6, "one card per resume entry");
assert.equal(model.cards[0].id, "alpha-resume", "active resume sorts first");
assert.equal(model.cards[1].id, "beta-resume");

const alpha = model.cards[0];
assert.equal(alpha.active, true);
assert.equal(alpha.template, "modern");
assert.equal(alpha.status, "approved");
assert.equal(alpha.statusDate, "2026-01-03");
assert.deepEqual(alpha.audit?.fills, [88.1, 94.6]);
assert.equal(alpha.audit?.cycles, 3);
assert.equal(alpha.audit?.ats_composite, 91);
assert.deepEqual(
  alpha.audit?.gates.map((g) => `${g.name}:${g.verdict}`),
  ["evaluate:pass", "provenance:pass", "ats:pass", "term_grounding:warn"],
);
assert.equal(alpha.audit?.gates[3].reason, "seven generic words only, nothing invented");
assert.deepEqual(alpha.featuredRoles.map((r) => r.title), ["A", "B"]);
assert.deepEqual(alpha.openQuestions, ["x", "y"]);
assert.equal(alpha.warnCount, 2, "one warn gate + one audit warning");
assert.equal(alpha.failCount, 0);
assert.deepEqual(alpha.counts, { featured: 2, mentioned: 1, dropped: 1, unsupported_claims: 1 });
assert.equal(alpha.pngs.length, 2);
assert.equal(alpha.pdfPageCount, 2);
// pages carry their fill and the floor each answers to: 90 everywhere, the
// resume's own last-page floor on the last page
assert.equal(alpha.pages.length, 2);
assert.deepEqual(alpha.pages.map((p) => p.threshold), [90, 75]);
assert.deepEqual(alpha.pages.map((p) => p.low), [true, false], "page one misses the 90 percent floor");
// the tick row is always the same eight marks, in the same order. The eighth,
// Review, is the resume-critic's verdict, and it is `skip` until a review exists.
assert.deepEqual(
  alpha.checks.map((c) => `${c.key}:${c.verdict}`),
  ["evaluate:pass", "provenance:pass", "ats:pass", "term_grounding:warn", "preserve:skip", "editorial:skip", "keyword_coverage:pass", "critic:skip"],
);
assert.equal(alpha.stamp.kind, "approved");
assert.ok(/^Approved 3 Jan/.test(alpha.stamp.text), alpha.stamp.text);
// one dot per must-have term, split surfaced / renderable / not renderable
assert.equal(alpha.keywordDots.length, 10);
assert.equal(alpha.keywordDots.filter((d) => d.state === "surfaced").length, 7);
assert.equal(alpha.keywordDots.filter((d) => d.state === "renderable").length, 2);
assert.equal(alpha.keywordDots.filter((d) => d.state === "absent").length, 1);
assert.equal(alpha.keywordDots[7].term, "kappa", "unsurfaced terms are named from the audit");
assert.ok(alpha.mtimes.audit && alpha.mtimes.composition, "artefact mtimes are read");
assert.ok(alpha.links.pdf && alpha.links.docx && alpha.links.html && alpha.links.md);
assert.ok(alpha.links.audit && alpha.links.composition && alpha.links.provenance && alpha.links.keyword_plan && alpha.links.metadata);
assert.equal(alpha.links.audit, `alpha-resume/${alphaPrefix}.audit.json`);
assert.equal(alpha.links.md, `alpha-resume/${alphaPrefix}.md`, "md link must not be the composition sidecar");

const beta = model.cards[1];
assert.equal(beta.active, false);
assert.equal(beta.audit, null, "beta has no audit.json");
assert.equal(beta.status, "stale", "approved_hash diverged from content_hash");
assert.equal(beta.keywordPlan, null);
assert.equal(beta.links.docx, null);
assert.equal(beta.pngs.length, 0);
assert.equal(beta.stamp.kind, "stale");
assert.equal(beta.stamp.text, "Stale, rebuilt after approval");
assert.deepEqual(beta.checks.map((c) => c.verdict), new Array(8).fill("skip"), "no audit means every mark is a skip");

const gamma = model.cards.find((c) => c.id === "gamma-resume")!;
assert.equal(gamma.status, "fresh");
assert.equal(gamma.stamp.text, "Not approved");
// a plan with no must-haves counts its renderable terms instead of drawing nothing
assert.equal(gamma.keywordDotKind, "renderable");
assert.equal(gamma.keywordDots.length, 38, "38 renderable terms, the 3 foreign ones left out");
assert.equal(gamma.keywordDots.filter((d) => d.state === "surfaced").length, 31);
assert.equal(gamma.keywordDots.filter((d) => d.state === "absent").length, 0);
// Coverage is per cloud now: heaviest first, every plan term in its own cloud's row.
assert.deepEqual(gamma.keywordClouds.map((c) => [c.id, c.weight, c.surfaced, c.total]), [
  ["delivery-cloud", 5, 25, 25],
  ["tooling-cloud", 3, 6, 16],
]);
assert.equal(gamma.keywordClouds[1].dots.filter((d) => d.state === "absent").length, 3, "foreign terms are absent dots, not dropped");
// A plan predating clouds keeps the single undifferentiated row.
assert.deepEqual(model.cards.find((c) => c.id === "alpha-resume")!.keywordClouds, []);
assert.equal(gamma.checks.find((c) => c.key === "keyword_coverage")?.reason, null, "a pass leaves the count to the dots");

// --- zeta: the plan replayed against the composition ------------------------
// Nothing in the plan on disk says a term surfaced. Everything the rows report
// comes from applying the plan to the composition, the audit's own method.
const zeta = model.cards.find((c) => c.id === "zeta-resume")!;
assert.deepEqual(zeta.keywordClouds.map((c) => [c.id, c.weight, c.surfaced, c.renderable, c.total]), [
  ["platform", 5, 1, 3, 4],
  ["tooling", 2, 1, 2, 3],
  // CHANGED: terms carrying no cloud_id used to be dropped from every row, so
  // the chip groups undercounted the summary sentence. They now close the list
  // as one weightless row, heaviest clouds first and this one last.
  ["other", 0, 1, 2, 4],
], "counts come from the applied plan, not the pre-render zeros");
assert.equal(zeta.keywordClouds[2].label, "Other market terms");
assert.deepEqual(zeta.keywordClouds[2].terms.surfaced, ["roadmap"]);
assert.deepEqual(zeta.keywordClouds[2].terms.renderable, ["observability"]);
assert.deepEqual(zeta.keywordClouds[2].terms.absent, ["cics", "service mesh"],
  "a confirmed term the source has not caught up with is not yet renderable");
const platform = zeta.keywordClouds[0];
assert.deepEqual(platform.terms.surfaced, ["event streaming"], "only the term the composition carries surfaced");
assert.deepEqual(platform.terms.renderable, ["domain-driven design", "chaos engineering (familiarity)"]);
assert.deepEqual(platform.terms.absent, ["mainframe"]);
assert.equal(platform.familiarity, 1);
assert.deepEqual(zeta.keywordClouds[1].terms.surfaced, ["kubernetes"], "a skills bullet counts as surfacing");
assert.deepEqual(zeta.keywordClouds[1].terms.renderable, ["terraform"]);
assert.equal(zeta.keywordPlan?.surfaced_total, 3, "three of the seven source-backed terms landed");
assert.equal(zeta.keywordPlan?.renderable_total, 7);
assert.equal(zeta.keywordPlan?.familiarity_total, 1);
assert.equal(zeta.keywordPlan?.must_have_surfaced, 2);
assert.equal(zeta.keywordPlan?.must_have_renderable, 4);
assert.equal(
  zeta.checks.find((c) => c.key === "keyword_coverage")?.reason,
  "2 of 4 must-have terms surfaced, plus 1 as familiarity",
  "the Keywords check counts the applied plan's facts",
);
// every check names its issue, and no reason runs past the cap
const gammaReason = (key: string) => gamma.checks.find((c) => c.key === key)?.reason ?? "";
assert.equal(gammaReason("evaluate"), "two skill blocks one item over cap; two roles one bullet over cap");
assert.equal(gammaReason("provenance"), "4 weak citations; 2 numbers not in cited lines");
assert.equal(gammaReason("ats"), "two dates use a slash");
assert.equal(gammaReason("term_grounding"), "twenty generic words only, nothing invented; 2 unconfirmed");
assert.equal(gammaReason("preserve"), "1 unaccounted role");
assert.equal(gammaReason("editorial"), "rule matched: banned_phrase");
for (const check of gamma.checks) {
  assert.ok((check.reason ?? "").length <= 90, `reason over 90 characters: ${check.reason}`);
}
assert.ok(!gamma.checks.some((c) => (c.reason ?? "").includes("worth a look")), "no shrugging reasons");

// The eighth mark: a review the machines could not do.
assert.equal(gamma.checks.at(-1)?.key, "critic", "Review sits last, after the gates");
assert.equal(gamma.checks.at(-1)?.verdict, "warn", "revise reads as a warn");
assert.equal(gammaReason("critic"), "revise, 2 open, round 1", "the review row says verdict, open count and round; the sentence lives behind the Review tab");
assert.equal(gamma.review.summary, "Two bullets in the current role say the same thing.");
assert.deepEqual(gamma.openFindings, [
  "duplicate at experiences[0].bullets[1]: second lap on the same fact",
  "register at summary: reads like a job advert",
], "open findings carry their kind, their unit path and the reason");
assert.deepEqual(alpha.openFindings, [], "a never-reviewed CV has no findings, only a skip mark");

// epsilon: a stale approval, so the next move says re-approve AND names the warn
const epsilon = model.cards.find((c) => c.id === "epsilon-resume")!;
assert.equal(epsilon.status, "stale");
assert.equal(
  nextMove(epsilon),
  "Next, re-approve it now the pages have been rebuilt, after a look at provenance's 4 weak citations.",
);
const delta = model.cards.find((c) => c.id === "delta-resume")!;
assert.equal(delta.status, "missing");
assert.equal(delta.stamp.text, "No render");

// header links point at the profile files that exist
const headerLabels = model.headerLinks.map((l) => l.label);
assert.ok(headerLabels.includes("Source CV"));
assert.ok(headerLabels.includes("Ban list"));
assert.ok(headerLabels.includes("Latest journal"));
assert.ok(!headerLabels.includes("Market confirmations"), "absent files are not linked");

const html = await renderResumeIndexHtml(model);
assert.ok(html.startsWith("<!doctype html>"));
assert.ok(html.includes("<style>"), "CSS is inlined");
assert.ok(!/(src|href)="https?:/.test(html), "no external assets");
assert.ok(html.includes(`--sans: "Avenir Next"`), "one geometric sans family");
assert.ok(!html.includes("@font-face"), "system fonts only, nothing embedded");
assert.ok(!html.includes("EB Garamond"), "the serif reading room is gone");

// --- the tab column ---------------------------------------------------------
// One tab per positioning, coloured by state, plus the binder tab above them.
assert.ok(html.includes(`class="who">Example Person`), "the name appears once, at the top of the tabs");
assert.ok(html.includes(`class="tab tab-binder" data-view="binder"`), "binder tab");
assert.ok(html.includes(`class="tab state-approved" data-resume="alpha-resume"`), "approved tab is green");
assert.ok(html.includes(`class="tab state-stale is-inactive" data-resume="beta-resume"`), "stale and inactive tab");
assert.ok(html.includes(`class="tab state-fresh is-inactive" data-resume="gamma-resume"`), "rendered, not approved");
assert.ok(html.includes(`class="tab state-missing is-inactive" data-resume="delta-resume"`), "no render");
assert.equal((html.match(/class="tab /g) ?? []).length, 7, "six positionings and the binder tab");
assert.ok(html.includes(`writing-mode: vertical-rl`), "tab text runs down the spine");
assert.ok(html.includes(`prefers-reduced-motion`), "the tab slide respects reduced motion");
// the first active positioning is the one the server renders open
const alphaTab = html.slice(html.indexOf(`data-resume="alpha-resume"`));
assert.ok(alphaTab.startsWith(`data-resume="alpha-resume" aria-selected="true"`), "alpha opens selected");
assert.ok(html.includes(`data-resume="beta-resume" aria-selected="false"`));

// --- the open spread --------------------------------------------------------
assert.ok(html.includes(`<section class="page brief" data-resume="alpha-resume">`), "the brief is the left page");
assert.ok(html.includes(`class="page pdf-page" data-resume="alpha-resume"`), "the PDF is the right page");
assert.ok(html.includes("--desk: #14213D"), "deep ink blue desk");
assert.ok(/--shadow: \dpx \dpx 0 /.test(html), "hard offset shadow, no blur");

// the viewer keeps its own toolbar: page width and nothing else
assert.equal(pdfSrcFor("a/b.pdf"), "a/b.pdf#toolbar=0&navpanes=0&zoom=page-width");
assert.ok(html.includes(`src="alpha-resume/${alphaPrefix}.pdf#toolbar=0&amp;navpanes=0&amp;zoom=page-width"`), "iframe opens at page width");
assert.ok(html.includes("toolbar=0"), "the viewer toolbar is hidden");
assert.ok(!html.includes("#page="), "no page in the fragment");
assert.ok(!/class="(arrow|thumb|thumbs)/.test(html), "no chevrons and no thumbnail gallery");
assert.ok(!html.includes("<svg viewBox=\"0 0 16 16\""), "the chevron glyphs are gone");
assert.ok(html.includes("No render yet. Run /resume-render delta-resume."), "empty state names the command");

// --- the brief, section by section, in order --------------------------------
const brief = html.slice(html.indexOf(`<section class="page brief" data-resume="alpha-resume">`));
const briefBody = brief.slice(0, brief.indexOf(`<section class="page brief" data-resume="beta-resume"`));
// CHANGED: the brief is a header, then ONE tabbed panel, then the files row.
// Readiness, Coverage and Pages are no longer sections of their own: the
// readiness line and the fill bars moved into the header, and Coverage moved
// behind the panel's Terms tab.
const order = ["checks", "files"];
const positions = order.map((id) => briefBody.indexOf(`data-section="${id}"`));
assert.ok(positions.every((p) => p > 0), "every section is present");
assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, "sections run in order");
for (const gone of ["readiness", "coverage", "pages"]) {
  assert.ok(!html.includes(`data-section="${gone}"`), `the ${gone} section folded into the new layout`);
}
assert.ok(!briefBody.includes("<h2>"), "the panel's tabs and the icon captions label themselves");

// 1. the header: name, stamp, fill bars, and the one next move
// CHANGED: the fill bars and the readiness line used to be two sections lower
// down; they now sit in the header as the state at a glance.
const head = briefBody.slice(0, briefBody.indexOf(`data-section="checks"`));
assert.ok(head.includes(`<h1 class="brief-title">Alpha Positioning</h1>`));
assert.ok(/<span class="stamp state-approved">Approved 3 Jan( 2026)?<\/span>/.test(html), "approved stamp");
assert.ok(html.includes(`<span class="stamp state-stale">Stale, rebuilt after approval</span>`), "stale stamp");
assert.ok(html.includes(`<span class="stamp state-fresh">Not approved</span>`), "unapproved stamp");
assert.ok(html.includes(`<span class="stamp state-missing">No render</span>`), "no-render stamp");
assert.ok(head.indexOf(`class="brief-title"`) < head.indexOf(`class="stamp`), "the name leads, the stamp follows on the same line");
assert.ok(head.indexOf(`class="stamp`) < head.indexOf(`class="fill-bar"`), "the bars sit under the headline");
assert.equal((head.match(/class="fill-bar"/g) ?? []).length, 2, "one fill bar per page, in the header");
assert.ok(head.includes(`<span class="is-low" style="width:88.10%">`), "the thin page is amber");
assert.ok(head.includes(`<span class="" style="width:94.60%">`), "the page above its floor is ink");
assert.ok(head.includes(`<span class="fill-pct">88%</span>`) && head.includes(`<span class="fill-pct">95%</span>`));
// CHANGED: the shape sentence is the bars' label rather than a second line of prose.
assert.ok(
  head.includes(`role="img" aria-label="Two pages, filled between 88 and 95 percent."`),
  "the bars carry the shape sentence as their accessible name",
);
assert.ok(head.includes(`<p class="brief-next">Next, answer two open questions on the keyword plan.</p>`));

// 2. the one panel: three tabs, Gates first, each wired to its own tabpanel
// CHANGED: the panel used to carry two tabs (Gates, Review) and the checks
// slice used to end where the Coverage section began. It now ends at Files.
const panel = briefBody.slice(briefBody.indexOf(`data-section="checks"`), briefBody.indexOf(`data-section="files"`));
assert.ok(panel.includes(`<div class="pane-tabs" role="tablist" aria-label="Checks">`), "one tablist for the panel");
assert.ok(panel.includes(`aria-selected="true" aria-controls="checks-alpha-resume-gates" data-pane="gates">Gates<`));
assert.ok(panel.includes(`aria-selected="false" aria-controls="checks-alpha-resume-review" data-pane="review">Review<`));
assert.ok(panel.includes(`aria-selected="false" aria-controls="checks-alpha-resume-terms" data-pane="terms">Terms<`));
assert.deepEqual(
  (panel.match(/data-pane="(gates|review|terms)"/g) ?? []),
  [`data-pane="gates"`, `data-pane="review"`, `data-pane="terms"`,
   `data-pane="gates"`, `data-pane="review"`, `data-pane="terms"`],
  "three tabs, then the three panels they control, in the same order",
);
assert.ok(panel.includes(`<div class="pane" id="checks-alpha-resume-terms" role="tabpanel" data-pane="terms" hidden>`));
assert.ok(panel.includes(`<div class="pane" id="checks-alpha-resume-review" role="tabpanel" data-pane="review" hidden>`));

// 2a. Gates: eight marks, name left, reason right, always visible
const gates = panel.slice(panel.indexOf(`id="checks-alpha-resume-gates"`), panel.indexOf(`id="checks-alpha-resume-review"`));
assert.equal((gates.match(/class="mark mark-/g) ?? []).length, 8, "eight marks");
assert.deepEqual(
  (gates.match(/class="mark mark-(\w+)"/g) ?? []).map((m) => m.split("-").pop()!.replace(/"$/, "")),
  ["pass", "pass", "pass", "warn", "skip", "skip", "pass", "skip"],
  "the marks keep their fixed order",
);
assert.ok(gates.includes("Review") && gates.includes("Never reviewed"), "an unreviewed CV says so rather than going quiet");
assert.ok(gates.includes("Term grounding") && gates.includes("Seven generic words only, nothing invented"));
assert.ok(gates.includes(`<span class="mark-why"></span>`), "a plain pass says nothing more");
assert.ok(!gates.includes("aria-expanded"), "no disclosure, the reasons are just there");
// CHANGED: the composition bar used to live in the Pages section; it now closes
// the Gates panel, where the preserve mark it explains already sits.
assert.ok(gates.includes(`<span class="featured" style="width:50.00%"></span>`));
assert.ok(gates.includes(`<span class="mentioned" style="width:25.00%"></span>`));
assert.ok(gates.includes(`<span class="dropped" style="width:25.00%"></span>`));
assert.ok(gates.includes("Two featured, one mentioned, one dropped, one unsupported claim and two warns."));

// 2b. Terms: the summary, the legend, the toggle, then the two views
// CHANGED: everything here used to be the Coverage section.
const terms = panel.slice(panel.indexOf(`id="checks-alpha-resume-terms"`));
assert.ok(terms.includes(`<span class="swatch surfaced"></span>in the CV`), "the legend leads the tab");
assert.ok(terms.includes(`<div class="view-toggle" role="group" aria-label="Term view">`), "one toggle, two views");
assert.ok(terms.includes(`data-terms-view="clouds" aria-pressed="true" aria-controls="terms-alpha-resume-clouds">By cloud<`));
assert.ok(terms.includes(`data-terms-view="used" aria-pressed="false" aria-controls="terms-alpha-resume-used">Used / not used<`));
assert.ok(terms.includes(`<div class="terms-view" id="terms-alpha-resume-used" data-terms-view="used" hidden>`), "the used view starts closed");
// a plan predating clouds keeps its dot row inside the By cloud view
const cloudsView = terms.slice(terms.indexOf(`id="terms-alpha-resume-clouds"`), terms.indexOf(`id="terms-alpha-resume-used"`));
assert.equal((cloudsView.match(/class="surfaced"/g) ?? []).length, 7);
assert.equal((cloudsView.match(/class="renderable"/g) ?? []).length, 2);
assert.equal((cloudsView.match(/class="absent"/g) ?? []).length, 1);
assert.ok(cloudsView.includes(`title="kappa"`), "each unsurfaced dot names its term");
assert.ok(cloudsView.includes("7 of 10 must-have terms surfaced."));
assert.equal(model.cards[0].keywordDotKind, "must_have");
assert.ok(cloudsView.includes("Two open questions on the keyword plan."));
assert.ok(cloudsView.includes("<li>x</li>"), "the questions themselves");
// the used / not-used view names what it can: alpha's plan only names the misses
const usedView = terms.slice(terms.indexOf(`id="terms-alpha-resume-used"`));
assert.ok(usedView.includes(`<p class="chip-head">In the CV<span class="chip-count">0</span></p>`));
assert.ok(usedView.includes(`<p class="chip-head">Not yet in the CV<span class="chip-count">2</span></p>`));
assert.ok(usedView.includes(`>kappa</span>`) && usedView.includes(`>lambda</span>`));
assert.ok(usedView.includes(`aria-expanded="false" aria-controls="absent-alpha-resume">Not in the source: 1 term<`));
assert.ok(usedView.includes(`<div class="absent-panel" id="absent-alpha-resume" hidden>`), "what the source never had stays folded");

assert.ok(!html.includes(`data-section="contents"`), "the contents section is gone");
assert.ok(!html.includes("role-title"), "and its roles list with it");

// 3. files: one icon row, each icon captioned, a hairline before the sidecars
// CHANGED: the two text rows (`div.files` and `div.files.secondary`) are now a
// single icon row; every control is an inline SVG with an aria-label, a title
// and an 11px caption, so the old text-link assertions are restated as icons.
const files = briefBody.slice(briefBody.indexOf(`data-section="files"`));
assert.ok(briefBody.includes(`<section class="brief-section" data-section="files" aria-label="Files">`), "the row names itself");
const captions = (files.match(/<span class="file-caption">([^<]+)<\/span>/g) ?? [])
  .map((m) => m.replace(/<[^>]+>/g, ""));
assert.deepEqual(
  captions,
  ["Download PDF", "Print", "Open PDF", "Word", "Web page", "Markdown",
   "Composition", "Provenance", "Audit", "Keyword plan", "Metadata"],
  "every artefact that exists gets an icon, in order, actions first",
);
for (const label of captions) {
  assert.ok(files.includes(`aria-label="${label}" title="${label}"`), `${label} is labelled for both screen readers and hover`);
}
assert.equal((files.match(/<svg viewBox="0 0 24 24"/g) ?? []).length, 11, "one inline icon per control");
assert.ok(files.includes(`<span class="file-divider" aria-hidden="true"></span>`), "a quiet rule between formats and sidecars");
assert.ok(
  files.indexOf(`class="file-divider"`) > files.indexOf(`>Markdown<`)
  && files.indexOf(`class="file-divider"`) < files.indexOf(`>Composition<`),
  "the divider falls between the readable formats and the working files",
);
assert.ok(!files.includes(`class="files secondary"`), "one row now, not two");
// the two PDF actions lead the row: save it, or print it through the viewer
assert.ok(
  files.includes(`<a class="file-icon" href="alpha-resume/${alphaPrefix}.pdf" download aria-label="Download PDF"`),
  "Download PDF is still a download link to the PDF",
);
assert.ok(
  files.includes(`<button type="button" class="file-icon file-action" data-print data-target="alpha-resume" aria-label="Print"`),
  "Print is still a button naming the positioning it prints",
);
assert.ok(files.includes(`<a class="file-icon is-quiet" href="alpha-resume/${alphaPrefix}.audit.json"`), "sidecars read quieter");
// no PDF, no actions: delta has nothing to download or print
assert.ok(!html.includes(`data-target="delta-resume"`), "an unrendered positioning offers no print");
assert.ok(html.includes("No files to open yet."), "and says so where its files would be");
// the button carries no border or background of its own, and shows keyboard focus
assert.ok(html.includes(".files .file-action") && html.includes("background: none"), "the print button reads as a link");
assert.ok(html.includes(".files .file-action:focus-visible"), "visible keyboard focus");
assert.ok(html.includes(".files .file-icon:focus-visible"), "every icon shows a focus ring");
assert.ok(html.includes("font-size: 11px"), "the captions are 11px muted type");
assert.ok(html.includes("contentWindow.print()"), "print drives the open same-origin viewer");
assert.ok(html.includes(`"#toolbar=1"`), "the fallback opens a toolbar the reader can print from");
assert.ok(briefBody.includes(`class="brief-foot"`) && briefBody.includes(">Source CV<")
  && briefBody.includes(">Ban list<") && briefBody.includes(">Latest journal<"), "profile files under the brief");

// a plan with no must-haves says how many renderable terms surfaced instead
const gammaBrief = html.slice(html.indexOf(`<section class="page brief" data-resume="gamma-resume"`));
const gammaEnd = gammaBrief.indexOf(`<section class="page brief"`, 1);
const gammaBody = gammaEnd > 0 ? gammaBrief.slice(0, gammaEnd) : gammaBrief;
assert.ok(gammaBody.includes(`<span class="cloud-count">25 of 25</span>`), "the heaviest cloud reports its own count");
assert.ok(gammaBody.includes(`<span class="cloud-count">6 of 16</span>`));
assert.ok(gammaBody.indexOf("Delivery<span") < gammaBody.indexOf("Tooling<span"), "clouds render heaviest first");
assert.ok(gammaBody.includes(`<span class="cloud-weight">weight 5</span>`), "each row shows its weight");
assert.ok(gammaBody.includes("Two bullets in the current role say the same thing."), "the review sentence is on the sheet, behind the Review tab");
assert.ok(gammaBody.includes('data-pane="review" hidden'), "the review pane starts collapsed");
assert.ok(gammaBody.includes("Review (2)"), "the Review tab counts the open findings");
assert.ok(gammaBody.includes("Duplicate at experiences[0].bullets[1]: second lap on the same fact"), "open findings are listed under Checks");
// The dot rows are gone: one stacked bar per cloud, plus the three legend swatches.
assert.equal((gammaBody.match(/class="cloud-bar"/g) ?? []).length, 2, "one bar per cloud");
assert.equal((gammaBody.match(/class="dots/g) ?? []).length, 0, "no dot rows once a plan has clouds");
assert.ok(gammaBody.includes(`<span class="swatch surfaced"></span>in the CV`), "the legend says what the ink means");
assert.ok(gammaBody.includes("source-backed, not yet in the CV") && gammaBody.includes("not in the source"));
// Each row opens onto its terms, grouped and comma-separated rather than one per line.
assert.ok(gammaBody.includes(`<button type="button" class="cloud-row" aria-expanded="false"`), "each cloud row is a disclosure");
assert.ok(gammaBody.includes(`id="cloud-gamma-resume-tooling-cloud" hidden`), "the terms panel starts closed");
assert.ok(gammaBody.includes(`<span class="term-head">In the CV:</span> alias-5, alias-6`), "surfaced terms read as one line");
assert.ok(gammaBody.includes(`<span class="term-head">Source-backed, not yet in the CV:</span> confirmed-1`));
assert.ok(gammaBody.includes(`<span class="term-head">Not in the source:</span> foreign-0, foreign-1, foreign-2`));
assert.ok(gammaBody.includes("Two skill blocks one item over cap; two roles one bullet over cap"));
assert.ok(gammaBody.includes("4 weak citations; 2 numbers not in cited lines"));
assert.ok(!html.includes("Worth a look"), "a mark names its issue rather than shrugging");

// the applied plan speaks in the Coverage section's opening sentence
const zetaBrief = html.slice(html.indexOf(`<section class="page brief" data-resume="zeta-resume"`));
const zetaEnd = zetaBrief.indexOf(`<section class="page brief"`, 1);
const zetaBody = zetaEnd > 0 ? zetaBrief.slice(0, zetaEnd) : zetaBrief;
assert.ok(
  zetaBody.includes(`<p class="coverage-summary">3 of 7 source-backed terms appear in the CV, 1 of them as familiarity. Must-have terms: 2 of 4.</p>`),
  "the summary sentence counts the applied plan",
);
assert.ok(zetaBody.includes(`<span class="cloud-count">1 of 4</span>`), "a cloud row counts what landed");
assert.ok(/<span class="cloud-where">(skills|experience|summary) 1[^<]*<\/span>/.test(zetaBody), "a cloud row says where its surfaced terms sit");
assert.ok(zetaBody.includes("chaos engineering (familiarity)"), "a familiarity term says so in the panel");

// the used / not-used view: every renderable term as a chip, cloud weight first
// then alphabetically, must-haves carrying a dot and a bold weight.
const { termChips } = await import("../tools/resume/resume-index.ts");
const chips = termChips(zeta);
assert.deepEqual(chips.used.map((c) => c.term), ["event streaming", "kubernetes", "roadmap"]);
assert.deepEqual(chips.unused.map((c) => c.term), ["chaos engineering", "domain-driven design", "terraform", "observability"]);
assert.deepEqual(chips.absent.map((c) => c.term), ["mainframe", "cobol", "cics", "service mesh"], "the heavier cloud's misses read first");
assert.deepEqual(chips.used.map((c) => c.cloud), ["Platform", "Tooling", "Other market terms"], "each chip carries its cloud");
// the two groups plus the source misses account for every term in the plan
assert.equal(
  chips.used.length + chips.unused.length,
  (zeta.keywordPlan?.renderable_total ?? 0),
  "the chip counts reconcile with the summary sentence",
);
const zetaUsed = zetaBody.slice(zetaBody.indexOf(`id="terms-zeta-resume-used"`));
assert.ok(
  zetaUsed.includes(`<span class="chip chip-used is-must" title="Platform"><span class="chip-dot" aria-hidden="true"></span>event streaming</span>`),
  "a must-have chip in the CV carries its dot, its cloud and the ink outline",
);
assert.ok(
  zetaUsed.includes(`<span class="chip chip-unused" title="Platform">chaos engineering<span class="chip-note">familiarity</span></span>`),
  "a familiarity term is amber and says so",
);
assert.ok(zetaUsed.includes(`<p class="chip-head">In the CV<span class="chip-count">3</span></p>`));
assert.ok(zetaUsed.includes(`<p class="chip-head">Not yet in the CV<span class="chip-count">4</span></p>`));
assert.ok(zetaUsed.includes(`<span class="chip chip-used" title="Other market terms">roadmap</span>`),
  "a term with no cloud still gets a chip, filed under Other market terms");
assert.ok(zetaUsed.includes(`>Not in the source: 4 terms<`), "and the rest sit behind one muted line");
assert.ok(zetaBody.includes(`<span class="cloud-name">Other market terms<span class="cloud-weight">weight 0</span></span>`),
  "the By cloud view carries the same row, so the two views reconcile");

// --- the closed binder ------------------------------------------------------
const binder = html.slice(html.indexOf(`<section class="binder-view"`));
assert.ok(binder.includes(`<h1>Example Person</h1>`), "the overview heading reads the profile name");
assert.ok(binder.includes("One active positioning of six. Pick one to open it."));
assert.equal((binder.match(/class="sheet /g) ?? []).length, 6, "a sheet per positioning");
assert.ok(binder.includes(`class="sheet state-approved" data-resume="alpha-resume"`));
assert.ok(binder.includes(`class="sheet state-stale is-inactive" data-resume="beta-resume"`));
assert.ok(binder.includes(`<span class="sheet-stamp state-approved">`), "the stamp reads under the sheet");
const alphaSheet = binder.slice(binder.indexOf(`data-resume="alpha-resume"`));
const alphaSheetBody = alphaSheet.slice(0, alphaSheet.indexOf("</button>"));
assert.ok(
  alphaSheetBody.indexOf(`class="sheet-name"`) < alphaSheetBody.indexOf("<img "),
  "the positioning label heads the sheet, above the preview",
);
assert.ok(html.includes("height: 420px"), "the preview is tall enough to read the top of page one");
assert.equal((alphaSheetBody.match(/class="fill-bar"/g) ?? []).length, 2, "fill bars on the sheet");
assert.equal((alphaSheetBody.match(/class="mark-/g) ?? []).length, 8, "the eight marks in one row");
assert.ok(binder.includes(`class="sheet-blank">No render yet</span>`), "an unrendered positioning still lies on the desk");

// --- routing ----------------------------------------------------------------
assert.ok(html.includes(`<script type="application/json" id="binder-model">`), "model embedded as JSON");
assert.ok(html.includes("history.pushState") && html.includes("popstate"), "back and forward retrace positionings");
assert.ok(html.includes(`"#binder"`), "the binder has its own hash");
assert.ok(html.includes("ArrowDown") && html.includes("ArrowUp"), "up and down move between tabs");
assert.ok(html.includes("localStorage"), "the last positioning read is remembered");
assert.ok(html.includes(`"resume-binder:pane:"`) && html.includes(`"resume-binder:terms:"`),
  "the open tab and the terms view are remembered beside it");
assert.ok(html.includes("applyRemembered()"), "and applied on load");
assert.ok(!html.includes("ArrowRight"), "nothing here pages the PDF");
// writeResumeIndex lands the file where the server expects it
const written = await writeResumeIndex();
assert.equal(written.outPath, path.join(resumesDir, "index.html"));

assert.equal(relativeLink(path.join(resumesDir, "index.html"), path.join(profileDir, "cv-source.md")), "../cv-source.md");

// --- server ----------------------------------------------------------------
const { startResumeServer, contentTypeFor, resolveWithinRoot } = await import("../tools/resume/resume-serve.ts");

assert.equal(contentTypeFor("x.pdf"), "application/pdf");
assert.equal(contentTypeFor("x.md"), "text/plain; charset=utf-8");
assert.equal(resolveWithinRoot(profileDir, "/../../etc/passwd"), path.join(profileDir, "etc/passwd"));
assert.equal(resolveWithinRoot(profileDir, "/resumes/index.html"), path.join(resumesDir, "index.html"));

const { server, url, port } = await startResumeServer({ port: 0 });
try {
  assert.ok(url.includes("127.0.0.1"), "binds localhost only");

  const indexRes = await fetch(`http://127.0.0.1:${port}/resumes/index.html`);
  assert.equal(indexRes.status, 200);
  assert.ok((indexRes.headers.get("content-type") ?? "").startsWith("text/html"));
  assert.ok((await indexRes.text()).includes("Alpha Positioning"));

  const rootRes = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  assert.equal(rootRes.status, 302);
  assert.equal(rootRes.headers.get("location"), "/resumes/index.html");

  const pdfRes = await fetch(`http://127.0.0.1:${port}/resumes/alpha-resume/${encodeURIComponent(alphaPrefix)}.pdf`);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get("content-type"), "application/pdf");

  const docxRes = await fetch(`http://127.0.0.1:${port}/resumes/alpha-resume/${encodeURIComponent(alphaPrefix)}.docx`);
  assert.ok((docxRes.headers.get("content-disposition") ?? "").startsWith("attachment"));

  const dirRes = await fetch(`http://127.0.0.1:${port}/resumes/beta-resume/`);
  assert.equal(dirRes.status, 200);
  assert.ok((await dirRes.text()).includes(`${betaPrefix}.pdf`), "directory listing fallback");

  const missingRes = await fetch(`http://127.0.0.1:${port}/resumes/nope.txt`);
  assert.equal(missingRes.status, 404);
} finally {
  server.close();
}

console.log("resume-index.test.ts: ok");
