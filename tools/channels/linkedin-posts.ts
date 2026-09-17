#!/usr/bin/env tsx
/**
 * linkedin-posts.ts — scan LinkedIn for hiring posts matching the user's
 * configured query terms.
 *
 * Uses LinkedIn's content search: linkedin.com/search/results/content/?keywords=...
 * with sortBy=date_posted. Reads the persisted login from
 * state/channels/storage-state/linkedin.json.
 *
 * Output: writes to state/pipeline/linkedin-posts-queue.json for the
 * outreach-drafter agent to pick up. Returns the same data via the
 * HuntChannel.search interface so opportunity-finder can also see counts.
 *
 * Drafts ONLY: this module never posts comments and never sends DMs.
 * The outreach-drafter writes drafts; the user sends from their LinkedIn
 * client.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { type Page } from "playwright";
import { openChromeContext } from "./_browser.ts";
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";
import { repoPath } from "../repo-root.ts";

const QUEUE_PATH = repoPath("state/pipeline/linkedin-posts-queue.json");

export type HiringPost = {
  channel: "linkedin_posts";
  postId: string;
  posterName: string;
  posterUrl: string;
  postUrl: string;
  text: string;
  postedAt?: string;
  matchedTerm: string;
};

async function loginWallDetected(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/login|\/checkpoint|\/uas\/login/.test(url)) return true;
  const hasSignIn = await page.locator('a[href*="/login"], button:has-text("Sign in")').first().isVisible({ timeout: 500 }).catch(() => false);
  return hasSignIn;
}

async function profileExists(): Promise<boolean> {
  try { await fs.access(repoPath("state/channels/chrome-profile/linkedin/Default/Cookies")); return true; }
  catch { try { await fs.access(repoPath("state/channels/chrome-profile/linkedin")); return true; } catch { return false; } }
}

async function extractPosts(page: Page, matchedTerm: string): Promise<HiringPost[]> {
  return await page.evaluate((term) => {
    const out: any[] = [];
    // LinkedIn's content search results use feed-shared-update-v2 or similar wrappers
    const updates = document.querySelectorAll('[data-urn^="urn:li:activity:"], div.feed-shared-update-v2, div[data-id^="urn:li:activity:"]');
    updates.forEach((u) => {
      const urn = u.getAttribute("data-urn") || u.getAttribute("data-id") || "";
      const postId = urn.split(":").pop() || Math.random().toString(36).slice(2);

      // Poster info: usually in an actor block
      const actorLink = u.querySelector('a[href*="/in/"], a.update-components-actor__meta-link') as HTMLAnchorElement | null;
      const actorName = u.querySelector('.update-components-actor__name span[aria-hidden="true"], .update-components-actor__title');
      const posterUrl = actorLink?.href || "";
      const posterName = (actorName?.textContent || "").trim();

      // Post text: in update-components-text or feed-shared-update-v2__commentary
      const textEl = u.querySelector('.update-components-text, .feed-shared-update-v2__commentary, .feed-shared-text');
      const text = (textEl?.textContent || "").trim();

      // Post URL: built from URN
      const postUrl = urn ? `https://www.linkedin.com/feed/update/${urn}/` : "";

      if (text.length < 30) return; // skip too-short fragments
      out.push({ channel: "linkedin_posts", postId, posterName, posterUrl, postUrl, text, matchedTerm: term });
    });
    return out;
  }, matchedTerm);
}

export const linkedinPosts = {
  id: "linkedin_posts" as const,

  async search(_config: SearchConfig): Promise<DiscoveredOpportunity[]> {
    // Posts aren't roles in the usual sense; we return an empty array here so
    // the opportunity-finder doesn't try to upsert them into opportunities.json. The
    // canonical posts queue lives at state/pipeline/linkedin-posts-queue.json.
    return [];
  },

  async scan(config: SearchConfig): Promise<HiringPost[]> {
    const terms = ((config.scan as any)?.query_terms ?? ["hiring contract architect Sydney"]) as string[];
    if (!(await profileExists())) {
      console.error(`[linkedin-posts] no persisted login — run: npm run login:linkedin`);
      return [];
    }
    const ctx = await openChromeContext("linkedin", { headless: true });
    try {
      const all: HiringPost[] = [];
      for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(term)}&sortBy=%22date_posted%22&datePosted=%22past-week%22`;
        const page = await ctx.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(1500 + Math.random() * 1500);
          if (await loginWallDetected(page)) {
            console.error(`[linkedin-posts] login wall — run: npm run login:linkedin`);
            await page.close();
            break;
          }
          // Scroll a few times to load results
          for (let s = 0; s < 3; s++) {
            await page.evaluate(() => window.scrollBy(0, 1500));
            await page.waitForTimeout(700);
          }
          const items = await extractPosts(page, term);
          console.error(`[linkedin-posts] "${term}" → ${items.length} posts`);
          all.push(...items);
        } catch (e) {
          console.error(`[linkedin-posts] failed "${term}": ${(e as Error).message}`);
        } finally {
          await page.close();
        }
        if (i < terms.length - 1) await new Promise((r) => setTimeout(r, 4000 + Math.random() * 3000));
      }
      // Dedup by postId
      const byId = new Map<string, HiringPost>();
      for (const p of all) if (!byId.has(p.postId)) byId.set(p.postId, p);

      await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
      await fs.writeFile(QUEUE_PATH, JSON.stringify([...byId.values()], null, 2));
      console.error(`[linkedin-posts] wrote ${byId.size} posts to ${QUEUE_PATH}`);
      return [...byId.values()];
    } finally {
      await ctx.close();
    }
  },
} satisfies HuntChannel & { scan: (cfg: SearchConfig) => Promise<HiringPost[]> };

async function loadConfig(): Promise<SearchConfig> {
  const file = await fs.readFile(repoPath("state/profile/channels.yaml"), "utf8");
  const all = YAML.parse(file);
  return all.channels?.linkedin_posts ?? {};
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== "scan") {
    console.error("Usage: tsx tools/channels/linkedin-posts.ts scan");
    process.exit(2);
  }
  const cfg = await loadConfig();
  const posts = await linkedinPosts.scan(cfg);
  console.log(JSON.stringify({ count: posts.length, queue: QUEUE_PATH }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
