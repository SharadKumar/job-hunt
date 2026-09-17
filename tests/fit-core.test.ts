import assert from "node:assert/strict";
import { computeFit, formatFitText } from "../tools/resume/lib/fit-core.ts";
import { assignPages, diffChangedPages } from "../tools/resume/lib/pdf-metrics.ts";
import type { LineUnitMetric } from "../tools/resume/lib/measure-document.ts";
import type { PageMetric } from "../tools/resume/lib/pdf-metrics.ts";

const unit = (unitPath: string, page: number, lineCount: number, lastLineFillPct = 90, text = `Unit ${unitPath} text that is long enough to locate on a page ${unitPath}`): LineUnitMetric => ({
  unitPath, kind: unitPath.includes("bullets") ? "experience_bullet" : "experience_summary", text,
  charCount: text.length, charsPerRenderedLine: [], lineCount, availableWidth: 500, lineHeightPx: 16,
  lineFillPct: Array(lineCount).fill(90).map((v, i) => (i === lineCount - 1 ? lastLineFillPct : v)), lastLineFillPct, page,
});
const page = (n: number, fillPct: number): PageMetric => ({ page: n, fillPct, heightPt: 842, contentBottomPt: (fillPct / 100) * 842 });
const rubric = { line_units: { experience_bullet: { desired_chars: "78-96", max_lines: 3 } } };
const base = { rubric, templateName: "classic", resume: "r", html: "h.html", pdf: "p.pdf", tempRender: false };

// over budget: 3 pages against hard_max 2 → lines_to_remove = lines on page 3, overflow candidates ranked by size.
const over = computeFit({
  ...base,
  policy: { hard_max: 2, target_pages: 2, last_page_min_fill_pct: 75 },
  pages: [page(1, 96), page(2, 95), page(3, 20)],
  units: [
    ...Array.from({ length: 30 }, (_, i) => unit(`experiences[0].bullets[${i}]`, 1, 1)),
    ...Array.from({ length: 30 }, (_, i) => unit(`experiences[1].bullets[${i}]`, 2, 1)),
    unit("experiences[2].bullets[0]", 3, 2, 40),
    unit("experiences[2].bullets[1]", 3, 3),
  ],
});
assert.equal(over.verdict, "over_budget");
assert.equal(over.delta.lines_to_remove, 5);
assert.deepEqual(over.candidates.units_on_overflow_pages.map((u) => u.unit_path), ["experiences[2].bullets[1]", "experiences[2].bullets[0]"]);
assert.equal(over.candidates.ragged_tails_shave_to_save_a_line[0].unit_path, "experiences[2].bullets[0]");
assert.ok(over.delta.notes[0].startsWith("block-atomicity:"));
console.log("  ✓ over_budget: lines to remove and overflow candidates ranked by size");

// under filled: last page at 50% against 75% → lines_to_add = ceil(25 / pct_per_line).
const under = computeFit({
  ...base,
  policy: { hard_max: 2, target_pages: 2, last_page_min_fill_pct: 75 },
  pages: [page(1, 96), page(2, 50)],
  units: [...Array.from({ length: 40 }, (_, i) => unit(`experiences[0].bullets[${i}]`, 1, 1)), unit("experiences[1].bullets[0]", 2, 1)],
});
assert.equal(under.verdict, "under_filled");
const pctPerLine = (16 * 0.75 / 842) * 100;
assert.equal(under.delta.lines_to_add, Math.ceil(25 / pctPerLine));
assert.ok(under.candidates.fill_guidance.some((g) => g.kind === "experience_bullet" && g.desired_chars === "78-96"));
console.log("  ✓ under_filled: lines to add derived from measured line height, fill guidance echoed from rubric");

// converged.
const ok = computeFit({ ...base, policy: { hard_max: 2, target_pages: 2, last_page_min_fill_pct: 75 }, pages: [page(1, 96), page(2, 80)], units: [unit("experiences[0].bullets[0]", 1, 1)] });
assert.equal(ok.verdict, "converged");
assert.equal(ok.delta.lines_to_add + ok.delta.lines_to_remove, 0);
const textReport = formatFitText(ok);
assert.ok(textReport.includes("VERDICT: CONVERGED") && textReport.includes("PAGE FIT — r / classic"));
console.log("  ✓ converged report and text rendering");

// assignPages locates units by normalised text; diffChangedPages compares hashes.
const units = [unit("summary", 0, 1, 90, "Senior technology operator with fifteen years"), unit("experiences[0].bullets[0]", 0, 1, 90, "Reset a fragmented transformation portfolio")];
assignPages(units, ["xxx seniortechnologyoperatorwithfifteenyears yyy", "resetafragmentedtransformationportfolio"]);
assert.equal(units[0].page, 1);
assert.equal(units[1].page, 2);
assert.deepEqual(diffChangedPages(["a", "b", "c"], ["a", "x", "c"]), [2]);
assert.deepEqual(diffChangedPages(null, ["a", "b"]), [1, 2]);
assert.deepEqual(diffChangedPages(["a", "b", "c"], ["a", "b"]), [3]);
console.log("  ✓ assignPages locates units; diffChangedPages reports changed page numbers");

// ---- short single lines: where to ADD chars when the page under-fills ------
// Detected against the same rubric thresholds failingLineUnits uses (min minus
// tolerance), sized from each unit's own measured chars-per-fill ratio.
const shortRubric = {
  line_units: {
    experience_bullet: { single_line_min_fill_pct: 80, tolerance_pct: 5, desired_chars: "78-96" },
    experience_summary: { desired_chars: "x" },
  },
};
const short = computeFit({
  ...base,
  rubric: shortRubric,
  policy: { hard_max: 2, target_pages: 2, last_page_min_fill_pct: 75 },
  pages: [page(1, 96), page(2, 60)],
  units: [
    unit("experiences[0].bullets[0]", 1, 1, 50, "short one"),
    unit("experiences[0].bullets[1]", 1, 1, 70, "a somewhat longer bullet"),
    unit("experiences[0].bullets[2]", 1, 1, 90, "comfortably full line"),
    unit("experiences[0].bullets[3]", 2, 2, 30, "a wrapped unit with a ragged tail"),
    unit("summary", 1, 1, 10, "x"),
  ],
});
assert.deepEqual(
  short.candidates.short_single_lines.map((s) => s.unit_path),
  ["experiences[0].bullets[1]", "experiences[0].bullets[0]"],
  "only short SINGLE-line units of a kind that declares a min fill, cheapest first",
);
assert.deepEqual(short.candidates.short_single_lines.map((s) => s.add_chars), [4, 6]);
assert.deepEqual(short.candidates.short_single_lines[0], {
  unit_path: "experiences[0].bullets[1]", kind: "experience_bullet", page: 1, chars: 24, fill_pct: 70, add_chars: 4,
});
// A rubric that declares no min fill for the kind proposes nothing.
assert.deepEqual(
  computeFit({ ...base, policy: { hard_max: 2, target_pages: 2 }, pages: [page(1, 40)], units: [unit("experiences[0].bullets[0]", 1, 1, 20)] }).candidates.short_single_lines,
  [],
  "no single_line_min_fill_pct in the rubric, no short-line candidates",
);
console.log("  ✓ short_single_lines: under-filled single lines ranked by chars to add");

console.log("fit-core: all assertions passed");
