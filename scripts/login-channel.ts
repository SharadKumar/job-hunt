#!/usr/bin/env tsx
/**
 * login-channel.ts — open a headed real Chrome with a persistent profile
 * so the user can log in once. Subsequent scrapes re-use the profile.
 *
 * The persistent profile (state/channels/chrome-profile/<channel>/) is a
 * full Chrome user-data-dir. Cookies, localStorage, and IndexedDB all
 * persist across runs without needing a separate storageState JSON.
 *
 * Usage:
 *   tsx scripts/login-channel.ts seek
 *   tsx scripts/login-channel.ts linkedin
 */

import readline from "node:readline";
import { openChromeContext } from "../tools/channels/_browser.ts";

const LOGIN_URLS: Record<string, string> = {
  seek: "https://www.seek.com.au/sign-in",
  linkedin: "https://www.linkedin.com/login",
  hays: "https://www.hays.com.au/myaccount/login",
};

async function main() {
  const channel = process.argv[2];
  if (!channel || !LOGIN_URLS[channel]) {
    console.error(`Usage: tsx scripts/login-channel.ts (${Object.keys(LOGIN_URLS).join("|")})`);
    process.exit(2);
  }
  const ctx = await openChromeContext(channel, { headless: false });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URLS[channel]);
  console.error(`\nA real Chrome window has opened to ${LOGIN_URLS[channel]}.`);
  console.error(`Log in there (email + password, any 2FA — Google SSO will also work).`);
  console.error(`When you're done and see the logged-in dashboard, press Enter here.`);
  await new Promise<void>((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("> ", () => { rl.close(); res(); });
  });
  console.error(`Saved persistent profile to state/channels/chrome-profile/${channel}/`);
  await ctx.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
