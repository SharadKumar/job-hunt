#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectCorpus, mineTerms, suggestCloud, titleFamilies, JD_BOILERPLATE, MIN_FULL_TEXT_CHARS } from "../tools/resume/lexicon-mine.ts";

const root = mkdtempSync(path.join(tmpdir(), "lexicon-mine-test-"));
const archive = path.join(root, "archive");
mkdirSync(archive, { recursive: true });

const filler = "The successful candidate will join our team in a contract position based in the city office. ".repeat(6);
const jdA = `Senior Solution Architect\n\nAbout the role\n${filler}\nMust have: strong experience with Azure integration services and event driven architecture.\nEssential: Logic Apps and API Management.\nDesirable: TOGAF certification.`;
const jdB = `Solution Architect - Integration\n${filler}\nYou must have hands-on Azure integration services experience and event driven architecture patterns.\nNice to have: Kubernetes.`;
const jdC = `Solution Architect\n${filler}\nRequired: event driven architecture, Azure integration services, Logic Apps.\nBonus: TOGAF certification.`;
const unrelated = `Marketing Coordinator\n${filler}\nMust have: social media campaign experience and event driven architecture is not needed here.`;
assert.ok(jdA.length >= MIN_FULL_TEXT_CHARS, "fixture JDs must clear the full-text threshold");

const pipeline = [
  { id: "seek-a", title: "Senior Solution Architect", description: jdA, resumeId: "solution-architect" },
  { id: "seek-b", title: "Solution Architect - Integration", description: jdB },
  { id: "seek-c", title: "Solution Architect", description: "short teaser" },
  { id: "seek-d", title: "Marketing Coordinator", description: unrelated },
  { id: "seek-e", title: "Principal Solution Architect", description: "" },
];
mkdirSync(path.join(archive, "seek-c"), { recursive: true });
writeFileSync(path.join(archive, "seek-c", "jd.md"), jdC);
writeFileSync(path.join(root, "opportunities.json"), JSON.stringify(pipeline));
writeFileSync(path.join(root, "classifications.json"), JSON.stringify({ "seek-b": { matched_resume_id: "solution-architect" } }));

const corpus = await collectCorpus({
  resumeId: "solution-architect",
  searchKeywords: ["Solution Architect"],
  pipelinePath: path.join(root, "opportunities.json"),
  classificationsPath: path.join(root, "classifications.json"),
  archiveDir: archive,
});

// resumeId match, classification match, title match; marketing row excluded.
assert.equal(corpus.matchingRows, 4);
const full = corpus.docs.filter((d) => d.text);
assert.deepEqual(full.map((d) => d.id).sort(), ["seek-a", "seek-b", "seek-c"]);
assert.equal(full.find((d) => d.id === "seek-c")?.source, "archive", "archived jd.md replaces a short pipeline teaser");
assert.equal(corpus.docs.filter((d) => !d.text).length, 1, "title-only row kept for title vocabulary");
assert.ok(corpus.backgroundDocs.some((d) => d.id === "seek-d"), "background includes unrelated full JDs");

const cvSource = "## Skills\n- Azure integration services, Logic Apps, API Management\n- Event-driven architecture on Service Bus\n";
const terms = mineTerms(corpus.docs, cvSource, { minDf: 2, titles: corpus.titles, backgroundDocs: corpus.backgroundDocs });
const byTerm = new Map(terms.map((t) => [t.term, t]));

const eda = byTerm.get("event driven architecture");
assert.ok(eda, "3-gram must-have term is mined");
assert.equal(eda.df, 3);
assert.equal(eda.must_have_df, 3);
assert.equal(eda.corpus_status, "present");
assert.equal(eda.suggested_tier, "corpus");
assert.ok(eda.corpus_lines.length > 0);

const togaf = byTerm.get("togaf certification");
assert.ok(togaf, "certification phrase is mined");
assert.equal(togaf.corpus_status, "absent");
assert.equal(togaf.suggested_category, "certification");
assert.equal(togaf.suggested_tier, "forbidden", "absent certifications are never suggested as claimable");
assert.equal(togaf.must_have_df, 0, "desirable/bonus lines do not count as must-have");

for (const t of terms) {
  assert.ok(!JD_BOILERPLATE.has(t.term), `boilerplate term leaked: ${t.term}`);
  assert.ok(!["successful candidate", "contract position", "join our"].includes(t.term), `advert phrase leaked: ${t.term}`);
}
assert.ok(!byTerm.has("must"), "cue words are never terms");

// Background penalty: a term in the unrelated JD scores lower than the same-df term absent from it.
assert.ok(eda.background_df === 1, "event driven architecture appears in the unrelated JD");
const azure = byTerm.get("azure integration services");
assert.ok(azure && azure.background_df === 0);
assert.ok(azure.score > eda.score * (1 - 0.85) , "background penalty applied but does not zero a strong term");

// Titles
const fam = titleFamilies(corpus.titles);
assert.equal(fam[0].title, "solution architect");
assert.ok(fam[0].count >= 3);

// minDf filter
const strict = mineTerms(corpus.docs, cvSource, { minDf: 3, backgroundDocs: corpus.backgroundDocs });
assert.ok(strict.every((t) => t.df >= 3 || t.title_df >= 3));

// --- cloud suggestions ------------------------------------------------------
// A mined term is raw research; the suggestion says which cloud should own it.
{
  const clouds = [
    { id: "enterprise-architecture", kind: "capability", label: "Enterprise architecture", terms: [{ term: "event-driven architecture", aliases: ["EDA", "pub/sub"] }, { term: "integration architecture" }] },
    { id: "azure-and-microsoft-ai", kind: "tooling", label: "Azure and Microsoft AI", terms: [{ term: "Azure", aliases: ["Azure integration services"] }] },
    { id: "programme-delivery", kind: "capability", label: "Programme delivery", terms: [{ term: "release management" }] },
  ];
  assert.equal(suggestCloud("event driven architecture", clouds)?.id, "enterprise-architecture");
  assert.equal(suggestCloud("azure integration services", clouds)?.id, "azure-and-microsoft-ai");
  assert.equal(suggestCloud("azure integration services", clouds)?.kind, "tooling");
  assert.equal(suggestCloud("release management", clouds)?.id, "programme-delivery");
  assert.equal(suggestCloud("competitive netball", clouds), null, "nothing overlapping means no suggestion");
  assert.equal(suggestCloud("", clouds), null);
  assert.equal(suggestCloud("event driven architecture", []), null, "no clouds means no suggestion");
}

console.log("lexicon-mine tests passed");
