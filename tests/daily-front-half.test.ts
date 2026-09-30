#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { huntArgsFor, seekVerificationRequired } from "../tools/daily-front-half.ts";

assert.equal(seekVerificationRequired({ result: { challenge: true } }), true);
assert.equal(seekVerificationRequired({ error: "visible=Help us keep SEEK secure, confirm you are human" }), true);
assert.equal(seekVerificationRequired({ error: "Performing security verification" }), true);
assert.equal(seekVerificationRequired({ error: "SEEK human verification required on saved-jobs page" }), true);
assert.equal(seekVerificationRequired({ result: { selected: 2, failed: 1, challenge: false } }), false);
assert.equal(seekVerificationRequired({ error: "network timeout" }), false);
assert.equal(seekVerificationRequired(undefined), false);

assert.deepEqual(huntArgsFor("linkedin_jobs"), ["--upsert", "--no-enrich"]);
assert.deepEqual(huntArgsFor("seek"), ["--upsert"]);

console.log("daily-front-half.test.ts: SEEK challenge detection and single LinkedIn enrichment passed");
