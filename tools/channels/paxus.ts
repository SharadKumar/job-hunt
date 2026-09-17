#!/usr/bin/env tsx
/** Paxus AU IT roles (stub). */
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";
export const paxus: HuntChannel = {
  id: "paxus",
  async search(_cfg: SearchConfig): Promise<DiscoveredOpportunity[]> {
    console.error(`[paxus] STUB`); return [];
  },
};
if (import.meta.url === `file://${process.argv[1]}`) paxus.search({}).then((r) => console.log(JSON.stringify(r, null, 2)));
