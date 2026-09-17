#!/usr/bin/env tsx
/** Talenza Sydney IT roles (stub). */
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";
export const talenza: HuntChannel = {
  id: "talenza",
  async search(_cfg: SearchConfig): Promise<DiscoveredOpportunity[]> {
    console.error(`[talenza] STUB`); return [];
  },
};
if (import.meta.url === `file://${process.argv[1]}`) talenza.search({}).then((r) => console.log(JSON.stringify(r, null, 2)));
