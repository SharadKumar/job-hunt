#!/usr/bin/env tsx
/**
 * seek-submit.ts — SEEK Quick Apply submission.
 *
 * Drives the signed-in "seek" Chrome profile (state/channels/chrome-profile/seek)
 * through SEEK's Quick Apply wizard for one opportunity:
 *
 *   1. /job/<id>/apply                    Choose documents (stored resumé by exact
 *                                         filename + "Write a cover letter" textarea)
 *   2. /job/<id>/apply/role-requirements  Employer questions (optional)
 *   3. /job/<id>/apply/profile            Update SEEK Profile (just Continue)
 *   4. /job/<id>/apply/review             Review and submit (verify resumé filename,
 *                                         tick a required privacy checkbox, Submit)
 *   5. /job/<id>/apply/success            "Your application has been sent to <advertiser>"
 *
 * Ads whose Apply link leaves the SEEK domain (applr.io, JobAdder,
 * SuccessFactors, ...) are returned as needsManual without touching anything.
 *
 * Screening questions come from state/profile/screening-answers.yaml. Each
 * entry under `answers:` has:
 *
 *   id:       stable identifier
 *   patterns: case-insensitive regexes matched against the question label;
 *             the first entry with any pattern match owns the question
 *   answer:   free-text answer, used for textarea / text-input questions
 *   select:   OPTIONAL ordered list of case-insensitive regexes matched against
 *             the option labels of a select / radio / checkbox question. The
 *             first option matching any regex (in list order) is chosen. When
 *             an entry has no `select`, the built-in defaults below apply.
 *
 * Built-in option defaults (used when no entry, or the entry has no `select`):
 *   right to work            → /australian citizen/i
 *   "how many years ..."     → /more than 5 years|10\+|more than 10/i
 *   notice period            → /1 week/i
 *   security clearance       → /no, ability to obtain|able to obtain|eligible/i
 *   privacy-policy consent   → /yes|agree/i, or tick the checkbox
 *
 * Any question with no confident answer stops the run BEFORE Continue and is
 * returned as `newScreeningQuestion` so the user can add it to the YAML.
 *
 * Safety: this module performs an irreversible external action. It must only
 * be invoked from an attended /apply or /submit-approved flow via
 * tools/submission-gate.ts. `--dry-run` walks the wizard to the review page,
 * verifies the resumé, screenshots it and never clicks Submit.
 *
 * CLI:
 *   tsx tools/channels/seek-submit.ts --id <opportunityId> --resume-file <path.docx> \
 *     --cover-letter <path.md> [--dry-run] [--screenshot-dir <dir>]
 *   exit 0 = ok, 1 = needsManual, 2 = error
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { BrowserContext, Page } from "playwright";
import type { SubmitPackage, SubmitResult } from "./_interface.ts";
import { load as loadPipeline, type Opportunity } from "../pipeline.ts";
import { repoPath } from "../repo-root.ts";
import { openChromeContext } from "./_browser.ts";

export type SubmitSeekOptions = {
  dryRun?: boolean;
  /** Exact stored-resumé filename as SEEK lists it (e.g. Jane-Citizen_Delivery-Manager.docx). */
  resumeFilename: string;
  screenshotDir?: string;
  /** Per-step timeout in ms (default 20s). */
  stepTimeoutMs?: number;
};

export type ScreeningEntry = {
  id: string;
  patterns: string[];
  answer?: string | null;
  select?: string[];
};

export type PageQuestion = {
  kind: "select" | "radio" | "checkbox" | "text";
  /** Question label (legend / label text). */
  label: string;
  /** Locator hints. For select/text: element id or name. For radio/checkbox: per-option ids. */
  id: string;
  name: string;
  options: { label: string; id: string }[];
  required: boolean;
};

export type QuestionDecision =
  | { kind: "option"; option: { label: string; id: string } }
  | { kind: "text"; answer: string }
  | { kind: "unmatched" };

const SEEK_HOST = /(^|\.)seek\.com(\.au)?$/i;
const DEFAULT_STEP_TIMEOUT = 20_000;

// ---------------------------------------------------------------------------
// Screening answers
// ---------------------------------------------------------------------------

