/**
 * browser-session.ts — ONE Chromium per audit cycle.
 *
 * Every measurement the resume tools take (render, bullet fill, line units,
 * orphan headings, orphan experience starts, page-fit) needs the same thing:
 * the rendered HTML laid out at the print content box. Before this module each
 * of those launched its own cold Chromium (7 per cycle). Now the caller opens
 * one session, renders and measures on the same page, and closes it once.
 *
 * The launch function is injectable so tests can count launches without a
 * real browser.
 */

import { chromium, type Browser, type Page } from "playwright";
import path from "node:path";

export type ViewportSize = { width: number; height: number };
export type LaunchFn = () => Promise<Browser>;

export type BrowserSession = {
  browser: Browser;
  /** The single shared page. Callers navigate it; nobody else opens pages. */
  page: Page;
  /** Number of launches performed by this session (always 1 for a real session). */
  launches: number;
};

const defaultLaunch: LaunchFn = () => chromium.launch({ headless: true });

export async function openBrowserSession(opts: { launch?: LaunchFn } = {}): Promise<BrowserSession> {
  const browser = await (opts.launch ?? defaultLaunch)();
  const page = await browser.newPage();
  return { browser, page, launches: 1 };
}

export async function closeBrowserSession(session: BrowserSession | undefined): Promise<void> {
  await session?.browser.close().catch(() => undefined);
}

export async function withBrowserSession<T>(fn: (session: BrowserSession) => Promise<T>, opts: { launch?: LaunchFn } = {}): Promise<T> {
  const session = await openBrowserSession(opts);
  try {
    return await fn(session);
  } finally {
    await closeBrowserSession(session);
  }
}

export function pathToFileUrl(file: string): string {
  const resolved = path.resolve(file);
  return `file://${resolved.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function cssLengthPx(value: string): number | null {
  const match = value.trim().match(/^([\d.]+)(px|pt|mm|cm|in)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "px") return amount;
  if (unit === "pt") return amount * (96 / 72);
  if (unit === "mm") return amount * (96 / 25.4);
  if (unit === "cm") return amount * (96 / 2.54);
  if (unit === "in") return amount * 96;
  return null;
}

export function expandMargin(values: number[]): [number, number, number, number] {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
}

/**
 * The print content box the template lays out into: page size minus the
 * `@page` margins. Render AND measurement must both use this viewport, or the
 * orphan repair sees different line wraps than the checks do.
 */
export function printContentViewport(htmlSource: string): ViewportSize {
  const a4 = { width: 210 * (96 / 25.4), height: 297 * (96 / 25.4) };
  const letter = { width: 8.5 * 96, height: 11 * 96 };
  const pageRule = htmlSource.match(/@page\s*\{([^}]*)\}/i)?.[1] ?? "";
  const pageSize = /\bletter\b/i.test(pageRule) ? letter : a4;
  const marginValue = pageRule.match(/margin\s*:\s*([^;]+);?/i)?.[1] ?? "0";
  const marginParts = marginValue
    .trim()
    .split(/\s+/)
    .map(cssLengthPx)
    .filter((value): value is number => value !== null);
  const [top, right, bottom, left] = expandMargin(marginParts.length ? marginParts : [0]);
  return {
    width: Math.round(Math.max(320, pageSize.width - left - right)),
    height: Math.round(Math.max(480, pageSize.height - top - bottom)),
  };
}

/**
 * Point the session's page at a rendered HTML file at the print viewport with
 * print media emulated and fonts loaded. Idempotent: calling it for the page
 * that is already loaded is cheap but still re-navigates.
 */
export async function openPrintPage(session: BrowserSession, htmlPath: string, htmlSource?: string): Promise<Page> {
  const source = htmlSource ?? (await import("node:fs/promises")).readFile(htmlPath, "utf8").then((s) => s);
  const viewport = printContentViewport(await source);
  const page = session.page;
  await page.setViewportSize(viewport);
  await page.emulateMedia({ media: "print" });
  await page.goto(pathToFileUrl(htmlPath), { waitUntil: "load" });
  await page.evaluate(() => (document as any).fonts?.ready);
  return page;
}
