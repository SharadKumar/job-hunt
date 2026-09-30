#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { nextPriorityRow, priorSeekVerificationRequired, priorityOrder } from "../tools/daily-priority.ts";
import type { Opportunity } from "../tools/pipeline.ts";

function row(id: string, status: string, channel: string, source: string, saved = false, score = 0): Opportunity {
  return { id, status, channel, userSaved: saved, score,
    classification: { schema_version: 2, source, status: "automatic", matched_resume_id: "solution-architect" } } as Opportunity;
}

const selected = priorityOrder([
  row("jev-only", "approved", "seek", "jev", true, 99),
  { ...row("uncertain", "approved", "seek", "agent_fallback", true, 99),
    classification: { schema_version: 2, source: "agent_fallback", status: "uncertain", matched_resume_id: "solution-architect" } } as Opportunity,
  row("portal", "approved", "recruiter", "agent_fallback", true, 99),
  row("pending", "submission_pending", "seek", "agent_fallback", true, 99),
  row("linkedin", "awaiting_approval", "linkedin_jobs", "agent_fallback", false, 70),
  row("saved", "approved", "seek", "agent_fallback", true, 5),
  row("high", "approved", "seek", "agent_fallback", false, 90),
]);
assert.deepEqual(selected.map(item => item.id), ["saved", "high", "linkedin"]);
assert.equal(nextPriorityRow(selected, new Set(["saved"]), true)?.id, "linkedin",
  "a SEEK challenge must not consume the remaining priority slots or hide LinkedIn work");
assert.equal(priorSeekVerificationRequired({ channel_health: { seek: { verification_required: true } } }), true);
assert.equal(priorSeekVerificationRequired({ channel_health: { seek: { verification_required: false } } }), false);
console.log("daily-priority: eligible automatic packages ordered, ineligible rows excluded");
