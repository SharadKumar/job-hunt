/**
 * measure-document.ts — every DOM measurement the resume checks need, taken in
 * ONE `page.evaluate` on an already-open print-viewport page.
 *
 * Replaces four near-identical browser blobs in resume-evaluate.ts and one in
 * resume-page-fill.ts. Metric shapes are unchanged so the checks that consume
 * them (evaluate-core, fit-core) produce byte-identical issues.
 *
 * Also owns `repairPageBreakOrphans`, the pre-print DOM pass that moves a
 * section / experience whose heading would be stranded at a page foot. It
 * must run at the SAME viewport the checks measure at (see browser-session).
 */

import type { Page } from "playwright";

export type BulletLineFillMetric = {
  kind: string;
  text: string;
  lineCount: number;
  availableWidth: number;
  lineFillPct: number[];
  lastLineFillPct: number;
};

export type LineUnitMetric = BulletLineFillMetric & {
  unitPath: string | null;
  /**
   * Which flow laid this unit out. `"secondary"` means it sits inside a
   * `data-flow="secondary"` container (today: a `layout: "skills-columns"`
   * skills block). Those lines are measured but excluded from the page-fit
   * arithmetic in fit-core, because column-balanced lines are not
   * one-for-one addable/removable the way single-flow lines are.
   * Absent/`"primary"` for every single-flow template.
   */
  flow?: "primary" | "secondary";
  charCount: number;
  charsPerRenderedLine: number[];
  lineHeightPx: number;
  /** Filled in by pdf-metrics.assignPages once the PDF word stream is known. */
  page?: number;
  spansPages?: boolean;
};

export type HeadingOrphanMetric = {
  heading: string;
  nextText: string;
  headingPage: number;
  nextPage: number;
};

export type ExperienceStartOrphanMetric = HeadingOrphanMetric;

export type DomMetrics = {
  bullets: BulletLineFillMetric[];
  lineUnits: LineUnitMetric[];
  headingOrphans: HeadingOrphanMetric[];
  experienceStartOrphans: ExperienceStartOrphanMetric[];
  pageContentHeightPx: number;
};

// Shared in-page helpers, injected as source so the evaluate string stays a
// single round trip. Kept as a string (not a function) because Playwright
// serialises functions by source and the helpers reference each other.
const IN_PAGE_HELPERS = `
  const PX_PER_MM = 96 / 25.4;
  const PX_PER_IN = 96;

  function parseLength(value) {
    const match = String(value || "").trim().match(/^([\\d.]+)(px|pt|mm|cm|in)$/i);
    if (!match) return null;
    const amount = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "px") return amount;
    if (unit === "pt") return amount * (96 / 72);
    if (unit === "mm") return amount * PX_PER_MM;
    if (unit === "cm") return amount * PX_PER_MM * 10;
    if (unit === "in") return amount * PX_PER_IN;
    return null;
  }

  function expandMargin(values) {
    if (values.length === 1) return [values[0], values[0], values[0], values[0]];
    if (values.length === 2) return [values[0], values[1], values[0], values[1]];
    if (values.length === 3) return [values[0], values[1], values[2], values[1]];
    return [values[0] || 0, values[1] || 0, values[2] || 0, values[3] || 0];
  }

  function pageContentHeight() {
    let pageRule = "";
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(sheet.cssRules || []); } catch { rules = []; }
      for (const rule of rules) {
        if (String(rule.cssText || "").trim().startsWith("@page")) pageRule += " " + rule.cssText;
      }
    }
    const sizeText = pageRule.match(/size\\s*:\\s*([^;}{]+)/i)?.[1] || "A4";
    const isLetter = /\\bletter\\b/i.test(sizeText);
    const pageHeight = isLetter ? 11 * PX_PER_IN : 297 * PX_PER_MM;
    const marginText = pageRule.match(/margin\\s*:\\s*([^;}{]+)/i)?.[1] || "0";
    const margins = marginText.trim().split(/\\s+/).map(parseLength).filter((value) => value !== null);
    const [top, , bottom] = expandMargin(margins.length ? margins : [0]);
    return Math.max(1, pageHeight - top - bottom);
  }

  function nextVisibleElement(element) {
    let next = element.nextElementSibling;
    while (next) {
      const rect = next.getBoundingClientRect();
      if (rect.width > 0.5 && rect.height > 0.5 && (next.textContent || "").trim()) return next;
      next = next.nextElementSibling;
    }
    return null;
  }

  function pageIndex(y, height) {
    return Math.floor(Math.max(0, y + window.scrollY + 0.5) / height);
  }

  function textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      if (node.textContent && node.textContent.trim()) nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  }

  function simpleRect(rect) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function mergeLineRects(rects) {
    const lines = [];
    for (const rect of rects.filter((r) => r.width > 0.5 && r.height > 0.5).sort((a, b) => a.top - b.top || a.left - b.left)) {
      const existing = lines.find((line) => Math.abs(line.top - rect.top) < 2 || Math.abs((line.top + line.height / 2) - (rect.top + rect.height / 2)) < 2);
      if (!existing) {
        lines.push(simpleRect(rect));
      } else {
        const left = Math.min(existing.left, rect.left);
        const top = Math.min(existing.top, rect.top);
        const right = Math.max(existing.right, rect.right);
        const bottom = Math.max(existing.bottom, rect.bottom);
        existing.left = left;
        existing.top = top;
        existing.right = right;
        existing.bottom = bottom;
        existing.width = right - left;
        existing.height = bottom - top;
      }
    }
    return lines;
  }

  function lineGeometry(item) {
    const style = getComputedStyle(item);
    const itemRect = item.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
    const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
    const availableWidth = Math.max(1, itemRect.width - paddingLeft - paddingRight);
    const rects = [];
    for (const node of textNodes(item)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()));
      range.detach();
    }
    const lines = mergeLineRects(rects);
    const text = (item.textContent || "").replace(/\\s+/g, " ").trim();
    const lineFillPct = lines.map((line) => Math.max(0, Math.min(100, (line.width / availableWidth) * 100)));
    const lh = Number.parseFloat(style.lineHeight);
    return { style, lines, text, availableWidth, lineFillPct, lineHeightPx: Number.isFinite(lh) && lh > 0 ? lh : (lines.length ? lines[0].height : 0) };
  }

  function orphans(selector, containerSelector, breakClass) {
    const height = pageContentHeight();
    return Array.from(document.querySelectorAll(selector)).flatMap((heading) => {
      const container = heading.closest(containerSelector);
      if (container && container.classList.contains(breakClass)) return [];
      const next = nextVisibleElement(heading);
      if (!next) return [];
      const headingRect = heading.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      if (headingRect.height <= 0.5 || nextRect.height <= 0.5) return [];
      const headingPage = pageIndex(headingRect.bottom, height);
      const nextPage = pageIndex(nextRect.top, height);
      if (nextPage <= headingPage) return [];
      return [{
        heading: (heading.textContent || "").replace(/\\s+/g, " ").trim(),
        nextText: (next.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
        headingPage: headingPage + 1,
        nextPage: nextPage + 1,
      }];
    });
  }
`;

