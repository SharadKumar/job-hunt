#!/usr/bin/env tsx
/**
 * seek.ts — Seek.com.au search channel.
 *
 * Uses Playwright headless. Seek serves SSR HTML for /jobs/ pages and we
 * extract via DOM selectors. Submit is in seek-submit.ts (separate module
 * so it can be denied at the permission layer for safety).
 *
 * Persisted login at state/channels/storage-state/seek.json (created by
 * `npm run login:seek`). For search-only browsing, login is optional but
 * gets richer data.
 *
 * CLI:
 *   tsx tools/channels/seek.ts search [--upsert]
 *   tsx tools/channels/seek.ts enrich [--status shortlisted] [--min-score 20] [--limit N] [--resume <id>]
 *   tsx tools/channels/seek.ts saved [--upsert]      # jobs the user saved on SEEK (my-activity/saved-jobs)
 *   tsx tools/channels/seek.ts unsave --job <jobId>  # toggle a job's Save button off
 *
 * Reads search config from state/profile/channels.yaml under `seek.search`.
 * With --upsert, writes discovered roles to pipeline as status=discovered.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { load as loadPipeline, save as savePipeline, upsert, opportunityIdFor, type Opportunity } from "../pipeline.ts";
import { keywordsForChannel } from "../resumes.ts";
import { canonicaliseUrl } from "../url-canonical.ts";
import { openChromeContext } from "./_browser.ts";
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";

export const seek: HuntChannel = {
  id: "seek",
  async search(config: SearchConfig): Promise<DiscoveredOpportunity[]> {
    // Combine the SEEK-specific broad taxonomy with active resume-positioning
    // keywords. This prevents a channel override from silently hiding a new
    // profile's search terms, while retaining deliberate single-word coverage.
    const resumeKeywords = await keywordsForChannel("seek");
    const configuredKeywords = (config.keywords as string[] | undefined) ?? [];
    const keywords = mergeSearchKeywords(configuredKeywords, resumeKeywords);
    if (!keywords.length) keywords.push("Solutions Architect");
    if (!keywords.length) {
      console.error(`[seek] no keywords (no active resumes prefer 'seek' and no override in channels.yaml). Skipping.`);
      return [];
    }
    const location = (config.location as string | undefined) ?? "Sydney NSW";
    const workType = (config.work_type as string[] | undefined) ?? ["contract"];
    const postedWithinDays = (config.posted_within_days as number | undefined) ?? 7;
    const maxPagesPerKeyword = Math.max(1, Math.min(5, Number(config.max_pages_per_keyword ?? 2)));
    const ctx = await openChromeContext("seek", { headless: true });
    try {
      const all: DiscoveredOpportunity[] = [];
      for (const [keywordIndex, kw] of keywords.entries()) {
        const keywordStartedAt = Date.now();
        const beforeKeyword = all.length;
        let pagesRead = 0;
        for (let pageNumber = 1; pageNumber <= maxPagesPerKeyword; pageNumber++) {
          const url = buildSearchUrl(kw, location, workType, postedWithinDays, pageNumber);
          const page = await ctx.newPage();
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForTimeout(1500);
            pagesRead++;
            const items = await page.$$eval("[data-card-type='JobCard']", (nodes: any[]) => nodes.map((n) => {
            const titleEl = n.querySelector("[data-automation='jobTitle']") || n.querySelector("a[data-automation='jobTitle']");
            const companyEl = n.querySelector("[data-automation='jobCompany']");
            const locEl = n.querySelector("[data-automation='jobLocation']");
            const teaserEl = n.querySelector("[data-automation='jobShortDescription']") || n.querySelector("span[data-automation='jobShortDescription']");
            const workTypeEl = n.querySelector("[data-automation='jobWorkType']")
              || n.querySelector("[data-automation='job-detail-work-type']")
              || [...n.querySelectorAll("p")].find((p: any) => /^This is a .+ job$/i.test((p.textContent || "").trim()));
            const listingDateEl = n.querySelector("[data-automation='jobListingDate']");
            const rel = titleEl?.getAttribute("href") || "";
            const url = rel.startsWith("http") ? rel : `https://www.seek.com.au${rel}`;
            return {
              title: (titleEl?.textContent || "").trim(),
              company: (companyEl?.textContent || "").trim(),
              location: (locEl?.textContent || "").trim(),
              url,
              description: (teaserEl?.textContent || "").trim(),
              workType: (workTypeEl?.textContent || "").trim(),
              listingDate: (listingDateEl?.textContent || "").trim(),
              cardText: (n.textContent || "").trim(),
            };
            }));
            for (const it of items) {
              if (!it.url || !it.title) continue;
              if (!looksTechnicallyRelevant(it.title, it.description)) continue;
              // The URL filter is primary. This guard makes the contract-only
              // policy durable if SEEK changes routing or silently broadens the
              // result set again. Missing card metadata is left for the agent
              // classifier, but an explicit employee work type is rejected.
              if (it.workType && !looksLikeContractWorkType(it.workType)) continue;
              all.push({
                channel: "seek",
                title: it.title,
                company: it.company || "Unknown",
                location: it.location,
                url: canonicaliseUrl("seek", it.url),
                description: it.workType
                  ? `[Employment type: ${it.workType}] ${it.description}`
                  : it.description,
                postedAt: parseRelativePostedAt(it.listingDate || it.cardText),
                workArrangement: inferArrangement(it.location, `${it.description} ${it.cardText}`),
              });
            }
            // A short page is the final page. SEEK currently emits up to 32
            // job cards per result page.
            if (items.length < 32) break;
          } finally {
            await page.close();
          }
        }
        const elapsedSeconds = ((Date.now() - keywordStartedAt) / 1000).toFixed(1);
        console.error(`[seek] ${keywordIndex + 1}/${keywords.length} "${kw}": ${pagesRead} page(s), +${all.length - beforeKeyword} technical contract cards, ${elapsedSeconds}s`);
      }
      // Dedup by url
      const byUrl = new Map<string, DiscoveredOpportunity>();
      for (const r of all) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
      return [...byUrl.values()];
    } finally {
      await ctx.close();
    }
  },
};

/**
 * A channel taxonomy supplements active resume positionings; it never replaces
 * them. Deduplicate case-insensitively so broad terms do not waste a SEEK query
 * slot when a resume type happens to declare the same term with different case.
 */
