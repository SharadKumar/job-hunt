import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_KEY,
  GENERATOR,
  fromJsonResume,
  normaliseDate,
  toJsonResume,
  validateJsonResume,
} from "../tools/resume/jsonresume.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samplePath = path.join(repoRoot, "templates/resume/classic/sample/sample-content.json");
const sample = JSON.parse(await fs.readFile(samplePath, "utf8")) as ResumeContent;

// ---- export validates against the JSON Resume shape ------------------------

const exported = toJsonResume(sample, { lastModified: "2026-09-11T00:00:00" });
const check = validateJsonResume(exported);
assert.deepEqual(check.errors, []);
assert.equal(check.ok, true);
assert.equal(exported.meta?.generator, GENERATOR);
assert.equal(exported.meta?.resumeId, sample.resumeId);
assert.equal(exported.basics?.name, sample.frontmatter.name);
assert.equal(exported.basics?.summary, sample.summary);
assert.equal(exported.basics?.location?.countryCode, "AU");
assert.equal(exported.basics?.profiles?.[0]?.network, "LinkedIn");
assert.equal(exported.work?.length, sample.experiences.length);
console.log("  ✓ sample export is structurally valid JSON Resume");

// Malformed dates are caught by the structural check.
assert.equal(validateJsonResume({ work: [{ startDate: "March 2022" }] }).ok, false);
assert.equal(validateJsonResume({ work: [{ startDate: "2022-03" }] }).ok, true);
assert.equal(validateJsonResume({ skills: [{ keywords: "not-an-array" }] }).ok, false);
console.log("  ✓ structural check rejects bad dates and wrong types");

// ---- placement mapping -----------------------------------------------------

const featureIdx = sample.experiences.findIndex((e) => e.placement === "feature");
const mentionIdx = sample.experiences.findIndex((e) => e.placement === "mention");
assert.ok(featureIdx >= 0 && mentionIdx >= 0);
const featureExp = sample.experiences[featureIdx];
const mentionExp = sample.experiences[mentionIdx];
assert.equal(featureExp.placement, "feature");
assert.equal(mentionExp.placement, "mention");
if (featureExp.placement === "feature") {
  assert.deepEqual(exported.work?.[featureIdx]?.highlights, featureExp.bullets);
  assert.equal(exported.work?.[featureIdx]?.summary, featureExp.summary);
}
if (mentionExp.placement === "mention") {
  assert.equal(exported.work?.[mentionIdx]?.highlights, undefined);
  assert.equal(exported.work?.[mentionIdx]?.summary, mentionExp.one_liner);
}
// "current" exports as an omitted endDate.
assert.equal(exported.work?.[0]?.endDate, undefined);
assert.equal(exported.work?.[0]?.startDate, "2022-03");
console.log("  ✓ feature/mention and current-role date mapping");

// ---- skills → keywords -----------------------------------------------------

const firstSkill = sample.skills[0];
assert.ok((exported.skills?.[0]?.keywords?.length ?? 0) > firstSkill.bullets.length);
assert.equal(exported.skills?.[0]?.keywords?.[0], firstSkill.bullets[0].split(",")[0].trim());
console.log("  ✓ skill bullets split into keywords");

// ---- round trip on the sample ---------------------------------------------

const back = fromJsonResume(exported);
assert.deepEqual(back.experiences, sample.experiences);
assert.deepEqual(back.skills, sample.skills);
assert.equal(back.summary, sample.summary);
assert.deepEqual(back.highlights, sample.highlights);
assert.deepEqual(back.frontmatter, sample.frontmatter);
assert.equal(back.resumeId, sample.resumeId);
assert.deepEqual(back.dropped_experiences, sample.dropped_experiences);
console.log("  ✓ import(export(sample)) preserves experiences, bullets, skills, summary");

// ---- round trip on a content that exercises every carried field ------------