export async function loadScreeningAnswers(file = repoPath("state/profile/screening-answers.yaml")): Promise<ScreeningEntry[]> {
  const raw = YAML.parse(await fs.readFile(file, "utf8"));
  const answers = Array.isArray(raw?.answers) ? raw.answers : [];
  const entries: ScreeningEntry[] = answers
    .filter((a: any) => a && a.id && Array.isArray(a.patterns))
    .map((a: any) => ({
      id: String(a.id),
      patterns: a.patterns.map(String),
      answer: a.answer == null ? null : String(a.answer),
      select: Array.isArray(a.select) ? a.select.map(String) : undefined,
    }));
  // An unknown question the user has since answered becomes an exact-match
  // entry, so the paused application resumes on the next run without anyone
  // re-keying it into `answers`.
  const unknowns = Array.isArray(raw?.unknown_questions) ? raw.unknown_questions : [];
  for (const u of unknowns) {
    if (!u || typeof u.question !== "string" || u.answer == null || String(u.answer).trim() === "") continue;
    const exact = "^" + String(u.question).replace(/\s+/g, " ").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
    entries.push({ id: `unknown:${u.opportunity_id ?? "any"}`, patterns: [exact], answer: String(u.answer), select: Array.isArray(u.select) ? u.select.map(String) : undefined });
  }
  return entries;
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, "i");
  } catch {
    return null;
  }
}

export function matchScreeningEntry(label: string, entries: ScreeningEntry[]): ScreeningEntry | undefined {
  const text = label.replace(/\s+/g, " ").trim();
  return entries.find((e) => e.patterns.some((p) => safeRegex(p)?.test(text)));
}

