#!/usr/bin/env tsx
/**
 * screening-derive.test.ts: unknown screening questions answered from the CV
 * source and the profile's fixed framing before they escalate.
 *
 * Synthetic data only. Jev is replaced by an injected evaluator, so nothing
 * leaves the process; a fixture repo root keeps the profile files throwaway.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "screening-derive-"));
process.env.HARNESS_REPO_ROOT = root;
process.env.AUDIT_DIR = path.join(root, "audit");
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
delete process.env.HARNESS_PROFILE;
delete process.env.HARNESS_STORE;
// Never spawn a real model from a test; the model path is tested with a fake below.
process.env.SCREENING_ANSWER_CLI = "off";
const profileDir = path.join(root, "state", "profile");
fs.mkdirSync(profileDir, { recursive: true });

const derive = await import("../tools/screening-derive.ts");
const seek = await import("../tools/channels/seek-submit.ts");
const health = await import("../tools/ui/health-api.ts");
type PageQuestion = import("../tools/channels/seek-submit.ts").PageQuestion;

// cv-source.md headings use an en dash in the range and an em dash before the role.
const EN = "\u2013";
const EM = "\u2014";
const CV = `# Jane Citizen

## Professional Summary

Synthetic profile for tests.

## Professional Experience

### 2024-01 ${EN} present ${EM} Principal Architect, Example Consulting (Remote)
Leads solution architecture for client platforms.

### 2020-01 ${EN} 2023-12 ${EM} Solution Architect, Sample Bank
Designed integration and platform architecture.

### 2016-01 ${EN} 2019-12 ${EM} Delivery Manager, Placeholder Agency
Ran delivery for digital programmes.

### 2018-06 ${EN} 2019-06 ${EM} Advisory Board Member, Hidden Partner Pty
Quarterly advisory role, overlapping the delivery role.

### 2012-01 ${EN} 2015-12 ${EM} Software Engineer, Demo Software
Built web applications.

#### Founder administration (not for CVs)

### 2010-01 ${EN} 2011-12 ${EM} Private Venture, Not For CV
Should never be counted.

## Applied Practice (non-employment)

### 2008-01 ${EN} 2009-12 ${EM} Builder, Weekend Project
Side project, not employment.

## Skills

### Technology
- Architecture
`;

const NOW = new Date("2026-06-15T00:00:00Z");
const opt = (...labels: string[]) => labels.map((label, i) => ({ label, id: `o${i}` }));
const q = (label: string, kind: PageQuestion["kind"], options: { label: string; id: string }[] = [], numeric = false): PageQuestion =>
  ({ label, kind, options, id: "", name: "", required: true, numeric });
const YEAR_OPTIONS = opt("Select", "No experience", "Less than 1 year", "1 to 2 years", "3 to 5 years", "6 to 10 years", "More than 10 years");

/** A Jev stand-in: role probabilities keyed by a heading fragment, or a fixed choice. */
function fakeJev(opts: { roles?: Record<string, number>; choice?: string; probabilities?: Record<string, number>; degraded?: boolean }) {
  const calls: any[] = [];
  const evaluate = async (args: any): Promise<any> => {
    calls.push(args);
    if (opts.degraded) return { status: "degraded", reason: "no credential", mode: "live", question_set_hash: "h", question_ids: [], fixture_key: "k" };
    const answers: Record<string, any> = {};
    for (const key of Object.keys(args.questions)) {
      if (key === "employment_answer") {
        answers[key] = { type: "choice", choice: opts.choice, probabilities: opts.probabilities };
        continue;
      }
      const heading = String(args.state.roles[key].heading);
      const hit = Object.entries(opts.roles ?? {}).find(([frag]) => heading.includes(frag));
      answers[key] = { type: "boolean", probability: hit ? hit[1] : 0.02 };
    }
    return {
      status: "ok", mode: "live", question_set_hash: "qs-hash", question_ids: Object.keys(args.questions),
      gateway_route_fingerprint: "fp", route_fingerprint_matches: true, resolved_model_version: "jev-1.0", model_version_observable: true,
      latency_ms: 1, estimated_cost_usd: 0, response_cost_usd: 0, fixture_key: "k",
      result: { answers, usage: {}, response: { modelId: "jev-1.0" } },
    };
  };
  return { evaluate: evaluate as any, calls };
}

