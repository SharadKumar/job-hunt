#!/usr/bin/env tsx
/**
 * hn-who-is-hiring.ts — scrape the current month's "Ask HN: Who is hiring?"
 * thread for roles that match the user's filters.
 *
 * Uses Algolia's HN Search API (https://hn.algolia.com/api) — public, no
 * auth, much more reliable than parsing news.ycombinator.com HTML.
 *
 * Strategy:
 *   1. Find the most recent "Ask HN: Who is hiring" story.
 *   2. Fetch its children (top-level comments = job postings).
 *   3. Filter each by the user's tags from channels.yaml (e.g. REMOTE, Sydney, Architect, Lead).
 *   4. Return as DiscoveredOpportunity[] with channel="hn_who_is_hiring".
 *
 * No login needed; works headlessly.
 *
 * CLI: tsx tools/channels/hn-who-is-hiring.ts search [--upsert]
 */

import YAML from "yaml";
import { promises as fs } from "node:fs";
import { fetch } from "undici";
import { upsertMany, opportunityIdFor } from "../pipeline.ts";
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";

const ALGOLIA = "https://hn.algolia.com/api/v1";

type AlgoliaHit = {
  objectID: string;
  title?: string;
  story_text?: string;
  created_at: string;
  author?: string;
  story_id?: number;
};

type AlgoliaItem = {
  id: number;
  title?: string;
  text?: string;
  author?: string;
  created_at: string;
  children?: AlgoliaItem[];
};

async function findLatestWhoIsHiring(): Promise<{ id: number; title: string; created_at: string } | null> {
  // Look for "Ask HN: Who is hiring" stories from the last 60 days
  const sinceTimestamp = Math.floor((Date.now() - 60 * 86_400_000) / 1000);
  const url = `${ALGOLIA}/search?query=Ask+HN+Who+is+hiring&tags=story,author_whoishiring&numericFilters=created_at_i>${sinceTimestamp}&hitsPerPage=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN Algolia search failed: ${res.status}`);
  const json = (await res.json()) as { hits: AlgoliaHit[] };
  const hits = json.hits.filter((h) => /who is hiring/i.test(h.title ?? ""));
  if (!hits.length) return null;
  const latest = hits.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  return { id: Number(latest.objectID), title: latest.title ?? "", created_at: latest.created_at };
}

async function fetchThread(id: number): Promise<AlgoliaItem> {
  const res = await fetch(`${ALGOLIA}/items/${id}`);
  if (!res.ok) throw new Error(`HN item fetch failed: ${res.status}`);
  return (await res.json()) as AlgoliaItem;
}

/** Strip basic HTML the way Algolia returns post bodies. */
function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a [^>]*href=\"([^\"]+)\"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

/** Parse the first line of a HN job post — convention is `Company | Role | Location | type | tags`. */
function parseFirstLine(text: string): { company: string; title: string; location: string; tags: string[] } {
  const first = text.split(/\n+/).find((l) => l.trim().length > 0) ?? "";
  const parts = first.split("|").map((s) => s.trim()).filter(Boolean);
  // Heuristic: first part = company; second = role; third/fourth often location or type
  return {
    company: parts[0] || "Unknown",
    title: parts[1] || "(see post)",
    location: parts.slice(2).find((p) => /sydney|melbourne|au|aust|remote|usa|united|berlin|london|uk|emea|apac/i.test(p)) || "",
    tags: parts.slice(2),
  };
}

function matchesFilters(post: { title: string; company: string; location: string; text: string }, includeTags: string[]): boolean {
  if (!includeTags?.length) return true;
  const blob = `${post.title} ${post.company} ${post.location} ${post.text}`.toLowerCase();
  return includeTags.some((tag) => blob.includes(tag.toLowerCase()));
}

export const hnWhoIsHiring: HuntChannel = {
  id: "hn_who_is_hiring",
  async search(config: SearchConfig): Promise<DiscoveredOpportunity[]> {
    const story = await findLatestWhoIsHiring();
    if (!story) {
      console.error("[hn-who-is-hiring] no recent 'Who is hiring' thread found");
      return [];
    }
    console.error(`[hn-who-is-hiring] using thread ${story.id}: ${story.title}`);
    const thread = await fetchThread(story.id);
    const includeTags = (config.scan as any)?.include_tags ?? ["REMOTE", "Australia", "Sydney"];
    const remoteOnly = (config.scan as any)?.remote_only === true;
    const contractOnly = (config.scan as any)?.contract_only === true;
    const results: DiscoveredOpportunity[] = [];
    for (const child of thread.children ?? []) {
      if (!child.text) continue;
      const text = stripHtml(child.text);
      const parsed = parseFirstLine(text);
      const post = { ...parsed, text };
      if (!matchesFilters(post, includeTags)) continue;
      if (remoteOnly && !/remote/i.test(`${parsed.location} ${text}`)) continue;
      if (contractOnly && !/\b(contract|contractor|contracting|freelance|fractional|part[- ]time|interim)\b/i.test(text)) continue;
      results.push({
        channel: "hn_who_is_hiring",
        title: parsed.title,
        company: parsed.company,
        location: parsed.location,
        url: `https://news.ycombinator.com/item?id=${child.id}`,
        description: text,
        workArrangement: /remote/i.test(`${parsed.location} ${text}`) ? "remote" : /hybrid/i.test(text) ? "hybrid" : "unknown",
        postedAt: child.created_at,
      });
    }
    return results;
  },
};

async function loadConfig(): Promise<SearchConfig> {
  const file = await fs.readFile("state/profile/channels.yaml", "utf8");
  const all = YAML.parse(file);
  return all.channels?.hn_who_is_hiring ?? {};
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== "search") {
    console.error("Usage: tsx tools/channels/hn-who-is-hiring.ts search [--upsert]");
    process.exit(2);
  }
  const upsertFlag = argv.includes("--upsert");
  const cfg = await loadConfig();
  const roles = await hnWhoIsHiring.search(cfg);
  console.error(`[hn-who-is-hiring] matched ${roles.length} roles`);
  if (upsertFlag) {
    // One transaction for the whole thread, not one pipeline rewrite per post.
    await upsertMany(roles.map((r) => ({ ...r, id: opportunityIdFor(r.channel, r.url), status: "discovered" as const })));
    console.error(`[hn-who-is-hiring] upserted ${roles.length} roles`);
  } else {
    console.log(JSON.stringify(roles, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
