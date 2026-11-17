#!/usr/bin/env tsx
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "li-throttle-"));
process.env.LINKEDIN_THROTTLE_PATH = path.join(dir, "throttle.json");
const { takeLinkedInLoad, LinkedInBudgetExhausted, allowanceFor } = await import("../tools/channels/linkedin-throttle.ts");

const config = { dailyLoads: 4, sendReserve: 2, minGapMs: 30_000, gapSpreadMs: 0 };
let clock = Date.parse("2026-11-18T00:00:00Z");
const waits: number[] = [];
const opts = { config, now: () => clock, sleep: async (ms: number) => { waits.push(ms); clock += ms; }, random: () => 0 };

assert.equal(allowanceFor("advert", config), 2, "reading stops short of the send reserve");
assert.equal(allowanceFor("apply", config), 4);

await takeLinkedInLoad("advert", opts);
assert.equal(waits.length, 0, "first load of the day does not wait");
clock += 5_000;
await takeLinkedInLoad("search", opts);
assert.deepEqual(waits, [25_000], "a load inside the gap waits out the remainder");

await assert.rejects(() => takeLinkedInLoad("advert", opts), LinkedInBudgetExhausted, "reads cannot spend the send reserve");
await takeLinkedInLoad("apply", opts);
await takeLinkedInLoad("apply", opts);
await assert.rejects(() => takeLinkedInLoad("apply", opts), LinkedInBudgetExhausted, "the daily cap holds for sends too");

clock = Date.parse("2026-11-18T14:00:00Z"); // next Sydney day
await takeLinkedInLoad("advert", opts);
assert.equal(JSON.parse(fs.readFileSync(process.env.LINKEDIN_THROTTLE_PATH, "utf8")).loads, 1, "the budget resets on the Sydney date");

console.log("linkedin throttle tests passed");
