/**
 * modern / render.ts — "Editorial" template (signed off 2026-05-31).
 *
 * Two flavours, two media:
 *   - presentation → shared HTML builder + this template's styles.css + bundled
 *     Inter → Playwright PDF. The world-class artefact; design lives in
 *     styles.css (the golden target).
 *   - ats → the ONE shared plain single-column .docx (_ats-docx.ts).
 *
 * Persona fit: applied-ai, and any operator/tech-leadership audience that
 * reads the PDF. Page budget: preferred 2, hard_max 3 (see rubric.yaml).
 *
 * The render body is shared (`_html-template.ts`); this file is the design.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHtmlTemplate, type HtmlTemplateDefinition } from "../_html-template.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DESIGN: HtmlTemplateDefinition = {
  name: "modern",
  design: "editorial",
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
};

export default defineHtmlTemplate(DESIGN);
