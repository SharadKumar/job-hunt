/** Read-only recovery queue. This discovers work; it never authorises a send. */
import { list } from "./pipeline.ts";
import { displayReason } from "./ui/api.ts";
import { actionFor, actionResolver, laneFor, screeningResolved } from "./ui/rows-ext-api.ts";
import { getScreening } from "./ui/health-api.ts";
import { getPolicy } from "./ui/policy-api.ts";

const bank = await getScreening();
const policy = await getPolicy();
const all = await list();
const resolveAction = await actionResolver();
const preparation = all.filter(row => {
  if (row.status !== "manual_action_needed") return false;
  const reason = displayReason(row);
  const { lane } = laneFor(row, policy);
  return actionFor(row, reason, lane).kind === "portal"
    && resolveAction(row, reason, lane).kind === "in_flight";
});
const rows = all.filter(row => {
  if (row.status !== "manual_action_needed") return false;
  const reason = displayReason(row);
  const { lane } = laneFor(row, policy);
  return lane === "autopilot" && screeningResolved(row.id, reason, bank)
    && actionFor(row, reason, lane, true).kind === "in_flight";
});
console.log(JSON.stringify({
  count: rows.length,
  candidates: rows.map(row => ({ id: row.id, title: row.title, company: row.company })),
  attended_preparation: preparation.map(row => ({ id: row.id, title: row.title, company: row.company,
    reason: "Missing, failing or stale letter critic. Recheck employment eligibility and availability before preparing; never submit unattended." })),
  authority: "Retry candidates only. Recheck expiry, classification, package and all submission gates through autopilot:submit.",
}));
