#!/usr/bin/env tsx
/**
 * score-band.test.ts — banded fit_verdict on the pipeline scorer.
 *
 * The band is ADVISORY: it is an added field on the score result and must never
 * move the numeric `score` used for ranking, so these tests exercise the pure
 * banding/weighting helpers with a synthetic taxonomy (nothing personal).
 */

import assert from "node:assert/strict";
import { bandFor, computeFitVerdict, type SkillTaxonomy } from "../tools/score.ts";

const taxonomy: SkillTaxonomy = {
  categories: {
    platforms: {
      servicenow: { synonyms: ["ServiceNow", "SNow"], seniority: "expert" },
      microsoft365: { synonyms: ["Microsoft 365", "M365"], seniority: "expert" },
    },
    engineering_stack: {
      java: { synonyms: ["Java"], seniority: "practitioner" },
    },
  },
};

// --- bands ------------------------------------------------------------------
assert.equal(bandFor(0), "weak");
assert.equal(bandFor(39), "weak");
assert.equal(bandFor(40), "partial");
assert.equal(bandFor(64), "partial");
assert.equal(bandFor(65), "strong");
assert.equal(bandFor(89), "strong");
assert.equal(bandFor(90), "over_qualified");
assert.equal(bandFor(100), "over_qualified");

// --- 0.7 / 0.3 weighting ----------------------------------------------------
{
  // required: ServiceNow + Microsoft 365 covered, Kubernetes not → 67
  // preferred: Java covered, Terraform not → 50
  const v = computeFitVerdict({
    requiredTerms: ["ServiceNow", "Microsoft 365", "Kubernetes"],
    preferredTerms: ["Java", "Terraform"],
    taxonomy,
    overallOverlapPct: 0,
  });
  assert.equal(v.derived_from, "term_lists");
  assert.equal(v.required_match, 67);
  assert.equal(v.preferred_match, 50);
  assert.equal(v.combined, Math.round(67 * 0.7 + 50 * 0.3));
  assert.equal(v.combined, 62);
  assert.equal(v.band, "partial");
  assert.equal(v.flight_risk, false);
}

// whole-word matching: "Java" must not be covered by a "JavaScript" requirement
{
  const v = computeFitVerdict({ requiredTerms: ["JavaScript"], taxonomy, overallOverlapPct: 0 });
  assert.equal(v.required_match, 0, "'Java' in the taxonomy does not cover a JavaScript requirement");
}

// --- over-qualified is a flight risk, not a "best" ---------------------------
{
  const v = computeFitVerdict({
    requiredTerms: ["ServiceNow", "M365"],
    preferredTerms: ["Java"],
    taxonomy,
    overallOverlapPct: 0,
  });
  assert.equal(v.combined, 100);
  assert.equal(v.band, "over_qualified");
  assert.equal(v.flight_risk, true);
  assert.match(v.reason, /flight risk/);
}

// --- derived fallback when no term lists exist -------------------------------
{
  const v = computeFitVerdict({ taxonomy, overallOverlapPct: 72.4 });
  assert.equal(v.derived_from, "overall_overlap");
  assert.equal(v.required_match, 72);
  assert.equal(v.preferred_match, 72);
  assert.equal(v.combined, 72, "0.7/0.3 blend of one derived number collapses to that number");
  assert.equal(v.band, "strong");
  assert.match(v.reason, /derived from overall skill overlap/);
}

// empty term lists on a taxonomy-less call still land in range
{
  const v = computeFitVerdict({ overallOverlapPct: 0 });
  assert.equal(v.combined, 0);
  assert.equal(v.band, "weak");
}

console.log("score band tests passed");
