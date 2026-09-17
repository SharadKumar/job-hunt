/**
 * modern-columns / render.ts — scaffolded from 'modern' on 2026-09-10.
 *
 *   - presentation → shared HTML builder + modern-columns/styles.css + bundled
 *     fonts → Playwright PDF (the designed artefact a human reads).
 *   - ats → the ONE shared plain single-column .docx (_ats-docx.ts).
 *
 * The render body is shared (`_html-template.ts`); this file is the design.
 * Edit styles.css for the visual identity, template.md for persona fit and
 * composition constraints, and rubric.yaml for the line-unit budgets — then
 * regenerate the golden.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHtmlTemplate, type HtmlTemplateDefinition } from "../_html-template.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DESIGN: HtmlTemplateDefinition = {
  name: "modern-columns",
  design: "modern-columns",
  cssPath: path.join(HERE, "styles.css"),
  fonts: [
    { family: "EB Garamond", style: "normal", weightRange: "400 800", file: "EBGaramond-roman.woff2" },
    { family: "Inter", style: "normal", weightRange: "100 900", file: "Inter-roman.woff2" },
    { family: "Inter", style: "italic", weightRange: "100 900", file: "Inter-italic.woff2" },
  ],
  labels: { summary: "Summary", impact: "Selected Impact", experience: "Experience", skills: "Skills", earlier: "Earlier", credentials: "Education" },
  omitSummaryHeading: true,
  omitImpactHeading: true,
  omitEarlierHeading: true,
  sectionOrder: ["summary", "impact", "skills", "experience", "credentials"],
  layout: "skills-columns",
};

export default defineHtmlTemplate(DESIGN);
