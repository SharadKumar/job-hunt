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

import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
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

/** A busy profile or crashed launch is not evidence that Chrome is absent. */
export async function launchWithChromeFallback<T>(
  launchChrome: () => Promise<T>,
  launchBundled: () => Promise<T>,
): Promise<T> {
  try {
    return await launchChrome();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Chromium distribution 'chrome' is not found|Executable doesn't exist at/i.test(message)) throw error;
    console.error(`[browser] Chrome executable missing; falling back to bundled Chromium`);
    return await launchBundled();
  }
}

export type SeekBrowserMode = "background" | "headless" | "headed";

/** How scheduled SEEK work opens Chrome. SEEK's check challenges headless
 * Chrome, and a foreground window takes focus from the person on every new
 * page, so macOS defaults to a visible window kept behind the person's apps.
 * HARNESS_SEEK_HEADLESS=1 or HARNESS_SEEK_HEADED=1 forces the other modes. */
export function seekBrowserMode(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): SeekBrowserMode {
  if (env.HARNESS_SEEK_HEADLESS === "1") return "headless";
  if (env.HARNESS_SEEK_HEADED === "1") return "headed";
  return platform === "darwin" ? "background" : "headless";
}

/** Open the signed-in SEEK profile in the configured mode. */
export async function openSeekContext(env: NodeJS.ProcessEnv = process.env): Promise<BrowserContext> {
  const mode = seekBrowserMode(env);
  if (mode === "background") return openBackgroundChromeContext("seek");
  return openChromeContext("seek", { headless: mode === "headless" });
}

const MAC_CHROME_APP = "Google Chrome";

/** Process id of the frontmost app. A process id, not a bundle id: the
 * person's own Chrome and the harness Chrome share a bundle id. */