const baseCtx = { cvSource: CV, standingRules: [] as string[], neverNamed: [/\bHidden Partner\b/i], profileMd: "---\nname: Jane\n---\n\n# Profile\n", now: NOW };

// --- question shapes ---------------------------------------------------------
assert.equal(derive.questionShape("How many years' experience do you have as an Artificial Intelligence Architect?"), "years_discipline");
assert.equal(derive.questionShape("How many years' experience do you have in Solution Architecture, Software Architecture, Platform Engineering or a similar role?"), "years_discipline");
assert.equal(derive.questionShape("Are you currently employed?"), "employment_status");
assert.equal(derive.questionShape("How many years of work experience do you have?"), "years_overall");
assert.equal(derive.questionShape("How many years' experience do you have?"), "years_overall");
assert.equal(derive.questionShape("Are you currently employed by Example Ltd?"), null, "the integrity question is not an employment-status question");
assert.equal(derive.questionShape("Why do you want this role?"), null);

// --- CV roles and month arithmetic ------------------------------------------
const roles = derive.parseCvRoles(CV);
assert.ok(!roles.some((r) => /Not For CV/.test(r.heading)), "a not-for-CVs subtree is excluded");
const weekend = roles.find((r) => /Weekend Project/.test(r.heading));
assert.equal(weekend?.employment, false, "a non-employment section is marked as such");
assert.ok(!roles.some((r) => r.section === "Skills"), "skill groups are not roles");
// 2012-01..2026-06 minus the gap? None: 2012-2015, 2016-2019, 2020-2023, 2024-now are contiguous.
const employment = roles.filter((r) => r.employment);
assert.equal(derive.unionMonths(employment, NOW), (2026 - 2012) * 12 + 6, "overlapping roles count once");
assert.equal(derive.unionMonths([{ start: "2020-01", end: "2020-12" }, { start: "2020-06", end: "2021-01" }], NOW), 13);

// --- overall years: deterministic ------------------------------------------
{
  const out = await derive.deriveScreeningAnswer(q("How many years of work experience do you have?", "select", YEAR_OPTIONS), baseCtx);
  assert.ok("derived" in out, JSON.stringify(out));
  assert.equal(out.derived.decision.kind === "option" && out.derived.decision.option.label, "More than 10 years");
  assert.match(out.derived.evidence.computation, /174 months .* = 14 completed years as of 2026-06/);
  assert.ok(out.derived.evidence.sources.some((s) => /cv-source\.md line \d+: 2020-01 . 2023-12 . Solution Architect/.test(s)));
  assert.ok(out.derived.evidence.sources.some((s) => /heading withheld: never named/.test(s)), "a never-named heading is withheld from the evidence");
  assert.ok(!out.derived.evidence.sources.some((s) => /Hidden Partner/.test(s)));
  const numeric = await derive.deriveScreeningAnswer(q("How many years of work experience do you have?", "text", [], true), baseCtx);
  assert.ok("derived" in numeric && numeric.derived.answer === 14);
}