export function mergeSearchKeywords(configured: string[], resumeKeywords: string[]): string[] {
  const merged = new Map<string, string>();
  for (const raw of [...configured, ...resumeKeywords]) {
    const keyword = String(raw).trim();
    if (!keyword) continue;
    const key = keyword.toLocaleLowerCase("en-AU");
    if (!merged.has(key)) merged.set(key, keyword);
  }
  return [...merged.values()];
}

export type SeekEnrichment = {
  description: string;
  location?: string;
  workType?: string;
  postedAt?: string;
  workArrangement: "remote" | "hybrid" | "onsite" | "unknown";
};

/**
 * Fetch full SEEK adverts for existing rows. Search cards are enough for broad
 * discovery, but mandatory skills, certifications and arrangement often only
 * appear in the full advert.
 *
 * The pipeline is loaded and saved once. That keeps this pass linear instead
 * of repeatedly rewriting the entire state file for every advert.
 */
export async function enrichSeekRoles(options: {
  id?: string;
  status?: string;
  minScore?: number;
  concurrency?: number;
  limit?: number;
  /** Only rows matched to this resume id (pipeline resumeId or classification matched_resume_id). */
  resume?: string;
} = {}): Promise<{ selected: number; enriched: number; unchanged: number; failed: number }> {
  const roles = await loadPipeline();
  const status = options.status ?? "shortlisted";
  const minScore = options.minScore ?? 20;
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 4));
  const classifiedResume = options.resume ? await loadClassifiedResumeIds() : null;
  const candidates = roles
    .filter((role) => role.channel === "seek")
    .filter((role) => !options.id || role.id === options.id)
    .filter((role) => !options.resume || role.resumeId === options.resume || classifiedResume?.get(role.id) === options.resume)
    .filter((role) => status === "any" || role.status === status)
    .filter((role) => (role.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);

  if (!candidates.length) return { selected: 0, enriched: 0, unchanged: 0, failed: 0 };

  const ctx = await openChromeContext("seek-enrich", { headless: true });
  let enriched = 0;
  let unchanged = 0;
  let failed = 0;
  let cursor = 0;
  const startedAt = Date.now();

  try {
    const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const role = candidates[index];
        const page = await ctx.newPage();
        try {
          await page.goto(role.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForSelector("[data-automation='jobAdDetails']", { timeout: 12_000 });
          // Pass a browser-native expression rather than a transpiled callback.
          // tsx/esbuild can otherwise inject its `__name` helper into nested
          // functions, which does not exist inside the page JavaScript realm.
          const data = await page.evaluate(`(() => {
            const bodyText = document.body ? document.body.innerText : "";
            const postedMatch = bodyText.match(/\\b(?:Listed|Posted)\\s+(?:(?:about\\s+)?\\d+\\s*(?:minutes?|mins?|hours?|hrs?|days?|d)\\s+ago|(?:an?|one)\\s+(?:minute|hour|day)\\s+ago|just now|moments ago)\\b/i);
            const descriptionNode = document.querySelector("[data-automation='jobAdDetails']");
            const workTypeNode = document.querySelector("[data-automation='job-detail-work-type']");
            const locationNode = document.querySelector("[data-automation='job-detail-location']");
            return {
              description: descriptionNode ? (descriptionNode.textContent || "").trim() : "",
              workType: workTypeNode ? (workTypeNode.textContent || "").trim() : "",
              location: locationNode ? (locationNode.textContent || "").trim() : "",
              posted: postedMatch ? postedMatch[0] : "",
            };
          })()`) as { description: string; workType: string; location: string; posted: string };
          if (!data.description || data.description.length < 80) throw new Error("full job description was empty or too short");

          const enrichment: SeekEnrichment = {
            description: data.workType ? `[Employment type: ${data.workType}]\n\n${data.description}` : data.description,
            location: data.location || role.location,
            workType: data.workType || undefined,
            // Relative labels move every run; preserve the first captured
            // timestamp so enrichment is idempotent and does not create drift.
            postedAt: role.postedAt ?? parseRelativePostedAt(data.posted),
            workArrangement: inferArrangement(data.location || role.location || "", data.description),
          };
          const changed = applySeekEnrichment(role, enrichment);
          if (changed) enriched++;
          else unchanged++;
        } catch (error) {
          failed++;
          console.error(`[seek:enrich] ${role.id} failed: ${(error as Error).message.slice(0, 180)}`);
        } finally {
          await page.close();
          const complete = enriched + unchanged + failed;
          if (complete % 5 === 0 || complete === candidates.length) {
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            console.error(`[seek:enrich] ${complete}/${candidates.length}: ${enriched} updated, ${unchanged} unchanged, ${failed} failed (${elapsed}s)`);
          }
        }
      }
    });
    await Promise.all(workers);
  } finally {
    await ctx.close();
  }

  if (enriched) await savePipeline(roles);
  return { selected: candidates.length, enriched, unchanged, failed };
}

