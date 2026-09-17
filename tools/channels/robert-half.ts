#!/usr/bin/env tsx
/** Robert Half Australia Technology contract roles (stub). */
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";
export const robertHalf: HuntChannel = {
  id: "robert_half",
  async search(_cfg: SearchConfig): Promise<DiscoveredOpportunity[]> {
    console.error(`[robert-half] STUB`); return [];
  },
};
if (import.meta.url === `file://${process.argv[1]}`) robertHalf.search({}).then((r) => console.log(JSON.stringify(r, null, 2)));
