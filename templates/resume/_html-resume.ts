/**
 * _html-resume.ts — shared content→HTML builder for the HTML/CSS presentation
 * templates (modern, classic, minimalist). The HTML STRUCTURE is shared (one
 * semantic, single-logical-column, ATS-readable DOM); each template supplies
 * its own visual identity purely through CSS + bundled fonts + section labels.
 * This keeps the three designs DRY and guarantees they stay structurally
 * consistent — the design lives in <template>/styles.css (the signed-off
 * golden target), never in markup.
 *
 * Fonts are embedded as @font-face data URIs (bundled WOFF2) so renders are
 * self-contained + deterministic — independent of host-installed fonts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countryName, displayPhone, displayUrl, fmtDate } from "./_docx-helpers.ts";
import { escapeHtml, fontDataUri, linkifyHtml } from "./_html-helpers.ts";
import { orderedExperiences } from "./_experience-order.ts";
import type { ExperienceFeatured, ExperienceMentioned, ResumeContent, ResumeRenderPolicy } from "./_interface.ts";

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fonts");
const SCREEN_PREVIEW_CSS = `
@media screen {
  body {
    padding: 28px;
  }
}
@media print {
  body {
    padding: 0;
  }
}`;

export type FontFace = { family: string; style: "normal" | "italic"; weightRange: string; file: string };

export type SectionLabels = {
  summary: string;
  impact: string;       // highlights
  experience: string;   // featured
  skills: string;
  earlier: string;      // legacy label; mentioned roles now continue Experience
  credentials?: string;
};

export type HtmlDesign = {
  cssPath: string;          // absolute path to the template's styles.css
  fonts: FontFace[];        // bundled WOFF2 files (under templates/resume/fonts)
  labels: SectionLabels;
  omitSummaryHeading?: boolean;
  omitImpactHeading?: boolean;
  omitEarlierHeading?: boolean;
  sectionOrder?: Array<"summary" | "impact" | "skills" | "experience" | "earlier" | "credentials">;
  /**
   * Page-level flow model. Default `"single"`: one semantic column, every
   * rendered line participates in the page-fit arithmetic.
   *
   * `"skills-columns"` puts ONLY the skill blocks into CSS multi-columns. The
   * columned container is marked `data-flow="secondary"`, which tells
   * `measureDocument`/`computeFit` to exclude those line units from the
   * primary-flow line count — balanced columns are not addable/removable lines
   * in the same sense a single-flow bullet is, so counting them would corrupt
   * "add N lines / remove N lines" advice.
   *
   * DOM order is unchanged, so PDF text extraction (ATS parsers, our own
   * pdftotext gates) still reads the resume in semantic order. Full sidebar /
   * two-column PAGE layouts are deliberately not offered — see README.
   */
  layout?: "single" | "skills-columns";
};

/**
 * Injected BEFORE the template stylesheet (so a template can override it) and
 * only for the layout that needs it — keeping the emitted CSS byte-identical
 * for single-flow templates.
 */
const SKILLS_COLUMNS_CSS = `
.skills-columns {
  column-count: 2;
  column-gap: 7mm;
  column-fill: balance;
}
.skills-columns > .skill {
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
}`;

async function fontFaceCss(fonts: FontFace[]): Promise<string> {
  const faces = await Promise.all(
    fonts.map(async (f) => {
      const uri = await fontDataUri(path.join(FONTS_DIR, f.file));
      return `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weightRange};font-display:block;src:url(${uri}) format('woff2');}`;
    }),
  );
  return faces.join("\n");
}

const SEP = `<span class="sep">·</span>`;

function contactLine(fm: ResumeContent["frontmatter"]): string {
  const country = countryName(fm.location?.country);
  const loc = fm.location ? `${fm.location.city ?? ""}${country ? `, ${country}` : ""}` : "";
  const parts: string[] = [];
  const part = (value: string) => `<span class="contact-part">${escapeHtml(value)}</span>`;
  if (fm.email) parts.push(`<a href="mailto:${fm.email}">${escapeHtml(fm.email)}</a>`);
  if (fm.phone) parts.push(part(displayPhone(fm.phone)));
  if (loc) parts.push(part(loc));
  if (fm.linkedin_url) parts.push(`<a href="${escapeHtml(fm.linkedin_url)}">${escapeHtml(displayUrl(fm.linkedin_url))}</a>`);
  if (fm.github_url) parts.push(`<a href="${escapeHtml(fm.github_url)}">${escapeHtml(displayUrl(fm.github_url))}</a>`);
  return parts.join(SEP);
}

