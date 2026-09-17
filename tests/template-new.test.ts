/**
 * template-new.test.ts — the template scaffold (A7) and the two things it
 * depends on: the shared `defineHtmlTemplate` body, and the `skills-columns`
 * layout's `data-flow="secondary"` contract with the page-fit arithmetic.
 *
 * No browser here — buildResumeHtml is pure string composition and computeFit
 * is pure arithmetic, so both are unit-testable. Rendering is covered by
 * `npm run resume:templates:check`.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildResumeHtml, type HtmlDesign } from "../templates/resume/_html-resume.ts";
import { defineHtmlTemplate } from "../templates/resume/_html-template.ts";
import { computeFit } from "../tools/resume/lib/fit-core.ts";
import { scaffoldTemplate } from "../tools/resume/template-new.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";
import type { LineUnitMetric } from "../tools/resume/lib/measure-document.ts";
import type { PageMetric } from "../tools/resume/lib/pdf-metrics.ts";

const TEMPLATES_DIR = "templates/resume";
const SCRATCH = "zz-scaffold-test";

const CONTENT: ResumeContent = {
  frontmatter: { name: "Alex Morgan", email: "alex@example.com", phone: "+61 400 000 000" },
  summary: "Senior operator who ships.",
  highlights: ["Shipped a thing that mattered to the business."],
  skills: [
    { name: "Delivery", bullets: ["Program recovery", "Release governance"] },
    { name: "Platforms", bullets: ["Integration", "Observability"] },
  ],
  experiences: [{ placement: "feature", title: "Director", company: "Northbank", start: "2022-01", end: "current", summary: "Ran the portfolio.", bullets: ["Reset the portfolio."] }],
  resumeId: "test",
};

const DESIGN: HtmlDesign = {
  cssPath: path.join(TEMPLATES_DIR, "modern", "styles.css"),
  fonts: [],
  labels: { summary: "Summary", impact: "Impact", experience: "Experience", skills: "Skills", earlier: "Earlier" },
  sectionOrder: ["summary", "impact", "skills", "experience"],
};

async function rmScratch(): Promise<void> {
  await fs.rm(path.join(TEMPLATES_DIR, SCRATCH), { recursive: true, force: true });
}

async function main(): Promise<void> {
  // ---- layout: single is the default and emits no columns container --------
  const single = await buildResumeHtml(CONTENT, DESIGN);
  assert.ok(!single.includes('data-flow="secondary"'), "single layout must not mark any flow secondary");
  assert.ok(!single.includes("skills-columns"), "single layout must not emit the columns container or its CSS");
  console.log("  ✓ layout single: no secondary flow, no columns CSS (goldens stay byte-identical)");

  // ---- layout: skills-columns wraps ONLY the skill blocks ------------------
  const columned = await buildResumeHtml(CONTENT, { ...DESIGN, layout: "skills-columns" });
  assert.ok(columned.includes('<div class="skills-columns" data-flow="secondary">'), "skills-columns must mark the columned container secondary");
  assert.ok(columned.includes("column-count: 2"), "skills-columns must inject the columns CSS");
  // Semantic DOM order is the ATS/text-extraction contract: skills still sit
  // between the impact section and experience, exactly as in single layout.
  // Match on rendered CONTENT, not selectors — the stylesheet is inlined above the body.
  const order = (html: string) => [html.indexOf("Shipped a thing"), html.indexOf("Program recovery"), html.indexOf("Northbank")];
  const [highlightAt, skillAt, experienceAt] = order(columned);
  assert.ok(highlightAt > 0 && highlightAt < skillAt && skillAt < experienceAt, "skills-columns must not reorder the DOM");
  assert.deepEqual(order(columned).map((i) => i > 0), [true, true, true]);
  assert.equal((columned.match(/data-flow="secondary"/g) ?? []).length, 1, "exactly one secondary-flow container");
  console.log("  ✓ layout skills-columns: one secondary container, semantic DOM order preserved");

  // ---- fit arithmetic counts primary-flow lines only ----------------------
  const unit = (unitPath: string, page: number, lineCount: number, flow?: "secondary"): LineUnitMetric => ({
    unitPath, kind: "experience_bullet", text: `text for ${unitPath}`, charCount: 40, charsPerRenderedLine: [],
    lineCount, availableWidth: 500, lineHeightPx: 16, lineFillPct: Array(lineCount).fill(90), lastLineFillPct: 90, page, flow,
  });
  const pageMetric = (n: number, fillPct: number): PageMetric => ({ page: n, fillPct, heightPt: 842, contentBottomPt: (fillPct / 100) * 842 });
  const fitArgs = {
    rubric: {}, templateName: "modern-columns", resume: null, html: "h.html", pdf: "p.pdf", tempRender: false,
    policy: { hard_max: 1, target_pages: 1, last_page_min_fill_pct: 75 },
    pages: [pageMetric(1, 96), pageMetric(2, 20)],
  };
  const primaryOnly = computeFit({ ...fitArgs, units: [unit("highlights[0]", 1, 1), unit("skills[0].bullets[0]", 2, 4, "secondary")] });
  assert.equal(primaryOnly.measured.line_units_measured, 1, "secondary-flow units are excluded from the fit line count");
  assert.equal(primaryOnly.delta.lines_to_remove, 0, "secondary-flow lines must not be reported as removable overflow lines");
  assert.equal(primaryOnly.candidates.units_on_overflow_pages.length, 0, "secondary-flow units are not overflow candidates");
  const withPrimary = computeFit({ ...fitArgs, units: [unit("highlights[0]", 1, 1), unit("experiences[0].bullets[0]", 2, 4)] });
  assert.equal(withPrimary.delta.lines_to_remove, 4, "primary-flow overflow is still counted");
  console.log("  ✓ computeFit: data-flow=secondary lines excluded, primary-flow overflow unchanged");

  // ---- defineHtmlTemplate wires meta + honours the flavour list ------------
  const render = defineHtmlTemplate({ ...DESIGN, name: "zz-meta", design: "test-identity" });
  const noFlavours = await render(CONTENT, { flavours: [], outDir: "/tmp" });
  assert.deepEqual(noFlavours.meta, { template: "zz-meta", engine: "html+playwright (presentation) / docx (ats)", design: "test-identity" });
  assert.equal(noFlavours.presentation, undefined);
  assert.equal(noFlavours.ats, undefined);
  console.log("  ✓ defineHtmlTemplate: meta from the design, artefacts only for requested flavours");

  // ---- scaffold refusals ---------------------------------------------------
  await assert.rejects(scaffoldTemplate({ name: "modern", from: "modern", skipVerify: true }), /already exists/, "must refuse an existing template name");
  await assert.rejects(scaffoldTemplate({ name: "_shared", from: "modern", skipVerify: true }), /reserved/, "must refuse a leading underscore");
  await assert.rejects(scaffoldTemplate({ name: SCRATCH, from: "nope-not-a-template", skipVerify: true }), /not found/, "must refuse an unknown --from");
  await assert.rejects(
    scaffoldTemplate({ name: SCRATCH, from: "modern", fonts: ["Nope=NotBundled.woff2"], skipVerify: true }),
    /not bundled/i,
    "must refuse a font that is not bundled",
  );
  assert.equal(await fs.access(path.join(TEMPLATES_DIR, SCRATCH)).then(() => true, () => false), false, "a refused scaffold leaves nothing behind");
  console.log("  ✓ scaffold refusals: existing name, '_' prefix, unknown source, unbundled font");

  // ---- scaffold happy path -------------------------------------------------
  await rmScratch();
  try {
    const result = await scaffoldTemplate({ name: SCRATCH, from: "modern", layout: "skills-columns", skipVerify: true });
    const files = result.files.map((f) => path.basename(f)).sort();
    assert.deepEqual(files, ["quality-checks.md", "render.ts", "rubric.yaml", "sample-content.json", "styles.css", "template.md"]);

    const renderTs = await fs.readFile(path.join(result.dir, "render.ts"), "utf8");
    assert.ok(renderTs.includes(`name: "${SCRATCH}"`), "render.ts name rewritten");
    assert.ok(renderTs.includes(`design: "${SCRATCH}"`), "render.ts design id rewritten");
    assert.ok(renderTs.includes('layout: "skills-columns"'), "render.ts carries the requested layout");
    assert.ok(!renderTs.includes('name: "modern"'), "no trace of the source template identity");

    const rubric = await fs.readFile(path.join(result.dir, "rubric.yaml"), "utf8");
    assert.ok(new RegExp(`^template: ${SCRATCH}$`, "m").test(rubric), "rubric template key rewritten");

    const meta = await fs.readFile(path.join(result.dir, "template.md"), "utf8");
    assert.ok(/^version: 1$/m.test(meta), "template.md starts at version 1");
    assert.ok(new RegExp(`^added_at: ${new Date().toISOString().slice(0, 10)}$`, "m").test(meta), "template.md stamped with today");
    assert.ok(new RegExp(`^template: ${SCRATCH}$`, "m").test(meta), "template.md template key rewritten");

    // The scaffolded design must actually load and render markup.
    const mod = await import(path.resolve(result.dir, "render.ts"));
    const scaffolded = await mod.default(CONTENT, { flavours: [], outDir: "/tmp" });
    assert.equal((scaffolded.meta as Record<string, string>).template, SCRATCH);
    console.log("  ✓ scaffold: six files written, identity rewritten, design loads");
  } finally {
    await rmScratch();
  }

  console.log("template-new.test.ts: all assertions passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
