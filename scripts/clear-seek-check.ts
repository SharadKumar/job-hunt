#!/usr/bin/env tsx
/**
 * clear-seek-check.ts: the once-a-day human step when SEEK's "verify you are
 * human" check has stopped the harness.
 *
 * Opens a visible Chrome window on the harness's signed-in SEEK profile, at
 * the highest-scoring queued SEEK advert. If SEEK shows its check, the person
 * ticks it; the window closes by itself once the advert is readable and the
 * cleared state stays in the profile for the scheduled runs. Never interacts
 * with the check itself.
 *
 * Usage: npm run seek:clear [-- --url <seek advert url>] [--wait-minutes 10]
 */
import { openChromeContext } from "../tools/channels/_browser.ts";
import { isSeekHumanVerification, waitForSeekChallengeToClear } from "../tools/channels/seek-submit.ts";
import { load } from "../tools/pipeline.ts";

const FALLBACK_URL = "https://www.seek.com.au/jobs";

export async function advertToOpen(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const queued = (await load())
    .filter((row) => row.channel === "seek" && ["shortlisted", "approved", "awaiting_approval"].includes(row.status))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return queued[0]?.url ?? FALLBACK_URL;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const waitMinutes = Math.max(1, Number(arg("wait-minutes") ?? 10));
  const url = await advertToOpen(arg("url"));

  const ctx = await openChromeContext("seek", { headless: false });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);
    const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    if (/sign in|log in/i.test(await page.title()) || /\/oauth|\/login|sign-in/i.test(page.url())) {
      console.log(JSON.stringify({ ok: false, url, state: "signed_out", next: "Run npm run login:seek, sign in, then run npm run seek:clear again" }));
      process.exitCode = 1;
      return;
    }
    if (!isSeekHumanVerification(text)) {
      console.log(JSON.stringify({ ok: true, url, state: "no_check_showing" }));
      return;
    }
    console.error(`\nSEEK is showing its "verify you are human" check in the Chrome window.`);
    console.error(`Tick it there. This window closes by itself once the advert loads (waiting up to ${waitMinutes} minutes).`);
    const cleared = await waitForSeekChallengeToClear(page, { timeoutMs: waitMinutes * 60_000, pollMs: 2_000 });
    console.log(JSON.stringify({ ok: cleared, url, state: cleared ? "cleared" : "still_challenged" }));
    if (!cleared) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exit(1); });
