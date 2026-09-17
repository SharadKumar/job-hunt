#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { classifyApplyStep, coverLetterToPlainText, decideQuestion, matchScreeningEntry, type PageQuestion, type ScreeningEntry } from "../tools/channels/seek-submit.ts";

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

console.log("seek-submit.test.ts OK");
