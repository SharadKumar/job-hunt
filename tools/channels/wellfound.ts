#!/usr/bin/env tsx
/** Wellfound (formerly AngelList) (stub; disabled in channels.yaml by default). */
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";
export const wellfound: HuntChannel = {
  id: "wellfound",
  async search(_cfg: SearchConfig): Promise<DiscoveredOpportunity[]> {
    console.error(`[wellfound] STUB`); return [];
  },
};
if (import.meta.url === `file://${process.argv[1]}`) wellfound.search({}).then((r) => console.log(JSON.stringify(r, null, 2)));