// --- discipline years: Jev decides which roles count ------------------------
{
  const label = "How many years' experience do you have in Solution Architecture, Software Architecture, Platform Engineering or a similar role?";
  const jev = fakeJev({ roles: { "Principal Architect": 0.95, "Solution Architect": 0.93 } });
  const out = await derive.deriveScreeningAnswer(q(label, "select", YEAR_OPTIONS), { ...baseCtx, evaluate: jev.evaluate });
  assert.ok("derived" in out, JSON.stringify(out));
  // 2020-01..2026-06 = 78 months = 6 completed years.
  assert.equal(out.derived.decision.kind === "option" && out.derived.decision.option.label, "6 to 10 years");
  assert.equal(out.derived.evidence.sources.length, 2);
  assert.equal(jev.calls[0].callSite, "screening-derive-years");
  assert.ok(!JSON.stringify(jev.calls[0].state).includes("Weekend Project"), "non-employment roles are never offered as evidence");
  assert.ok(!JSON.stringify(jev.calls[0].state).includes("Hidden Partner"), "never-named text is withheld from Jev");
  assert.ok(JSON.stringify(jev.calls[0].state).includes("[withheld]"));

  // An uncertain role that cannot move the band still allows the answer.
  const steady = await derive.deriveScreeningAnswer(q(label, "select", YEAR_OPTIONS),
    { ...baseCtx, evaluate: fakeJev({ roles: { "Principal Architect": 0.95, "Solution Architect": 0.93, "Advisory Board": 0.5 } }).evaluate });
  assert.ok("derived" in steady && /uncertain roles it would be 7, the same answer/.test(steady.derived.evidence.computation));

  // An uncertain role that moves the band: answer with the conservative figure, record both bounds.
  const moved = await derive.deriveScreeningAnswer(q(label, "select", YEAR_OPTIONS),
    { ...baseCtx, evaluate: fakeJev({ roles: { "Principal Architect": 0.95, "Solution Architect": 0.93, "Delivery Manager": 0.5, "Software Engineer": 0.5 } }).evaluate });
  assert.ok("derived" in moved, JSON.stringify(moved));
  assert.equal(moved.derived.answer, "6 to 10 years", "the low bound from the roles Jev is sure about");
  assert.match(moved.derived.evidence.computation, /conservative 6 \(range 6 to 14\)/);
  assert.equal(moved.derived.evidence.uncertain?.length, 2);

  // Numeric field: exact years only when the bounds agree.
  const num = await derive.deriveScreeningAnswer(q(label, "text", [], true), { ...baseCtx, evaluate: jev.evaluate });
  assert.ok("derived" in num && num.derived.answer === 6);

  // No role counts: evidence is missing, so it escalates rather than answering zero.
  const none = await derive.deriveScreeningAnswer(q("How many years' experience do you have as an Artificial Intelligence Architect?", "select", YEAR_OPTIONS),
    { ...baseCtx, evaluate: fakeJev({ roles: {} }).evaluate });
  assert.ok("escalate" in none && /no CV role confidently counts/.test(none.escalate));

  // Jev degraded: escalate.
  const degraded = await derive.deriveScreeningAnswer(q(label, "select", YEAR_OPTIONS), { ...baseCtx, evaluate: fakeJev({ degraded: true }).evaluate });
  assert.ok("escalate" in degraded && /Jev unavailable/.test(degraded.escalate));
}

// --- employment status: only the fixed framing ------------------------------
{
  const label = "Are you currently employed?";
  const yesNo = opt("Yes", "No");
  const framing = { ...baseCtx, standingRules: ["Example Consulting is the applicant's employer, March 2024 to present.", "Never name the lender client."] };
  const jev = fakeJev({ choice: "option_0", probabilities: { option_0: 0.95, option_1: 0.03, unsure: 0.02 } });
  const out = await derive.deriveScreeningAnswer(q(label, "radio", yesNo), { ...framing, evaluate: jev.evaluate });
  assert.ok("derived" in out, JSON.stringify(out));
  assert.equal(out.derived.answer, "Yes");
  assert.ok(out.derived.evidence.sources.includes("letter-critic-rules.yaml standing_rules[0]"));
  assert.ok(!out.derived.evidence.sources.includes("letter-critic-rules.yaml standing_rules[1]"), "unrelated rules are not evidence");
  assert.ok(!JSON.stringify(jev.calls[0].state.framing).includes("lender"), "only employment framing is sent");
  assert.ok(!out.derived.evidence.sources.join(" ").includes("Example Consulting is"), "evidence cites the rule, not its text");

  const unsure = await derive.deriveScreeningAnswer(q(label, "radio", yesNo),
    { ...framing, evaluate: fakeJev({ choice: "unsure", probabilities: { unsure: 0.7, option_0: 0.2, option_1: 0.1 } }).evaluate });
  assert.ok("escalate" in unsure);
  const weak = await derive.deriveScreeningAnswer(q(label, "radio", yesNo),
    { ...framing, evaluate: fakeJev({ choice: "option_0", probabilities: { option_0: 0.5, option_1: 0.4, unsure: 0.1 } }).evaluate });
  assert.ok("escalate" in weak, "a low-confidence judgement escalates");
  const approximate = await derive.deriveScreeningAnswer(q(label, "radio", yesNo),
    { ...framing, evaluate: fakeJev({ choice: "option_0", probabilities: { option_0: 0.65, option_1: 0.3, unsure: 0.05 } }).evaluate });
  assert.ok("derived" in approximate, "a moderate, clearly leading judgement stands");
  const text = await derive.deriveScreeningAnswer(q(label, "text"), { ...framing, evaluate: jev.evaluate });
  assert.ok("escalate" in text && /free-text/.test(text.escalate), "free-text employment answers are never composed");
  const silent = await derive.deriveScreeningAnswer(q(label, "radio", yesNo),
    { ...baseCtx, cvSource: `# X\n\n## Professional Experience\n\n### 2010-01 ${EN} 2012-01 ${EM} Engineer, Old Co\n`, evaluate: jev.evaluate });
  assert.ok("escalate" in silent && /no fixed current-work framing/.test(silent.escalate));
}