/** id → matched_resume_id from state/pipeline/classifications.json (absent file → empty map). */
async function loadClassifiedResumeIds(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const raw = JSON.parse(await fs.readFile("state/pipeline/classifications.json", "utf8"));
    for (const [id, entry] of Object.entries(raw as Record<string, any>)) {
      if (entry?.matched_resume_id) out.set(id, String(entry.matched_resume_id));
    }
  } catch {
    // no classifications yet
  }
  return out;
}

export function applySeekEnrichment(role: Opportunity, enrichment: SeekEnrichment): boolean {
  let changed = false;
  const fields = {
    description: enrichment.description,
    location: enrichment.location,
    postedAt: enrichment.postedAt,
    workArrangement: enrichment.workArrangement,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && role[key as keyof Opportunity] !== value) {
      (role as any)[key] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * SEEK sometimes returns construction/commercial roles for broad words such as
 * "manager" and "lead". Keep this deliberately cheap: it is only a pre-ingest
 * noise gate; agent classification remains the authoritative fit decision.
 */
export function looksTechnicallyRelevant(title: string, description: string): boolean {
  const heading = title.toLowerCase();
  const text = `${title} ${description}`.toLowerCase();
  const strongTitleSignal = /\b(ai|artificial intelligence|genai|llm|agentic|architect|architecture|technology|technical|software|engineering|engineer|developer|development|digital|it|ict|data|cloud|platform|systems?|cyber|security|threat intelligence|servicenow|salesforce|dynamics(?: 365)?|microsoft|m365|sharepoint|oracle|erp|edi|integration|applications?|solutions?|functional consultant|product specialist|service management)\b/;
  if (strongTitleSignal.test(heading)) return true;

  const genericTargetTitle = /\b(delivery manager|delivery lead|program(?:me)? manager|project lead|transformation lead|engagement manager|consultant|director)\b/;
  const technicalContext = /\b(technology|technical|software|engineering|digital|it|ict|data|cloud|platform|systems?|cyber|security|servicenow|salesforce|dynamics|microsoft|m365|sharepoint|oracle|erp|edi|integration|applications?|saas|api)\b/;
  return genericTargetTitle.test(heading) && technicalContext.test(text);
}

export function looksLikeContractWorkType(workType: string): boolean {
  return /\b(contract|temp(?:orary)?|casual|freelance|fractional|interim)\b/i.test(workType);
}

export function buildSearchUrl(keyword: string, location: string, workType: string[], postedWithinDays: number, pageNumber = 1): string {
  const k = encodeURIComponent(keyword.replace(/\s+/g, "-"));
  const l = encodeURIComponent(location.replace(/\s+/g, "-"));
  // SEEK's current public route for Contract/Temp results is `/contract-temp`.
  // The former numeric `worktype=242,243` mapping no longer constrained the
  // results and admitted permanent/full-time jobs.
  const typePath = workType.some((t) => t === "contract" || t === "casual") ? "/contract-temp" : "";
  const date = `daterange=${Math.max(1, Math.min(31, postedWithinDays))}`;
  const page = pageNumber > 1 ? `&page=${pageNumber}` : "";
  return `https://www.seek.com.au/${k}-jobs/in-${l}${typePath}?sortmode=ListedDate&${date}${page}`;
}

function inferArrangement(location: string, description: string): "remote" | "hybrid" | "onsite" | "unknown" {
  const text = `${location} ${description}`.toLowerCase();
  if (/\bremote\b/.test(text) && !/hybrid/.test(text)) return "remote";
  if (/hybrid|2-3 days|2 to 3 days/.test(text)) return "hybrid";
  if (/onsite|on-site|in-office/.test(text)) return "onsite";
  return "unknown";
}

export function parseRelativePostedAt(text: string, now = new Date()): string | undefined {
  const value = text.toLowerCase();
  const countMatch = value.match(/(?:listed|posted)\s+(?:about\s+)?(\d+)\s*(minute|min|hour|hr|day|d)s?\s+ago/);
  const wordMatch = value.match(/(?:listed|posted)\s+(an?|one)\s+(minute|hour|day)\s+ago/);
  let count: number | undefined;
  let unit: string | undefined;
  if (countMatch) {
    count = Number(countMatch[1]);
    unit = countMatch[2];
  } else if (wordMatch) {
    count = 1;
    unit = wordMatch[2];
  } else if (/(?:listed|posted)\s+(?:just now|moments ago)/.test(value)) {
    return now.toISOString();
  }
  if (!count || !unit) return undefined;
  const millis = /day|^d$/.test(unit) ? count * 86_400_000 : /hour|hr/.test(unit) ? count * 3_600_000 : count * 60_000;
  return new Date(now.getTime() - millis).toISOString();
}

// ---------------------------------------------------------------------------
// Saved jobs (https://www.seek.com.au/my-activity/saved-jobs)
// ---------------------------------------------------------------------------

export type SeekSavedJob = {
  jobId: string;
  title: string;
  company: string;
  /** Canonical https://www.seek.com.au/job/<id>. */
  url: string;
  location?: string;
  posted?: string;
  /** "Quick apply" (SEEK-hosted) vs "Apply" (external ATS). */
  quickApply: boolean;
  /** SEEK marks the card "Expired" and links to /expiredjob/<id>. */
  expired: boolean;
};

const SAVED_JOBS_URL = "https://www.seek.com.au/my-activity/saved-jobs";

// Browser-realm string (see enrich for why this is not a transpiled callback).
const EXTRACT_SAVED_CARDS_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  return Array.from(document.querySelectorAll('[data-automation^="job-item-"]')).map((card) => {
    const link = Array.from(card.querySelectorAll("a[href]")).find((a) => /\\/(expired)?job\\/\\d+/.test(a.getAttribute("href") || "") && !/\\/apply\\b/.test(a.getAttribute("href") || ""));
    const href = link ? link.getAttribute("href") || "" : "";
    const idMatch = href.match(/\\/(expired)?job\\/(\\d+)/);
    const lines = (card.innerText || "").split("\\n").map(clean).filter(Boolean);
    const after = (label) => { const i = lines.findIndex((l) => l.toLowerCase() === label); return i >= 0 ? lines[i + 1] || "" : ""; };
    const applyLink = card.querySelector('[data-automation^="apply-link-"]');
    return {
      jobId: idMatch ? idMatch[2] : "",
      expired: !!(idMatch && idMatch[1]) || lines[0] === "Expired",
      title: after("job title") || clean((link ? link.textContent : "").replace(/^Job Title/i, "")),
      company: after("advertiser"),
      location: after("location"),
      posted: (lines.find((l) => /^posted\\b/i.test(l)) || ""),
      applyText: applyLink ? clean(applyLink.textContent) : "",
    };
  });
})()`;

/**
 * Walk every page of the signed-in user's SEEK saved-jobs list. Saved jobs are
 * a strong interest signal: the user chose them by hand on the phone or in the
 * browser, so the harness should know about them even if search never
 * surfaced them.
 */
export async function fetchSeekSavedJobs(): Promise<SeekSavedJob[]> {
  const ctx = await openChromeContext("seek", { headless: true });
  const byId = new Map<string, SeekSavedJob>();
  try {
    const page = await ctx.newPage();
    await page.goto(SAVED_JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (/\/oauth|\/login/i.test(page.url())) throw new Error("SEEK session is signed out; re-run npm run login:seek");
    await page.locator('[data-automation^="job-item-"]').first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
    const totalText = await page.locator("body").innerText().then((t) => t.match(/(\d+)\s+jobs?\b/i)?.[1]).catch(() => undefined);
    const expected = totalText ? Number(totalText) : undefined;

    for (let pageNumber = 1; pageNumber <= 50; pageNumber++) {
      // Nudge lazy rendering, then read the cards on this page.
      await page.mouse.wheel(0, 20_000).catch(() => {});
      await page.waitForTimeout(600);
      const cards = (await page.evaluate(EXTRACT_SAVED_CARDS_JS)) as Array<Omit<SeekSavedJob, "url" | "quickApply"> & { applyText: string }>;
      let added = 0;
      for (const c of cards) {
        if (!c.jobId || byId.has(c.jobId)) continue;
        byId.set(c.jobId, {
          jobId: c.jobId,
          title: c.title,
          company: c.company || "Unknown",
          url: `https://www.seek.com.au/job/${c.jobId}`,
          location: c.location || undefined,
          posted: c.posted || undefined,
          quickApply: /quick apply/i.test(c.applyText),
          expired: c.expired,
        });
        added++;
      }
      console.error(`[seek:saved] page ${pageNumber}: ${cards.length} card(s), +${added} new (total ${byId.size}${expected ? `/${expected}` : ""})`);
      if (expected && byId.size >= expected) break;

      const next = page.getByRole("link", { name: /^next$/i }).or(page.getByRole("button", { name: /^next$/i })).first();
      if ((await next.count()) === 0) break;
      const disabled = await next.evaluate((el: any) => el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled") || el.getAttribute("aria-current") === "page").catch(() => true);
      if (disabled || added === 0) break;
      const firstBefore = cards[0]?.jobId;
      await next.click();
      await page.waitForFunction(
        `(() => { const a = document.querySelector('[data-automation="job-item-0"] a[href]'); return a && !(a.getAttribute("href") || "").includes("/${firstBefore}"); })()`,
        undefined,
        { timeout: 15_000 },
      ).catch(() => {});
      await page.waitForTimeout(800);
    }
  } finally {
    await ctx.close();
  }
  return [...byId.values()];
}

