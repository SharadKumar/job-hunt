#!/usr/bin/env tsx
/**
 * Unit tests for the browser-free parts of tools/channels/linkedin-submit.ts:
 * numeric answers for LinkedIn's decimal-only "years of experience" inputs,
 * and the screening decisions the adapter shares with SEEK.
 *
 * Run: npx tsx tests/linkedin-submit.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { numericFromAnswer, submitLinkedIn } from "../tools/channels/linkedin-submit.ts";
import { decideQuestion, type PageQuestion, type ScreeningEntry } from "../tools/channels/seek-submit.ts";

const ENTRIES: ScreeningEntry[] = [
  { id: "years_experience_generic", patterns: ["years of experience (do you have )?(as|in|with)"], answer: "More than 5 years." },
  { id: "years_with_servicenow", patterns: ["years.*servicenow"], answer: "3+ years — led the ESM transformation." },
  { id: "years_with_m365", patterns: ["years.*(microsoft 365|m365|sharepoint)"], answer: "15+ years across Office 365 / SharePoint." },
];

function numeric(label: string): PageQuestion {
  return { kind: "text", label, id: "single-line-text-form-component-numeric", name: "", options: [], required: true };
}

const tests: [string, () => void][] = [
  ["numericFromAnswer takes the leading number and never rounds up", () => {
    assert.equal(numericFromAnswer("3+ years — led the ESM transformation."), "3");
    assert.equal(numericFromAnswer("More than 5 years."), "5");
    assert.equal(numericFromAnswer("15+ years across Office 365"), "15");
    assert.equal(numericFromAnswer("2.5 years"), "2.5");
    assert.equal(numericFromAnswer("Yes, extensively"), undefined);
    assert.equal(numericFromAnswer(null), undefined);
  }],

  ["a product-specific years question resolves to that entry's number", () => {
    const d = decideQuestion(numeric("How many years of work experience do you have with ServiceNow?"), ENTRIES);
    assert.equal(d.kind, "text");
    assert.equal(numericFromAnswer((d as { answer: string }).answer), "3");
    const m = decideQuestion(numeric("How many years of work experience do you have with SharePoint?"), ENTRIES);
    assert.equal(numericFromAnswer((m as { answer: string }).answer), "15");
  }],

  ["a years question about an unknown subject stays unmatched (parked, never invented)", () => {
    const d = decideQuestion(numeric("How many years of work experience do you have with Data Center Consolidation?"), ENTRIES);
    assert.equal(d.kind, "unmatched");
  }],

  ["submitLinkedIn refuses rows without a LinkedIn job id before touching a browser", async () => {
    const r = await submitLinkedIn(
      { id: "x", channel: "linkedin_jobs", title: "t", company: "c", url: "https://www.linkedin.com/jobs/search/", status: "approved", history: [] },
      { cvDocxPath: "/nonexistent.docx", coverLetterMd: "", screeningAnswers: [] },
      { resumeFilename: "x.docx", dryRun: true },
    );
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /cannot derive LinkedIn job id/);
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