// --- recording: derived, visible, changeable --------------------------------
{
  const file = path.join(profileDir, "screening-answers.yaml");
  const label = "How many years' experience do you have as a Solution Architect?";
  fs.writeFileSync(file, [
    "# Person's comment survives.",
    "answers: []",
    "unknown_questions:",
    "  - opportunity_id: seek-1",
    "    company: \"Example Co\"",
    "    title: \"Architect\"",
    `    question: ${JSON.stringify(label)}`,
    "    answer: null",
    "  - opportunity_id: seek-2",
    "    question: \"Do you hold a licence?\"",
    "    answer: null",
    "  - opportunity_id: seek-3",
    "    question: \"Are you currently employed?\"",
    "    answer: \"Yes\"",
    "",
  ].join("\n"));
  const jev = fakeJev({ roles: { "Principal Architect": 0.95, "Solution Architect": 0.93 } });
  const question = q(label, "select", YEAR_OPTIONS);
  const out = await derive.deriveScreeningAnswer(question, { ...baseCtx, evaluate: jev.evaluate });
  assert.ok("derived" in out);
  assert.equal(await derive.recordDerivedAnswer({ id: "seek-1" }, question, out.derived, file, NOW), "filled");
  let text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# Person's comment survives\./);
  let parsed = (await import("yaml")).default.parse(text);
  const row = parsed.unknown_questions[0];
  assert.equal(row.answer, "6 to 10 years");
  assert.equal(row.derived, true);
  assert.equal(row.company, "Example Co");
  assert.match(row.derived_evidence.computation, /completed years/);
  assert.equal(parsed.unknown_questions[1].answer, null, "other rows are untouched");
  assert.equal(parsed.unknown_questions.length, 3);

  // The next run replays the derived answer as the exact option, not the generic default.
  const bank = await seek.loadScreeningAnswers(file);
  const replay = seek.decideQuestion(question, bank);
  assert.equal(replay.kind === "option" && replay.option.label, "6 to 10 years");

  // A person's existing answer is never overwritten.
  const emp = q("Are you currently employed?", "radio", opt("Yes", "No"));
  const fakeDerived = { decision: { kind: "option" as const, option: { label: "No", id: "o1" } }, answer: "No", evidence: { method: "m", computation: "c", sources: [] } };
  assert.equal(await derive.recordDerivedAnswer({ id: "seek-3" }, emp, fakeDerived, file, NOW), "kept_person_answer");

  // A new question is appended.
  const overall = q("How many years of work experience do you have?", "select", YEAR_OPTIONS);
  const o = await derive.deriveScreeningAnswer(overall, baseCtx);
  assert.ok("derived" in o);
  assert.equal(await derive.recordDerivedAnswer({ id: "seek-4", company: "Other Co", title: "Lead" }, overall, o.derived, file, NOW), "appended");
  parsed = (await import("yaml")).default.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.unknown_questions.length, 4);
  assert.equal(parsed.unknown_questions[3].answer, "More than 10 years");
  assert.equal(parsed.unknown_questions[3].context, YEAR_OPTIONS.slice(1).map((x) => x.label).join(" | "));

  // The harness may refresh its own derived answer (a different option list).
  const otherList = q("How many years of work experience do you have?", "select", opt("0-2 years", "3-7 years", "8+ years"));
  const o2 = await derive.deriveScreeningAnswer(otherList, baseCtx);
  assert.ok("derived" in o2);
  assert.equal(await derive.recordDerivedAnswer({ id: "seek-4" }, otherList, o2.derived, file, NOW), "filled");
  parsed = (await import("yaml")).default.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.unknown_questions.length, 4);
  assert.equal(parsed.unknown_questions[3].answer, "8+ years");
  assert.equal(parsed.unknown_questions[3].company, "Other Co", "identifying fields survive the refresh");
  assert.match(fs.readFileSync(file, "utf8"), /^# Person's comment survives\./);

  // The UI shows the derived evidence, and the person's change makes the row theirs.
  const snapshot = await health.getScreening();
  const shown = snapshot.unknown.find((u) => u.opportunity_id === "seek-1");
  assert.ok(shown?.derived && /completed years/.test(shown.derived.computation));
  assert.equal(snapshot.unknown.find((u) => u.opportunity_id === "seek-2")?.derived, undefined);
  await health.postScreeningAnswer({ question: label, answer: "3 to 5 years", kind: "option" });
  parsed = (await import("yaml")).default.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.unknown_questions[0].answer, "3 to 5 years");
  assert.equal(parsed.unknown_questions[0].derived, false, "the person's answer is no longer marked derived");
  const changed = seek.decideQuestion(question, await seek.loadScreeningAnswers(file));
  assert.equal(changed.kind === "option" && changed.option.label, "3 to 5 years", "the person's answer wins");
}