type BuildResumeHtmlOptions = {
  renderPolicy?: ResumeRenderPolicy;
};

/**
 * Every line unit carries `data-unit-path` — a JSON path back into the
 * ResumeContent composition (e.g. `experiences[3].bullets[2]`). This is what
 * makes measurement actionable: resume-page-fill.ts reports "trim
 * experiences[3].bullets[2] to save 1 line" and the caller can edit that exact
 * node in composition.json without re-deriving the mapping by hand.
 */
function featuredBlock(xp: ExperienceFeatured, index: number, renderPolicy: ResumeRenderPolicy = {}): string {
  const where = xp.location ? ` <span class="where">· ${escapeHtml(xp.location)}</span>` : "";
  const showExperienceDates = renderPolicy.show_experience_dates !== false;
  const bullets = xp.bullets.map((b, j) => `<li data-resume-line-unit="true" data-line-unit-kind="experience_bullet" data-unit-path="experiences[${index}].bullets[${j}]" data-resume-bullet="true" data-bullet-kind="experience">${linkifyHtml(b)}</li>`).join("");
  return `<div class="xp" data-unit-block="experiences[${index}]">
    <div class="xp-head">
      <div><span class="role">${escapeHtml(xp.title)}</span>, <span class="org">${escapeHtml(xp.company)}</span>${where}</div>
      ${showExperienceDates ? `<div class="dates">${escapeHtml(xp.date_label ?? `${fmtDate(xp.start)} – ${fmtDate(xp.end)}`)}</div>` : ""}
    </div>
    ${xp.summary ? `<div class="xp-sum" data-resume-line-unit="true" data-line-unit-kind="experience_summary" data-unit-path="experiences[${index}].summary">${linkifyHtml(xp.summary)}</div>` : ""}
    ${bullets ? `<ul>${bullets}</ul>` : ""}
  </div>`;
}

/**
 * A mention renders with the SAME heading row as a featured experience —
 * bold title, company, optional location, and a right-aligned date column in
 * the identical style — followed by its one-liner as a short summary
 * paragraph. The only difference from a featured block is density: no bullet
 * list, and tighter vertical rhythm (`.xp-mention` in each stylesheet).
 *
 * The `earlier_one_liner` line unit is therefore the SUMMARY TEXT ONLY; the
 * role/company/date prefix is no longer part of the measured unit.
 */
function mentionBlock(xp: ExperienceMentioned, index: number, renderPolicy: ResumeRenderPolicy = {}): string {
  const where = xp.location ? ` <span class="where">· ${escapeHtml(xp.location)}</span>` : "";
  const showExperienceDates = renderPolicy.show_experience_dates !== false;
  return `<div class="xp xp-mention" data-unit-block="experiences[${index}]">
    <div class="xp-head">
      <div><span class="role">${escapeHtml(xp.title)}</span>, <span class="org">${escapeHtml(xp.company)}</span>${where}</div>
      ${showExperienceDates ? `<div class="dates">${escapeHtml(xp.date_label ?? `${fmtDate(xp.start)} – ${fmtDate(xp.end)}`)}</div>` : ""}
    </div>
    <div class="xp-sum" data-resume-line-unit="true" data-line-unit-kind="earlier_one_liner" data-unit-path="experiences[${index}].one_liner">${linkifyHtml(xp.one_liner)}</div>
  </div>`;
}

function skillBlock(skill: ResumeContent["skills"][number], index: number): string {
  const items = skill.bullets
    .map((item, j) => `<li data-resume-line-unit="true" data-line-unit-kind="skill_item" data-unit-path="skills[${index}].bullets[${j}]">${linkifyHtml(item.replace(/[.;:!?]+$/u, ""))}</li>`)
    .join("");
  const summary = skill.summary ? ` <span class="skill-summary" data-resume-line-unit="true" data-line-unit-kind="skill_summary" data-unit-path="skills[${index}].summary">${linkifyHtml(skill.summary.replace(/[.;:!?]+$/u, ""))}</span>` : "";
  return `<div class="skill" data-unit-block="skills[${index}]">
    <div class="skill-heading"><span class="skill-name">${escapeHtml(skill.name)}:</span>${summary}</div>
    ${items ? `<ul class="skill-items">${items}</ul>` : ""}
  </div>`;
}