const BUILT_IN_OPTION_RULES: { label: RegExp; option: RegExp }[] = [
  { label: /right to work|work rights|eligib\w* to work|work in australia/i, option: /australian citizen/i },
  { label: /how many years|years['’]? (of )?experience|years.{0,30}experience/i, option: /more than 5 years|10\+|more than 10/i },
  { label: /notice/i, option: /1 week/i },
  { label: /clearance/i, option: /no, ability to obtain|able to obtain|eligible/i },
  { label: /privacy policy|privacy statement|privacy notice|terms and conditions/i, option: /^(yes|i agree|agree|accept)/i },
];

/** Options SEEK uses as placeholders in native selects. */
function isPlaceholderOption(label: string): boolean {
  return /^(select|choose|please select|-+|—)/i.test(label.trim()) || !label.trim();
}

/**
 * Pure decision: what to do for one question given the YAML entries.
 * Exported so the matching logic can be unit tested without a browser.
 */
export function decideQuestion(question: PageQuestion, entries: ScreeningEntry[]): QuestionDecision {
  const entry = matchScreeningEntry(question.label, entries);
  if (question.kind === "text") {
    const answer = entry?.answer?.trim();
    if (answer && !/^TODO\b/i.test(answer)) return { kind: "text", answer };
    return { kind: "unmatched" };
  }
  const options = question.options.filter((o) => !isPlaceholderOption(o.label));
  if (!options.length) return { kind: "unmatched" };

  const pick = (regexes: RegExp[]): { label: string; id: string } | undefined => {
    for (const re of regexes) {
      const hit = options.find((o) => re.test(o.label));
      if (hit) return hit;
    }
    return undefined;
  };

  if (entry?.select?.length) {
    const regexes = entry.select.map(safeRegex).filter((r): r is RegExp => !!r);
    const hit = pick(regexes);
    if (hit) return { kind: "option", option: hit };
    // An explicit select list that matches nothing is not confident.
    return { kind: "unmatched" };
  }

  for (const rule of BUILT_IN_OPTION_RULES) {
    if (!rule.label.test(question.label)) continue;
    const hit = pick([rule.option]);
    if (hit) return { kind: "option", option: hit };
  }

  // A single-checkbox consent ("Do you agree to the privacy policy of X?") has
  // one option whose label may be the question itself: tick it.
  if (question.kind === "checkbox" && options.length === 1 && /privacy|agree|consent/i.test(`${question.label} ${options[0].label}`)) {
    return { kind: "option", option: options[0] };
  }

  // Yes / No questions (2026-09-15). SEEK employer questions are mostly binary
  // and predictable; answer them from the profile rather than parking the
  // application. Anything outside these shapes stays unmatched.
  const yes = options.find((o) => /^yes\b/i.test(o.label));
  const no = options.find((o) => /^no\b/i.test(o.label));
  if (yes && no) {
    const label = question.label.replace(/\s+/g, " ").replace(/\s+\?/g, "?").trim();
    // Clearance held? The profile holds none: always No (eligibility is stated elsewhere).
    if (/(hold|have|possess|currently).{0,40}(security clearance|baseline|nv1|nv2|tspv|clearance)/i.test(label)) return { kind: "option", option: no };
    // Integrity / conflict questions: always No.
    if (/close personal relationship|related to (an|any) (existing )?employee|family member|conflict of interest|previously (worked|been employed|applied)|currently employed by|criminal|convict|bankrupt|disqualif|sponsorship/i.test(label)) return { kind: "option", option: no };
    // Named product or platform experience: Yes only when the profile's taxonomy knows the term.
    const m = label.match(/experience (?:working |delivering |in |with |of |using |on )+(?:the )?(.+?)\??$/i);
    if (m) {
      const subject = m[1];
      if (/enterprise[- ]wide|transformation|program|programme|agile|scrum|stakeholder|vendor|government|regulated|delivery|architecture|integration|cloud|microsoft|azure|servicenow|salesforce|mulesoft|sharepoint|m365|office 365|ai|generative|llm|jira|confluence/i.test(subject)
          && !/civica|pega|sap\b|workday|guidewire|maximo|snowflake|dynamics|oracle|boomi|datastage|kubernetes|terraform|golang|python|java\b|\.net|c#/i.test(subject)) return { kind: "option", option: yes };
      return { kind: "option", option: no };
    }
    // Willingness / availability: Yes.
    if (/willing|able to|comfortable|available|can you (work|attend|travel|start)|happy to|prepared to|open to/i.test(label)) return { kind: "option", option: yes };
    // "Have you worked in a role that requires X" / "Have you managed X": Yes when X is a core capability.
    if (/have you (worked|held|managed|led|delivered|run)/i.test(label)
        && /software development lifecycle|sdlc|agile|delivery|architecture|integration|transformation|stakeholder|vendor|government|decommission|implementation|cloud|microsoft|servicenow|salesforce|sharepoint|m365|ai\b/i.test(label)
        && !/civica|pega|sap\b|workday|guidewire|maximo|snowflake|dynamics|oracle|boomi|datastage|kubernetes|terraform/i.test(label)) return { kind: "option", option: yes };
  }
  // Police / background checks: prefer the "willing to undertake" option; never claim a current certificate.
  if (/police|background check|working with children/i.test(question.label)) {
    const willing = options.find((o) => /willing|happy to|undertake|obtain/i.test(o.label));
    if (willing) return { kind: "option", option: willing };
  }
  return { kind: "unmatched" };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

function jobIdFromUrl(url: string): string | undefined {
  return url.match(/\/job\/(\d+)/)?.[1];
}

export function classifyApplyStep(url: string): "documents" | "role-requirements" | "profile" | "review" | "success" | "external" | "unknown" {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unknown";
  }
  if (!SEEK_HOST.test(u.hostname)) return "external";
  const p = u.pathname.replace(/\/+$/, "");
  if (/\/apply\/role-requirements$/.test(p)) return "role-requirements";
  if (/\/apply\/profile$/.test(p)) return "profile";
  if (/\/apply\/review$/.test(p)) return "review";
  if (/\/apply\/success$/.test(p)) return "success";
  if (/\/job\/\d+\/apply$/.test(p)) return "documents";
  return "unknown";
}

/** Cover letters are authored as markdown; SEEK's textarea wants plain text. */
export function coverLetterToPlainText(md: string): string {
  let text = md.replace(/\r\n/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");            // front matter
  text = text.replace(/^#{1,6}\s+/gm, "");                     // headings
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");         // links
  text = text.replace(/^\s*[-*]\s+/gm, "- ");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

async function screenshot(page: Page, dir: string | undefined, name: string): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (e) {
    console.error(`[seek-submit] screenshot failed: ${(e as Error).message.slice(0, 120)}`);
    return undefined;
  }
}

async function clickContinue(page: Page, timeout: number): Promise<void> {
  const before = page.url();
  const btn = page.getByRole("button", { name: /^continue$/i }).first();
  await btn.waitFor({ state: "visible", timeout });
  await btn.click();
  await page.waitForURL((u) => u.href !== before, { timeout });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);
}

/**
 * Enumerate the questions on the role-requirements step. Runs as a string in
 * the page realm (tsx may inject `__name` helpers into transpiled callbacks,
 * which do not exist in the browser).
 */
const DISCOVER_QUESTIONS_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const textOfIds = (ids) => clean(ids.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ""; }).join(" "));
  const labelFor = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.innerText); }
    const lb = el.getAttribute("aria-labelledby"); if (lb) { const t = textOfIds(lb); if (t) return t; }
    const al = el.getAttribute("aria-label"); if (al) return clean(al);
    const wrap = el.closest("label"); if (wrap) return clean(wrap.innerText);
    return "";
  };
  const groupLabel = (el) => {
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend"); if (lg) return clean(lg.innerText);
      const lb = fs.getAttribute("aria-labelledby"); if (lb) return textOfIds(lb);
    }
    const grp = el.closest('[role="group"],[role="radiogroup"]');
    if (grp) {
      const lb = grp.getAttribute("aria-labelledby"); if (lb) return textOfIds(lb);
      const al = grp.getAttribute("aria-label"); if (al) return clean(al);
    }
    return "";
  };
  const isRequired = (el) => el.required || el.getAttribute("aria-required") === "true" || /\\*|required/i.test(groupLabel(el) + labelFor(el));
  const out = [];
  document.querySelectorAll("select").forEach((s) => {
    out.push({ kind: "select", label: labelFor(s) || groupLabel(s), id: s.id || "", name: s.name || "", required: isRequired(s),
      options: Array.from(s.options).map((o) => ({ label: clean(o.textContent), id: o.value })) });
  });
  const groups = new Map();
  document.querySelectorAll('input[type="checkbox"],input[type="radio"]').forEach((i) => {
    const key = i.type + ":" + (i.name || groupLabel(i) || i.id);
    if (!groups.has(key)) groups.set(key, { kind: i.type, label: groupLabel(i), id: "", name: i.name || "", required: isRequired(i), options: [] });
    const g = groups.get(key);
    g.options.push({ label: labelFor(i), id: i.id || "" });
    if (!g.label) g.label = labelFor(i);
  });
  for (const g of groups.values()) out.push(g);
  document.querySelectorAll('textarea,input[type="text"],input[type="number"]').forEach((t) => {
    out.push({ kind: "text", label: labelFor(t) || groupLabel(t), id: t.id || "", name: t.name || "", required: isRequired(t), options: [] });
  });
  return out;
})()`;

async function discoverQuestions(page: Page): Promise<PageQuestion[]> {
  const raw = (await page.evaluate(DISCOVER_QUESTIONS_JS)) as PageQuestion[];
  return raw.filter((q) => q.label);
}

async function applyDecision(page: Page, q: PageQuestion, d: QuestionDecision, timeout: number): Promise<void> {
  if (d.kind === "unmatched") throw new Error(`unmatched question: ${q.label}`);
  if (d.kind === "text") {
    const loc = q.id ? page.locator(`#${cssEscape(q.id)}`) : page.getByLabel(q.label).first();
    await loc.waitFor({ state: "visible", timeout });
    await loc.fill(d.answer);
    return;
  }
  if (q.kind === "select") {
    const loc = q.id ? page.locator(`select#${cssEscape(q.id)}`) : q.name ? page.locator(`select[name="${q.name}"]`) : page.getByLabel(q.label).first();
    await loc.waitFor({ state: "attached", timeout });
    await loc.selectOption({ label: d.option.label });
    return;
  }
  // radio / checkbox: prefer the input id, fall back to the accessible name.
  const role = q.kind === "radio" ? "radio" : "checkbox";
  const input = d.option.id ? page.locator(`#${cssEscape(d.option.id)}`) : page.getByRole(role, { name: d.option.label }).first();
  const checked = await input.isChecked().catch(() => false);
  if (checked) return;
  try {
    await input.check({ timeout: Math.min(timeout, 5_000) });
  } catch {
    // SEEK styles its inputs off-screen; clicking the label works when the input cannot be clicked.
    const label = d.option.id ? page.locator(`label[for="${d.option.id}"]`) : page.getByText(d.option.label, { exact: true }).first();
    await label.click({ timeout });
  }
}