// --- adapter wiring: unmatched questions reach the resolver only with an opportunity
{
  const file = path.join(profileDir, "screening-answers.yaml");
  fs.writeFileSync(file, "answers: []\nunknown_questions: []\n");
  fs.writeFileSync(path.join(profileDir, "cv-source.md"), CV);
  // Years options with no "more than 5/10" label fall past the built-in default.
  const odd = q("How many years of work experience do you have?", "select", opt("0-2 years", "3-7 years", "8+ years"));
  const bank = await seek.loadScreeningAnswers(file);
  assert.equal((await seek.decideQuestionWithJev(odd, bank)).kind, "unmatched", "no opportunity, no derivation");
  const decided = await seek.decideQuestionWithJev(odd, bank, { opportunity: { id: "seek-9", company: "C", title: "T", channel: "seek" } });
  assert.equal(decided.kind === "option" && decided.option.label, "8+ years");
  const parsed = (await import("yaml")).default.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.unknown_questions[0].derived, true);
}


// What the person already said answers new wordings (facts, earlier answers, skill years).
{
  const known = derive.knownItems([
    "facts:",
    "  - fact: \"About 2 years as an AI architect\"",
    "unknown_questions:",
    "  - question: \"Are you willing to work onsite three days a week?\"",
    "    answer: \"Yes\"",
    "answers:",
    "  - id: notice_period",
    "    patterns: [\"notice\"]",
    "    answer: \"1 week\"",
    "skills_years:",
    "  azure: 8",
  ].join("\n"));
  assert.deepEqual(known.map((k) => k.kind), ["fact", "answered", "answered", "fact"]);
  assert.equal(known[3].text, "8 years of experience with azure");

  const choose = (choice: string, p = 0.93) => (async (args: any) => {
    const probabilities: Record<string, number> = {};
    for (const key of Object.keys(args.questions.known_answer.criteria)) probabilities[key] = key === choice ? p : (1 - p) / 3;
    return {
      status: "ok", mode: "live", question_set_hash: "qs-known", question_ids: ["known_answer"], gateway_route_fingerprint: "fp", route_fingerprint_matches: true,
      resolved_model_version: "jev-1.0", model_version_observable: true, latency_ms: 1, estimated_cost_usd: 0, response_cost_usd: 0, fixture_key: "k",
      result: { answers: { known_answer: { type: "choice", choice, probabilities } }, usage: {}, response: { modelId: "jev-1.0" } },
    };
  }) as any;
  const ctx = { ...baseCtx, known };
  const sel = q("Can you work from the office three days a week?", "select", opt("Yes", "No"));
  const yes = await derive.deriveFromKnown(sel, { ...ctx, evaluate: choose("choice_0") });
  assert.ok("derived" in yes && yes.derived.answer === "Yes", "an earlier answer covers a new wording");
  assert.ok("escalate" in (await derive.deriveFromKnown(sel, { ...ctx, evaluate: choose("unsure") })), "unsure escalates");
  assert.ok("escalate" in (await derive.deriveFromKnown(sel, { ...ctx, evaluate: choose("choice_0", 0.5) })), "a weak match escalates");
  assert.ok("derived" in (await derive.deriveFromKnown(sel, { ...ctx, evaluate: choose("choice_0", 0.65) })), "an approximate match stands");
  const text = q("What is your notice period?", "text", []);
  const t = await derive.deriveFromKnown(text, { ...ctx, evaluate: (async (args: any) => {
    const crit = args.questions.known_answer.criteria; const key = Object.keys(crit).find((k) => crit[k] === "1 week")!;
    return (await choose(key)(args));
  }) as any });
  assert.ok("derived" in t && t.derived.answer === "1 week", "a free-text field reuses the earlier answer word for word");
  assert.ok("escalate" in (await derive.deriveFromKnown(sel, { ...baseCtx, known: [], evaluate: choose("choice_0") })), "nothing said yet escalates");
}


