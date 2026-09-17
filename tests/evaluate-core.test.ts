import assert from "node:assert/strict";
import { evaluateContent, failingLineUnits, type Rubric } from "../tools/resume/lib/evaluate-core.ts";
import type { LineUnitMetric } from "../tools/resume/lib/measure-document.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";

const rubric: Rubric = {
  template: "test",
  allowed_headings: ["Summary", "Skills", "Experience"],
  section_order: ["summary", "skills", "experience"],
  page_budget: { target_pages: 2, hard_max: 2, last_page_min_fill_pct: 75, last_page_min_fill_severity: "fail" },
  summary: { min_chars: 10, max_chars: 500 },
  line_units: {
    skill_item: { single_line_min_fill_pct: 75, max_lines: 1, severity: "fail" },
    experience_bullet: { wrapped_last_line_min_fill_pct: 55, max_lines: 3, severity: "warn" },
  },
};

const unit = (partial: Partial<LineUnitMetric> & { kind: string; unitPath: string }): LineUnitMetric => ({
  text: "x".repeat(80),
  charCount: 80,
  charsPerRenderedLine: [80],
  lineCount: 1,
  availableWidth: 500,
  lineHeightPx: 16,
  lineFillPct: [90],
  lastLineFillPct: 90,
  ...partial,
});

const content: ResumeContent = {
  frontmatter: { name: "Test Person", email: "t@example.com", phone: "", citizenship: "", location: "" } as any,
  summary: "Senior operator who ships outcomes across delivery and platforms.",
  highlights: [],
  skills: [{ name: "Delivery", bullets: ["Roadmaps, governance"] }],
  experiences: [
    { placement: "feature", title: "Lead", company: "Co", start: "2022-01", end: "current", summary: "Ran things.", bullets: ["Delivered a platform used by 400 staff in 6 months."] },
    { placement: "feature", title: "Manager", company: "Co2", start: "2018-01", end: "2021-12", summary: "Managed things.", bullets: ["Cut spend 12%."] },
  ],
  resumeId: "test",
};

const units = [
  unit({ kind: "skill_item", unitPath: "skills[0].bullets[0]", lineCount: 1, lastLineFillPct: 60, lineFillPct: [60] }),
  unit({ kind: "skill_item", unitPath: "skills[0].bullets[1]", lineCount: 1, lastLineFillPct: 90, lineFillPct: [90] }),
  unit({ kind: "experience_bullet", unitPath: "experiences[0].bullets[0]", lineCount: 2, lastLineFillPct: 30, lineFillPct: [95, 30] }),
  unit({ kind: "experience_bullet", unitPath: "experiences[0].bullets[1]", lineCount: 4, lastLineFillPct: 80, lineFillPct: [95, 95, 95, 80] }),
];

const text = "Summary\nblah\n\nSkills\nRoadmaps\n\nExperience\nLead";

// 1. strict line units: ragged skill item is a FAIL, ragged bullet a WARN, over-long bullet a WARN.
const strict = evaluateContent({
  rubric, content, text, pages: 2, pdfSupplied: true, lastPageFill: { fillPct: 80, trailingBlankPct: 20 }, htmlSupplied: true,
  bulletMetrics: [], lineUnitMetrics: units, headingOrphans: [], experienceStartOrphans: [], strictLineUnits: true,
});
const rules = strict.issues.map((i) => `${i.severity}:${i.rule}`);
assert.ok(rules.includes("fail:line_unit_single_line_fill"), rules.join(","));
assert.ok(rules.includes("warn:line_unit_wrapped_last_line_fill"));
assert.ok(rules.includes("warn:line_unit_line_count"));
assert.equal(strict.verdict, "fail");
console.log("  ✓ strict line units: ragged skill item fails, ragged/over-long bullets warn");

// 2. non-strict: line-unit rules are not applied; the same input passes.
const lax = evaluateContent({
  rubric, content, text, pages: 2, pdfSupplied: true, lastPageFill: { fillPct: 80, trailingBlankPct: 20 }, htmlSupplied: true,
  bulletMetrics: [], lineUnitMetrics: units, headingOrphans: [], experienceStartOrphans: [], strictLineUnits: false,
});
assert.ok(!lax.issues.some((i) => i.rule.startsWith("line_unit_")));
console.log("  ✓ non-strict mode skips line-unit rules");

// 3. orphan heading and page budget are hard fails with the historical messages.
const broken = evaluateContent({
  rubric, content, text, pages: 3, pdfSupplied: true, lastPageFill: { fillPct: 40, trailingBlankPct: 60 }, htmlSupplied: true,
  bulletMetrics: [], lineUnitMetrics: [], strictLineUnits: false,
  headingOrphans: [{ heading: "Experience", nextText: "Lead", headingPage: 1, nextPage: 2 }],
  experienceStartOrphans: [],
});
const details = Object.fromEntries(broken.issues.map((i) => [i.rule, i.detail]));
assert.equal(details.page_budget, "3 pages exceeds hard max 2");
assert.equal(details.page_target, "3 pages differs from target 2");
assert.equal(details.last_page_fill, "last page fill 40.0% below min 75% (trailing blank 60.0%)");
assert.equal(details.section_heading_orphan, "section heading 'Experience' is alone at the end of page 1; first content starts on page 2: Lead");
assert.equal(broken.verdict, "fail");
console.log("  ✓ page budget, last-page fill and orphan heading messages are byte-identical to the legacy evaluator");

// 4. failingLineUnits mirrors checkLineUnits exactly.
const failing = failingLineUnits(units, rubric, true);
assert.deepEqual(failing.map((f) => [f.unit_path, f.rule, f.severity]), [
  ["skills[0].bullets[0]", "line_unit_single_line_fill", "fail"],
  ["experiences[0].bullets[0]", "line_unit_wrapped_last_line_fill", "warn"],
  ["experiences[0].bullets[1]", "line_unit_line_count", "warn"],
]);
assert.deepEqual(failingLineUnits(units, rubric, false), []);
console.log("  ✓ failingLineUnits lists exactly the units checkLineUnits flags");

// 5. Missing metrics with html supplied → "could not inspect" warns, not crashes.
const missing = evaluateContent({
  rubric, content, text, pages: null, pdfSupplied: true, lastPageFill: null, htmlSupplied: true, htmlPath: "x.html", pdfPath: "x.pdf",
  bulletMetrics: null, lineUnitMetrics: null, headingOrphans: null, experienceStartOrphans: null, strictLineUnits: true,
});
assert.ok(missing.issues.some((i) => i.rule === "page_budget" && i.detail === "could not inspect PDF page count: x.pdf"));
assert.ok(missing.issues.some((i) => i.rule === "bullet_line_fill" && i.detail === "could not inspect rendered bullet line fill: x.html"));
console.log("  ✓ missing metrics degrade to the historical 'could not inspect' warnings");