const MEASURE_SCRIPT = `(() => {
  ${IN_PAGE_HELPERS}

  const bullets = [...document.querySelectorAll("[data-resume-bullet='true']")].map((item) => {
    const g = lineGeometry(item);
    return {
      kind: item.dataset.bulletKind || "unknown",
      text: g.text,
      lineCount: g.lineFillPct.length,
      availableWidth: g.availableWidth,
      lineFillPct: g.lineFillPct,
      lastLineFillPct: g.lineFillPct.length ? g.lineFillPct[g.lineFillPct.length - 1] : 0,
    };
  });

  const lineUnits = [...document.querySelectorAll("[data-resume-line-unit='true']")].map((item) => {
    const g = lineGeometry(item);
    return {
      unitPath: item.getAttribute("data-unit-path"),
      kind: item.dataset.lineUnitKind || "unknown",
      flow: item.closest("[data-flow='secondary']") ? "secondary" : "primary",
      text: g.text,
      charCount: g.text.length,
      charsPerRenderedLine: g.lines.map((line, index) => {
        const fill = g.lineFillPct[index] || 0;
        return fill ? Math.round((g.text.length / g.lines.length) * 10) / 10 : 0;
      }),
      lineCount: g.lineFillPct.length,
      availableWidth: g.availableWidth,
      lineHeightPx: g.lineHeightPx,
      lineFillPct: g.lineFillPct,
      lastLineFillPct: g.lineFillPct.length ? g.lineFillPct[g.lineFillPct.length - 1] : 0,
    };
  });

  return {
    bullets,
    lineUnits,
    headingOrphans: orphans("section > h2", "section", "resume-section-break-before"),
    experienceStartOrphans: orphans(".xp > .xp-head", ".xp", "resume-xp-break-before"),
    pageContentHeightPx: pageContentHeight(),
  };
})()`;

/** Take every DOM metric in one round trip. The page must already be at the print viewport. */
export async function measureDocument(page: Page): Promise<DomMetrics> {
  return (await page.evaluate(MEASURE_SCRIPT)) as DomMetrics;
}

const REPAIR_SCRIPT = `(() => {
  ${IN_PAGE_HELPERS}

  const height = pageContentHeight();
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const heading of Array.from(document.querySelectorAll("section > h2"))) {
      const section = heading.closest("section");
      const next = nextVisibleElement(heading);
      if (!section || !next) continue;
      const headingRect = heading.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      if (headingRect.height <= 0.5 || nextRect.height <= 0.5) continue;
      const headingPage = pageIndex(headingRect.bottom, height);
      const nextPage = pageIndex(nextRect.top, height);
      if (nextPage > headingPage && !section.classList.contains("resume-section-break-before")) {
        section.classList.add("resume-section-break-before");
        changed = true;
      }
    }
    for (const head of Array.from(document.querySelectorAll(".xp > .xp-head"))) {
      const xp = head.closest(".xp");
      const next = nextVisibleElement(head);
      if (!xp || !next) continue;
      const headRect = head.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      if (headRect.height <= 0.5 || nextRect.height <= 0.5) continue;
      const headPage = pageIndex(headRect.bottom, height);
      const nextPage = pageIndex(nextRect.top, height);
      if (nextPage > headPage && !xp.classList.contains("resume-xp-break-before")) {
        xp.classList.add("resume-xp-break-before");
        changed = true;
      }
    }
    if (!changed) break;
    document.body.offsetHeight;
  }
})()`;

/**
 * Pre-print pass: push a section / experience whose heading lands at a page
 * foot onto the next page. Mutates the live DOM; callers snapshot
 * `page.content()` afterwards to persist the repaired HTML.
 */
export async function repairPageBreakOrphans(page: Page): Promise<void> {
  await page.emulateMedia({ media: "print" });
  await page.evaluate(REPAIR_SCRIPT);
}
