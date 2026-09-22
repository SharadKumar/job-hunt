#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Opportunity } from "../tools/pipeline.ts";
import { classificationV2 } from "./fixtures/classification-v2.ts";
import { verificationCandidates } from "../tools/jev/verification-queue.ts";

const policy = {
  kill_switch: false,
  autopilot: { enabled: true, channels: ["seek", "linkedin_jobs"] },
  channels: { seek: { auto_submit: true }, linkedin_jobs: { auto_submit: true } },
};

function row(id: string, discipline_fit: "core" | "platform_gap" | "adjacent" | "outside", score: number, extra: Partial<Opportunity> = {}): Opportunity {
  return {
    id, channel: "seek", title: id, company: "Example", url: `https://example.test/${id}`,
    status: "discovered", score, applyMethod: "quick_apply", red_flag_blocker: false,
    classification: classificationV2({ source: "jev", status: "automatic", discipline_fit, matched_resume_id: discipline_fit === "outside" ? null : "solution-architect" }),
    history: [], ...extra,
  };
}

const result = verificationCandidates([
  row("core", "core", 70),
  row("near", "platform_gap", 60),
  row("too-low", "adjacent", 40),
  row("outside", "outside", 20),
  row("saved", "outside", 10, { userSaved: true }),
  row("saved-uncertain", "outside", 10, { userSaved: true, classification: classificationV2({ source: "jev", status: "uncertain", discipline_fit: "outside", matched_resume_id: null }) }),
  row("external", "core", 80, { applyMethod: "external" }),
  row("attended", "core", 80, { channel: "recruiter" }),
  row("uncertain", "core", 80, { classification: classificationV2({ source: "jev", status: "uncertain" }) }),
], policy, 55);

assert.deepEqual(result.map((item) => item.id), ["saved", "saved-uncertain", "core", "near"]);
assert.equal(result.find((item) => item.id === "near")?.reason, "near_miss_parachute");
assert.equal(result.find((item) => item.id === "saved-uncertain")?.reason, "saved_job", "saved jobs reach bounded verification regardless of Jev certainty");
assert.deepEqual(
  verificationCandidates([row("approved", "core", 70, { status: "approved" })], policy, 55).map((item) => item.id),
  ["approved"],
  "an interrupted in-flight row can regain its verification prerequisite",
);
assert.deepEqual(
  verificationCandidates([row("lower", "core", 60), row("higher", "core", 80)], policy, 55).map((item) => item.id),
  ["higher", "lower"],
  "same-kind candidates use score and id tie-breakers instead of a non-zero comparator result",
);
assert.equal(verificationCandidates([row("core", "core", 70)], { ...policy, kill_switch: true }, 55).length, 0);
assert.equal(verificationCandidates([row("core", "core", 70)], { ...policy, autopilot: { ...policy.autopilot, enabled: false } }, 55).length, 0);

console.log("Jev verification queue tests passed");