function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

async function selectRadioByLabel(page: Page, name: string | RegExp, timeout: number): Promise<void> {
  const radio = page.getByRole("radio", { name }).first();
  await radio.waitFor({ state: "attached", timeout });
  if (await radio.isChecked().catch(() => false)) return;
  try {
    await radio.check({ timeout: Math.min(timeout, 5_000) });
  } catch {
    await page.getByText(name).first().click({ timeout });
  }
  if (!(await radio.isChecked().catch(() => false))) throw new Error(`could not select radio "${String(name)}"`);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

export async function submitSeek(opportunity: Opportunity, pkg: SubmitPackage, opts: SubmitSeekOptions): Promise<SubmitResult> {
  const jobId = jobIdFromUrl(opportunity.url);
  if (!jobId) return { ok: false, reason: `cannot derive SEEK job id from url ${opportunity.url}`, needsManual: true };
  if (!opts?.resumeFilename) return { ok: false, reason: "resumeFilename is required", needsManual: true };
  const timeout = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT;
  const shotDir = opts.screenshotDir;
  const entries = await loadScreeningAnswers();
  const coverLetter = coverLetterToPlainText(pkg.coverLetterMd);

  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  const fail = async (reason: string, extra: Partial<Extract<SubmitResult, { ok: false }>> = {}): Promise<SubmitResult> => {
    const shot = page ? await screenshot(page, shotDir, `${opportunity.id}-error.png`) : undefined;
    console.error(`[seek-submit] ${opportunity.id}: ${reason}${shot ? ` (screenshot ${shot})` : ""}`);
    return { ok: false, reason, needsManual: true, ...extra };
  };

  try {
    ctx = await openChromeContext("seek", { headless: true });
    page = await ctx.newPage();
    await page.goto(`https://www.seek.com.au/job/${jobId}/apply`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1000);

    let host = "";
    try {
      host = new URL(page.url()).hostname;
    } catch {}
    if (!SEEK_HOST.test(host)) {
      console.error(`[seek-submit] ${opportunity.id}: apply link left SEEK → ${host}`);
      return { ok: false, needsManual: true, reason: `external ATS: ${host}` };
    }
    if (/sign in|log in/i.test(await page.title()) || /\/oauth|\/login/i.test(page.url())) {
      return fail("SEEK session is signed out; re-run npm run login:seek");
    }

    const bodyText = async () => (await page!.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/already applied|you(?:'|’)ve applied|application (?:was )?already/i.test(await bodyText()) && classifyApplyStep(page.url()) !== "documents") {
      return fail("SEEK reports this application was already submitted");
    }

    for (let hop = 0; hop < 8; hop++) {
      const step = classifyApplyStep(page.url());
      console.error(`[seek-submit] ${opportunity.id}: step=${step} url=${page.url()}`);
      switch (step) {
        case "external":
          return { ok: false, needsManual: true, reason: `external ATS: ${new URL(page.url()).hostname}` };

        case "documents": {
          // Resumé: always select by exact filename; SEEK remembers the last used one.
          const resumeRadio = page.getByRole("radio", { name: opts.resumeFilename });
          if ((await resumeRadio.count()) === 0) {
            await page.getByRole("radio").first().waitFor({ state: "attached", timeout }).catch(() => {});
            if ((await resumeRadio.count()) === 0) {
              const listed = await page.getByRole("radio").evaluateAll((els: any[]) =>
                els.map((e) => e.getAttribute("aria-label") || (e.labels && e.labels[0] ? e.labels[0].innerText : "") || e.value).filter(Boolean));
              return fail(`stored resumé "${opts.resumeFilename}" not offered on SEEK (listed: ${listed.join(" | ") || "none"})`);
            }
          }
          await selectRadioByLabel(page, opts.resumeFilename, timeout);

          await selectRadioByLabel(page, /write a cover letter/i, timeout);
          const textarea = page.locator("textarea").first();
          await textarea.waitFor({ state: "visible", timeout });
          // fill() replaces the remembered previous letter wholesale.
          await textarea.fill(coverLetter);
          const typed = (await textarea.inputValue()).trim();
          if (typed.slice(0, 40) !== coverLetter.slice(0, 40)) return fail("cover letter textarea did not accept the letter");
          await clickContinue(page, timeout);
          break;
        }

        case "role-requirements": {
          const questions = await discoverQuestions(page);
          console.error(`[seek-submit] ${opportunity.id}: ${questions.length} employer question(s)`);
          for (const q of questions) {
            const decision = decideQuestion(q, entries);
            if (decision.kind === "unmatched") {
              const context = q.options.filter((o) => !isPlaceholderOption(o.label)).map((o) => o.label).join(" | ");
              await screenshot(page, shotDir, `${opportunity.id}-error.png`);
              console.error(`[seek-submit] ${opportunity.id}: no confident answer for "${q.label}"`);
              return {
                ok: false,
                needsManual: true,
                reason: `new screening question: ${q.label}`,
                newScreeningQuestion: { text: q.label, context: context || q.kind },
              };
            }
            console.error(`[seek-submit] ${opportunity.id}:   "${q.label}" → ${decision.kind === "text" ? "text" : decision.option.label}`);
            await applyDecision(page, q, decision, timeout);
          }
          await clickContinue(page, timeout);
          break;
        }

        case "profile":
          await clickContinue(page, timeout);
          break;

        case "review": {
          const text = await bodyText();
          if (!text.includes(opts.resumeFilename)) {
            return fail(`review page does not list resumé "${opts.resumeFilename}" under Documents included`);
          }
          // Employer privacy consent, when present, is required before Submit.
          const consent = page.getByRole("checkbox", { name: /privacy/i });
          if ((await consent.count()) > 0 && !(await consent.first().isChecked())) {
            try {
              await consent.first().check({ timeout: 5_000 });
            } catch {
              await page.getByText(/privacy policy/i).first().click({ timeout });
            }
          }
          if (opts.dryRun) {
            const shot = await screenshot(page, shotDir, `${opportunity.id}-review.png`);
            console.error(`[seek-submit] ${opportunity.id}: DRY RUN, review page verified, not submitting`);
            return { ok: true, confirmationRef: "DRY RUN: review page verified", screenshotPath: shot };
          }
          const submit = page.getByRole("button", { name: /^submit application$/i }).first();
          await submit.waitFor({ state: "visible", timeout });
          await submit.click();
          await page.waitForURL(/\/apply\/success/, { timeout: 45_000 });
          await page.waitForLoadState("domcontentloaded");
          await page.waitForTimeout(1000);
          break;
        }

        case "success": {
          const text = await bodyText();
          const sent = text.match(/Your application has been sent to [^.]+?(?=\.|\s{2,}|$)/i)?.[0]
            ?? text.match(/Nice work[^.]*/i)?.[0]
            ?? "SEEK application submitted";
          const shot = await screenshot(page, shotDir, `${opportunity.id}-success.png`);
          console.error(`[seek-submit] ${opportunity.id}: ${sent}`);
          return { ok: true, confirmationRef: sent.trim(), screenshotPath: shot };
        }

        default: {
          const text = await bodyText();
          if (/already applied|you(?:'|’)ve applied/i.test(text)) return fail("SEEK reports this application was already submitted");
          return fail(`unexpected page at ${page.url()}: ${text.slice(0, 160)}`);
        }
      }
    }
    return fail(`wizard did not reach review/success within 8 steps (last url ${page.url()})`);
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
  const usage = "Usage: tsx tools/channels/seek-submit.ts --id <opportunityId> --resume-file <path.docx> --cover-letter <path.md> [--dry-run] [--screenshot-dir <dir>]";
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
  if (opportunity.channel !== "seek") {
    console.error(`opportunity ${args.id} is on channel ${opportunity.channel}, not seek`);
    process.exit(2);
  }
  const cvDocxPath = args["resume-file"];
  await fs.access(cvDocxPath);
  const coverLetterMd = await fs.readFile(args["cover-letter"], "utf8");
  const pkg: SubmitPackage = { cvDocxPath, coverLetterMd, screeningAnswers: [] };
  const result = await submitSeek(opportunity, pkg, {
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
