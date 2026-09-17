#!/usr/bin/env tsx
/**
 * linkedin-jobs.ts — LinkedIn Jobs search + enrichment using a logged-in
 * real-Chrome profile (state/channels/chrome-profile/linkedin/).
 *
 * Login: `npm run login:linkedin` opens a headed Chrome, you log in once,
 * the persistent profile keeps the session.
 *
 * Commands:
 *   tsx tools/channels/linkedin-jobs.ts search [--upsert] [--no-enrich]
 *   tsx tools/channels/linkedin-jobs.ts enrich [--status discovered|any] [--limit N] [--id <opportunity-id>] [--force]
 *
 * Search cards carry no job description (only title, company, location,
 * posted time and an Easy Apply badge), so `search --upsert` enriches the
 * new rows straight away: it opens each job view, reads the full JD, the
 * employment type / arrangement pills and the apply method (Easy Apply vs
 * "Apply on company website"). The classifier needs that text; the submit
 * gate needs the apply method.
 *
 * Caveats LinkedIn-watchers should know (rewritten 2026-09-16 against the
 * logged-in SDUI layout):
 *   - Class names are hashed and rotate. Everything here keys off stable
 *     attributes (data-occludable-job-id, aria-labels, time[datetime]) or
 *     visible text anchors ("About the job"). Expect breakage every few months.
 *   - LinkedIn is "gradually retiring classic job search starting in
 *     September" (banner seen 2026-09-16). When /jobs/search/ stops
 *     rendering cards this module will report 0 results with no login wall;
 *     that is the signal to re-probe the DOM, not a session problem.
 *   - Aggressive scraping triggers account-safety checks. The module paces
 *     requests, randomises waits, and is read-only (never posts, never DMs).
 *   - Expired session (login wall) fails fast with "run npm run login:linkedin".
 *   - page.evaluate() receives browser-realm strings, not callbacks: tsx can
 *     inject an `__name` helper into transpiled nested functions that does
 *     not exist inside the page.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import { type Page } from "playwright";
import { load as loadPipeline, save as savePipeline, upsert, opportunityIdFor, type Opportunity } from "../pipeline.ts";
import { keywordsForChannel } from "../resumes.ts";
import { canonicaliseUrl } from "../url-canonical.ts";
import { openChromeContext } from "./_browser.ts";
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";

const CHANNEL_ID = "linkedin_jobs";
const PAGE_SIZE = 25;

type LinkedInSearchConfig = SearchConfig & {
  geo?: string;
  job_type?: string[];
  posted_within_days?: number;
  max_pages?: number;
  enrich_limit?: number;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function buildSearchUrl(keyword: string, geo: string, jobType: string[], postedWithinDays: number, start: number): string {
  // f_JT=C is the contract filter; f_TPR=r<seconds> is "posted within".
  const k = encodeURIComponent(keyword);
  const loc = encodeURIComponent(geo);
  const typeCode = jobType.includes("contract") ? "&f_JT=C" : "";
  const postedSecs = Math.max(60, postedWithinDays * 86_400);
  const page = start > 0 ? `&start=${start}` : "";
  return `https://www.linkedin.com/jobs/search/?keywords=${k}&location=${loc}&f_TPR=r${postedSecs}${typeCode}&sortBy=DD${page}`;
}

async function loginWallDetected(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/login|\/checkpoint|\/uas\/login|\/authwall/.test(url)) return true;
  return page.locator('form[action*="login"], a[href*="/login"]:has-text("Sign in")').first().isVisible({ timeout: 500 }).catch(() => false);
}

// Scroll the results list (an inner overflow:auto pane) so the occluded cards hydrate.
const HYDRATE_LIST_SCRIPT = `(async () => {
  const first = document.querySelector("li[data-occludable-job-id]");
  const list = first && first.closest("ul");
  const pane = list && list.parentElement;
  if (!pane) return 0;
  const step = Math.max(300, Math.floor(pane.clientHeight * 0.8));
  for (let y = 0; y <= pane.scrollHeight; y += step) {
    pane.scrollTop = y;
    await new Promise(function (r) { setTimeout(r, 180); });
  }
  pane.scrollTop = 0;
  return document.querySelectorAll("li[data-occludable-job-id]").length;
})()`;

const EXTRACT_CARDS_SCRIPT = `(() => {
  const out = [];
  const clean = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
  document.querySelectorAll("li[data-occludable-job-id]").forEach(function (card) {
    const link = card.querySelector('a[href*="/jobs/view/"]');
    if (!link) return;
    const jobId = card.getAttribute("data-occludable-job-id") || "";
    const title = clean((link.querySelector("strong") || link).textContent);
    // Company and location are the first two dir=ltr spans after the title link.
    const spans = Array.prototype.slice.call(card.querySelectorAll('span[dir="ltr"]'))
      .map(function (s) { return clean(s.textContent); })
      .filter(function (t) { return t && t !== title; });
    const timeEl = card.querySelector("time[datetime]");
    const text = clean(card.innerText);
    out.push({
      jobId: jobId,
      href: link.getAttribute("href") || "",
      title: title,
      company: spans[0] || "",
      location: spans[1] || "",
      postedDate: timeEl ? timeEl.getAttribute("datetime") : "",
      easyApply: /\\bEasy Apply\\b/.test(text),
      viewed: /\\bViewed\\b/.test(text),
      promoted: /\\bPromoted\\b/.test(text),
    });
  });
  return out;
})()`;

type Card = { jobId: string; href: string; title: string; company: string; location: string; postedDate: string; easyApply: boolean; viewed: boolean; promoted: boolean };

function arrangementFromLocation(location: string): Opportunity["workArrangement"] {
  if (/\(remote\)/i.test(location)) return "remote";
  if (/\(hybrid\)/i.test(location)) return "hybrid";
  if (/\(on-site\)/i.test(location)) return "onsite";
  return "unknown";
}

function cardToOpportunity(card: Card): DiscoveredOpportunity & { applyMethod: Opportunity["applyMethod"] } {
  const abs = card.href.startsWith("http") ? card.href : `https://www.linkedin.com${card.href}`;
  return {
    channel: CHANNEL_ID,
    title: card.title,
    company: card.company || "Unknown",
    location: card.location.replace(/\s*\((?:Remote|Hybrid|On-site)\)\s*$/i, "").trim() || undefined,
    url: canonicaliseUrl(CHANNEL_ID, abs),
    postedAt: card.postedDate ? new Date(`${card.postedDate}T00:00:00+10:00`).toISOString() : undefined,
    workArrangement: arrangementFromLocation(card.location),
    applyMethod: card.easyApply ? "easy_apply" : "unknown",
  };
}

async function profileExists(): Promise<boolean> {
  try { await fs.access("state/channels/chrome-profile/linkedin/Default/Cookies"); return true; }
  catch { try { await fs.access("state/channels/chrome-profile/linkedin"); return true; } catch { return false; } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread: number) => base + Math.floor(Math.random() * spread);

export const linkedinJobs: HuntChannel = {
  id: CHANNEL_ID,
  async search(config: LinkedInSearchConfig): Promise<DiscoveredOpportunity[]> {
    const resumeKeywords = await keywordsForChannel(CHANNEL_ID);
    const keywords = config.keywords ?? (resumeKeywords.length ? resumeKeywords : ["Solution Architect"]);
    if (!keywords.length) {
      console.error(`[linkedin-jobs] no keywords. Skipping.`);
      return [];
    }
    const geo = config.geo ?? "Australia";
    const jobType = config.job_type ?? ["contract"];
    const postedWithinDays = config.posted_within_days ?? 7;
    const maxPages = Math.max(1, config.max_pages ?? 2);

    if (!(await profileExists())) {
      console.error(`[linkedin-jobs] no persisted login — run: npm run login:linkedin`);
      return [];
    }

    const ctx = await openChromeContext("linkedin", { headless: true });
    const byUrl = new Map<string, DiscoveredOpportunity>();
    try {
      keywordLoop: for (let i = 0; i < keywords.length; i++) {
        const kw = keywords[i];
        let found = 0;
        for (let p = 0; p < maxPages; p++) {
          const url = buildSearchUrl(kw, geo, jobType, postedWithinDays, p * PAGE_SIZE);
          const page = await ctx.newPage();
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForTimeout(jitter(2500, 1500));
            if (await loginWallDetected(page)) {
              console.error(`[linkedin-jobs] login wall hit for "${kw}" — session expired; run: npm run login:linkedin`);
              break keywordLoop;
            }
            await page.evaluate(HYDRATE_LIST_SCRIPT);
            const cards = (await page.evaluate(EXTRACT_CARDS_SCRIPT)) as Card[];
            let fresh = 0;
            for (const card of cards) {
              if (!card.title || !card.jobId) continue;
              const opp = cardToOpportunity(card);
              if (!byUrl.has(opp.url)) { byUrl.set(opp.url, opp); fresh++; }
            }
            found += cards.length;
            console.error(`[linkedin-jobs] "${kw}" page ${p + 1} → ${cards.length} cards (${fresh} new)`);
            // A short page means the result set is exhausted.
            if (cards.length < PAGE_SIZE) break;
          } catch (e) {
            console.error(`[linkedin-jobs] failed "${kw}" page ${p + 1}: ${(e as Error).message.slice(0, 160)}`);
            break;
          } finally {
            await page.close();
          }
          await sleep(jitter(2500, 2000));
        }
        if (found === 0) console.error(`[linkedin-jobs] "${kw}" → 0 cards; if this repeats across keywords the search DOM has changed`);
        if (i < keywords.length - 1) await sleep(jitter(4000, 3000));
      }
      return [...byUrl.values()];
    } finally {
      await ctx.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Enrich (full JD + apply method from the job view page)
// ---------------------------------------------------------------------------

const EXTRACT_VIEW_SCRIPT = `(() => {
  const clean = function (s) { return (s || "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim(); };
  const main = document.querySelector("main") || document.body;
  const text = main ? main.innerText : "";
  // Description: everything after the "About the job" heading up to the first trailing section.
  const start = text.indexOf("About the job");
  let description = "";
  if (start >= 0) {
    let body = text.slice(start + "About the job".length);
    const enders = ["Set alert for similar jobs", "Similar jobs", "People also viewed", "More jobs", "Explore collaborative articles", "Looking for talent?", "About the company", "Meet the hiring team", "How you match", "Featured benefits"];
    let cut = body.length;
    for (const e of enders) { const i = body.indexOf(e); if (i > 200 && i < cut) cut = i; }
    // innerText carries the clamped overflow too, so the JD is complete even
    // when the "… more" toggle is still showing; drop the marker itself.
    description = clean(body.slice(0, cut).replace(/^\\s*…\\s*more\\s*$/gm, ""));
  }
  const header = clean(text.slice(0, Math.max(0, start > 0 ? start : 1200)));
  const easy = document.querySelector('a[aria-label^="Easy Apply"], button[aria-label^="Easy Apply"]');
  const external = document.querySelector('button[aria-label^="Apply on company website"], a[aria-label^="Apply on company website"]');
  const applied = /\\bApplied\\b|\\bApplication submitted\\b|\\bSee application\\b/.test(header);
  const closed = /No longer accepting applications/i.test(text);
  const pills = header.split("\\n").map(function (l) { return l.trim(); }).filter(function (l) { return /^(Remote|Hybrid|On-site|Contract|Full-time|Part-time|Temporary|Internship|Casual)$/i.test(l); });
  const applicants = (header.match(/(\\d[\\d,]*)\\s+applicants?/i) || [])[1] || "";
  const ago = (header.match(/(\\d+)\\s+(minute|hour|day|week|month)s?\\s+ago/i) || [])[0] || "";
  const locLine = (header.split("\\n").find(function (l) { return /·/.test(l); }) || "").split("·")[0].trim();
  return { description: description, applyMethod: easy ? "easy_apply" : external ? "external" : "unknown", applied: applied, closed: closed, pills: pills, applicants: applicants, ago: ago, location: locLine };
})()`;

type ViewData = { description: string; applyMethod: "easy_apply" | "external" | "unknown"; applied: boolean; closed: boolean; pills: string[]; applicants: string; ago: string; location: string };

async function expandDescription(page: Page): Promise<void> {
  // The JD's "… more" button has no aria-label and shares its text with
  // "… more" buttons on hiring-team post cards, which NAVIGATE to the feed
  // when clicked (probed 2026-09-16). Scope to the nearest ancestor of the
  // "About the job" heading that contains such a button.
  const before = page.url();
  const section = page.getByText("About the job", { exact: true }).first()
    .locator("xpath=ancestor::*[.//button[contains(normalize-space(.), 'more')]][1]");
  const btns = section.getByRole("button", { name: /more/i }).filter({ hasNotText: /options/i });
  const n = await btns.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    if (await b.isVisible({ timeout: 300 }).catch(() => false)) {
      await b.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }
    if (page.url() !== before) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      break;
    }
  }
}

function arrangementFromPills(pills: string[], fallback: Opportunity["workArrangement"]): Opportunity["workArrangement"] {
  for (const p of pills) {
    if (/^remote$/i.test(p)) return "remote";
    if (/^hybrid$/i.test(p)) return "hybrid";
    if (/^on-site$/i.test(p)) return "onsite";
  }
  return fallback ?? "unknown";
}

export async function fetchLinkedInJob(page: Page, url: string): Promise<ViewData> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(jitter(2500, 1500));
  if (await loginWallDetected(page)) throw new Error("login wall — run: npm run login:linkedin");
  await expandDescription(page);
  return (await page.evaluate(EXTRACT_VIEW_SCRIPT)) as ViewData;
}

export function applyLinkedInEnrichment(role: Opportunity, data: ViewData): boolean {
  const employment = data.pills.find((p) => /^(Contract|Full-time|Part-time|Temporary|Casual|Internship)$/i.test(p));
  const meta: string[] = [];
  if (employment) meta.push(`Employment type: ${employment}`);
  if (data.applicants) meta.push(`${data.applicants} applicants`);
  const description = meta.length ? `[${meta.join("; ")}]\n\n${data.description}` : data.description;
  const next: Partial<Opportunity> = {
    description,
    applyMethod: data.applyMethod,
    workArrangement: arrangementFromPills(data.pills, role.workArrangement),
    location: data.location || role.location,
  };
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined && (role as any)[k] !== v) { (role as any)[k] = v; changed = true; }
  }
  if (data.closed && !/\[closed\]/.test(role.notes ?? "")) {
    role.notes = `[closed] LinkedIn: no longer accepting applications (seen ${new Date().toISOString().slice(0, 10)})${role.notes ? `\n${role.notes}` : ""}`;
    changed = true;
  }
  return changed;
}

export async function enrichLinkedInRoles(options: { id?: string; status?: string; limit?: number; force?: boolean } = {}): Promise<{ selected: number; enriched: number; unchanged: number; failed: number }> {
  const roles = await loadPipeline();
  const status = options.status ?? "discovered";
  const candidates = roles
    .filter((r) => r.channel === CHANNEL_ID)
    .filter((r) => !options.id || r.id === options.id)
    .filter((r) => status === "any" || r.status === status)
    // Without --force only rows that still lack a real JD are visited.
    .filter((r) => options.force || !!options.id || (r.description ?? "").length < 200)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  if (!candidates.length) return { selected: 0, enriched: 0, unchanged: 0, failed: 0 };

  const ctx = await openChromeContext("linkedin", { headless: true });
  let enriched = 0, unchanged = 0, failed = 0;
  const startedAt = Date.now();
  try {
    for (let i = 0; i < candidates.length; i++) {
      const role = candidates[i];
      const page = await ctx.newPage();
      try {
        const data = await fetchLinkedInJob(page, role.url);
        if (!data.description || data.description.length < 80) throw new Error("job description empty or too short (DOM change?)");
        if (applyLinkedInEnrichment(role, data)) enriched++; else unchanged++;
      } catch (error) {
        failed++;
        const msg = (error as Error).message;
        console.error(`[linkedin:enrich] ${role.id} failed: ${msg.slice(0, 180)}`);
        if (/login wall/.test(msg)) break;
      } finally {
        await page.close();
        const complete = enriched + unchanged + failed;
        if (complete % 5 === 0 || complete === candidates.length) {
          console.error(`[linkedin:enrich] ${complete}/${candidates.length}: ${enriched} updated, ${unchanged} unchanged, ${failed} failed (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
        }
      }
      // Sequential and paced on purpose: LinkedIn's account-safety checks watch job-view velocity.
      if (i < candidates.length - 1) await sleep(jitter(2000, 2500));
    }
  } finally {
    await ctx.close();
  }
  if (enriched) await savePipeline(roles);
  return { selected: candidates.length, enriched, unchanged, failed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<LinkedInSearchConfig> {
  const file = await fs.readFile("state/profile/channels.yaml", "utf8");
  const all = YAML.parse(file);
  return all.channels?.linkedin_jobs?.search ?? {};
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "search") {
    const upsertFlag = argv.includes("--upsert");
    const cfg = await loadConfig();
    const roles = await linkedinJobs.search(cfg);
    console.error(`[linkedin-jobs] discovered ${roles.length} roles`);
    if (!upsertFlag) { console.log(JSON.stringify(roles, null, 2)); return; }
    const newIds: string[] = [];
    const existing = new Set((await loadPipeline()).map((r) => r.id));
    for (const r of roles) {
      const id = opportunityIdFor(r.channel, r.url);
      if (!existing.has(id)) newIds.push(id);
      // Never send an empty description: upsert refreshes fields and would clobber an enriched JD.
      const { description: _d, ...rest } = r;
      await upsert({ ...rest, id, status: "discovered" });
    }
    console.error(`[linkedin-jobs] upserted ${roles.length} (${newIds.length} new)`);
    if (!argv.includes("--no-enrich") && newIds.length) {
      const limit = cfg.enrich_limit ?? 60;
      const result = await enrichLinkedInRoles({ status: "discovered", limit });
      console.error(`[linkedin-jobs] enriched ${result.enriched}/${result.selected} new rows (${result.failed} failed)`);
    }
    return;
  }
  if (cmd === "enrich") {
    const limitRaw = flag(argv, "--limit");
    const result = await enrichLinkedInRoles({
      id: flag(argv, "--id"),
      status: flag(argv, "--status"),
      limit: limitRaw ? Number(limitRaw) : undefined,
      force: argv.includes("--force"),
    });
    console.log(JSON.stringify(result));
    return;
  }
  console.error("Usage: tsx tools/channels/linkedin-jobs.ts (search [--upsert] [--no-enrich] | enrich [--status discovered|any] [--limit N] [--id <id>] [--force])");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
