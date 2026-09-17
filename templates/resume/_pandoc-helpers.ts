/**
 * _pandoc-helpers.ts — the canonical ResumeContent → markdown assembler.
 *
 * Historically this also shelled out to pandoc (docx) and chrome-headless
 * (PDF). No template uses those paths any more — presentation PDFs come from
 * HTML/CSS via Playwright and the ATS docx is built in-process by the `docx`
 * library — so the pandoc/chrome shell-outs were deleted on 2026-09-10 and
 * pandoc is NOT a dependency of this harness. Only `assembleMarkdown` survives;
 * it produces the `.md` artefact for resume-renderer.ts and resume-audit.ts.
 *
 * The filename is kept so existing imports keep resolving.
 */

import { contactText } from "./_docx-helpers.ts";
import { orderedExperiences } from "./_experience-order.ts";
import type { ResumeContent, ResumeRenderPolicy } from "./_interface.ts";

/** Reverse the YYYY-MM date to a human-readable "Mon YYYY". */
function fmtDate(yyyyMM: string): string {
  if (!yyyyMM || yyyyMM === "current") return "Present";
  const [y, m] = yyyyMM.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1] ?? m} ${y}`;
}

/**
 * Compose ResumeContent into a canonical markdown string. Templates can
 * override by writing their own assembler; this is the default.
 */
export function assembleMarkdown(content: ResumeContent, renderPolicy: ResumeRenderPolicy = {}): string {
  const lines: string[] = [];
  const { frontmatter: fm } = content;
  lines.push(`# ${fm.name}`);
  if (renderPolicy.show_contact_line !== false) lines.push(contactText(fm));
  lines.push("");

  lines.push("## Professional Summary");
  lines.push("");
  lines.push(content.summary);
  lines.push("");

  if (content.highlights.length) {
    lines.push("## Career Highlights");
    lines.push("");
    for (const h of content.highlights) lines.push(`- ${h}`);
    lines.push("");
  }

  if (content.skills.length) {
    lines.push("## Skills");
    lines.push("");
    for (const s of content.skills) {
      lines.push(`**${s.name}**`);
      lines.push("");
      for (const b of s.bullets) lines.push(`- ${b}`);
      lines.push("");
    }
    if (content.additional_skills_summary) {
      lines.push(content.additional_skills_summary);
      lines.push("");
    }
  }

  // Placement controls density; all entries still render in one true reverse-
  // chronological sequence so compact roles cannot appear after older features.
  const ordered = orderedExperiences(content.experiences);

  lines.push("## Professional Experience");
  lines.push("");
  for (const { xp } of ordered) {
    if (xp.placement === "feature") {
      lines.push(`### ${xp.title}, ${xp.company}${xp.location ? `, ${xp.location}` : ""}`);
      if (renderPolicy.show_experience_dates !== false) {
        lines.push(`*${xp.date_label ?? `${fmtDate(xp.start)} – ${fmtDate(xp.end)}`}*`);
        lines.push("");
      }
      if (xp.summary) {
        lines.push(xp.summary);
        lines.push("");
      }
      for (const b of xp.bullets) lines.push(`- ${b}`);
      lines.push("");
    } else {
      // Mentions use the SAME heading shape as a featured block (role, company,
      // then the date line), with the one-liner as a short summary paragraph —
      // no parentheses, no colon-joined prefix. Only the density differs.
      lines.push(`### ${xp.title}, ${xp.company}${xp.location ? `, ${xp.location}` : ""}`);
      if (renderPolicy.show_experience_dates !== false) {
        lines.push(`*${xp.date_label ?? `${fmtDate(xp.start)} – ${fmtDate(xp.end)}`}*`);
        lines.push("");
      }
      lines.push(xp.one_liner);
      lines.push("");
    }
  }
  if (ordered.length) lines.push("");

  if (content.credentials?.length) {
    lines.push("## Education");
    lines.push("");
    for (const credential of content.credentials) lines.push(`- ${credential}`);
    lines.push("");
  }

  return lines.join("\n");
}