const full: ResumeContent = {
  frontmatter: {
    name: "Jo Rivera",
    email: "jo@example.com",
    phone: "+61 400 111 222",
    citizenship: "Australian Citizen",
    location: { city: "Sydney", country: "AU" },
    linkedin_url: "https://www.linkedin.com/in/jo-rivera",
    github_url: "https://github.com/jorivera",
  },
  headline: "Agentic AI Engineering Lead",
  summary: "Prose summary that must survive the trip intact.",
  highlights: ["First impact line.", "Second impact line."],
  skills: [
    { name: "Platform", summary: "One-line skill summary.", bullets: ["Kafka, Kubernetes, Terraform", "Single item"] },
    { name: "Screener block", bullets: ["Python, TypeScript, Go"], role: "screener" },
    { name: "No bullets", bullets: [] },
  ],
  additional_skills_summary: "Other source-supported skills in one paragraph.",
  credentials: [
    "Bachelor of Engineering, University of Melbourne, 2004",
    "AWS Certified Solutions Architect, 2023",
    "Some credential with no year",
  ],
  experiences: [
    {
      placement: "feature",
      title: "Principal Consultant",
      company: "Acme Consulting",
      location: "Remote",
      start: "2026-03",
      end: "current",
      tier: 1,
      summary: "Featured summary.",
      bullets: ["Bullet one.", "Bullet two."],
    },
    {
      placement: "feature",
      title: "Founder",
      company: "Sideline Labs",
      start: "2025-01",
      end: "2026-02",
      date_label: "Launched February 2026",
      summary: "Featured with no bullets yet.",
      bullets: [],
    },
    {
      placement: "mention",
      title: "Analyst",
      company: "Earlier Co",
      start: "2007",
      end: "2010-01",
      one_liner: "Compact relevance hook.",
    },
  ],
  dropped_experiences: [{ id: "old-role", reason: "Not relevant to the positioning." }],
  resumeId: "full-fixture",
};

const fullJson = toJsonResume(full);
assert.deepEqual(validateJsonResume(fullJson).errors, []);
assert.deepEqual(fromJsonResume(fullJson), full);
console.log("  ✓ round trip is lossless across every carried field");

// A feature with zero bullets survives only because of the placement sidecar.
assert.equal(fullJson.work?.[1]?.highlights, undefined);
assert.equal(fullJson.meta?.[EXTENSION_KEY]?.work?.[1]?.placement, "feature");
assert.equal(fullJson.basics?.label, full.headline);
console.log("  ✓ headline maps to basics.label; empty-bullet feature keeps placement");

// ---- credentials heuristic -------------------------------------------------

assert.equal(fullJson.education?.length, 1);
assert.equal(fullJson.education?.[0]?.institution, "University of Melbourne");
assert.equal(fullJson.education?.[0]?.area, "Bachelor of Engineering");
assert.equal(fullJson.education?.[0]?.endDate, "2004");
assert.equal(fullJson.certificates?.length, 2);
assert.equal(fullJson.certificates?.[0]?.name, "AWS Certified Solutions Architect");
assert.equal(fullJson.certificates?.[0]?.date, "2023");
assert.equal(fullJson.certificates?.[1]?.date, undefined);
console.log("  ✓ credentials split into education vs certificates");

// ---- internal fields never leak -------------------------------------------

const withInternals: ResumeContent = {
  ...full,
  bench: { bullets: { "experiences[0]": [{ text: "Benched bullet." }] } },
  source_provenance: { evidence: { summary: [], highlights: [], skills: {}, experiences: {} } },
  market_alignment: { applied_terms: ["agentic"] },
};
const internalJson = JSON.stringify(toJsonResume(withInternals));
for (const leak of ["Benched bullet", "source_provenance", "market_alignment", "bench"]) {
  assert.equal(internalJson.includes(leak), false, `exported document leaked ${leak}`);
}
const reimported = fromJsonResume(toJsonResume(withInternals));
assert.equal(reimported.bench, undefined);
assert.equal(reimported.source_provenance, undefined);
assert.equal(reimported.market_alignment, undefined);
console.log("  ✓ bench / provenance / market alignment are omitted and never reconstructed");

// ---- foreign document (no harness extension) -------------------------------

const foreign = toJsonResume(full, { extensions: false });
assert.equal(foreign.meta?.[EXTENSION_KEY], undefined);
assert.deepEqual(validateJsonResume(foreign).errors, []);
const fromForeign = fromJsonResume(foreign);
assert.equal(fromForeign.summary, full.summary);
assert.equal(fromForeign.headline, full.headline);
assert.equal(fromForeign.experiences[0].placement, "feature");
// No sidecar: a bullet-less feature degrades to a mention, and skill lines collapse.
assert.equal(fromForeign.experiences[1].placement, "mention");
assert.deepEqual(fromForeign.skills[0].bullets, ["Kafka, Kubernetes, Terraform, Single item"]);
assert.equal(fromForeign.credentials?.length, 3);
assert.deepEqual(fromForeign.highlights, []);
console.log("  ✓ extension-free documents still import with documented fallbacks");

// ---- date normalisation ----------------------------------------------------

assert.equal(normaliseDate("2022-03"), "2022-03");
assert.equal(normaliseDate("2022-03-15"), "2022-03");
assert.equal(normaliseDate("2022"), "2022");
assert.equal(normaliseDate("current"), undefined);
assert.equal(normaliseDate(""), undefined);
assert.equal(normaliseDate(undefined), undefined);
console.log("  ✓ date normalisation to YYYY-MM");

console.log("jsonresume: all assertions passed");
