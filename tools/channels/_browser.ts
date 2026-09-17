/**
 * _browser.ts — shared Chrome launcher for all channel modules + the login flow.
 *
 * Why this exists: Playwright's bundled Chromium is detected by Seek and
 * LinkedIn as automation and refuses to authenticate (sign-in pages either
 * show CAPTCHA loops or stall on Google SSO). The fix is two-fold:
 *
 *  1. Use the user's REAL installed Google Chrome via `channel: "chrome"`.
 *     Falls back to bundled Chromium only if Chrome isn't installed.
 *  2. Use a PERSISTENT user-data-dir per channel (a real Chrome profile)
 *     so cookies + localStorage + IndexedDB all persist exactly like a
 *     normal Chrome session. No fragile storageState JSON.
 *
 * Stealth basics: launch with --disable-blink-features=AutomationControlled
 * and inject an init script that hides navigator.webdriver. This isn't
 * full stealth (that needs puppeteer-extra-plugin-stealth or similar) but
 * it handles the common detectors and is enough for Seek/LinkedIn read-only
 * scraping when combined with a real Chrome profile.
 *
 * Usage:
 *   const ctx = await openChromeContext("seek", { headless: true });
 *   const page = await ctx.newPage();
 *   await page.goto(...);
 *   await ctx.close();
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

export type ChannelKey = "seek" | "linkedin" | "hays" | string;

export const CHROME_PROFILES_ROOT = "state/channels/chrome-profile";

const COMMON_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-default-browser-check",
  "--no-first-run",
  "--password-store=basic",      // avoid macOS keychain prompt on every launch
  "--use-mock-keychain",
];

const REAL_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function profileDirFor(channel: ChannelKey): Promise<string> {
  const dir = path.resolve(CHROME_PROFILES_ROOT, channel);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function openChromeContext(
  channel: ChannelKey,
  opts: { headless?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<BrowserContext> {
  const dir = await profileDirFor(channel);
  const launchOpts = {
    headless: opts.headless ?? false,
    args: COMMON_ARGS,
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    userAgent: REAL_CHROME_UA,
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    // Cookies should not be wiped between runs
    acceptDownloads: false,
  };

  // Prefer the user's installed Google Chrome (less likely to be flagged).
  // Fall back to bundled Chromium only if Chrome isn't available.
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, { channel: "chrome", ...launchOpts });
  } catch (e) {
    console.error(`[browser] Chrome not available (${(e as Error).message.slice(0, 80)}); falling back to bundled Chromium`);
    context = await chromium.launchPersistentContext(dir, launchOpts);
  }

  // Strip the most common automation tells.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // window.chrome shim — real Chrome exposes this, headless Chromium doesn't
    if (!(window as any).chrome) (window as any).chrome = { runtime: {} };
    // plugins.length > 0 — many bot detectors check this
    try {
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5].map(() => ({ name: "plugin" })),
      });
    } catch {}
    // languages — should be a non-empty array
    try {
      Object.defineProperty(navigator, "languages", { get: () => ["en-AU", "en"] });
    } catch {}
  });

  return context;
}