function frontmostPid(): number | null {
  try {
    const pid = Number(execFileSync("osascript", ["-e", 'tell application "System Events" to get unix id of first application process whose frontmost is true'],
      { timeout: 5_000 }).toString().trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function activatePid(pid: number): void {
  try { execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first application process whose unix id is ${pid}) to true`], { timeout: 5_000 }); }
  catch { /* the person's app may have quit; nothing to give focus back to */ }
}

function isChromeOnProfile(pid: number, dir: string): boolean {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }).toString().includes(`--user-data-dir=${dir}`); }
  catch { return false; }
}

/** True while a Chrome process is running on this user-data-dir. */
export function profileInUse(dir: string, list: () => string = () => execFileSync("ps", ["-axo", "command="], { timeout: 5_000 }).toString()): boolean {
  const flag = `--user-data-dir=${dir}`;
  return list().split("\n").some((line) => /Chrome|chrome/.test(line)
    && line.split(/\s+/).includes(flag));
}

const OWNER_FILE = "harness-owner.json";

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A background Chrome outlives a harness step killed by its time limit. If
 * the step that opened it has died, quit that Chrome so the profile frees. */
export async function reapOrphanedChrome(dir: string, alive: (pid: number) => boolean = processAlive): Promise<boolean> {
  let owner: { ownerPid?: number; chromePids?: number[] };
  try { owner = JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), "utf8")); } catch { return false; }
  if (!owner.ownerPid || alive(owner.ownerPid)) return false;
  for (const pid of owner.chromePids ?? []) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  await fs.rm(path.join(dir, OWNER_FILE), { force: true });
  console.error(`[browser] closed a Chrome left open by an ended harness step (owner ${owner.ownerPid})`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return true;
}

function chromePidsOnProfile(dir: string): number[] {
  const flag = `--user-data-dir=${dir}`;
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { timeout: 5_000 }).toString().split("\n")
      .filter((line) => line.split(/\s+/).includes(flag) && !/Helper/.test(line))
      .map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid > 0);
  } catch { return []; }
}

async function waitForProfileFree(dir: string, timeoutMs = Number(process.env.HARNESS_PROFILE_WAIT_MS ?? 15 * 60_000)): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  if (profileInUse(dir)) await reapOrphanedChrome(dir);
  while (profileInUse(dir)) {
    if (Date.now() > deadline) throw new Error(`browser profile ${dir} stayed in use for ${Math.round(timeoutMs / 60_000)} minutes; another harness step is still running`);
    if (!logged) { console.error(`[browser] profile in use by another harness step; waiting up to ${Math.round(timeoutMs / 60_000)} minutes`); logged = true; }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * A real, visible Chrome on the channel's persistent profile that never takes
 * focus. macOS starts it without activation (`open -g -n`); Chrome still
 * raises its first window, so focus is handed straight back to the app the
 * person was using. Every later page is a background target, and navigating
 * or closing pages does not activate Chrome. Closing the context quits this
 * Chrome instance.
 */
export async function openBackgroundChromeContext(channel: ChannelKey): Promise<BrowserContext> {
  const dir = await profileDirFor(channel);
  // One Chrome per profile: wait for another harness step to finish with it
  // rather than failing a send into the manual queue.
  await waitForProfileFree(dir);
  const port = await freePort();
  const prior = frontmostPid();
  const launcher = spawn("open", ["-g", "-n", "-a", MAC_CHROME_APP, "--args",
    `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--use-mock-keychain",
    "--hide-crash-restore-bubble", "--lang=en-AU", "about:blank"], { stdio: "ignore" });
  launcher.unref();

  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${endpoint}/json/version`)).ok; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!ready) throw new Error(`background Chrome did not open its debugging port for profile ${channel}; is the profile already in use?`);
  // Chrome raises its first window shortly after the port opens; give focus
  // back each time it does during the first few seconds.
  if (prior) {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const front = frontmostPid();
      if (front !== null && front !== prior && isChromeOnProfile(front, dir)) activatePid(prior);
    }
  }

  await fs.writeFile(path.join(dir, OWNER_FILE), JSON.stringify({ ownerPid: process.pid, chromePids: chromePidsOnProfile(dir), at: new Date().toISOString() }) + "\n");
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const browserSession = await browser.newBrowserCDPSession();
  // Background tabs are not painted, so client-rendered pages such as the
  // Quick Apply form stay blank in them. Hand out Chrome's own front tab first
  // (navigating it does not take focus) and reset it instead of closing it;
  // only a second concurrent page becomes a background tab.
  const frontTab = context.pages()[0];
  let frontTabInUse = false;
  if (frontTab) {
    const closeFrontTab = frontTab.close.bind(frontTab);
    frontTab.close = async () => {
      if (!frontTabInUse) return closeFrontTab();
      frontTabInUse = false;
      await frontTab.goto("about:blank").catch(() => {});
    };
  }
  context.newPage = async () => {
    if (frontTab && !frontTabInUse && !frontTab.isClosed()) {
      frontTabInUse = true;
      return frontTab;
    }
    const opened = context.waitForEvent("page", { timeout: 15_000 });
    await browserSession.send("Target.createTarget", { url: "about:blank", background: true });
    return await opened;
  };
  context.close = async () => {
    await browserSession.send("Browser.close").catch(() => {});
    await browser.close().catch(() => {});
    await fs.rm(path.join(dir, OWNER_FILE), { force: true }).catch(() => {});
  };
  return context;
}

/** Gap between SEEK advert reads: a random 4 to 9 seconds, so reads arrive at
 * a person's pace rather than in a burst. HARNESS_SEEK_PACE_MS fixes it. */
export function seekPaceMs(env: NodeJS.ProcessEnv = process.env, random = Math.random): number {
  if (env.HARNESS_SEEK_PACE_MS !== undefined) return Math.max(0, Number(env.HARNESS_SEEK_PACE_MS) || 0);
  return 4_000 + Math.round(random() * 5_000);
}

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
    // Let the installed browser report its own version. A fixed Chrome 131
    // user agent became inconsistent with the installed Chrome 154 binary.
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    // Cookies should not be wiped between runs
    acceptDownloads: false,
  };

  // Prefer the user's installed Google Chrome (less likely to be flagged).
  // Fall back to bundled Chromium only if Chrome isn't available.
  const context = await launchWithChromeFallback(
    () => chromium.launchPersistentContext(dir, { channel: "chrome", ...launchOpts }),
    () => chromium.launchPersistentContext(dir, launchOpts),
  );

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
