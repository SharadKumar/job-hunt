/**
 * _ats-docx.ts — the ONE shared ATS-safe .docx renderer for every positioning.
 *
 * The beautiful, designed artefact is the HTML→PDF presentation flavour. This
 * is its plain-clothes twin: a single-column, standard-heading, table-free,
 * image-free .docx that any ATS (incl. legacy Taleo/iCIMS) parses cleanly. ATS
 * ignores design, so there is no per-template variation here — one renderer
 * serves all. Contact + in-prose links stay clickable via contactRuns /
 * linkifyRuns (shared with the docx P3.1 work).
 *
 * Standard headings (Professional Summary / Career Highlights / Core Skills /
 * Professional Experience / Education) maximise recogniser hit-rate.
 */

import {
  AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat,
  PageOrientation, Paragraph, TabStopPosition, TabStopType, TextRun,
} from "docx";
import { A4, contactRuns, fmtDate, linkifyRuns, writeDocx } from "./_docx-helpers.ts";
import { orderedExperiences } from "./_experience-order.ts";
import type { ExperienceFeatured, ExperienceMentioned, ResumeContent, ResumeRenderPolicy } from "./_interface.ts";

const MARGINS = { top: 1080, right: 1080, bottom: 1080, left: 1080 }; // 0.75"
const FONT = "Arial"; // ubiquitous, ATS-safe; design lives in the PDF
const TEXT = "111111";
const MUTED = "555555";
const RULE = "BBBBBB";
const BULLET_REF = "atsBullets";

function nameH1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, bold: true, size: 40, font: FONT })], // 20pt
  });
}

function contactLine(fm: ResumeContent["frontmatter"]): Paragraph {
  return new Paragraph({
    spacing: { after: 200 },
    children: contactRuns(fm, { separator: "  |  ", size: 20, color: MUTED, font: FONT }),
  });
}

function sectionH2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 3 } },
    children: [new TextRun({ text, bold: true, size: 24, font: FONT })], // 12pt
  });
}

function bodyPara(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 120, line: 276 }, children: linkifyRuns(text, { size: 21, font: FONT, color: TEXT }) });
}

function bulletPara(text: string): Paragraph {
  return new Paragraph({ numbering: { reference: BULLET_REF, level: 0 }, spacing: { after: 70, line: 276 }, children: linkifyRuns(text, { size: 21, font: FONT, color: TEXT }) });
}

function featuredBlock(xp: ExperienceFeatured, renderPolicy: ResumeRenderPolicy = {}): Paragraph[] {
  const left = `${xp.title}, ${xp.company}${xp.location ? `, ${xp.location}` : ""}`;
  const right = xp.date_label ?? `${fmtDate(xp.start)} – ${fmtDate(xp.end)}`;
  const showExperienceDates = renderPolicy.show_experience_dates !== false;
  const head = new Paragraph({
    spacing: { before: 150, after: 50 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: left, bold: true, size: 22, font: FONT, color: TEXT }),
      ...(showExperienceDates ? [
        new TextRun({ text: "\t" }),
        new TextRun({ text: right, italics: true, size: 20, color: MUTED, font: FONT }),
      ] : []),
    ],
  });
  const out = [head];
  if (xp.summary) out.push(bodyPara(xp.summary));
  for (const b of xp.bullets) out.push(bulletPara(b));
  return out;
}

/**
 * A mention gets the same heading row as a featured block — bold role/company
 * on the left, the date range right-aligned at the same tab stop — followed by
 * the one-liner as a short summary paragraph. No parentheses, no colon-joined
 * prefix; only the density differs from `featuredBlock` (no bullets, tighter
 * spacing).
 */
function mentionBlock(xp: ExperienceMentioned, renderPolicy: ResumeRenderPolicy = {}): Paragraph[] {
  const left = `${xp.title}, ${xp.company}${xp.location ? `, ${xp.location}` : ""}`;
  const right = xp.date_label ?? `${fmtDate(xp.start)} – ${fmtDate(xp.end)}`;
  const showExperienceDates = renderPolicy.show_experience_dates !== false;
  const head = new Paragraph({
    spacing: { before: 110, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: left, bold: true, size: 22, font: FONT, color: TEXT }),
      ...(showExperienceDates ? [
        new TextRun({ text: "\t" }),
        new TextRun({ text: right, italics: true, size: 20, color: MUTED, font: FONT }),
      ] : []),
    ],
  });
  const summary = new Paragraph({
    spacing: { after: 60, line: 276 },
    children: linkifyRuns(xp.one_liner, { size: 21, font: FONT, color: TEXT }),
  });
  return [head, summary];
}

function buildAtsDocument(content: ResumeContent, renderPolicy: ResumeRenderPolicy = {}): Document {
  const c: Paragraph[] = [];
  c.push(nameH1(content.frontmatter.name));
  if (renderPolicy.show_contact_line !== false) c.push(contactLine(content.frontmatter));

  c.push(sectionH2("Professional Summary"));
  c.push(bodyPara(content.summary));

  if (content.highlights.length) {
    c.push(sectionH2("Career Highlights"));
    for (const h of content.highlights) c.push(bulletPara(h));
  }

  if (content.skills.length) {
    c.push(sectionH2("Core Skills"));
    for (const s of content.skills) {
      c.push(new Paragraph({
        spacing: { before: 120, after: 50 },
        children: [
          new TextRun({ text: `${s.name}: `, bold: true, size: 21, font: FONT, color: TEXT }),
          new TextRun({ text: s.bullets.join(", "), size: 21, font: FONT, color: TEXT }),
        ],
      }));
    }
    if (content.additional_skills_summary) c.push(bodyPara(content.additional_skills_summary));
  }

  const ordered = orderedExperiences(content.experiences);

  if (ordered.length) {
    c.push(sectionH2("Professional Experience"));
    for (const { xp } of ordered) {
      if (xp.placement === "feature") c.push(...featuredBlock(xp, renderPolicy));
      else c.push(...mentionBlock(xp, renderPolicy));
    }
  }
  if (content.credentials?.length) {
    c.push(sectionH2("Education"));
    for (const credential of content.credentials) c.push(bulletPara(credential));
  }

  return new Document({
    creator: "resume-writer",
    title: "",
    styles: {
      default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 40, bold: true }, paragraph: { spacing: { after: 60 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 24, bold: true }, paragraph: { spacing: { before: 220, after: 80 }, outlineLevel: 1 } },
      ],
    },
    numbering: {
      config: [{
        reference: BULLET_REF,
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 260 } } } }],
      }],
    },
    sections: [{
      properties: { page: { size: { width: A4.width, height: A4.height, orientation: PageOrientation.PORTRAIT }, margin: MARGINS } },
      children: c,
    }],
  });
}

/** Render the shared ATS-safe .docx for any positioning. */
export async function renderAtsDocx(content: ResumeContent, outDocx: string, renderPolicy: ResumeRenderPolicy = {}): Promise<void> {
  await writeDocx(buildAtsDocument(content, renderPolicy), outDocx);
}
