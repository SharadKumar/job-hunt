/**
 * minimalist / render.ts — "Bare" template (Arimo, Helvetica-metric).
 *
 *   - presentation → shared HTML builder + minimalist/styles.css + bundled
 *     Arimo → Playwright PDF (the designed artefact a human reads).
 *   - ats → the ONE shared plain single-column .docx (_ats-docx.ts).
 *
 * Persona fit: fractional-cto / design-aware companies / founder-network
 * advisory. Page budget: preferred 2, hard_max 2 (see rubric.yaml) — restraint
 * is the statement.
 *
 * The render body is shared (`_html-template.ts`); this file is the design.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHtmlTemplate, type HtmlTemplateDefinition } from "../_html-template.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DESIGN: HtmlTemplateDefinition = {
  name: "minimalist",
  design: "bare",
  cssPath: path.join(HERE, "styles.css"),
  fonts: [
    { family: "Arimo", style: "normal", weightRange: "400", file: "Arimo-regular.woff2" },
    { family: "Arimo", style: "normal", weightRange: "700", file: "Arimo-bold.woff2" },
    { family: "Arimo", style: "italic", weightRange: "400", file: "Arimo-italic.woff2" },
  ],
  labels: { summary: "Summary", impact: "Highlights", experience: "Experience", skills: "Skills", earlier: "Earlier" },
};

export default defineHtmlTemplate(DESIGN);
