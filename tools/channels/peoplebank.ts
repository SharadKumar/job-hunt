#!/usr/bin/env tsx
/** Peoplebank Sydney IT roles (stub). */
import type { DiscoveredOpportunity, HuntChannel, SearchConfig } from "./_interface.ts";
export const peoplebank: HuntChannel = {
  id: "peoplebank",
  async search(_cfg: SearchConfig): Promise<DiscoveredOpportunity[]> {
    console.error(`[peoplebank] STUB`); return [];
  },
};
if (import.meta.url === `file://${process.argv[1]}`) peoplebank.search({}).then((r) => console.log(JSON.stringify(r, null, 2)));
