#!/usr/bin/env tsx
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyApplyStep,
  coverLetterToPlainText,
  decideQuestion,
  loadScreeningAnswers,
  lookupSkillYears,
  matchScreeningEntry,
  normaliseQuestion,
  parseYearOption,
  pickYearOption,
  yearsQuestionSubject,
  type PageQuestion,
  type ScreeningEntry,
} from "../tools/channels/seek-submit.ts";

const entries: ScreeningEntry[] = [
  { id: "right_to_work_au", patterns: ["right to work in australia"], answer: "Yes." },
  { id: "notice_period", patterns: ["notice period", "availability"], answer: "TODO — set" },
  { id: "years_sn", patterns: ["years.*servicenow"], answer: "3+ years", select: ["^3 years", "more than 5"] },
  { id: "why_us", patterns: ["why do you want"], answer: "Because." },
];
const opts = (...labels: string[]) => labels.map((label, i) => ({ label, id: `o${i}` }));
const q = (kind: PageQuestion["kind"], label: string, options: PageQuestion["options"] = []): PageQuestion => ({ kind, label, id: "", name: "", options, required: true });

assert.equal(matchScreeningEntry("Which of the following statements best describes your right to work in Australia?", entries)?.id, "right_to_work_au");

// select via built-in when entry has no `select`
let d = decideQuestion(q("select", "Which of the following statements best describes your right to work in Australia?", opts("Select", "I'm an Australian citizen", "I require sponsorship")), entries);
assert.deepEqual(d, { kind: "option", option: { label: "I'm an Australian citizen", id: "o1" } });

// years-experience built-in, no entry at all
d = decideQuestion(q("select", "How many years' experience do you have as a delivery manager?", opts("No experience", "1 year", "5 years", "More than 5 years")), entries);
assert.equal(d.kind === "option" && d.option.label, "More than 5 years");

// explicit `select` list wins, in order
d = decideQuestion(q("select", "How many years of ServiceNow experience do you have?", opts("1 year", "3 years", "More than 5 years")), entries);
assert.equal(d.kind === "option" && d.option.label, "3 years");

// notice built-in via entry with TODO answer
d = decideQuestion(q("select", "How much notice are you required to give your current employer?", opts("None, I'm ready to go now", "1 week", "2 weeks")), entries);
assert.equal(d.kind === "option" && d.option.label, "1 week");

// clearance checkbox group
d = decideQuestion(q("checkbox", "Do you have an AGSVA security clearance?", opts("No, ability to obtain (Australian Citizen)", "Yes, Baseline")), entries);
assert.equal(d.kind === "option" && d.option.label, "No, ability to obtain (Australian Citizen)");

// privacy consent single checkbox
d = decideQuestion(q("checkbox", "Do you agree to the privacy policy of Acme Recruitment?", opts("Yes")), entries);
assert.equal(d.kind, "option");

// free text: answer used; TODO answer and unknown question are unmatched
assert.deepEqual(decideQuestion(q("text", "Why do you want this role?"), entries), { kind: "text", answer: "Because." });
assert.deepEqual(decideQuestion(q("text", "What is your availability?"), entries), { kind: "unmatched" });
assert.deepEqual(decideQuestion(q("text", "Describe a device rollout you led"), entries), { kind: "unmatched" });
assert.deepEqual(decideQuestion(q("select", "Preferred pronouns", opts("He", "She")), entries), { kind: "unmatched" });

assert.equal(classifyApplyStep("https://au.seek.com/job/123/apply"), "documents");
assert.equal(classifyApplyStep("https://www.seek.com.au/job/123/apply/role-requirements"), "role-requirements");
assert.equal(classifyApplyStep("https://au.seek.com/job/123/apply/review?x=1"), "review");
assert.equal(classifyApplyStep("https://au.seek.com/job/123/apply/success"), "success");
assert.equal(classifyApplyStep("https://apply.jobadder.com/au1/123"), "external");

assert.equal(coverLetterToPlainText("---\nrole: x\n---\n# Hi\n\nI **led** the _thing_.\n\n\n\nRegards"), "Hi\n\nI led the thing.\n\nRegards");

// ---------------------------------------------------------------------------
// WP2.4: normalisation, the skills_years resolver, and the parked questions
// ---------------------------------------------------------------------------

// normaliseQuestion: trailing "Required", "*", "(required)" and punctuation go.
assert.equal(normaliseQuestion("Are you legally authorized to work in Australia? Required"), "are you legally authorized to work in australia");
assert.equal(normaliseQuestion("  Are you   legally authorized to work in Australia?  *  "), "are you legally authorized to work in australia");
assert.equal(normaliseQuestion("How many years with Azure? (Required)"), "how many years with azure");
assert.equal(normaliseQuestion("What's your expected annual base salary? "), normaliseQuestion("What's your expected annual base salary?"));
assert.equal(normaliseQuestion(null), "");
// "required" mid-sentence is left alone.
assert.equal(normaliseQuestion("How much notice are you required to give?"), "how much notice are you required to give");

// A hand-answered unknown_questions row fires on a differently-punctuated render.
assert.equal(
  matchScreeningEntry("Right to work in Australia *", [{ id: "u", patterns: ["^right to work in australia$"], answer: "Yes." }] as ScreeningEntry[])?.id,
  "u",
);

// Years-question subject extraction.
assert.equal(yearsQuestionSubject("How many years of work experience do you have with Microsoft Azure?"), "microsoft azure");
assert.equal(yearsQuestionSubject("How many years of work experience do you have with TensorFlow?"), "tensorflow");
assert.equal(yearsQuestionSubject("Why do you want this role?"), undefined);

