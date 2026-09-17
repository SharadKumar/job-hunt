#!/usr/bin/env tsx
/**
 * linkedin-submit.ts — LinkedIn Easy Apply submission.
 *
 * Drives the signed-in "linkedin" Chrome profile (state/channels/chrome-profile/linkedin)
 * through the Easy Apply modal for one opportunity:
 *
 *   0. /jobs/view/<id>/                 Confirm the ad is open, not already applied,
 *                                       and carries an Easy Apply button (an
 *                                       "Apply on company website" ad is returned
 *                                       as needsManual without touching anything).
 *   1. Contact info                     Prefilled from the LinkedIn profile; the
 *                                       phone number is filled from profile.md
 *                                       when the field is empty.
 *   2. Resume                           Pick the stored resumé whose name matches
 *                                       the package's docx, else upload that docx.
 *   3. Additional questions (0..n)      Answered from state/profile/screening-answers.yaml
 *                                       through the same decideQuestion() as SEEK.
 *                                       Numeric "years of experience" inputs take
 *                                       the leading number of the matched answer.
 *   4. Review your application          Untick "Follow <company>", screenshot,
 *                                       then Submit application.
 *   5. "Your application was sent"      Confirmation captured, dialog dismissed.
 *
 * Easy Apply has no cover-letter field on most ads. When the modal offers a
 * message / cover-letter textarea the letter is pasted in; otherwise the
 * letter is not sent and the result says so (`coverLetterDelivered: false`
 * in the confirmation ref) so the journal records what the employer saw.
 *
 * Any question with no confident answer stops the run BEFORE the next step
 * and is returned as `newScreeningQuestion`; the modal is discarded so
 * LinkedIn keeps no half-filled draft.
 *
 * Safety: this module performs an irreversible external action. It must only
 * be invoked through tools/submission-gate.ts (attended /apply or
 * /submit-approved, or tools/autopilot-submit.ts once linkedin_jobs is in
 * autopilot.channels). `--dry-run` walks the modal to the review step,
 * screenshots it, and discards the application without submitting.
 *
 * DOM notes (probed 2026-09-16 against the SDUI apply flow): the modal is a
 * [role=dialog] inside an open shadow root; class names are hashed, so
 * everything keys off role/aria/text. When LinkedIn moves the
 * furniture the adapter fails closed (needsManual with the step and a
 * screenshot) rather than guessing.
 *
 * CLI:
 *   tsx tools/channels/linkedin-submit.ts --id <opportunityId> --resume-file <path.docx> \
 *     --cover-letter <path.md> [--dry-run] [--screenshot-dir <dir>]
 *   exit 0 = ok, 1 = needsManual, 2 = error
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import type { SubmitPackage, SubmitResult } from "./_interface.ts";
import { load as loadPipeline, type Opportunity } from "../pipeline.ts";
import { repoPath } from "../repo-root.ts";
import { openChromeContext } from "./_browser.ts";
import {
  coverLetterToPlainText,
  decideQuestion,
  loadScreeningAnswers,
  type PageQuestion,
  type QuestionDecision,
  type ScreeningEntry,
} from "./seek-submit.ts";

export type SubmitLinkedInOptions = {
  dryRun?: boolean;
  /** Basename of the package docx; matched against LinkedIn's stored resumés before uploading. */
  resumeFilename: string;
  screenshotDir?: string;
  /** Per-step timeout in ms (default 20s). */
  stepTimeoutMs?: number;
};

const DEFAULT_STEP_TIMEOUT = 20_000;
const MAX_STEPS = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jobIdFromUrl(url: string): string | undefined {
  return url.match(/\/jobs\/view\/(\d+)/)?.[1];
}

async function screenshot(page: Page, dir: string | undefined, name: string): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch (e) {
    console.error(`[linkedin-submit] screenshot failed: ${(e as Error).message.slice(0, 120)}`);
    return undefined;
  }
}

