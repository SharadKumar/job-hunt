/**
 * classic / render.ts — "Executive Editorial" template (EB Garamond serif).
 *
 *   - presentation → shared HTML builder + classic/styles.css + bundled EB
 *     Garamond → Playwright PDF (the designed artefact a human reads).
 *   - ats → the ONE shared plain single-column .docx (_ats-docx.ts).
 *
 * Persona fit: Solution / ServiceNow / Microsoft architects, Delivery Manager —
 * senior consulting / government / executive audiences expecting gravitas.
 * Page budget: preferred 3, hard_max 3 (see rubric.yaml).
 *
 * The render body is shared (`_html-template.ts`); this file is the design.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHtmlTemplate, type HtmlTemplateDefinition } from "../_html-template.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DESIGN: HtmlTemplateDefinition = {
  name: "classic",
  design: "executive-editorial",
  cssPath: path.join(HERE, "styles.css"),
  fonts: [
    { family: "EB Garamond", style: "normal", weightRange: "400 800", file: "EBGaramond-roman.woff2" },
    { family: "EB Garamond", style: "italic", weightRange: "400 700", file: "EBGaramond-italic.woff2" },
  ],
  labels: {
    summary: "Professional Summary",
    impact: "Career Highlights",
    experience: "Professional Experience",
    skills: "Core Skills",
    earlier: "Earlier Experience",
    credentials: "Education",
  },
  sectionOrder: ["summary", "impact", "skills", "experience", "credentials"],
  omitSummaryHeading: true,
  omitImpactHeading: true,
};

export default defineHtmlTemplate(DESIGN);
