import { applySeekEnrichment, buildSearchUrl, looksLikeContractWorkType, looksTechnicallyRelevant, mergeSearchKeywords, parseRelativePostedAt } from "../tools/channels/seek.ts";
import type { Opportunity } from "../tools/pipeline.ts";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const cases: Array<[string, string, boolean]> = [
  ["Bid Manager", "Commercial bids for road and civil infrastructure projects", false],
  ["AI Solutions Architect", "Design agentic systems for enterprise clients", true],
  ["Delivery Manager", "Lead a software platform and cloud transformation programme", true],
  ["Delivery Manager", "Deliver civil construction and rail packages", false],
  ["Microsoft 365 Consultant", "SharePoint and modern workplace advisory", true],
];

let failed = 0;
for (const [title, description, expected] of cases) {
  const actual = looksTechnicallyRelevant(title, description);
  if (actual !== expected) {
    failed++;
    console.error(`  ✗ ${title}: expected ${expected}, got ${actual}`);
  } else {
    console.log(`  ✓ ${title}: ${actual ? "keep" : "reject"}`);
  }
}

if (failed) process.exit(1);

const fixedNow = new Date("2026-09-03T03:00:00.000Z");
const listedOneDayAgo = parseRelativePostedAt("Listed one day ago", fixedNow);
if (listedOneDayAgo !== "2026-09-02T03:00:00.000Z") {
  console.error(`  ✗ relative posting date parse: ${listedOneDayAgo}`);
  failed++;
} else {
  console.log("  ✓ relative posting date parses one day ago");
}

const posted19dAgo = parseRelativePostedAt("Posted 19d ago", fixedNow);
if (posted19dAgo !== "2026-08-15T03:00:00.000Z") {
  console.error(`  ✗ compact posting date parse: ${posted19dAgo}`);
  failed++;
} else {
  console.log("  ✓ relative posting date parses compact days");
}

const contractUrl = buildSearchUrl("AI Architect", "All Australia", ["contract", "casual"], 7);
if (!contractUrl.includes("/contract-temp?")) {
  console.error(`  ✗ contract URL did not use /contract-temp: ${contractUrl}`);
  failed++;
} else {
  console.log("  ✓ contract URL uses /contract-temp");
}

const secondPageUrl = buildSearchUrl("Azure AI Agent Developer", "All Australia", ["contract"], 7, 2);
if (!secondPageUrl.includes("&page=2")) {
  console.error(`  ✗ second-page URL omitted pagination: ${secondPageUrl}`);
  failed++;
} else {
  console.log("  ✓ second-page URL includes page=2");
}

const mergedKeywords = mergeSearchKeywords(
  ["AI", "SharePoint", "Delivery Manager"],
  ["ai", "Azure AI Agent Developer", "Technology Project Manager"],
);
if (
  mergedKeywords.join("|") !== "AI|SharePoint|Delivery Manager|Azure AI Agent Developer|Technology Project Manager"
) {
  console.error(`  ✗ SEEK keyword merge replaced a profile term or failed case-insensitive dedup: ${mergedKeywords.join("|")}`);
  failed++;
} else {
  console.log("  ✓ SEEK taxonomy supplements active-resume keywords without duplicate queries");
}

const seekConfig = YAML.parse(readFileSync("state/profile/channels.yaml", "utf8"));
const profileResumes = YAML.parse(readFileSync("state/profile/resumes.yaml", "utf8"));
const orgResumeTypes = YAML.parse(readFileSync("state/org/resume-types.yaml", "utf8"));
const activeResumeIds = new Set(
  profileResumes.resumes.filter((resume: { active?: boolean }) => resume.active).map((resume: { id: string }) => resume.id),
);
const activeResumeKeywords = orgResumeTypes.resume_types
  .filter((resume: { id: string }) => activeResumeIds.has(resume.id))
  .flatMap((resume: { search_keywords?: string[] }) => resume.search_keywords ?? []);
const taxonomy = new Set(
  mergeSearchKeywords(seekConfig.channels.seek.search.keywords, activeResumeKeywords)
    .map((keyword: string) => keyword.toLocaleLowerCase("en-AU")),
);
const requiredFamilies = [
  "AI Agent Developer",
  "Solution Architect",
  "SharePoint",
  "Technology Project Manager",
  "M&A",
  "Fractional CTO",
  "ServiceNow",
];
const missingFamilies = requiredFamilies.filter(
  (keyword) => !taxonomy.has(keyword.toLocaleLowerCase("en-AU")),
);
if (missingFamilies.length) {
  console.error(`  ✗ SEEK taxonomy lost target-family coverage: ${missingFamilies.join(", ")}`);
  failed++;
} else {
  console.log("  ✓ SEEK taxonomy retains AI, architecture, M365, delivery, M&A and fractional coverage");
}

for (const [label, expected] of [
  ["Contract/Temp", true],
  ["Casual/Vacation", true],
  ["Full time", false],
] as Array<[string, boolean]>) {
  const actual = looksLikeContractWorkType(label);
  if (actual !== expected) {
    console.error(`  ✗ work type ${label}: expected ${expected}, got ${actual}`);
    failed++;
  } else {
    console.log(`  ✓ work type ${label}: ${actual ? "keep" : "reject"}`);
  }
}

const role = {
  id: "seek-test",
  channel: "seek",
  title: "AI Developer",
  company: "Example",
  url: "https://www.seek.com.au/job/123",
  description: "short teaser",
  status: "shortlisted",
  history: [],
} as Opportunity;
const enrichmentChanged = applySeekEnrichment(role, {
  description: "[Employment type: Contract/Temp]\n\nFull evidence-rich job description",
  location: "Sydney NSW (Hybrid)",
  postedAt: "2026-09-03T03:00:00.000Z",
  workArrangement: "hybrid",
});
if (!enrichmentChanged || role.workArrangement !== "hybrid" || !role.description?.includes("Full evidence-rich")) {
  console.error("  ✗ SEEK enrichment did not update the existing pipeline row");
  failed++;
} else {
  console.log("  ✓ SEEK enrichment updates full evidence without replacing pipeline metadata");
}

if (failed) process.exit(1);
