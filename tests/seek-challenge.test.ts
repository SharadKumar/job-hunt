import assert from "node:assert/strict";
import { seekHeadless, seekPaceMs } from "../tools/channels/_browser.ts";
import { waitForSeekChallengeToClear } from "../tools/channels/seek-submit.ts";
import { SEEK_CHECK_ACTION, seekCheckReason } from "../tools/daily-summary.ts";
import { SEEK_SHORTLIST_ENRICH_LIMIT } from "../tools/daily-front-half.ts";

// Scheduled SEEK work stays hidden so it never takes focus; headed is opt-in.
assert.equal(seekHeadless({}), true);
assert.equal(seekHeadless({ HARNESS_SEEK_HEADED: "0" }), true);
assert.equal(seekHeadless({ HARNESS_SEEK_HEADED: "1" }), false);

// Advert reads are spaced 4 to 9 seconds apart; tests can pin the gap.
assert.equal(seekPaceMs({}, () => 0), 4_000);
assert.equal(seekPaceMs({}, () => 1), 9_000);
assert.equal(seekPaceMs({ HARNESS_SEEK_PACE_MS: "0" }), 0);
assert.equal(seekPaceMs({ HARNESS_SEEK_PACE_MS: "-5" }), 0);
assert.equal(seekPaceMs({ HARNESS_SEEK_PACE_MS: "250" }), 250);

// The queued-advert cap is a bounded number.
assert.ok(Number(SEEK_SHORTLIST_ENRICH_LIMIT) > 0 && Number(SEEK_SHORTLIST_ENRICH_LIMIT) <= 25);

function fakePage(texts: string[]) {
  let waits = 0;
  return {
    get waits() { return waits; },
    waitForTimeout: async () => { waits++; },
    locator: () => ({ innerText: async () => texts.length > 1 ? texts.shift()! : texts[0] }),
  } as any;
}

// A check that passes by itself within the window is reported as cleared.
const clears = fakePage(["Performing security verification", "Just a moment", "Senior Architect\nAbout the role"]);
assert.equal(await waitForSeekChallengeToClear(clears, { timeoutMs: 1_000, pollMs: 0 }), true);

// A blank page is not evidence that SEEK let the harness through.
const blankThenCheck = fakePage(["", "Performing security verification"]);
assert.equal(await waitForSeekChallengeToClear(blankThenCheck, { timeoutMs: 20, pollMs: 0 }), false);

// A check that stays up is reported as still challenged once the wait ends.
const stuck = fakePage(["Verify you are human by completing the action below"]);
assert.equal(await waitForSeekChallengeToClear(stuck, { timeoutMs: 20, pollMs: 0 }), false);
assert.ok(stuck.waits > 0);

// Cloudflare's hard block page stops the channel like a check does.
const { isSeekHumanVerification } = await import("../tools/channels/seek-submit.ts");
assert.equal(isSeekHumanVerification("Attention Required! | Cloudflare Sorry, you have been blocked"), true);
assert.equal(isSeekHumanVerification("Senior Architect About the role"), false);

// The daily line says what is waiting and gives one command.
assert.match(seekCheckReason(5, 2), /2 prepared packages and 5 queued SEEK roles$/);
assert.match(seekCheckReason(1, 0), /Waiting: 1 queued SEEK role$/);
assert.doesNotMatch(seekCheckReason(0, 0), /Waiting/);
assert.match(SEEK_CHECK_ACTION, /npm run seek:clear/);
assert.doesNotMatch(seekCheckReason(3, 1) + SEEK_CHECK_ACTION, /[–—]/);

console.log("SEEK challenge pacing tests passed");
