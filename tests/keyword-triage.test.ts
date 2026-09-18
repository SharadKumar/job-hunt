#!/usr/bin/env tsx
/**
 * keyword-triage.test.ts: the deterministic keyword triage.
 *
 * Everything runs against the synthetic fixtures in
 * `tests/fixtures/keyword-triage/` copied into a temp directory. The real
 * `state/profile/` ledger, taxonomy and cv-source are never opened, and no
 * fixture carries a real person, employer or fact.
 *
 * The one real file under test is the shipped stoplist,
 * `.claude/skills/keyword-triage/references/boilerplate.yaml`: it is framework
 * data, and a rule is only worth having if the list it ships with fires it.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { repoPath } from "../tools/repo-root.ts";
import {
  buildTriageContext, loadTriageContext, triageTerm, triageRows, pendingKeywordRows,
  buildReport, rejectAnswers, loadBoilerplate, cmdTriage,
  type RejectRule, type TriageContext,
} from "../tools/resume/keyword-triage.ts";
import { readLedger, cmdQueue, rejectsPathFor } from "../tools/resume/keyword-confirm.ts";
import type { KeywordPlan, KeywordTerm } from "../tools/resume/keyword-lexicon.ts";
import type { MarketConfirmation } from "../tools/resume/market-lens-audit.ts";

const FIXTURES = repoPath("tests/fixtures/keyword-triage");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-triage-"));
const ledgerPath = path.join(tmp, "market-confirmations.yaml");
const cvPath = path.join(FIXTURES, "cv-source.md");
const taxonomyPath = path.join(FIXTURES, "skills-taxonomy.yaml");
const cloudsPath = path.join(FIXTURES, "keyword-clouds.yaml");
const planPath = path.join(tmp, "keyword-plan.json");

async function reset(): Promise<void> {
  await fs.copyFile(path.join(FIXTURES, "ledger.yaml"), ledgerPath);
  await fs.rm(rejectsPathFor(ledgerPath), { force: true });
}
await reset();

const paths = { "cv-source": cvPath, taxonomy: taxonomyPath, clouds: cloudsPath };
const ctx: TriageContext = await loadTriageContext({
  cvSource: cvPath, taxonomy: taxonomyPath, clouds: cloudsPath,
});

const logs: string[] = [];
const realLog = console.log;
console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
function lastJson(): any {
  const line = [...logs].reverse().find((l) => l.trim().startsWith("{"));
  return JSON.parse(line!.slice(line!.indexOf("{")));
}

// --- the shipped stoplist ---------------------------------------------------

{
  const boilerplate = await loadBoilerplate();
  assert.ok(boilerplate.jd_boilerplate.phrases.includes("apply now"), "the shipped stoplist carries the ad furniture");
  assert.ok(boilerplate.eeo_or_diversity.includes("lgbtq"));
  assert.ok(boilerplate.clearance_or_logistics.exact.includes("wfh"));
  assert.ok(boilerplate.qualifiers.includes("strong"));
  assert.ok(!boilerplate.qualifiers.includes("deep"), "'deep' is not a qualifier: deep learning is a real term");
  assert.ok(boilerplate.trailing_words.includes("what"));
  // The stoplist must stay generic framework data: no profile facts in it.
  const raw = await fs.readFile(repoPath(".claude/skills/keyword-triage/references/boilerplate.yaml"), "utf8");
  assert.ok(!/sharad|nterprise|servicenow|seek\.com/i.test(raw), "the stoplist names no person, employer or tool");
}

// --- every reject rule fires on its own examples ----------------------------

const EXPECTED_REJECTS: Record<string, RejectRule> = {
  "Apply Now": "jd_boilerplate",
  "Key Skills": "jd_boilerplate",
  "Primary Skills": "jd_boilerplate",
  "Why Northwind": "jd_boilerplate",
  "Also Receive": "jd_boilerplate",
  LGBTQ: "eeo_or_diversity",
  "Torres Strait Islander": "eeo_or_diversity",
  "NV1 Clearance": "clearance_or_logistics",
  WFH: "clearance_or_logistics",
  "National Police Check": "clearance_or_logistics",
  "September 2026": "date_or_number",
  "Minimum 5": "date_or_number",
  P1: "date_or_number",
  "Marlow Fentiman": "person_name",
  "Dara Quillfeather": "person_name",
  "enterprise technol": "truncated_fragment",
  "senior te": "truncated_fragment",
  "iterative d": "truncated_fragment",
  "Catalog De": "truncated_fragment",
  "Architectural GovernanceFacilitate": "truncated_fragment",
  "Infrastructure as C": "truncated_fragment",
  "Guidewire Cloud What": "truncated_fragment",
  "ASX 100": "employer_or_program",
  ZNBC: "employer_or_program",
  "Strong ITSM": "generic_phrase",
  "apply problem-solving": "generic_phrase",
  "Excellent Stakeholder Engagement": "generic_phrase",
  "cloud services to develop and maintain": "generic_phrase",
};

const EXPECTED_KEEPS = [
  "TOGAF", "Azure Functions", "LlamaIndex", "ServiceNow", "SQL", "XSLT", "Waterfall",
  "Microsoft Fabric", "deep learning", "Ragas", "Catalog Development",
];

const rows = pendingKeywordRows(await readLedger(ledgerPath));
assert.equal(rows.length, Object.keys(EXPECTED_REJECTS).length + EXPECTED_KEEPS.length,
  "the fixture's pending keyword rows are exactly the expected rejects plus the expected keeps");
assert.ok(!rows.some((r) => r.term === "Kubernetes" || r.term === "architecture framework"),
  "answered keyword rows and market_signal rows are not pending keyword questions");

const verdicts = triageRows(rows, ctx);
const byTerm = new Map(verdicts.map((v) => [v.term, v]));

for (const [term, rule] of Object.entries(EXPECTED_REJECTS)) {
  const verdict = byTerm.get(term);
  assert.ok(verdict, `${term} is in the fixture`);
  assert.equal(verdict!.decision, "reject", `${term} is rejected (got ${JSON.stringify(verdict)})`);
  assert.equal(verdict!.rule, rule, `${term} is rejected by ${rule}, not ${verdict!.rule}`);
  assert.ok(verdict!.evidence.length > 10, `${term} carries readable evidence`);
}

for (const term of EXPECTED_KEEPS) {
  const verdict = byTerm.get(term);
  assert.ok(verdict, `${term} is in the fixture`);
  assert.equal(verdict!.decision, "keep", `${term} survives every reject rule (got ${JSON.stringify(verdict)})`);
}

// A keep is never rejected by any single rule either, not just by the cascade.
for (const term of EXPECTED_KEEPS) {
  const row = rows.find((r) => r.term === term)!;
  const solo = triageTerm(row, { ...ctx, peers: new Set([...ctx.peers, "catalog development"]) });
  assert.equal(solo.decision, "keep", `${term} stays a keep when triaged on its own`);
}

// --- rule detail ------------------------------------------------------------

{
  // the curated vocabularies beat every stoplist: a taxonomy or cloud term is
  // screener vocabulary by construction
  const loud = triageTerm({ term: "ServiceNow", category: "concept", question: "Strong ServiceNow" }, ctx);
  assert.equal(loud.rule, "taxonomy_synonym");

  // peer prefix: the cut form is only rejected because the whole word is queued
  const lonely = buildTriageContext({ boilerplate: ctx.boilerplate, peers: [] });
  assert.equal(triageTerm({ term: "Catalog De" }, lonely).decision, "keep",
    "without the whole word alongside it, a two-capital tail is not evidence enough");

  // the advertiser on the row's own opportunity is never a keyword
  const withCompany = { ...ctx, companyOf: (id: string | null | undefined) => (id === "opp-1" ? "Northwind Utilities" : null) };
  const employer = triageTerm({ term: "Northwind Utilities", opportunity_id: "opp-1" }, withCompany);
  assert.equal(employer.decision, "reject");
  assert.equal(employer.rule, "employer_or_program");
  assert.equal(triageTerm({ term: "Northwind Utilities", opportunity_id: "opp-2" }, withCompany).decision, "keep",
    "the same string on another opportunity is not that advertiser's name");

  // a term the corpus already carries is kept with its evidence named
  const corpus = triageTerm({ term: "architecture principles" }, ctx);
  assert.equal(corpus.decision, "keep");
  assert.equal(corpus.rule, "in_cv_source");

  // camel-cased product names are not sentence glue
  for (const product of ["IntegrationHub", "LlamaIndex", "ServiceNow", "DataFactory"]) {
    assert.equal(triageTerm({ term: product }, ctx).decision, "keep", `${product} is a product name, not a cut sentence`);
  }
}

// --- dry run writes nothing -------------------------------------------------

{
  await reset();
  const before = await fs.readFile(ledgerPath, "utf8");
  assert.equal(await cmdTriage({ ledger: ledgerPath, ...paths }), 0);
  const report = lastJson();
  assert.equal(report.dry_run, true);
  assert.equal(report.pending, rows.length);
  assert.equal(report.reject, Object.keys(EXPECTED_REJECTS).length);
  assert.equal(report.keep, EXPECTED_KEEPS.length);
  assert.equal(report.by_rule.jd_boilerplate, 5);
  assert.equal(report.by_rule.truncated_fragment, 7);
  assert.equal(await fs.readFile(ledgerPath, "utf8"), before, "a dry run never touches the ledger");
  assert.equal(await fs.access(rejectsPathFor(ledgerPath)).then(() => true, () => false), false);
}

// --- --apply records not_applicable and touches nothing else ----------------

{
  await reset();
  const before = await readLedger(ledgerPath);
  assert.equal(await cmdTriage({ ledger: ledgerPath, ...paths, apply: "true" }), 0);
  const report = lastJson();
  assert.equal(report.dry_run, false);
  assert.equal(report.applied.recorded.length, Object.keys(EXPECTED_REJECTS).length);
  assert.deepEqual(report.applied.unmatched, []);

  const after = await readLedger(ledgerPath);
  assert.equal(after.length, before.length, "no row is added or removed");
  for (const row of after) {
    const term = row.term ?? row.signal;
    const was = before.find((r) => (r.term ?? r.signal) === term && r.kind === row.kind)!;
    if (term in EXPECTED_REJECTS) {
      assert.equal(row.status, "not_applicable", `${term} is recorded not_applicable`);
      assert.equal(row.origin, "triage");
      assert.equal(row.notes, `triage: ${EXPECTED_REJECTS[term as keyof typeof EXPECTED_REJECTS]}`);
      continue;
    }
    assert.equal(row.status, was.status, `${term} is untouched`);
    assert.equal(row.notes, was.notes, `${term} keeps its notes`);
    assert.equal(row.origin, was.origin, `${term} keeps its origin`);
  }
  // the already-answered rows are exactly as they were
  const kubernetes = after.find((r) => r.term === "Kubernetes")!;
  assert.equal(kubernetes.status, "confirmed");
  assert.equal(kubernetes.source_update_required, true);

  // and a second pass has nothing left to do
  assert.equal(await cmdTriage({ ledger: ledgerPath, ...paths, apply: "true" }), 0);
  assert.equal(lastJson().pending, EXPECTED_KEEPS.length, "the rejects are gone from pending");
}

// --- answers are the four fixed ones ----------------------------------------

{
  const report = buildReport(triageRows(rows, ctx), { ledger: ledgerPath, dryRun: true });
  const answers = rejectAnswers(report);
  assert.equal(answers.length, Object.keys(EXPECTED_REJECTS).length);
  assert.ok(answers.every((a) => a.status === "not_applicable" && a.answer === "na"));
  assert.ok(answers.every((a) => a.note!.startsWith("triage: ")), "every reject carries the rule that refused it");
}

// --- queue refuses junk before it ever reaches the ledger -------------------

function term(overrides: Partial<KeywordTerm> & { term: string }): KeywordTerm {
  return {
    jd_form: overrides.term, corpus_form: null, aliases: [], alias_group: null, category: "concept", must_have: true,
    status: "needs_confirmation", render_as: null, render_both_forms: false, corpus_lines: [], source_update_required: false,
    jd_context: null, evidence_hint: null, why: null,
    question: `${overrides.term}: did you use or deliver ${overrides.term} in any role?`,
    proposed_phrasing: null, surfaced_in: [],
    cloud_id: null, cloud_kind: null,
    ...overrides,
  };
}

{
  await reset();
  await fs.writeFile(ledgerPath, YAML.stringify({ confirmations: [] as MarketConfirmation[] }));
  const terms = [
    term({ term: "Azure Functions" }),
    term({ term: "XSLT", category: "tool" }),
    term({ term: "Apply Now" }),
    term({ term: "Marlow Fentiman" }),
    term({ term: "WFH" }),
    term({ term: "Key Skills" }),
  ];
  const plan: KeywordPlan = {
    version: 1, resume_id: "platform-architect", profile_id: null, opportunity_id: "opp-77", mode: "jd",
    jd_hash: "hash", cv_source_hash: "hash", generated_at: "2026-09-18",
    title: { jd_title: null, title_family: null, alignment: "unknown", reason: "test" },
    terms, clouds: [], signals: [],
    coverage: { must_have_total: terms.length, must_have_renderable: 0, must_have_surfaced: 0, must_have_familiarity: 0, renderable_pct: 0, surfaced_pct: 0, renderable_total: 0, surfaced_total: 0, familiarity_total: 0 },
    questions: terms.map((t) => ({
      term: t.term, category: t.category, question: t.question!, options: [],
      evidence_hint: null, proposed_phrasing: null, why: null,
      aliases: [], alias_group: null, cloud_id: null, cloud_kind: null, cloud_weight: 0,
    })),
    gaps: [], screener_surface: { headline_aligned: null, screener_block_present: null },
    warnings: [], verdict: "warn",
  };
  await fs.writeFile(planPath, JSON.stringify(plan));

  assert.equal(await cmdQueue({ ledger: ledgerPath, plan: planPath, origin: "daily", ...paths }), 0);
  const out = lastJson();
  assert.deepEqual(out.queued.sort(), ["Azure Functions", "XSLT"], "only the real skills enter the ledger");
  assert.equal(out.rejected_by_triage, 4);
  assert.deepEqual(
    out.rejected.map((r: { term: string; rule: string }) => [r.term, r.rule]).sort(),
    [["Apply Now", "jd_boilerplate"], ["Key Skills", "jd_boilerplate"], ["Marlow Fentiman", "person_name"], ["WFH", "clearance_or_logistics"]],
  );

  const ledger = await readLedger(ledgerPath);
  assert.equal(ledger.length, 2, "the ledger carries two rows, not six");
  assert.ok(ledger.every((r) => r.status === "pending" && r.origin === "daily"));

  const rejectLines = (await fs.readFile(rejectsPathFor(ledgerPath), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rejectLines.length, 4);
  assert.deepEqual(new Set(rejectLines.map((r) => r.rule)), new Set(["jd_boilerplate", "person_name", "clearance_or_logistics"]));
  for (const line of rejectLines) {
    assert.equal(line.opportunity_id, "opp-77");
    assert.equal(line.resume_id, "platform-architect");
    assert.match(line.at, /^\d{4}-\d{2}-\d{2}T/);
  }

  // re-queueing the same plan is a no-op on both files
  const ledgerBefore = await fs.readFile(ledgerPath, "utf8");
  assert.equal(await cmdQueue({ ledger: ledgerPath, plan: planPath, origin: "daily", ...paths }), 0);
  assert.equal(lastJson().queued_count, 0, "the two queued terms are already pending");
  assert.equal(await fs.readFile(ledgerPath, "utf8"), ledgerBefore);

  // a dry run queues nothing and logs nothing
  await fs.rm(rejectsPathFor(ledgerPath), { force: true });
  await fs.writeFile(ledgerPath, YAML.stringify({ confirmations: [] as MarketConfirmation[] }));
  const empty = await fs.readFile(ledgerPath, "utf8");
  assert.equal(await cmdQueue({ ledger: ledgerPath, plan: planPath, origin: "daily", "dry-run": "true", ...paths }), 0);
  assert.equal(lastJson().rejected_by_triage, 4);
  assert.equal(await fs.readFile(ledgerPath, "utf8"), empty, "a dry run writes no ledger row");
  assert.equal(await fs.access(rejectsPathFor(ledgerPath)).then(() => true, () => false), false, "a dry run writes no reject log");
}

console.log = realLog;
await fs.rm(tmp, { recursive: true, force: true });
console.log("keyword-triage.test.ts: all assertions passed");
