/**
 * _html-helpers.ts — shared HTML/CSS → PDF renderer for design-forward
 * (presentation-flavour) templates, via Playwright headless Chromium.
 *
 * Why this medium: docx-js has no layout engine — no grid, no real vertical
 * rhythm, no letter-spacing, coarse spacing. A browser IS a layout engine, so
 * the presentation PDF is rendered from an HTML/CSS template. The same HTML/CSS
 * is the human-signed-off target AND the runtime renderer, so the two cannot
 * drift. The ATS-safe .docx is produced separately (see _ats-docx.ts).
 *
 * Determinism: the template owns the page via `@page { size: A4; margin: … }`
 * in CSS; we render with `preferCSSPageSize: true` and zero PDF margins so the
 * CSS is authoritative. Fonts should be embedded by the template (bundled
 * WOFF2 + @font-face) so output doesn't depend on host-installed fonts. We
 * `goto(file://…)` the written HTML (not setContent) so @font-face file URLs
 * and any relative assets resolve, and wait for `document.fonts.ready` before
 * printing.
 */

import { chromium, type Browser, type Page } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { printContentViewport, type BrowserSession } from "../../tools/resume/lib/browser-session.ts";
import { repairPageBreakOrphans } from "../../tools/resume/lib/measure-document.ts";

export type HtmlPdfResult = {
  ok: boolean;
  htmlPath: string;
  pdfPath: string;
  reason?: string;
  /**
   * When rendered through a shared BrowserSession, the page is left open on
   * the repaired document (print media, print viewport) so the caller can
   * measure it without a second navigation. Absent for one-shot renders.
   */
  page?: Page;
};

/**
 * Render a full HTML document string to an A4 PDF. Writes the HTML alongside
 * (it's the `presentation.html` artefact and the resolution base for fonts/
 * assets), then prints it to PDF. The HTML's own `@page` CSS controls size +
 * margins.
 *
 * Viewport: the orphan repair (`repairPageBreakOrphans`) decides page breaks
 * from element geometry, so it MUST run at the print content box — the same
 * viewport every downstream check measures at. Before 2026-09-10 it ran at
 * Playwright's default 1280×720, which wraps fewer lines than A4 and could
 * disagree with resume:evaluate about where pages break.
 *
 * Pass `opts.session` to reuse an already-launched browser (one launch per
 * audit cycle). Without it a private browser is launched and closed here.
 */
export async function renderHtmlToPdf(
  html: string,
  opts: { outPdf: string; outHtml?: string; session?: BrowserSession },
): Promise<HtmlPdfResult> {
  const pdfPath = opts.outPdf;
  const htmlPath = opts.outHtml ?? pdfPath.replace(/\.pdf$/, ".html");
  await fs.mkdir(path.dirname(pdfPath), { recursive: true });
  await fs.writeFile(htmlPath, html);

  let ownBrowser: Browser | undefined;
  try {
    let page: Page;
    if (opts.session) {
      page = opts.session.page;
    } else {
      ownBrowser = await chromium.launch({ headless: true });
      page = await ownBrowser.newPage();
    }
    await page.setViewportSize(printContentViewport(html));
    await page.emulateMedia({ media: "print" });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    // Ensure @font-face fonts are loaded before we snapshot to PDF.
    await page.evaluate(() => (document as any).fonts?.ready);
    await repairPageBreakOrphans(page);
    const repairedHtml = await page.content();
    await fs.writeFile(htmlPath, repairedHtml);
    await page.pdf({
      path: pdfPath,
      printBackground: true,       // honour background colours / blocks
      preferCSSPageSize: true,     // the template's @page rules are authoritative
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return opts.session ? { ok: true, htmlPath, pdfPath, page } : { ok: true, htmlPath, pdfPath };
  } catch (e) {
    return { ok: false, htmlPath, pdfPath, reason: (e as Error).message };
  } finally {
    await ownBrowser?.close();
  }
}

/** Read a font file and return a `data:` URI for self-contained @font-face embedding. */
export async function fontDataUri(filePath: string, mime = "font/woff2"): Promise<string> {
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// URLs + bare product domains (curated TLDs) — mirrors linkifyRuns in
// _docx-helpers.ts so the HTML PDF and the ATS docx linkify identically.
const HTML_LINK_RE = /(https?:\/\/[^\s<)]+|(?:[\w-]+\.)+(?:ai|agency|com|io|dev|app|co|net|org|tech|cloud)\b(?:\/[^\s<)]*)?)/gi;

/**
 * Escape `text`, then wrap any URL / bare product domain in an `<a href>`.
 * Bare domains get an implied https:// scheme. Trailing sentence punctuation is
 * kept outside the link. Use for summary / bullet / one-liner prose so
 * example.org, example.com, etc. render as live links in the PDF.
 */
export function linkifyHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(HTML_LINK_RE, (m) => {
    const trail = m.match(/[.,;:)\]]+$/)?.[0] ?? "";
    const token = trail ? m.slice(0, -trail.length) : m;
    const href = /^https?:\/\//i.test(token) ? token : `https://${token}`;
    return `<a href="${href}">${token}</a>${trail}`;
  });
}
