/**
 * pdf-metrics.ts — pagination ground truth from the PDF, in ONE `pdftotext
 * -bbox` call. Gives page count (so `pdfinfo` is no longer needed), per-page
 * fill (max word yMax / page height — the exact measure the quality gate uses),
 * each page's normalised word stream (to locate line units on a page), and a
 * per-page text hash (so a re-audit can say which pages changed).
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LineUnitMetric } from "./measure-document.ts";

const exec = promisify(execFile);

export type PageMetric = { page: number; fillPct: number; heightPt: number; contentBottomPt: number };

export type PdfMetrics = {
  pageCount: number;
  pages: PageMetric[];
  pageText: string[];
  pageHashes: string[];
};

/** Normalise for cross-engine (DOM text vs PDF word stream) matching. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function measurePdfPages(pdf: string): Promise<PdfMetrics> {
  const { stdout } = await exec("pdftotext", ["-bbox", pdf, "-"], { maxBuffer: 32 * 1024 * 1024 });
  const chunks = stdout.split(/<page\b/).slice(1);
  const pages: PageMetric[] = [];
  const pageText: string[] = [];
  const pageHashes: string[] = [];
  chunks.forEach((chunk, i) => {
    const heightPt = Number(chunk.match(/\bheight="([\d.]+)"/)?.[1] ?? NaN);
    const yMaxes = [...chunk.matchAll(/<word\b[^>]*\byMax="([\d.]+)"/g)].map((m) => Number(m[1])).filter(Number.isFinite);
    const words = [...chunk.matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/g)].map((m) => m[1]);
    const contentBottom = yMaxes.length ? Math.max(...yMaxes) : 0;
    pages.push({
      page: i + 1,
      heightPt: Number.isFinite(heightPt) ? heightPt : 0,
      contentBottomPt: contentBottom,
      fillPct: Number.isFinite(heightPt) && heightPt > 0 ? Math.max(0, Math.min(100, (contentBottom / heightPt) * 100)) : 0,
    });
    const text = norm(words.join(" "));
    pageText.push(text);
    pageHashes.push(createHash("sha256").update(text).digest("hex").slice(0, 16));
  });
  return { pageCount: pages.length, pages, pageText, pageHashes };
}

/** The gate's last-page fill measure, derived from the same metrics. */
export function lastPageFill(metrics: PdfMetrics): { fillPct: number; trailingBlankPct: number } | null {
  const last = metrics.pages[metrics.pages.length - 1];
  if (!last || last.heightPt <= 0 || last.contentBottomPt <= 0) return null;
  return { fillPct: last.fillPct, trailingBlankPct: Math.max(0, Math.min(100, 100 - last.fillPct)) };
}

/** Locate each line unit on a page by matching its opening text into the page word stream. */
export function assignPages(units: LineUnitMetric[], pageText: string[]): void {
  for (const unit of units) {
    const n = norm(unit.text);
    if (!n) continue;
    // Try a long needle first; fall back to shorter ones for units whose text
    // is short or whose glyphs normalise differently in the PDF word stream.
    let startPage = -1;
    for (const len of [40, 24, 12]) {
      const head = n.slice(0, len);
      if (head.length < len && len !== 12) continue;
      startPage = pageText.findIndex((t) => t.includes(head));
      if (startPage >= 0) break;
    }
    const tail = n.slice(-Math.min(40, n.length));
    const endPage = pageText.findIndex((t) => t.includes(tail));
    if (startPage >= 0) unit.page = startPage + 1;
    if (startPage >= 0 && endPage >= 0 && endPage !== startPage) unit.spansPages = true;
  }
}

/** Pages whose text hash differs from a previous audit (1-based). All pages when there is no previous. */
export function diffChangedPages(previousHashes: string[] | null | undefined, currentHashes: string[]): number[] {
  if (!previousHashes) return currentHashes.map((_, i) => i + 1);
  const changed: number[] = [];
  const max = Math.max(previousHashes.length, currentHashes.length);
  for (let i = 0; i < max; i++) {
    if (previousHashes[i] !== currentHashes[i]) changed.push(i + 1);
  }
  return changed;
}
