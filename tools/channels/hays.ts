#!/usr/bin/env tsx
/**
 * hays.ts — Hays Australia IT roles (stub).
 *
 * STATUS: skeleton. Hays has a public search UI at hays.com.au/job-search;
 * fleshing this out is mostly a regex/selector exercise. Submit is via
 * their portal (a separate hays-submit.ts adapter, not yet built).
 */

import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";

export const hays: HuntChannel = {
  id: "hays",
  async search(_cfg: SearchConfig): Promise<DiscoveredOpportunity[]> {
    console.error(`[hays] STUB — implement Hays AU search here.`);
    return [];
  },
};

if (import.meta.url === `file://${process.argv[1]}`) hays.search({}).then((r) => console.log(JSON.stringify(r, null, 2)));
