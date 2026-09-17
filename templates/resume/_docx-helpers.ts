/**
 * _docx-helpers.ts — shared docx primitives for the ATS flavour (_ats-docx.ts).
 *
 * Patterns reused from Anthropic docx skill:
 *   ~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/docx/SKILL.md
 *   - explicit page size (A4 DXA), never default
 *   - LevelFormat.BULLET for bullets, never unicode
 *   - never use \n; separate Paragraph elements
 *
 * The ATS docx builder composes a `Document` from these primitives and writes
 * it with writeDocx(). There is no docx→PDF path: the presentation PDF is
 * rendered from HTML/CSS by Playwright (see _html-helpers.ts), so the old
 * LibreOffice `convertDocxToPdf` shell-out was removed on 2026-09-10.
 */

import { Document, ExternalHyperlink, Packer, TextRun } from "docx";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResumeContent } from "./_interface.ts";

// A4 DXA dimensions. 1440 DXA = 1 inch.
export const A4 = { width: 11906, height: 16838 } as const;

/** Format `YYYY-MM` (or "current") → "Mon YYYY" / "Present". */
export function fmtDate(yyyyMM: string): string {
  if (!yyyyMM || yyyyMM === "current") return "Present";
  const [y, m] = yyyyMM.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1] ?? m} ${y}`;
}

export function countryName(country?: string): string {
  if (!country) return "";
  const known: Record<string, string> = { AU: "Australia" };
  return known[country] ?? country;
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");
}

export function displayPhone(phone: string): string {
  const trimmed = phone.trim();
  const auMobile = trimmed.match(/^\+61\s*([45])(\d{2})\s*(\d{3})\s*(\d{3})$/);
  if (auMobile) return `0${auMobile[1]}${auMobile[2]} ${auMobile[3]} ${auMobile[4]}`;
  return trimmed;
}

/** Joined contact line as plain text: email | phone | location | URLs.
 *  Used for the markdown flavour and anywhere clickable links aren't supported. */
export function contactText(fm: ResumeContent["frontmatter"], separator = " | "): string {
  const country = countryName(fm.location?.country);
  const loc = fm.location ? `${fm.location.city ?? ""}${country ? `, ${country}` : ""}` : "";
  return [
    fm.email,
    fm.phone ? displayPhone(fm.phone) : "",
    loc,
    fm.linkedin_url ? displayUrl(fm.linkedin_url) : "",
    fm.github_url ? displayUrl(fm.github_url) : "",
  ].filter(Boolean).join(separator);
}

/**
 * Contact line as docx runs, with email / LinkedIn / GitHub rendered as live
 * ExternalHyperlinks, so the links stay clickable in Word and in any downstream
 * PDF conversion. Links are styled the SAME colour as the rest of the
 * contact line (no garish blue / underline) so clickability is added without
 * disturbing the template's visual identity.
 *
 * Order: email · phone · location · LinkedIn URL · GitHub URL.
 * Email → mailto:, LinkedIn/GitHub → the readable profile URL.
 *
 * Each template passes its own typography (size / colour / font / separator).
 */
export function contactRuns(
  fm: ResumeContent["frontmatter"],
  style: { separator?: string; size: number; color: string; font: string },
): (TextRun | ExternalHyperlink)[] {
  const sep = style.separator ?? "  ·  ";
  const runProps = { size: style.size, color: style.color, font: style.font };
  const text = (t: string) => new TextRun({ text: t, ...runProps });
  const link = (label: string, href: string) =>
    new ExternalHyperlink({ link: href, children: [new TextRun({ text: label, ...runProps })] });

  const country = countryName(fm.location?.country);
  const loc = fm.location ? `${fm.location.city ?? ""}${country ? `, ${country}` : ""}` : "";

  // Each segment is a run/hyperlink; plain strings become text segments.
  const segments: (TextRun | ExternalHyperlink)[] = [];
  if (fm.email) segments.push(link(fm.email, `mailto:${fm.email}`));
  if (fm.phone) segments.push(text(displayPhone(fm.phone)));
  if (loc) segments.push(text(loc));
  if (fm.linkedin_url) segments.push(link(displayUrl(fm.linkedin_url), fm.linkedin_url));
  if (fm.github_url) segments.push(link(displayUrl(fm.github_url), fm.github_url));

  // Interleave separators.
  const out: (TextRun | ExternalHyperlink)[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) out.push(text(sep));
    out.push(seg);
  });
  return out;
}

// URLs (http/https) and bare product domains with a curated TLD set. The TLD
// allow-list keeps "Node.js" / "etc." / "12.5%" from being mistaken for links
// while still catching example.org, example.com, github.com, etc.
const LINK_RE = /(https?:\/\/[^\s)]+|(?:[\w-]+\.)+(?:ai|agency|com|io|dev|app|co|net|org|tech|cloud)\b(?:\/[^\s)]*)?)/gi;
// docx run options we thread through to keep each template's typography.
type RunProps = { size?: number; color?: string; font?: string; bold?: boolean; italics?: boolean };

/**
 * Turn a string into docx runs, wrapping any URL / bare product domain in a
 * live ExternalHyperlink (preserved as a clickable /URI in the PDF). Links
 * inherit the surrounding run's typography — clickable without visual noise.
 * Bare domains get an implied https:// scheme for the href. Returns a single
 * plain TextRun when there are no links.
 */
export function linkifyRuns(text: string, props: RunProps = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    let token = m[0];
    // Pull trailing sentence punctuation back out of the link (URLs grab it greedily).
    const trail = token.match(/[.,;:)\]]+$/)?.[0] ?? "";
    if (trail) token = token.slice(0, -trail.length);
    if (start > last) out.push(new TextRun({ text: text.slice(last, start), ...props }));
    const href = /^https?:\/\//i.test(token) ? token : `https://${token}`;
    out.push(new ExternalHyperlink({ link: href, children: [new TextRun({ text: token, ...props })] }));
    if (trail) out.push(new TextRun({ text: trail, ...props }));
    last = start + m[0].length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...props }));
  return out.length ? out : [new TextRun({ text, ...props })];
}

export async function writeDocx(doc: Document, outDocx: string): Promise<void> {
  await fs.mkdir(path.dirname(outDocx), { recursive: true });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(outDocx, buffer);
}