/**
 * Open a job ad and click its Save/Saved toggle only when it currently reads
 * as saved. Returns whether a click happened.
 */
export async function unsaveSeekJob(jobId: string): Promise<{ jobId: string; unsaved: boolean; state: string }> {
  const ctx = await openChromeContext("seek", { headless: true });
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.seek.com.au/job/${jobId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector("[data-automation='jobAdDetails']", { timeout: 15_000 }).catch(() => {});
    const toggle = page.getByRole("button", { name: /^(save|saved|unsave)( job)?$/i }).first();
    if ((await toggle.count()) === 0) return { jobId, unsaved: false, state: "no save button" };
    const readState = async () => {
      const label = (await toggle.innerText().catch(() => "")).trim();
      const pressed = await toggle.getAttribute("aria-pressed").catch(() => null);
      const saved = /^saved$/i.test(label) || /unsave/i.test(label) || pressed === "true";
      return { label, saved };
    };
    const before = await readState();
    if (!before.saved) return { jobId, unsaved: false, state: before.label || "save" };
    await toggle.click();
    await page.waitForTimeout(1200);
    const after = await readState();
    return { jobId, unsaved: !after.saved, state: after.label };
  } finally {
    await ctx.close();
  }
}

async function loadConfig(): Promise<SearchConfig> {
  const file = await fs.readFile("state/profile/channels.yaml", "utf8");
  const all = YAML.parse(file);
  return all.channels?.seek?.search ?? {};
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "enrich") {
    const args: Record<string, string> = {};
    for (let i = 1; i < argv.length; i++) {
      if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    const result = await enrichSeekRoles({
      id: args.id,
      status: args.status,
      minScore: args["min-score"] ? Number(args["min-score"]) : undefined,
      concurrency: args.concurrency ? Number(args.concurrency) : undefined,
      limit: args.limit ? Number(args.limit) : undefined,
      resume: args.resume,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === "saved") {
    const jobs = await fetchSeekSavedJobs();
    const upsertFlag = argv.includes("--upsert");
    const ids: string[] = [];
    let created = 0;
    let alreadyKnown = 0;
    let expired = 0;
    if (upsertFlag) {
      const known = new Map((await loadPipeline()).map((r) => [r.id, r]));
      const now = new Date().toISOString();
      for (const job of jobs) {
        if (job.expired) {
          expired++;
          continue;
        }
        const id = opportunityIdFor("seek", job.url);
        const existing = known.get(id);
        if (existing) alreadyKnown++;
        else created++;
        // Same shape as `search --upsert`; upsert() never rewinds an existing
        // row's status, so a submitted row only gains the userSaved flag.
        const partial: Partial<Opportunity> & { channel: string; url: string; title: string; company: string } = {
          id,
          channel: "seek",
          title: job.title,
          company: job.company,
          url: job.url,
          userSaved: true,
          ...(existing ? {} : { location: job.location, status: "discovered" as const }),
        };
        if (!existing?.userSavedAt) partial.userSavedAt = now;
        await upsert(partial);
        ids.push(id);
      }
      console.log(JSON.stringify({ saved: jobs.length, new: created, alreadyKnown, expired, ids }, null, 2));
    } else {
      const known = new Set((await loadPipeline()).map((r) => r.id));
      for (const job of jobs) {
        const id = opportunityIdFor("seek", job.url);
        ids.push(id);
        if (job.expired) expired++;
        else if (known.has(id)) alreadyKnown++;
        else created++;
      }
      console.log(JSON.stringify({ saved: jobs.length, new: created, alreadyKnown, expired, ids, jobs }, null, 2));
    }
    return;
  }
  if (cmd === "unsave") {
    const jobArg = argv.indexOf("--job");
    const jobId = jobArg >= 0 ? argv[jobArg + 1] : undefined;
    if (!jobId || !/^\d+$/.test(jobId)) {
      console.error("Usage: tsx tools/channels/seek.ts unsave --job <jobId>");
      process.exit(2);
    }
    console.log(JSON.stringify(await unsaveSeekJob(jobId), null, 2));
    return;
  }
  if (cmd !== "search") {
    console.error("Usage: tsx tools/channels/seek.ts (search [--upsert] | enrich [--status shortlisted|any] [--min-score 20] [--concurrency 4] [--limit N] [--resume <id>] | saved [--upsert] | unsave --job <jobId>)");
    process.exit(2);
  }
  const upsertFlag = argv.includes("--upsert");
  const cfg = await loadConfig();
  console.error(`[seek] searching with config: ${JSON.stringify(cfg)}`);
  const opportunities = await seek.search(cfg);
  console.error(`[seek] discovered ${opportunities.length} opportunities`);
  if (upsertFlag) {
    for (const r of opportunities) {
      const id = opportunityIdFor(r.channel, r.url);
      const partial: any = { ...r, id, status: "discovered" };
      await upsert(partial);
    }
    console.error(`[seek] upserted ${opportunities.length} opportunities`);
  } else {
    console.log(JSON.stringify(opportunities, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