async function loadProfilePhone(): Promise<string | undefined> {
  try {
    const md = await fs.readFile(repoPath("state/profile/profile.md"), "utf8");
    const m = md.match(/^phone:\s*"?([^"\n]+)"?/m);
    return m?.[1].trim();
  } catch {
    return undefined;
  }
}

/** "3+ years", "More than 5 years.", "15+" → 3 / 5 / 15. Conservative: never rounds up. */
export function numericFromAnswer(answer: string | null | undefined): string | undefined {
  const m = (answer ?? "").match(/\d+(?:\.\d+)?/);
  return m ? m[0] : undefined;
}

function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/**
 * The SDUI Easy Apply dialog lives inside an open shadow root (probed
 * 2026-09-16). Playwright locators pierce it; page.evaluate() code must walk
 * it. Every browser-realm script below starts with this snippet, which
 * yields `dialog` (the [role=dialog] element or null) and `byId` (id lookup
 * inside the dialog's root, since document.getElementById cannot see in).
 */
const FIND_DIALOG_JS = `
  const findDialog = function (root) {
    const nodes = root.querySelectorAll("*");
    for (let i = 0; i < nodes.length; i++) {
      const e = nodes[i];
      if (e.getAttribute && e.getAttribute("role") === "dialog") { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return e; }
      if (e.shadowRoot) { const hit = findDialog(e.shadowRoot); if (hit) return hit; }
    }
    return null;
  };
  const dialog = findDialog(document);
  const scope = dialog ? dialog.getRootNode() : document;
  const byId = function (id) { return scope.getElementById ? scope.getElementById(id) : scope.querySelector("#" + CSS.escape(id)); };
`;

/**
 * Enumerate the form controls inside the Easy Apply dialog. Same shape as the
 * SEEK discovery so decideQuestion() applies unchanged, plus `numeric` for
 * LinkedIn's decimal-only inputs and `value` so prefilled fields are skipped.
 * Browser-realm string: tsx may inject `__name` into transpiled callbacks.
 */
const DISCOVER_MODAL_QUESTIONS_JS = `(() => {
  ${FIND_DIALOG_JS}
  const root = dialog || document.body;
  const clean = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
  const textOfIds = function (ids) { return clean(ids.split(/\\s+/).map(function (id) { const n = byId(id); return n ? n.innerText : ""; }).join(" ")); };
  const labelFor = function (el) {
    if (el.id) { const l = root.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.innerText); }
    const lb = el.getAttribute("aria-labelledby"); if (lb) { const t = textOfIds(lb); if (t) return t; }
    const al = el.getAttribute("aria-label"); if (al) return clean(al);
    const wrap = el.closest("label"); if (wrap) return clean(wrap.innerText);
    return "";
  };
  const groupLabel = function (el) {
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend"); if (lg) return clean(lg.innerText);
      const lb = fs.getAttribute("aria-labelledby"); if (lb) return textOfIds(lb);
    }
    const grp = el.closest('[role="group"],[role="radiogroup"]');
    if (grp) {
      const lb = grp.getAttribute("aria-labelledby"); if (lb) return textOfIds(lb);
      const al = grp.getAttribute("aria-label"); if (al) return clean(al);
      const h = grp.querySelector("legend, h3, h4, span"); if (h) return clean(h.innerText);
    }
    return "";
  };
  const isRequired = function (el) { return el.required || el.getAttribute("aria-required") === "true" || /\\*|required/i.test(groupLabel(el) + labelFor(el)); };
  const out = [];
  root.querySelectorAll("select").forEach(function (s) {
    out.push({ kind: "select", label: labelFor(s) || groupLabel(s), id: s.id || "", name: s.name || "", required: isRequired(s), numeric: false, value: s.value,
      options: Array.prototype.slice.call(s.options).map(function (o) { return { label: clean(o.textContent), id: o.value }; }) });
  });
  const groups = new Map();
  root.querySelectorAll('input[type="checkbox"],input[type="radio"]').forEach(function (i) {
    const key = i.type + ":" + (i.name || groupLabel(i) || i.id);
    if (!groups.has(key)) groups.set(key, { kind: i.type, label: groupLabel(i), id: "", name: i.name || "", required: isRequired(i), numeric: false, value: "", options: [] });
    const g = groups.get(key);
    g.options.push({ label: labelFor(i), id: i.id || "" });
    if (i.checked) g.value = labelFor(i);
    if (!g.label) g.label = labelFor(i);
  });
  groups.forEach(function (g) { out.push(g); });
  root.querySelectorAll('textarea,input[type="text"],input[type="number"],input[type="tel"],input[type="email"],input:not([type])').forEach(function (t) {
    const hint = clean((t.closest("div") && t.closest("div").innerText) || "");
    out.push({ kind: "text", label: labelFor(t) || groupLabel(t), id: t.id || "", name: t.name || "", required: isRequired(t),
      numeric: t.type === "number" || /numeric/i.test(t.id || "") || t.inputMode === "numeric" || t.inputMode === "decimal" || /decimal number|whole number/i.test(hint),
      value: t.value || "", options: [] });
  });
  return out;
})()`;

