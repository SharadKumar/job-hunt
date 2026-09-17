#!/usr/bin/env tsx
/**
 * keyword-confirm.test.ts — ledger writer + cv-source patcher.
 *
 * Everything runs against a temp copy of a synthetic ledger / cv-source; the
 * real `state/profile/` files are never opened.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  readLedger, writeLedger, findRow, upsertKeywordRow, groupPending, insertBullet, PatchRefusal,
  rowFromPlanTerm, findPlanTerm, cmdRecord, cmdQueue, cmdPending, cmdApplyPatch,
} from "../tools/resume/keyword-confirm.ts";
import type { KeywordPlan, KeywordTerm } from "../tools/resume/keyword-lexicon.ts";
import type { MarketConfirmation } from "../tools/resume/market-lens-audit.ts";

// --- fixtures ---------------------------------------------------------------

const CV_SOURCE = `# Test Candidate

## Professional Experience

### 2022-10 – 2025-09 — Delivery Manager, Department of Education
*NSW*

Led an enterprise service management programme.

- Delivered the customer-facing services gateway stream.
- Decommissioned the legacy ticketing platform.

### 2021-08 – 2022-04 — Enterprise Architect, Revenue NSW
*Sydney*

Owned the applications architecture practice.

- Chaired the architecture review board.

### 2019-01 – 2020-01 — Architect, No Bullets Co
*Sydney*

A role with prose only and no bullet list.

### 2018-01 – 2019-01 — Principal Consultant, Sub Block Co
*Remote*

One continuous engagement spanning framework work and a client engagement.

- Advised the client executive on platform strategy.
- Built the delivery harness.

**Open framework (non-commercial)**

- Designed the multi-agent orchestration.

**Client engagement (finance)**

Within the same engagement, worked as a forward-deployed engineer.

**Governance sub-section**

- Stood up the model-output review gate.

## Skills

### Technology and Design

- Enterprise integration patterns across API and event platforms.

### Leadership and Management

- Coaching delivery leads.
`;

function term(overrides: Partial<KeywordTerm> & { term: string }): KeywordTerm {
  return {
    jd_form: overrides.term, corpus_form: null, aliases: [], alias_group: null, category: "platform", must_have: true,
    status: "needs_confirmation", render_as: null, render_both_forms: false, corpus_lines: [], source_update_required: false,
    jd_context: null, evidence_hint: "cv-source.md:12 (Delivery Manager, Department of Education)",
    why: "Named in most ESM adverts.", question: `${overrides.term}: did you work with this at the Department of Education?`,
    proposed_phrasing: `Configured ${overrides.term} for the services gateway stream.`, surfaced_in: [],
    cloud_id: null, cloud_kind: null,
    ...overrides,
  };
}

function plan(overrides: Partial<KeywordPlan> = {}): KeywordPlan {
  const terms = overrides.terms ?? [term({ term: "IntegrationHub" }), term({ term: "CMDB" })];
  return {
    version: 1, resume_id: "servicenow-architect", profile_id: null, opportunity_id: "opp-123", mode: "jd",
    jd_hash: "abc", cv_source_hash: "def", generated_at: "2026-09-10",
    title: { jd_title: null, title_family: null, alignment: "unknown", reason: "test" },
    terms,
    clouds: [],
    signals: [],
    coverage: { must_have_total: 2, must_have_renderable: 0, must_have_surfaced: 0, must_have_familiarity: 0, renderable_pct: 0, surfaced_pct: 0, renderable_total: 0, surfaced_total: 0, familiarity_total: 0 },
    questions: terms.filter((t) => t.status === "needs_confirmation" && t.question).map((t) => ({
      term: t.term, category: t.category, question: t.question!, options: ["Confirm and update source", "Not applicable", "Unsure / keep pending"],
      evidence_hint: t.evidence_hint, proposed_phrasing: t.proposed_phrasing, why: t.why,
      aliases: t.aliases, alias_group: t.alias_group, cloud_id: null, cloud_kind: null, cloud_weight: 0,
    })),
    gaps: [],
    screener_surface: { headline_aligned: null, screener_block_present: null },
    warnings: [], verdict: "warn",
    ...overrides,
  };
}

// --- harness ----------------------------------------------------------------

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-confirm-"));
const ledgerPath = path.join(tmp, "market-confirmations.yaml");
const cvPath = path.join(tmp, "cv-source.md");
const planPath = path.join(tmp, "keyword-plan.json");

async function reset(rows: MarketConfirmation[] = []): Promise<void> {
  await writeLedger(ledgerPath, rows);
  await fs.writeFile(cvPath, CV_SOURCE);
  await fs.writeFile(planPath, JSON.stringify(plan(), null, 2));
}

const base = { ledger: ledgerPath, "cv-source": cvPath, plan: planPath };
const logs: string[] = [];
const realLog = console.log;
console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
function lastJson(): any {
  const line = [...logs].reverse().find((l) => l.trim().startsWith("{"));
  return JSON.parse(line!.slice(line!.indexOf("{")));
}

// --- pure helpers -----------------------------------------------------------

{
  const p = plan();
  assert.equal(findPlanTerm(p, "integrationhub")?.term, "IntegrationHub");
  assert.equal(findPlanTerm(p, "nope"), null);
  const row = rowFromPlanTerm(p, findPlanTerm(p, "CMDB")!, { status: "confirmed", opportunityId: "opp-9" });
  assert.equal(row.kind, "keyword");
  assert.equal(row.signal, "CMDB");
  assert.equal(row.opportunity_id, "opp-9");
  assert.equal(row.category, "platform");
  assert.equal(row.proposed_phrasing, "Configured CMDB for the services gateway stream.");
  assert.equal(row.source_update_required, true, "confirmed alone never authorises rendering");
}

{
  // Upsert is keyed by resume_id + signal, across kinds, so an existing
  // market_signal answer is never shadowed by a duplicate keyword row.
  const rows: MarketConfirmation[] = [{ resume_id: "r1", signal: "Now Assist", status: "not_applicable", updated_at: "2026-06-08" }];
  const first = upsertKeywordRow(rows, { resume_id: "r1", signal: "now assist", status: "declined", kind: "keyword" });
  assert.equal(first.created, false);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].status, "declined");
  assert.equal(first.rows[0].kind, "keyword");
  // Keyword rows are person-scoped: a second positioning reuses the one row
  // rather than opening a duplicate question about the same fact.
  const second = upsertKeywordRow(first.rows, { resume_id: "r2", signal: "Now Assist", status: "pending", kind: "keyword" });
  assert.equal(second.created, false, "a different resume reuses the person-scoped row");
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].resume_id, "r2", "resume_id records the asking positioning");
  assert.ok(second.rows[0].asked_at, "asked_at survives the update");
  const fresh = upsertKeywordRow([], { resume_id: "r1", signal: "Virtual Agent", status: "pending", kind: "keyword" });
  assert.ok(fresh.rows[0].asked_at, "asked_at stamped on creation");
}

{
  const groups = groupPending([
    { resume_id: "r1", kind: "keyword", signal: "CMDB", term: "CMDB", status: "pending", opportunity_id: "o1", question: "q1" },
    { resume_id: "r1", kind: "keyword", signal: "CMDB", term: "CMDB", status: "pending", opportunity_id: "o2" },
    { resume_id: "r1", kind: "keyword", signal: "SPM", term: "SPM", status: "pending" },
    { resume_id: "r1", kind: "keyword", signal: "HRSD", status: "confirmed" },
    { resume_id: "r1", signal: "security architecture", status: "pending" },
  ]);
  assert.deepEqual(groups.map((g) => g.term), ["CMDB", "SPM"], "keyword pending only, grouped by term, busiest first");
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].opportunities, ["o1", "o2"]);
  assert.equal(groups[0].question, "q1");
  // A market_signal row stays positioning-scoped, so it never leaks into another
  // resume's pending list.
  assert.equal(groupPending([{ resume_id: "r2", signal: "security architecture", status: "pending" }], "r1").length, 0);
  // A keyword row does cross: the question is open for the person, and `queue`
  // under r1 will refuse to re-ask it, so it must show up here too.
  const crossed = groupPending([
    { resume_id: "r2", kind: "keyword", signal: "CMDB", term: "CMDB", status: "pending" },
    { resume_id: "r1", kind: "keyword", signal: "CMDB", term: "CMDB", status: "pending" },
  ], "r1");
  assert.equal(crossed.length, 1, "one outstanding question, not one per resume");
  assert.deepEqual(crossed[0].resumes, ["r2", "r1"]);
}

// --- insertBullet -----------------------------------------------------------

{
  const out = insertBullet(CV_SOURCE, { bullet: "Modelled the CMDB for 350+ services.", roleHeading: "Delivery Manager, Department of Education" });
  const lines = out.text.split("\n");
  assert.equal(lines[out.line - 1], "- Modelled the CMDB for 350+ services.");
  assert.equal(lines[out.line - 2], "- Decommissioned the legacy ticketing platform.", "lands after the last bullet of that role");
  assert.equal(lines[out.line], "", "the following blank line survives");
  assert.ok(out.heading.includes("Delivery Manager"));
  assert.ok(out.diff.startsWith("--- a/"), "prints a unified diff");
  assert.ok(out.diff.includes("+- Modelled the CMDB for 350+ services."));
  assert.equal(out.text.split("\n").length, CV_SOURCE.split("\n").length + 1, "exactly one line added");
}

{
  const out = insertBullet(CV_SOURCE, { bullet: "Ran the ADR practice.", roleHeading: "No Bullets Co" });
  const lines = out.text.split("\n");
  assert.equal(lines[out.line - 1], "- Ran the ADR practice.");
  assert.equal(lines[out.line - 2], "A role with prose only and no bullet list.", "appends to the end of a bullet-less block");
}

{
  const out = insertBullet(CV_SOURCE, { bullet: "ServiceNow CMDB and IntegrationHub.", skills: true, roleHeading: "Technology and Design" });
  const lines = out.text.split("\n");
  assert.equal(lines[out.line - 2], "- Enterprise integration patterns across API and event platforms.");
  assert.ok(!out.text.includes("Leadership and Management\n\n- ServiceNow"), "does not leak into the other skills block");
}

{
  // A role block with bold sub-blocks: the default target is the role's OWN
  // bullet list, not the end of the block (which is a client sub-section).
  const out = insertBullet(CV_SOURCE, { bullet: "Ran the pre-sales agent harness.", roleHeading: "Sub Block Co" });
  const lines = out.text.split("\n");
  assert.equal(lines[out.line - 1], "- Ran the pre-sales agent harness.");
  assert.equal(lines[out.line - 2], "- Built the delivery harness.", "lands after the role's last top-level bullet");
  const firstSub = lines.findIndex((l) => l === "**Open framework (non-commercial)**");
  assert.ok(out.line - 1 < firstSub, "never lands inside a bold sub-block by default");
}

{
  const out = insertBullet(CV_SOURCE, {
    bullet: "Implemented cross-model review.", roleHeading: "Sub Block Co", subHeading: "Open framework",
  });
  const lines = out.text.split("\n");
  assert.equal(lines[out.line - 1], "- Implemented cross-model review.");
  assert.equal(lines[out.line - 2], "- Designed the multi-agent orchestration.", "appends to the end of the named sub-block");
  assert.equal(lines[out.line], "", "the following blank line survives");
  assert.ok(out.line < lines.findIndex((l) => l === "**Client engagement (finance)**"), "stays inside its own sub-block");
}

{
  // A sub-block whose prose carries no bullets still gets one appended inside it.
  const out = insertBullet(CV_SOURCE, {
    bullet: "Reported to the client COO.", roleHeading: "Sub Block Co", subHeading: "Client engagement",
  });
  const lines = out.text.split("\n");
  assert.equal(lines[out.line - 2], "Within the same engagement, worked as a forward-deployed engineer.");
  assert.ok(out.line < lines.findIndex((l) => l === "**Governance sub-section**"));
}

assert.throws(
  () => insertBullet(CV_SOURCE, { bullet: "New fact.", roleHeading: "Sub Block Co", subHeading: "Nonexistent sub-block" }),
  PatchRefusal, "refuses an unknown sub-heading rather than guessing a block",
);
assert.throws(
  () => insertBullet(CV_SOURCE, { bullet: "New fact.", roleHeading: "Revenue NSW", subHeading: "Anything" }),
  PatchRefusal, "refuses --sub-heading against a block with no sub-headings",
);
assert.throws(
  () => insertBullet(CV_SOURCE, { bullet: "New fact.", roleHeading: "Sub Block Co", subHeading: "e" }),
  PatchRefusal, "refuses an ambiguous sub-heading substring",
);

assert.throws(() => insertBullet(CV_SOURCE, { bullet: "Chaired the architecture review board.", roleHeading: "Revenue NSW" }), PatchRefusal, "refuses a bullet already in the source");
assert.throws(() => insertBullet(CV_SOURCE, { bullet: "New thing.", roleHeading: "Nonexistent Client" }), PatchRefusal, "refuses an unknown heading");
assert.throws(() => insertBullet(CV_SOURCE, { bullet: "New thing.", roleHeading: "Sydney" }), PatchRefusal, "refuses an ambiguous heading substring");

// --- subcommands ------------------------------------------------------------

await reset();
assert.equal(await cmdRecord({ ...base, term: "CMDB", status: "confirmed", opportunity: "opp-123" }), 0);
{
  const rows = await readLedger(ledgerPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "keyword");
  assert.equal(rows[0].status, "confirmed");
  assert.equal(rows[0].source_update_required, true);
  assert.equal(rows[0].origin, "attended");
  assert.ok(lastJson().next_step.includes("apply-patch"));
}

assert.equal(await cmdRecord({ ...base, term: "CMDB", status: "not_applicable" }), 0, "re-answering updates in place");
{
  const rows = await readLedger(ledgerPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "not_applicable");
  assert.equal(rows[0].source_update_required, undefined, "the stale confirmed flag is cleared");
}
// "Bring in as familiarity": answered, never a source patch, never re-asked
assert.equal(await cmdRecord({ ...base, term: "CMDB", status: "familiarity", origin: "attended" }), 0);
{
  const rows = await readLedger(ledgerPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "familiarity");
  assert.equal(rows[0].source_update_required, undefined, "familiarity authorises framing, not a source claim");
  const out = lastJson();
  assert.equal(out.source_update_required, false);
  assert.match(out.next_step, /render_as/, "the caller is told this renders as familiarity only");
}

assert.equal(await cmdRecord({ ...base, term: "not-in-plan", status: "pending" }), 1, "an unknown term is refused, not invented");
assert.equal(await cmdRecord({ ...base, term: "CMDB", status: "maybe" }), 2, "bad status is a usage error");

// queue: never reopens an answered row, never contacts the user
assert.equal(await cmdRecord({ ...base, term: "CMDB", status: "not_applicable" }), 0);
assert.equal(await cmdQueue({ ...base, origin: "daily" }), 0);
{
  const rows = await readLedger(ledgerPath);
  assert.equal(rows.length, 2);
  const queued = rows.find((r) => r.signal === "IntegrationHub")!;
  assert.equal(queued.status, "pending");
  assert.equal(queued.origin, "daily");
  assert.ok(queued.question);
  assert.equal(rows.find((r) => r.signal === "CMDB")!.status, "not_applicable", "answered rows are left alone");
  assert.deepEqual(lastJson().queued, ["IntegrationHub"]);
  assert.deepEqual(lastJson().already_recorded, ["CMDB"]);
}
await cmdQueue({ ...base, origin: "daily" });
assert.equal((await readLedger(ledgerPath)).length, 2, "queue is idempotent");

{
  // a familiarity answer is terminal for the unattended queue, exactly like declined
  await reset([{ resume_id: "servicenow-architect", kind: "keyword", signal: "IntegrationHub", term: "IntegrationHub", status: "familiarity" }]);
  assert.equal(await cmdQueue({ ...base, origin: "daily" }), 0);
  assert.deepEqual(lastJson().queued, ["CMDB"], "familiarity rows are never reopened as pending");
  assert.deepEqual(lastJson().already_recorded, ["IntegrationHub"]);
  assert.equal((await readLedger(ledgerPath)).find((r) => r.signal === "IntegrationHub")!.status, "familiarity");
}

{
  // Person-scope: an answer recorded under one positioning closes the question
  // under every other positioning — the ledger holds one row per term, not one
  // per resume. A `market_signal` row is positioning-scoped and does not cross.
  await reset([
    { resume_id: "applied-ai", kind: "keyword", scope: "person", signal: "IntegrationHub", term: "IntegrationHub", status: "not_applicable" },
    { resume_id: "applied-ai", signal: "CMDB", status: "not_applicable" },
  ]);
  assert.equal(await cmdQueue({ ...base, origin: "daily" }), 0);
  assert.deepEqual(lastJson().already_recorded, ["IntegrationHub"], "an answer under another resume is never re-asked");
  assert.deepEqual(lastJson().queued, ["CMDB"], "a market_signal answer under another resume does not cross");
  const rows = await readLedger(ledgerPath);
  assert.equal(rows.length, 3, "the queued CMDB row is new; the answered keyword row is untouched");
  assert.equal(rows.find((r) => r.kind === "keyword" && r.signal === "IntegrationHub")!.resume_id, "applied-ai");

  // Re-answering under the asking positioning updates that one row in place.
  assert.equal(await cmdRecord({ ...base, term: "IntegrationHub", status: "familiarity" }), 0);
  const after = await readLedger(ledgerPath);
  assert.equal(after.filter((r) => (r.signal ?? "").toLowerCase() === "integrationhub").length, 1, "no duplicate row per resume");
  const row = after.find((r) => r.signal === "IntegrationHub")!;
  assert.equal(row.status, "familiarity");
  assert.equal(row.scope, "person", "keyword answers are recorded as facts about the person");
  assert.equal(row.resume_id, "servicenow-architect", "resume_id records who asked last");

  // The outstanding-question list is deduped by term across resumes.
  assert.equal(await cmdPending({ ...base, "group-by": "term" }), 0);
  assert.deepEqual(lastJson().groups.map((g: { term: string }) => g.term), ["CMDB"]);
}

// restore the state the apply-patch assertions below expect
await reset();
assert.equal(await cmdRecord({ ...base, term: "CMDB", status: "not_applicable" }), 0);
assert.equal(await cmdQueue({ ...base, origin: "daily" }), 0);

assert.equal(await cmdPending({ ...base, "group-by": "term" }), 0);
{
  const out = lastJson();
  assert.equal(out.pending_total, 1);
  assert.equal(out.groups[0].term, "IntegrationHub");
  assert.equal(out.groups[0].proposed_phrasing, "Configured IntegrationHub for the services gateway stream.");
}

// apply-patch: the only path that makes a confirmed term renderable
assert.equal(await cmdApplyPatch({
  ...base, term: "IntegrationHub", resume: "servicenow-architect",
  "role-heading": "Delivery Manager, Department of Education",
  bullet: "Built IntegrationHub spokes for the services gateway stream.",
}), 0);
{
  const source = await fs.readFile(cvPath, "utf8");
  assert.ok(source.includes("- Built IntegrationHub spokes for the services gateway stream.\n"));
  const rows = await readLedger(ledgerPath);
  const row = rows.find((r) => r.signal === "IntegrationHub")!;
  assert.equal(row.status, "confirmed");
  assert.equal(row.source_update_required, false, "the source now carries the fact");
  assert.equal(row.source_patch, "- Built IntegrationHub spokes for the services gateway stream.");
  assert.ok(row.source_ref!.includes("Delivery Manager"));
  assert.equal(row.question, plan().questions[0].question, "question/evidence context is preserved across the patch");
  assert.ok(logs.some((l) => l.includes("+- Built IntegrationHub spokes")), "the applied diff is printed");
  assert.ok(lastJson().reminder.includes(".docx"));
}

assert.equal(await cmdApplyPatch({
  ...base, term: "IntegrationHub", resume: "servicenow-architect",
  "role-heading": "Delivery Manager, Department of Education",
  bullet: "Built IntegrationHub spokes for the services gateway stream.",
}), 1, "re-applying the same bullet is refused");
assert.equal(await cmdApplyPatch({
  ...base, term: "CMDB", resume: "servicenow-architect",
  "role-heading": "Sub Block Co", "sub-heading": "Governance sub-section",
  bullet: "Tracked CMDB change sign-offs.",
}), 0, "--sub-heading targets a bold sub-block");
{
  const lines = (await fs.readFile(cvPath, "utf8")).split("\n");
  const at = lines.indexOf("- Tracked CMDB change sign-offs.");
  assert.ok(at > lines.indexOf("**Governance sub-section**"), "landed in the named sub-block");
  assert.equal(lines[at - 1], "- Stood up the model-output review gate.");
}
assert.equal(await cmdApplyPatch({
  ...base, term: "CMDB", resume: "servicenow-architect",
  "role-heading": "Sub Block Co", "sub-heading": "No Such Block", bullet: "Another CMDB fact.",
}), 1, "an unknown sub-heading is refused at the CLI boundary");

assert.equal(await cmdApplyPatch({ ...base, term: "CMDB", resume: "r", bullet: "x" }), 2, "no target heading is a usage error");

// dry-run touches nothing
{
  const before = await fs.readFile(cvPath, "utf8");
  const ledgerBefore = await fs.readFile(ledgerPath, "utf8");
  assert.equal(await cmdApplyPatch({
    ...base, term: "CMDB", resume: "servicenow-architect", "role-heading": "Revenue NSW",
    bullet: "Owned the CMDB data model.", "dry-run": "true",
  }), 0);
  assert.equal(await fs.readFile(cvPath, "utf8"), before);
  assert.equal(await fs.readFile(ledgerPath, "utf8"), ledgerBefore);
}

// the ledger stays a plain `confirmations:` list that market-lens-audit can read
{
  const parsed = YAML.parse(await fs.readFile(ledgerPath, "utf8"));
  assert.ok(Array.isArray(parsed.confirmations));
  assert.deepEqual(Object.keys(parsed), ["confirmations"]);
  assert.equal(findRow(parsed.confirmations, "servicenow-architect", "integrationhub")!.term, "IntegrationHub");
}

console.log = realLog;
await fs.rm(tmp, { recursive: true, force: true });
console.log("keyword-confirm.test.ts: all assertions passed");