// Option bands.
assert.deepEqual(parseYearOption("5+"), { lo: 5, hi: Infinity });
assert.deepEqual(parseYearOption("10+ years"), { lo: 10, hi: Infinity });
assert.deepEqual(parseYearOption("More than 5 years"), { lo: 5, hi: Infinity, loExclusive: true });
assert.deepEqual(parseYearOption("3-5 years"), { lo: 3, hi: 5 });
assert.deepEqual(parseYearOption("No experience"), { lo: 0, hi: 0 });
assert.equal(parseYearOption("Preferred pronouns"), null);
assert.equal(pickYearOption(opts("1-2 years", "3-5 years", "5+ years", "10+ years"), 8)?.label, "5+ years");
assert.equal(pickYearOption(opts("1-2 years", "3-5 years"), 8), undefined);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/screening/screening-answers.yaml");
const fixture = await loadScreeningAnswers(FIXTURE);

assert.equal(lookupSkillYears("microsoft azure", fixture.skillsYears), 8);
assert.equal(lookupSkillYears("Microsoft Excel", fixture.skillsYears), 15);
assert.equal(lookupSkillYears("sharepoint", fixture.skillsYears), 12);   // alias
assert.equal(lookupSkillYears("tensorflow", fixture.skillsYears), undefined);

// "How many years ... with Microsoft Azure?" on a numeric field and on an option field.
const azureNumeric: PageQuestion = { kind: "text", label: "How many years of work experience do you have with Microsoft Azure?", id: "", name: "", options: [], required: true, numeric: true };
assert.deepEqual(decideQuestion(azureNumeric, fixture), { kind: "text", answer: "8" });
const azureOptions = decideQuestion(
  q("select", "How many years of work experience do you have with Microsoft Azure?", opts("1-2 years", "3-5 years", "5+ years", "10+ years")),
  fixture,
);
assert.equal(azureOptions.kind === "option" && azureOptions.option.label, "5+ years");

// An unlisted subject is never invented.
assert.deepEqual(
  decideQuestion({ ...azureNumeric, label: "How many years of work experience do you have with TensorFlow?" }, fixture),
  { kind: "unmatched" },
);

// The thirteen questions the live file had parked, anonymised in the fixture.
type Parked = { question: string; kind: PageQuestion["kind"]; numeric?: boolean; options?: string[] };
const PARKED: Parked[] = [
  { question: "How many years of experience do you have leading complex digital delivery projects and multiple Agile squads?", kind: "text" },
  { question: "What experience do you have delivering Salesforce CRM, workflow or customer portal solutions?", kind: "text" },
  { question: "Have you managed system implementation and legacy-system decommissioning within State Government or another complex organisation?", kind: "text" },
  { question: "What's your expected annual base salary?", kind: "select", options: ["$150k", "$170k", "$200k", "$250k", "$300k", "$350k", "$350k+"] },
  { question: "What's your expected annual base salary? ", kind: "select", options: ["$150k", "$170k", "$200k", "$250k", "$300k", "$350k", "$350k+"] },
  { question: "Have you worked in a role which requires a sound understanding of the software development lifecycle?", kind: "radio", options: ["Yes", "No"] },
  { question: "Do you hold a minimum Baseline Security Clearance?", kind: "radio", options: ["No", "Yes"] },
  { question: "What's your expected day rate?", kind: "select", options: ["$800", "$900", "$1,000", "$1,250", "$1,500", "$1,500+"] },
  { question: "Are you legally authorized to work in Australia? Required", kind: "radio", options: ["Yes", "No"] },
  { question: "How many years of work experience do you have with Microsoft Excel?", kind: "text", numeric: true },
  { question: "How many years of work experience do you have with Microsoft Azure?", kind: "text", numeric: true },
  { question: "Select an option Yes No", kind: "radio", options: ["Yes", "No"] },
  { question: "How many years of work experience do you have with TensorFlow?", kind: "text", numeric: true },
];

// The table above is the fixture's unanswered rows, in order.
const parkedInFixture = (await import("yaml")).default
  .parse(await (await import("node:fs")).promises.readFile(FIXTURE, "utf8"))
  .unknown_questions.filter((u: any) => u.answer == null)
  .map((u: any) => u.question as string);
assert.equal(parkedInFixture.length, 13);
assert.deepEqual(parkedInFixture, PARKED.map((p) => p.question));

const resolved: string[] = [];
const unresolved: string[] = [];
for (const p of PARKED) {
  const question: PageQuestion = {
    kind: p.kind,
    label: p.question,
    id: "",
    name: "",
    options: (p.options ?? []).map((label, i) => ({ label, id: `o${i}` })),
    required: true,
    numeric: p.numeric,
  };
  (decideQuestion(question, fixture).kind === "unmatched" ? unresolved : resolved).push(normaliseQuestion(p.question));
}

assert.deepEqual(unresolved, [
  "how many years of experience do you have leading complex digital delivery projects and multiple agile squads",
  "have you managed system implementation and legacy-system decommissioning within state government or another complex organisation",
  "select an option yes no",
  "how many years of work experience do you have with tensorflow",
]);
assert.equal(resolved.length, 9);
// "Are you legally authorized to work in Australia? Required" resolves via right_to_work_au.
assert.equal(matchScreeningEntry("Are you legally authorized to work in Australia? Required", fixture.entries)?.id, "right_to_work_au");
const rtw = decideQuestion(q("radio", "Are you legally authorized to work in Australia? Required", opts("Yes", "No")), fixture);
assert.equal(rtw.kind === "option" && rtw.option.label, "Yes");

console.log("seek-submit.test.ts OK");