type ModalQuestion = PageQuestion & { numeric: boolean; value: string };

async function discoverModalQuestions(page: Page): Promise<ModalQuestion[]> {
  const raw = (await page.evaluate(DISCOVER_MODAL_QUESTIONS_JS)) as ModalQuestion[];
  return raw.filter((q) => q.label);
}

const MODAL_TEXT_JS = `(() => { ${FIND_DIALOG_JS} return dialog ? dialog.innerText : ""; })()`;

async function modalText(page: Page): Promise<string> {
  return ((await page.evaluate(MODAL_TEXT_JS)) as string).replace(/\s+/g, " ").trim();
}

async function modalHeading(page: Page): Promise<string> {
  const dialog = page.locator('div[role="dialog"]').first();
  for (const sel of ["h3", "h2", "h1"]) {
    const h = dialog.locator(sel).first();
    if ((await h.count()) && (await h.isVisible().catch(() => false))) {
      const t = (await h.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (t && !/^apply to /i.test(t)) return t;
    }
  }
  return "";
}

function dialog(page: Page): Locator {
  return page.locator('div[role="dialog"]').first();
}

/** Footer navigation. Order matters: Submit only when we mean it. */
async function findButton(page: Page, kind: "next" | "review" | "submit" | "dismiss"): Promise<Locator | null> {
  const d = dialog(page);
  const candidates: Locator[] = {
    next: [d.getByRole("button", { name: /^(next|continue to next step)$/i }), d.locator('button[aria-label*="Continue to next step" i]')],
    review: [d.getByRole("button", { name: /^review( your application)?$/i }), d.locator('button[aria-label*="Review your application" i]')],
    submit: [d.getByRole("button", { name: /^submit application$/i }), d.locator('button[aria-label*="Submit application" i]')],
    dismiss: [d.getByRole("button", { name: /^(dismiss|close)$/i }), d.locator('button[aria-label="Dismiss"], button[aria-label="Close"]')],
  }[kind];
  for (const c of candidates) {
    const first = c.first();
    if ((await first.count()) && (await first.isVisible().catch(() => false))) return first;
  }
  return null;
}

async function applyDecision(page: Page, q: ModalQuestion, d: QuestionDecision, timeout: number): Promise<void> {
  if (d.kind === "unmatched") throw new Error(`unmatched question: ${q.label}`);
  const root = dialog(page);
  if (d.kind === "text") {
    const loc = q.id ? root.locator(`#${cssEscape(q.id)}`) : root.getByLabel(q.label).first();
    await loc.waitFor({ state: "visible", timeout });
    const value = q.numeric ? numericFromAnswer(d.answer) : d.answer;
    if (!value) throw new Error(`numeric answer required for "${q.label}" but matched answer has no number`);
    await loc.fill(value);
    return;
  }
  if (q.kind === "select") {
    const loc = q.id ? root.locator(`select#${cssEscape(q.id)}`) : q.name ? root.locator(`select[name="${q.name}"]`) : root.getByLabel(q.label).first();
    await loc.waitFor({ state: "attached", timeout });
    await loc.selectOption({ label: d.option.label });
    return;
  }
  const role = q.kind === "radio" ? "radio" : "checkbox";
  const input = d.option.id ? root.locator(`#${cssEscape(d.option.id)}`) : root.getByRole(role, { name: d.option.label }).first();
  if (await input.isChecked().catch(() => false)) return;
  try {
    await input.check({ timeout: Math.min(timeout, 5_000) });
  } catch {
    const label = d.option.id ? root.locator(`label[for="${d.option.id}"]`) : root.getByText(d.option.label, { exact: true }).first();
    await label.click({ timeout });
  }
}

/** Close the modal and confirm "Discard" so LinkedIn keeps no draft. Best effort. */
async function discardApplication(page: Page): Promise<void> {
  try {
    const close = await findButton(page, "dismiss");
    if (close) await close.click({ timeout: 5_000 });
    await page.waitForTimeout(600);
    const discard = page.getByRole("button", { name: /^discard$/i }).first();
    if ((await discard.count()) && (await discard.isVisible().catch(() => false))) await discard.click({ timeout: 5_000 });
    await page.waitForTimeout(400);
  } catch (e) {
    console.error(`[linkedin-submit] discard failed: ${(e as Error).message.slice(0, 120)}`);
  }
}

/** Validation feedback LinkedIn renders under a field after Next is pressed. */
async function modalErrors(page: Page): Promise<string[]> {
  const texts = (await page.evaluate(`(() => {
    ${FIND_DIALOG_JS}
    const d = dialog; if (!d) return [];
    const out = [];
    d.querySelectorAll('[role="alert"], [aria-live="assertive"], [class*="error" i], [id$="-error"]').forEach(function (e) {
      const t = (e.innerText || "").replace(/\\s+/g, " ").trim(); if (t) out.push(t);
    });
    return out;
  })()`)) as string[];
  return [...new Set(texts)].filter((t) => /required|enter|select|valid|must|please/i.test(t));
}

/** Answer every control on the current step; returns the first unanswerable question, if any. */
async function answerStep(page: Page, entries: ScreeningEntry[], phone: string | undefined, coverLetter: string, timeout: number, log: (m: string) => void): Promise<{ unmatched?: ModalQuestion; coverLetterDelivered: boolean }> {
  const questions = await discoverModalQuestions(page);
  let coverLetterDelivered = false;
  for (const q of questions) {
    const label = q.label.replace(/\s+/g, " ").trim();
    // Contact-info fields LinkedIn prefills; only fill what is empty.
    if (/^(email|email address)\b/i.test(label)) continue;
    if (/phone country code|country code/i.test(label)) continue;
    if (/mobile phone number|phone number/i.test(label)) {
      if (!q.value && phone) {
        await applyDecision(page, q, { kind: "text", answer: phone.replace(/^\+61\s?/, "0").replace(/\s+/g, "") }, timeout);
        log(`  "${label}" → phone from profile`);
      }
      continue;
    }
    // Cover letter / message to hiring manager.
    if (q.kind === "text" && /cover letter|message to the hiring|summary|why (are you|do you want)/i.test(label) && !q.numeric) {
      await applyDecision(page, q, { kind: "text", answer: coverLetter }, timeout);
      coverLetterDelivered = true;
      log(`  "${label}" → cover letter`);
      continue;
    }
    // Resume selection is handled by handleResumeStep, not as a question.
    if (/^select resume\b/i.test(label) || /^select resume\b/i.test(q.options[0]?.label ?? "")) continue;
    // Follow-company and marketing checkboxes are never ticked.
    if (q.kind === "checkbox" && /follow|newsletter|marketing|updates/i.test(`${label} ${q.options.map((o) => o.label).join(" ")}`)) continue;
    // Already answered (remembered from an earlier application): leave alone.
    if (q.value && q.kind !== "checkbox") continue;

    const decision = decideQuestion(q, entries);
    if (decision.kind === "unmatched") {
      // A numeric field the profile answers in words is still answerable when the words carry a number.
      return { unmatched: q, coverLetterDelivered };
    }
    if (decision.kind === "text" && q.numeric && !numericFromAnswer(decision.answer)) return { unmatched: q, coverLetterDelivered };
    log(`  "${label}" → ${decision.kind === "text" ? (q.numeric ? numericFromAnswer(decision.answer) : "text") : decision.option.label}`);
    await applyDecision(page, q, decision, timeout);
  }
  return { coverLetterDelivered };
}

/**
 * Resume step. LinkedIn lists recent uploads as radios named "Select resume
 * <filename>" ("Deselect resume <filename>" once checked; older ones behind
 * "Show N more resumes"); a fresh upload is auto-selected. Discarding an
 * application also discards its upload, so a dry run leaves nothing behind. Select by exact filename when listed, else
 * upload the package docx.
 */
async function handleResumeStep(page: Page, cvDocxPath: string, resumeFilename: string, timeout: number, log: (m: string) => void): Promise<string | undefined> {
  const d = dialog(page);
  // The checked entry is named "Deselect resume <file>", the others "Select resume <file>".
  const escaped = resumeFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stored = () => d.getByRole("radio", { name: new RegExp(`^(Select|Deselect) resume ${escaped}$`) }).first();
  if (!(await stored().count())) {
    const more = d.getByRole("button", { name: /show \d+ more resumes?/i }).first();
    if ((await more.count()) && (await more.isVisible().catch(() => false))) {
      await more.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(600);
    }
  }
  const radio = stored();
  if (await radio.count()) {
    if (!(await radio.isChecked().catch(() => false))) {
      await radio.check({ timeout }).catch(async () => d.getByText(resumeFilename, { exact: true }).first().click({ timeout }));
    }
    if (!(await radio.isChecked().catch(() => false))) return `could not select stored resumé "${resumeFilename}"`;
    log(`  resumé "${resumeFilename}" selected from stored list`);
    return undefined;
  }
  const fileInput = d.locator('input[type="file"]').first();
  if (!(await fileInput.count())) return `resume step offers neither stored resumé "${resumeFilename}" nor an upload control`;
  await fileInput.setInputFiles(cvDocxPath);
  await page.waitForTimeout(2500);
  const uploaded = stored();
  if (!(await uploaded.count())) return `uploaded "${resumeFilename}" but the modal does not list it`;
  if (!(await uploaded.isChecked().catch(() => false))) await uploaded.check({ timeout }).catch(() => undefined);
  if (!(await uploaded.isChecked().catch(() => false))) return `uploaded "${resumeFilename}" but could not select it`;
  log(`  resumé "${resumeFilename}" uploaded and selected`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

export async function submitLinkedIn(opportunity: Opportunity, pkg: SubmitPackage, opts: SubmitLinkedInOptions): Promise<SubmitResult> {
  const jobId = jobIdFromUrl(opportunity.url);
  if (!jobId) return { ok: false, reason: `cannot derive LinkedIn job id from url ${opportunity.url}`, needsManual: true };
  if (!opts?.resumeFilename) return { ok: false, reason: "resumeFilename is required", needsManual: true };
  const timeout = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT;
  const shotDir = opts.screenshotDir;
  const entries = await loadScreeningAnswers();
  const phone = await loadProfilePhone();
  const coverLetter = coverLetterToPlainText(pkg.coverLetterMd);
  const log = (m: string) => console.error(`[linkedin-submit] ${opportunity.id}: ${m}`);

  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  let opened = false;
  const fail = async (reason: string, extra: Partial<Extract<SubmitResult, { ok: false }>> = {}): Promise<SubmitResult> => {
    if (page?.isClosed()) log(`page closed before failure handling (url ${page.url()})`);
    const shot = page && !page.isClosed() ? await screenshot(page, shotDir, `${opportunity.id}-error.png`) : undefined;
    log(`${reason}${shot ? ` (screenshot ${shot})` : ""}`);
    if (page && opened && !page.isClosed()) await discardApplication(page);
    return { ok: false, reason, needsManual: true, ...extra };
  };

  try {
    ctx = await openChromeContext("linkedin", { headless: true });
    page = await ctx.newPage();
    page.on("crash", () => log("page crashed"));
    page.on("close", () => log("page closed"));
    await page.goto(`https://www.linkedin.com/jobs/view/${jobId}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3000);

    if (/\/login|\/checkpoint|\/authwall/.test(page.url())) return fail("LinkedIn session is signed out; re-run npm run login:linkedin");
    const bodyText = async () => (await page!.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
    const body = await bodyText();
    if (/No longer accepting applications/i.test(body)) return fail("LinkedIn ad is no longer accepting applications");
    if (/\bApplied\b.{0,40}\bago\b|Application submitted|See application/i.test(body.slice(0, 1500))) return fail("LinkedIn reports this application was already submitted");

    const easy = page.locator('a[aria-label^="Easy Apply"], button[aria-label^="Easy Apply"]').first();
    if (!(await easy.count())) {
      const external = page.locator('button[aria-label^="Apply on company website"], a[aria-label^="Apply on company website"]').first();
      if (await external.count()) return { ok: false, needsManual: true, reason: "external ATS: ad uses Apply on company website" };
      return fail("no Easy Apply control found on the ad (DOM change?)");
    }
    await easy.click({ timeout });
    await dialog(page).waitFor({ state: "visible", timeout });
    await page.waitForTimeout(1200);
    opened = true;

    let coverLetterDelivered = false;
    let lastHeading = "";
    const stem = opts.resumeFilename.replace(/\.(docx|pdf)$/i, "");
    for (let step = 0; step < MAX_STEPS; step++) {
      const heading = await modalHeading(page);
      let text = await modalText(page);
      log(`step ${step + 1}: "${heading || "(no heading)"}"`);

      // Success: LinkedIn swaps the form for a confirmation panel.
      if (/application (was )?sent|your application was sent|applied successfully/i.test(text) && !(await findButton(page, "submit"))) {
        const sent = text.match(/Your application was sent to [^.!]+/i)?.[0] ?? text.match(/Application sent[^.!]*/i)?.[0] ?? "LinkedIn Easy Apply submitted";
        const shot = await screenshot(page, shotDir, `${opportunity.id}-success.png`);
        log(sent);
        const close = await findButton(page, "dismiss");
        if (close) await close.click({ timeout: 5_000 }).catch(() => undefined);
        return { ok: true, confirmationRef: `${sent.trim()} (coverLetterDelivered: ${coverLetterDelivered})`, screenshotPath: shot };
      }

      // Resume controls can sit on their own step or share the first step
      // (single-step modals put contact, resume, follow and Submit together).
      const hasResumeControls = (await dialog(page).getByRole("button", { name: /^upload resume/i }).count()) > 0
        || (await dialog(page).getByRole("radio", { name: /^(select|deselect) resume /i }).count()) > 0;
      if (hasResumeControls) {
        const err = await handleResumeStep(page, pkg.cvDocxPath, opts.resumeFilename, timeout, log);
        if (err) return fail(err);
        text = await modalText(page);
      }

      // Form controls on this step (screening questions, phone, cover letter).
      const answered = await answerStep(page, entries, phone, coverLetter, timeout, log);
      coverLetterDelivered = coverLetterDelivered || answered.coverLetterDelivered;
      if (answered.unmatched) {
        const q = answered.unmatched;
        const context = q.options.map((o) => o.label).filter(Boolean).join(" | ") || (q.numeric ? "numeric" : q.kind);
        await screenshot(page, shotDir, `${opportunity.id}-error.png`);
        log(`no confident answer for "${q.label}"`);
        await discardApplication(page);
        opened = false;
        return { ok: false, needsManual: true, reason: `new screening question: ${q.label}`, newScreeningQuestion: { text: q.label, context } };
      }

      // Review: the step that carries Submit. Verify, untick follow, then submit (or stop in dry run).
      const submitBtn = await findButton(page, "submit");
      if (submitBtn) {
        text = await modalText(page);
        if (!text.includes(stem)) return fail(`review step does not show resumé "${opts.resumeFilename}"`);
        const modal = dialog(page);
        const follow = modal.getByRole("checkbox", { name: /follow/i }).first();
        if ((await follow.count()) && (await follow.isChecked().catch(() => false))) {
          await follow.uncheck({ timeout: 5_000 }).catch(async () => modal.getByText(/follow/i).first().click({ timeout: 5_000 }).catch(() => undefined));
        }
        if (opts.dryRun) {
          const shot = await screenshot(page, shotDir, `${opportunity.id}-review.png`);
          log("DRY RUN, review step verified, discarding without submitting");
          await discardApplication(page);
          opened = false;
          return { ok: true, confirmationRef: `DRY RUN: review step verified (coverLetterDelivered: ${coverLetterDelivered})`, screenshotPath: shot };
        }
        await screenshot(page, shotDir, `${opportunity.id}-review.png`);
        await submitBtn.click({ timeout });
        await page.waitForTimeout(3000);
        continue;
      }

      const nav = (await findButton(page, "next")) ?? (await findButton(page, "review"));
      if (!nav) return fail(`no Next/Review/Submit control on step "${heading}"`);
      await nav.click({ timeout });
      await page.waitForTimeout(1500);

      const errors = await modalErrors(page);
      const sameHeading = (await modalHeading(page)) === heading;
      if (errors.length && sameHeading) {
        // Re-discover to name the field LinkedIn is complaining about.
        const pending = (await discoverModalQuestions(page)).find((q) => q.required && !q.value);
        const label = pending?.label ?? errors[0];
        await screenshot(page, shotDir, `${opportunity.id}-error.png`);
        log(`validation stopped the step: ${errors.join(" / ")}`);
        await discardApplication(page);
        opened = false;
        return { ok: false, needsManual: true, reason: `new screening question: ${label}`, newScreeningQuestion: { text: label, context: pending ? (pending.options.map((o) => o.label).join(" | ") || (pending.numeric ? "numeric" : pending.kind)) : errors.join(" / ") } };
      }
      if (sameHeading && heading === lastHeading) return fail(`modal did not advance past "${heading}"`);
      lastHeading = heading;
    }
    return fail(`Easy Apply did not reach the review step within ${MAX_STEPS} steps`);
  } catch (e) {
    return fail(`${(e as Error).name}: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
  } finally {
    await ctx?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  const usage = "Usage: tsx tools/channels/linkedin-submit.ts --id <opportunityId> --resume-file <path.docx> --cover-letter <path.md> [--dry-run] [--screenshot-dir <dir>]";
  if (!args.id || !args["resume-file"] || !args["cover-letter"]) {
    console.error(usage);
    process.exit(2);
  }
  const all = await loadPipeline();
  const opportunity = all.find((r) => r.id === args.id);
  if (!opportunity) {
    console.error(`opportunity not found: ${args.id}`);
    process.exit(2);
  }
  if (opportunity.channel !== "linkedin_jobs") {
    console.error(`opportunity ${args.id} is on channel ${opportunity.channel}, not linkedin_jobs`);
    process.exit(2);
  }
  const cvDocxPath = args["resume-file"];
  await fs.access(cvDocxPath);
  const coverLetterMd = await fs.readFile(args["cover-letter"], "utf8");
  const pkg: SubmitPackage = { cvDocxPath, coverLetterMd, screeningAnswers: [] };
  const result = await submitLinkedIn(opportunity, pkg, {
    dryRun: args["dry-run"] === "true",
    resumeFilename: path.basename(cvDocxPath),
    screenshotDir: args["screenshot-dir"],
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : result.needsManual ? 1 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
