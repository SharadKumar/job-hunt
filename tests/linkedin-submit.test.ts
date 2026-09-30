#!/usr/bin/env tsx
/**
 * Unit tests for the browser-free parts of tools/channels/linkedin-submit.ts:
 * numeric answers for LinkedIn's decimal-only "years of experience" inputs,
 * and the screening decisions the adapter shares with SEEK.
 *
 * Run: npx tsx tests/linkedin-submit.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { chromium } from "playwright";
import { chooseQuestionLabel, discoverModalQuestions, isOptionEcho, numericFromAnswer, submitLinkedIn, waitForSubmissionConfirmation } from "../tools/channels/linkedin-submit.ts";
import { decideQuestion, loadScreeningAnswers, normaliseQuestion, type PageQuestion, type ScreeningEntry } from "../tools/channels/seek-submit.ts";
import { appendUnknownQuestion } from "../tools/autopilot-submit.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/screening/screening-answers.yaml");
const OPP = { id: "linkedin_jobs-fixture0010", company: "Kappa Infotech", title: "Lead AI Engineer" };

async function tmpFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp24-screening-"));
  const file = path.join(dir, "screening-answers.yaml");
  await fs.copyFile(FIXTURE, file);
  return file;
}

const ENTRIES: ScreeningEntry[] = [
  { id: "years_experience_generic", patterns: ["years of experience (do you have )?(as|in|with)"], answer: "More than 5 years." },
  { id: "years_with_servicenow", patterns: ["years.*servicenow"], answer: "3+ years — led the ESM transformation." },
  { id: "years_with_m365", patterns: ["years.*(microsoft 365|m365|sharepoint)"], answer: "15+ years across Office 365 / SharePoint." },
];

function numeric(label: string): PageQuestion {
  return { kind: "text", label, id: "single-line-text-form-component-numeric", name: "", options: [], required: true };
}

const tests: [string, () => void][] = [
  ["explicit banked binary answers override heuristics without inventing qualified consent", () => {
    const q: PageQuestion = { kind: "radio", label: "Are you willing to relocate?", id: "", name: "move", required: true,
      options: [{ label: "Yes", id: "y" }, { label: "No", id: "n" }] };
    assert.deepEqual(decideQuestion(q, [{ id: "move", patterns: ["relocate"], answer: "No." }]), { kind: "option", option: q.options[1] });
    assert.deepEqual(decideQuestion({ ...q, label: "Located locally?" }, [{ id: "local", patterns: ["locally"], answer: "Yes." }]), { kind: "option", option: q.options[0] });
    assert.equal(decideQuestion({ ...q, label: "Located locally?" }, [{ id: "local", patterns: ["locally"], answer: "Yes, only occasionally" }]).kind, "unmatched");
  }],
  ["SDUI radio options remain separate from the question, including inside shadow DOM", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const markup = `<dialog open>
        <fieldset><legend>Are you legally authorized to work in Australia?</legend>
          <div><div><input id="yes" type="radio" name="rights" aria-label="Are you legally authorized to work in Australia?"><label for="yes"></label></div><div><p>Yes</p></div></div>
          <div><div><input id="no" type="radio" name="rights" aria-label="Are you legally authorized to work in Australia?" checked><label for="no"></label></div><div><p>No</p></div></div>
        </fieldset>
        <fieldset><legend>Resume</legend><div><input id="cv" name="cv" type="radio" aria-label="Example.docx"><label for="cv"></label></div></fieldset>
        <fieldset><legend>Another question?</legend><input id="a" type="radio" name="ambiguous"><input id="b" type="radio" name="ambiguous"><p>Yes No</p></fieldset>
        <fieldset><legend>Choose availability</legend><input id="now" type="radio" name="available"><label for="now">Immediately</label></fieldset>
      </dialog>`;
      for (const shadow of [false, true]) {
        await page.setContent(shadow ? '<div id="host"></div>' : markup);
        if (shadow) await page.locator('#host').evaluate((el, html) => { el.attachShadow({ mode: 'open' }).innerHTML = html; }, markup);
        const questions = await discoverModalQuestions(page);
        const rights = questions.find((q) => q.name === "rights")!;
        assert.equal(rights.label, "Are you legally authorized to work in Australia?");
        assert.deepEqual(rights.options.map((o) => o.label), ["Yes", "No"]);
        assert.equal(rights.value, "No");
        assert.equal(questions.find((q) => q.name === "cv")!.options[0].label, "Example.docx");
        assert.deepEqual(questions.find((q) => q.name === "ambiguous")!.options.map((o) => o.label), ["", ""]);
        assert.equal(questions.find((q) => q.name === "available")!.options[0].label, "Immediately");
      }
    } finally { await browser.close(); }
  }],
  ["confirmation waits for delayed success without any send action", async () => {
    let reads = 0;
    let pauses = 0;
    assert.equal(await waitForSubmissionConfirmation(async () => {
      reads++;
      return { text: reads < 3 ? "Review your application" : "Your application was sent to Example", submitVisible: reads < 3 };
    }, async () => { pauses++; }, 4), true);
    assert.equal(reads, 3);
    assert.equal(pauses, 2);
  }],
  ["stalled submit stays unconfirmed and polling is bounded", async () => {
    let reads = 0;
    assert.equal(await waitForSubmissionConfirmation(async () => {
      reads++;
      return { text: "Review your application", submitVisible: true };
    }, async () => {}, 3), false);
    assert.equal(reads, 3);
    assert.equal(await waitForSubmissionConfirmation(async () => ({ text: "Your application was sent", submitVisible: true }), async () => {}, 1), false);
  }],
  ["confirmation transport failure is not a successful send", async () => {
    await assert.rejects(waitForSubmissionConfirmation(async () => { throw new Error("page closed"); }, async () => {}), /page closed/);
  }],
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

  ["a LinkedIn numeric years question resolves from skills_years", async () => {
    const answers = await loadScreeningAnswers(FIXTURE);
    const azure = decideQuestion(numeric("How many years of work experience do you have with Microsoft Azure?"), answers);
    assert.deepEqual(azure, { kind: "text", answer: "8" });
    assert.equal(numericFromAnswer((azure as { answer: string }).answer), "8");
    const excel = decideQuestion(numeric("How many years of work experience do you have with Microsoft Excel?"), answers);
    assert.equal(numericFromAnswer((excel as { answer: string }).answer), "15");
    // TensorFlow is not in skills_years and is never invented.
    assert.equal(decideQuestion(numeric("How many years of work experience do you have with TensorFlow?"), answers).kind, "unmatched");
  }],

  ["the control's placeholder and option text is never stored as the question", () => {
    assert.equal(isOptionEcho("Select an option Yes No", ["Yes", "No"]), true);
    assert.equal(isOptionEcho("Yes No", ["Yes", "No"]), true);
    assert.equal(isOptionEcho("Are you legally authorized to work in Australia? Required", ["Yes", "No"]), false);
    // The wrapping label echoes the select's own options: fall through to the fallback.
    const label = chooseQuestionLabel({ wrap: "Select an option Yes No" }, ["Yes", "No"]);
    assert.notEqual(label, "Select an option Yes No");
    assert.equal(label, "(unlabelled question near: Yes, No)");
  }],

  ["label capture prefers label[for], then aria-labelledby, then legend, then the preceding label", () => {
    const opts = ["Yes", "No"];
    assert.equal(chooseQuestionLabel({ forLabel: "A?", labelledby: "B?", legend: "C?", preceding: "D?" }, opts), "A?");
    assert.equal(chooseQuestionLabel({ labelledby: "B?", legend: "C?", preceding: "D?" }, opts), "B?");
    assert.equal(chooseQuestionLabel({ legend: "C?", preceding: "D?" }, opts), "C?");
    assert.equal(chooseQuestionLabel({ wrap: "Select an option Yes No", preceding: "D?" }, opts), "D?");
    assert.equal(chooseQuestionLabel(undefined, []), "(unlabelled question near: no options)");
  }],

  ["appendUnknownQuestion dedups on the normalised question text", async () => {
    const file = await tmpFixture();
    const before = YAML.parse(await fs.readFile(file, "utf8")).unknown_questions.length;

    // A genuinely new question appends once.
    const q = { text: "How many years of work experience do you have with Kubernetes?", context: "numeric" };
    assert.equal(await appendUnknownQuestion(OPP, q, file), true);
    let rows = YAML.parse(await fs.readFile(file, "utf8")).unknown_questions;
    assert.equal(rows.length, before + 1);

    // The same question again, and the same question rendered with a trailing
    // "Required" and extra whitespace, are both no-ops.
    assert.equal(await appendUnknownQuestion(OPP, q, file), false);
    assert.equal(await appendUnknownQuestion(OPP, { ...q, text: "  How many years of work experience do you have with Kubernetes?   Required " }, file), false);
    rows = YAML.parse(await fs.readFile(file, "utf8")).unknown_questions;
    assert.equal(rows.length, before + 1);

    // TensorFlow is already parked in the fixture: it must not be parked twice.
    assert.equal(await appendUnknownQuestion(OPP, { text: "How many years of work experience do you have with TensorFlow?", context: "numeric" }, file), false);
    rows = YAML.parse(await fs.readFile(file, "utf8")).unknown_questions;
    assert.equal(rows.length, before + 1);
    const texts = rows.map((r: any) => normaliseQuestion(r.question));
    assert.equal(texts.filter((t: string) => t === normaliseQuestion(q.text)).length, 1);
    // The fixture reproduces the live file's one pre-existing duplicate (the
    // salary question parked twice, once with a trailing space); every other
    // normalised question is unique, and nothing new can duplicate now.
    const dupes = texts.filter((t: string, i: number) => texts.indexOf(t) !== i);
    assert.deepEqual(dupes, ["what's your expected annual base salary"]);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
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

tests.push(["portal failures finish diagnostics before browser cleanup and dialog lookup supports native dialogs", async () => {
  const channelDir = new URL("../tools/channels/", import.meta.url);
  for (const name of ["linkedin-submit.ts", "seek-submit.ts"]) {
    const source = await fs.readFile(new URL(name, channelDir), "utf8");
    assert.doesNotMatch(source, /return fail\(/, `${name} must await failure screenshots before finally closes the context`);
  }
  const source = await fs.readFile(new URL("linkedin-submit.ts", channelDir), "utf8");
  assert.doesNotMatch(source, /div\[role="dialog"\]/);
  assert.match(source, /page\.getByRole\("dialog"\)/);
  assert.match(source, /e\.matches\('dialog, \[role="dialog"\]'\)/);
  assert.doesNotMatch(source, /heading === lastHeading/);
}]);

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