// --- model first: one structured call, guardrails after it ---------------------
{
  const RULES = "never_named:\n  - pattern: \"\\\\bHidden Partner\\\\b\"\n    issue: \"names the never-named partner\"\n";
  const known = derive.knownItems("facts:\n  - \"Holds a current driver licence\"\nskills_years:\n  azure: 8\n");
  const ctx = { ...baseCtx, rulesYaml: RULES, known, profileMd: "---\nname: Jane\n---\n\n# Profile\n\n- Based in Sydney, open to remote work\n" };

  // Evidence: the overall arithmetic, roles with their text, profile lines, facts; never-named withheld.
  const ev = derive.modelEvidence(ctx);
  assert.match(ev[0].text, /14 completed years/);
  assert.ok(ev.some((e) => /Solution Architect, Sample Bank/.test(e.text)));
  assert.ok(ev.some((e) => /Profile: Based in Sydney/.test(e.text)));
  assert.ok(ev.some((e) => /Fact: 8 years of experience with azure/.test(e.text)));
  assert.ok(ev.some((e) => /not paid employment/.test(e.text) && /Weekend Project/.test(e.text)));
  assert.ok(!JSON.stringify(ev.map((e) => e.text)).includes("Hidden Partner"), "never-named text is withheld from the model");
  const idOf = (re: RegExp) => ev.find((e) => re.test(e.text))!.id;
  const solution = idOf(/Solution Architect, Sample Bank/);

  /** A fake model: returns each scripted reply in turn and keeps every input. */
  const script = (...replies: Partial<import("../tools/screening-derive.ts").AnswerOutput>[]) => {
    const calls: import("../tools/screening-derive.ts").AnswerInput[] = [];
    const answer = async (input: any) => {
      calls.push(input);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { answer: "", confidence: "none", evidence: [], reasoning: "", model: "fake-model", ...r } as any;
    };
    return { answer, calls };
  };
  const passSlop = async () => ({ verdict: "pass" as const, hits: [] });

  // Free-text yes/no question with CV support: "Yes" plus a short evidence clause.
  {
    const m = script({ answer: "Yes, I designed integration and platform architecture as a solution architect at a bank.", confidence: "medium", evidence: [solution], reasoning: "the bank role covers integration architecture" });
    const out = await derive.answerWithModel(q("Do you have experience with integration architecture?", "text"), { ...ctx, answer: m.answer, slop: passSlop });
    assert.ok("derived" in out, JSON.stringify(out));
    assert.equal(out.derived.decision.kind, "text");
    assert.match(String(out.derived.answer), /^Yes, /);
    assert.equal(out.derived.evidence.confidence, "medium");
    assert.ok(out.derived.evidence.sources[0].startsWith("cv-source.md line"));
    assert.equal(m.calls[0].options.length, 0);
    assert.equal(m.calls.length, 1);
  }

  // Options: the label is matched exactly (case aside), with no shape rule gating the question.
  {
    const m = script({ answer: "yes", confidence: "high", evidence: [idOf(/driver licence/)], reasoning: "stated fact" });
    const out = await derive.answerWithModel(q("Do you hold a current driver's licence?", "radio", opt("Yes", "No")), { ...ctx, answer: m.answer });
    assert.ok("derived" in out && out.derived.answer === "Yes" && out.derived.decision.kind === "option");
    assert.deepEqual(m.calls[0].options, ["Yes", "No"]);
    assert.deepEqual(out.derived.select, ["^Yes$"]);
  }

  // An option not in the list gets one retry with the reason, then stands if fixed.
  {
    const m = script({ answer: "Six to ten years", confidence: "medium", evidence: [solution], reasoning: "r" }, { answer: "6 to 10 years", confidence: "medium", evidence: [solution], reasoning: "r" });
    const out = await derive.answerWithModel(q("How many years in architecture?", "select", YEAR_OPTIONS), { ...ctx, answer: m.answer });
    assert.ok("derived" in out && out.derived.answer === "6 to 10 years");
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1].findings.join(" "), /not one of the options/);
  }
  {
    const m = script({ answer: "Plenty", confidence: "high", evidence: [solution], reasoning: "r" });
    const out = await derive.answerWithModel(q("How many years in architecture?", "select", YEAR_OPTIONS), { ...ctx, answer: m.answer });
    assert.ok("escalate" in out && /guardrails twice/.test(out.escalate));
    assert.equal(m.calls.length, 2, "one retry only");
  }

  // Numeric fields take a bare number.
  {
    const ok = await derive.answerWithModel(q("Years of experience", "text", [], true), { ...ctx, answer: script({ answer: "14", confidence: "high", evidence: [ev[0].id], reasoning: "overall arithmetic" }).answer });
    assert.ok("derived" in ok && ok.derived.answer === 14 && ok.derived.decision.kind === "text" && ok.derived.decision.answer === "14");
    const bad = await derive.answerWithModel(q("Years of experience", "text", [], true), { ...ctx, answer: script({ answer: "about 14", confidence: "high", evidence: [ev[0].id], reasoning: "r" }).answer });
    assert.ok("escalate" in bad && /bare number/.test(bad.escalate));
  }

  // No or weak evidence goes to the person, without a retry.
  {
    const none = script({ answer: "", confidence: "none", evidence: [], reasoning: "nothing about salary" });
    const out = await derive.answerWithModel(q("What are your salary expectations?", "text"), { ...ctx, answer: none.answer });
    assert.ok("escalate" in out && /no supporting evidence/.test(out.escalate));
    assert.equal(none.calls.length, 1);
    const low = await derive.answerWithModel(q("Why this company?", "text"), { ...ctx, answer: script({ answer: "I like it.", confidence: "low", evidence: [solution], reasoning: "guess" }).answer });
    assert.ok("escalate" in low && /weak evidence/.test(low.escalate));
  }

  // Guardrails: cited evidence must exist; never-named parties and slop fail.
  {
    const m = script({ answer: "Yes", confidence: "high", evidence: ["e9999"], reasoning: "r" }, { answer: "Yes", confidence: "high", evidence: [solution], reasoning: "r" });
    const out = await derive.answerWithModel(q("Architecture experience?", "radio", opt("Yes", "No")), { ...ctx, answer: m.answer });
    assert.ok("derived" in out);
    assert.match(m.calls[1].findings.join(" "), /e9999/);

    const uncited = await derive.answerWithModel(q("Architecture experience?", "radio", opt("Yes", "No")), { ...ctx, answer: script({ answer: "Yes", confidence: "high", evidence: [], reasoning: "r" }).answer });
    assert.ok("escalate" in uncited && /cite the ids/.test(uncited.escalate));

    const named = script({ answer: "Yes, I advised Hidden Partner on architecture.", confidence: "high", evidence: [solution], reasoning: "r" });
    const n = await derive.answerWithModel(q("Advisory experience?", "text"), { ...ctx, answer: named.answer, slop: passSlop });
    assert.ok("escalate" in n && /never-named/.test(n.escalate));
    assert.match(named.calls[1].findings.join(" "), /names the never-named partner/, "the profile's never_named rule is applied");

    const withheld = await derive.answerWithModel(q("Advisory experience?", "text"), { ...ctx, answer: script({ answer: "Yes, at [withheld].", confidence: "high", evidence: [solution], reasoning: "r" }).answer, slop: passSlop });
    assert.ok("escalate" in withheld && /withheld marker/.test(withheld.escalate));

    const sloppy = await derive.answerWithModel(q("Describe your architecture work.", "text"),
      { ...ctx, answer: script({ answer: "I designed platform architecture for a bank.", confidence: "high", evidence: [solution], reasoning: "r" }).answer, slop: async () => ({ verdict: "fail" as const, hits: [{ phrase: "em dash" }] }) });
    assert.ok("escalate" in sloppy && /slop check failed/.test(sloppy.escalate));

    const note = await derive.answerWithModel(q("Describe your architecture work.", "text"),
      { ...ctx, answer: script({ answer: "I designed platform architecture (verify dates).", confidence: "high", evidence: [solution], reasoning: "r" }).answer, slop: passSlop });
    assert.ok("escalate" in note && /note to check/.test(note.escalate), "cleanAnswer applies");
  }

  // The model cannot be reached: the caller falls back.
  {
    const out = await derive.answerWithModel(q("Anything?", "text"), { ...ctx, answer: async () => { throw new Error("spawn failed"); } });
    assert.ok("unavailable" in out && /spawn failed/.test(out.unavailable));
  }

  // End to end: recorded as derived with its confidence, so the person can see and change it.
  {
    const file = path.join(profileDir, "screening-answers.yaml");
    fs.writeFileSync(file, "answers: []\nunknown_questions:\n  - opportunity_id: seek-20\n    question: \"Do you have experience with integration architecture?\"\n    answer: null\n");
    const m = script({ answer: "Yes, I designed integration architecture for a bank.", confidence: "medium", evidence: [solution], reasoning: "bank role" });
    const detail = await derive.resolveWithDetail({ id: "seek-20" }, q("Do you have experience with integration architecture?", "text"), { ...ctx, answer: m.answer, slop: passSlop });
    assert.ok(detail.decision && detail.confidence === "medium" && detail.via === "model");
    const row = (await import("yaml")).default.parse(fs.readFileSync(file, "utf8")).unknown_questions[0];
    assert.equal(row.answer, "Yes, I designed integration architecture for a bank.");
    assert.equal(row.derived, true);
    assert.equal(row.derived_evidence.confidence, "medium");
    assert.equal(row.derived_evidence.model, "fake-model");

    // Model off: the CV derivation stands in for a years question.
    const fallback = await derive.resolveWithDetail({ id: "seek-21" }, q("How many years of work experience do you have?", "select", YEAR_OPTIONS),
      { ...ctx, answer: async () => { throw new Error("off"); } });
    assert.ok(fallback.decision && fallback.via === "fallback" && fallback.answer === "More than 10 years");
    const escalated = await derive.resolveWithDetail({ id: "seek-22" }, q("What are your salary expectations?", "text"), { ...ctx, answer: script({ confidence: "none", reasoning: "no salary in evidence" }).answer });
    assert.ok(!escalated.decision && /no supporting evidence/.test(escalated.reason));
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log("screening-derive tests passed");
