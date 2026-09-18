/**
 * Channel module interface — implement this to add a new job-board / portal.
 *
 * A channel does one or both of:
 *   - search(): discovers opportunities matching a config
 *   - submit(): submits an approved application for one opportunity
 *
 * Channels with no submit() automatically land in `manual_action_needed`
 * after approval, so the user can finish in their browser.
 */

import type { Opportunity } from "../pipeline.ts";

export type ChannelId = string;

export type SearchConfig = {
  keywords?: string[];
  location?: string;
  work_type?: string[];
  remote?: "any" | "full" | "hybrid";
  posted_within_days?: number;
  // Per-channel custom fields are allowed.
  [k: string]: unknown;
};

export type DiscoveredOpportunity = Pick<Opportunity, "channel" | "title" | "company" | "url"> & Partial<Pick<Opportunity, "location" | "description" | "postedAt" | "dayRate" | "workArrangement">>;

export type SubmitPackage = {
  cvDocxPath: string;
  cvPdfPath?: string;
  coverLetterMd: string;
  screeningAnswers: { id: string; answer: string }[];
};

export type SubmitResult =
  | { ok: true; confirmationRef?: string; screenshotPath?: string }
  | { ok: false; reason: string; needsManual?: boolean; newScreeningQuestion?: { text: string; context: string } };

export interface HuntChannel {
  id: ChannelId;
  /** Search the channel. Throws if auth is required and missing. */
  search(config: SearchConfig): Promise<DiscoveredOpportunity[]>;
  /** Submit a single opportunity. May not exist; if so, it lands in the manual queue. */
  submit?: (opportunity: Opportunity, pkg: SubmitPackage) => Promise<SubmitResult>;
}

/**
 * Channel ids with a hunt adapter under tools/channels/, mapped to the npm
 * script that runs it. A channel enabled in channels.yaml without an entry here
 * has no scraper: report it, do not improvise one.
 */
export const HUNT_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  seek: "hunt:seek",
  linkedin_jobs: "hunt:linkedin-jobs",
  linkedin_posts: "hunt:linkedin-posts",
  hn_who_is_hiring: "hunt:hn",
});

export type HuntAdapterLookup =
  | { ok: true; script: string }
  | { ok: false; reason: string };

/** Resolve a channel id to its hunt script, or say plainly that none exists. */
export function huntScriptFor(channel: ChannelId): HuntAdapterLookup {
  const script = HUNT_SCRIPTS[channel];
  return script ? { ok: true, script } : { ok: false, reason: `no adapter for ${channel}` };
}
