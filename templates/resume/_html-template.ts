/**
 * _html-template.ts — the ONE renderer body every HTML/CSS presentation
 * template shares.
 *
 * Before this existed, `classic/render.ts`, `minimalist/render.ts` and
 * `modern/render.ts` each carried a byte-for-byte identical `render` function
 * and differed only in a `HtmlDesign` object plus two `meta` strings. Any fix
 * to the render path (shared browser session, orphan repair, artefact naming)
 * had to be applied three times or silently drift.
 *
 * A template now declares WHAT it is (fonts, stylesheet, section labels,
 * layout) and `defineHtmlTemplate` supplies HOW it renders:
 *
 *   presentation → `buildResumeHtml` + the template's styles.css + bundled
 *                  fonts → Playwright PDF (the designed artefact a human reads)
 *   ats          → the ONE shared plain single-column .docx (`_ats-docx.ts`)
 *
 * Adding a template is therefore a data change, not a code change — which is
 * what makes `npm run resume:template:new` a safe scaffold.
 */

import path from "node:path";
import { renderAtsDocx } from "./_ats-docx.ts";
import { renderHtmlToPdf } from "./_html-helpers.ts";
import { buildResumeHtml, type HtmlDesign } from "./_html-resume.ts";
import type { RenderResult, ResumeTemplate } from "./_interface.ts";

export type HtmlTemplateDefinition = HtmlDesign & {
  /** Template directory name; surfaced as `meta.template`. */
  name: string;
  /** Short visual-identity slug; surfaced as `meta.design` (e.g. "editorial"). */
  design: string;
};

const ENGINE = "html+playwright (presentation) / docx (ats)";

/**
 * Build a `ResumeTemplate` from a design declaration. Each template's
 * `render.ts` is then just the design object plus
 * `export default defineHtmlTemplate(DESIGN)`.
 */
export function defineHtmlTemplate(definition: HtmlTemplateDefinition): ResumeTemplate {
  const { name, design, ...htmlDesign } = definition;

  return async function render(content, options): Promise<RenderResult> {
    const prefix = options.filenamePrefix ?? "cv";
    const result: RenderResult = {
      warnings: [],
      meta: { template: name, engine: ENGINE, design },
    };

    if (options.flavours.includes("presentation")) {
      const html = await buildResumeHtml(content, htmlDesign, { renderPolicy: options.renderPolicy });
      const pdfPath = path.join(options.outDir, `${prefix}.pdf`);
      const htmlPath = path.join(options.outDir, `${prefix}.html`);
      const r = await renderHtmlToPdf(html, { outPdf: pdfPath, outHtml: htmlPath, session: options.session });
      if (r.ok) result.presentation = { pdf: pdfPath, html: htmlPath };
      else result.warnings!.push(`presentation pdf failed: ${r.reason ?? "unknown"}`);
    }

    if (options.flavours.includes("ats")) {
      const docxPath = path.join(options.outDir, `${prefix}.docx`);
      await renderAtsDocx(content, docxPath, options.renderPolicy);
      result.ats = { docx: docxPath };
    }

    return result;
  };
}