/** Compose the shared resume HTML for a template, styled entirely by `design`. */
export async function buildResumeHtml(content: ResumeContent, design: HtmlDesign, options: BuildResumeHtmlOptions = {}): Promise<string> {
  const [css, ff] = await Promise.all([fs.readFile(design.cssPath, "utf8"), fontFaceCss(design.fonts)]);
  const fm = content.frontmatter;
  const L = design.labels;
  const showContactLine = options.renderPolicy?.show_contact_line !== false;
  const layoutCss = design.layout === "skills-columns" ? `\n${SKILLS_COLUMNS_CSS}` : "";

  // Keep the composition-array index alongside each experience so every
  // rendered line unit can carry a `data-unit-path` that addresses the exact
  // node in composition.json (see featuredBlock/mentionBlock).
  const ordered = orderedExperiences(content.experiences);

  const sectionBlocks: Record<"summary" | "impact" | "skills" | "experience" | "earlier" | "credentials", string> = {
    summary: "",
    impact: "",
    skills: "",
    experience: "",
    earlier: "",
    credentials: "",
  };
  const summaryHeading = design.omitSummaryHeading ? "" : `<h2>${escapeHtml(L.summary)}</h2>`;
  sectionBlocks.summary = `<section class="summary-section">${summaryHeading}<div class="summary" data-resume-line-unit="true" data-line-unit-kind="summary" data-unit-path="summary">${linkifyHtml(content.summary)}</div></section>`;
  if (content.highlights.length) {
    const impactHeading = design.omitImpactHeading ? "" : `<h2>${escapeHtml(L.impact)}</h2>`;
    sectionBlocks.impact = `<section class="impact-section">${impactHeading}<ul>${content.highlights.map((h, i) => `<li data-resume-line-unit="true" data-line-unit-kind="impact_bullet" data-unit-path="highlights[${i}]" data-resume-bullet="true" data-bullet-kind="impact">${linkifyHtml(h)}</li>`).join("")}</ul></section>`;
  }
  if (ordered.length) {
    const experienceRows = ordered.map(({ xp, index }) => xp.placement === "feature"
      ? featuredBlock(xp, index, options.renderPolicy)
      : mentionBlock(xp, index, options.renderPolicy)).join("");
    sectionBlocks.experience = `<section><h2>${escapeHtml(L.experience)}</h2>${experienceRows}</section>`;
  }
  if (content.skills.length) {
    const skillBlocks = content.skills
      .map((skill, k) => skillBlock(skill, k))
      .join("");
    // `data-flow="secondary"` is the contract with measure-document/fit-core:
    // these lines are laid out by the column algorithm, not by the single flow,
    // so they are measured but excluded from the page-fit line arithmetic.
    const blocks = design.layout === "skills-columns"
      ? `<div class="skills-columns" data-flow="secondary">${skillBlocks}</div>`
      : skillBlocks;
    const additional = content.additional_skills_summary
      ? `<div class="skills-additional" data-resume-line-unit="true" data-line-unit-kind="additional_skills_summary" data-unit-path="additional_skills_summary">${linkifyHtml(content.additional_skills_summary)}</div>`
      : "";
    sectionBlocks.skills = `<section><h2>${escapeHtml(L.skills)}</h2>${blocks}${additional}</section>`;
  }
  if (content.credentials?.length) {
    sectionBlocks.credentials = `<section><h2>${escapeHtml(L.credentials ?? "Education")}</h2><ul>${content.credentials.map((credential, i) => `<li data-resume-line-unit="true" data-line-unit-kind="credential" data-unit-path="credentials[${i}]">${linkifyHtml(credential)}</li>`).join("")}</ul></section>`;
  }
  const order = design.sectionOrder ?? ["summary", "impact", "experience", "skills", "earlier", "credentials"];
  const sections = order.map((section) => sectionBlocks[section]).filter(Boolean);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title></title>
<style>${ff}${layoutCss}\n${css}\n${SCREEN_PREVIEW_CSS}</style></head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(fm.name)}</h1>
      ${content.headline ? `<div class="tagline">${escapeHtml(content.headline)}</div>` : ""}
    </div>
  </header>
  ${showContactLine ? `<div class="contact">${contactLine(fm)}</div>` : ""}
  ${sections.join("\n  ")}
</body></html>`;
}
