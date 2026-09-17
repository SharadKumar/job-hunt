/**
 * resume-index renderer: every byte of HTML the binder page is made of.
 *
 * Consumes the model built in `model.ts`, says it in the words `vocabulary.ts`
 * chooses, and wraps the result in the stylesheet from `css.ts` and the
 * browser script from `script.ts`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { CSS } from "./css.ts";
import { SCRIPT } from "./script.ts";
import {
  buildResumeIndexModel,
  escapeHtml,
  termChips,
  type CheckMark,
  type KeywordCloudRow,
  type ResumeCard,
  type ResumeIndexModel,
  type TermChip,
} from "./model.ts";
import {
  gateLabel,
  joinList,
  longDate,
  nextMove,
  pageCountOf,
  readinessSentences,
  railState,
  shortHumanDate,
  stateClass,
  upperFirst,
  verdictWords,
  words,
} from "./vocabulary.ts";

/**
 * Design plan — a binder of CVs, opened flat on a dark desk.
 *
 * The subject is one person's set of positionings. A binder makes that literal:
 * physical index tabs down the left edge, one per positioning, and an open
 * spread to their right. Left page is the printed brief (what this CV is, what
 * state it is in, what to do next). Right page is the PDF itself, shown in the
 * browser's own viewer with the viewer's own toolbar, because that toolbar
 * already does zoom, paging, print and download better than anything drawn
 * here. Nothing in this page tries to page the PDF: no chevrons, no thumbnail
 * gallery, no page in the hash.
 *
 * Palette. Desk #14213D (deep ink blue), paper #FFFFFF, ink #1A1D23, muted
 * #6B7280, hairline #E4E6EA. State colours are the only other ink: approved
 * green #2E7D32, needs attention amber #F0A202, inactive grey #9AA0A6, failure
 * red #C0392B. No gradients. Every shadow is hard and offset (blur 0), so the
 * pages read as paper lying on a dark table rather than as floating cards.
 *
 * Type. One geometric sans family throughout: "Avenir Next", Avenir,
 * "Helvetica Neue", Inter, system-ui. Two weights, 400 and 600. Four sizes,
 * 13 / 15 / 18 / 28. Left aligned, sentence case. No all-caps labels, no
 * tracked-out headings, no middle dots, no em dashes, no arrows.
 *
 * Layout.
 *
 *   +----+--------------------------+--------------------------------+
 *   | na |  brief page  34%, 380min |  pdf page, rest of the width   |
 *   | me |                          |  +--------------------------+  |
 *   |    |  Positioning name  28px  |  | viewer toolbar           |  |
 *   |[Bi]|  [ Approved 10 Sep ]     |  +--------------------------+  |
 *   |[nd]|  fill bars  88%   95%    |  |                          |  |
 *   |[er]|  Next, approve it.       |  |                          |  |
 *   |    |  ----------------------  |  |   the rendered CV, at    |  |
 *   |[ta]|  Gates | Review | Terms  |  |   page width, scrolled    |  |
 *   |[b ]|                          |  |   by the viewer itself   |  |
 *   |[ta]|  the chosen panel        |  |                          |  |
 *   |[b ]|                          |  |                          |  |
 *   |[ta]|  ----------------------  |  |                          |  |
 *   |[b ]|  Files, icons with       |  |                          |  |
 *   |    |  captions under them     |  |                          |  |
 *   |    |  source cv, rules, ...   |  +--------------------------+  |
 *   +----+--------------------------+--------------------------------+
 *
 * The selected tab is flush with the open page; the others sit a few pixels
 * back with an offset shadow, like tabs behind the open sheet. Tab text is the
 * positioning label rotated (writing-mode: vertical-rl). Hover or focus slides
 * a tab 4px towards the page, the one piece of motion on the screen, disabled
 * under prefers-reduced-motion.
 *
 * Interaction. Up and Down move between tabs and select as they go; Tab and
 * Enter do the same through native button semantics. That works because focus
 * never enters the iframe. Routing is `#<id>` and `#binder` only, pushState, so
 * browser back and forward retrace positionings. Landing view is the last
 * positioning read (localStorage) else the first active one.
 *
 * Overview. The "Binder" tab at the top of the column closes the binder: the
 * desk with every positioning as a small white sheet, coloured tab attached to
 * its left edge. The heading is the person's name, taken from the profile, over
 * the same lede. On each sheet the positioning label reads first, as the
 * sheet's own heading, then the preview of page one, then the stamp, the fill
 * bars and the marks in one row. The preview is tall enough (420px, cropped
 * from the top) to read the opening of the CV. Three sheets to a row on a wide
 * desk, two below 900px, one below 600px.
 *
 * Responsive. Below 960px the tabs become a horizontal strip of short tabs
 * above the content, the brief stacks above the PDF, and the viewer takes 80vh.
 *
 * Principles.
 *   1. The PDF is the product. Everything else is marginalia around it.
 *   2. Say it once. The stamp says the approval, the marks say the verdicts,
 *      the readiness line says the next move. No value appears twice.
 *   3. One panel, three ways in: Gates, Review, Terms. The eight marks keep
 *      their fixed order, and the panel remembers which tab you left open.
 *   4. Plain verbs and the command to run when something is missing.
 *   5. No personal detail lives in this file. The name comes from the profile.
 */

/* ------------------------------------------------------------------- html */

/** Proofreader's marks: tick, tilde, cross, ring. Drawn, never a pill. */
const MARKS: Record<CheckMark["verdict"], string> = {
  pass: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 7.5 5.5 11 12 3"/></svg>`,
  warn: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 8c1.5-3 3.5-3 5 0s3.5 3 5 0"/></svg>`,
  fail: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>`,
  skip: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.5"/></svg>`,
};

/**
 * The viewer fragment. The built-in toolbar and panes are off and the page
 * opens at page width, so there is no page number in the URL and nothing here
 * to keep in sync with it. Download and print live in the brief's Files row
 * instead, since the toolbar that would otherwise offer them is hidden.
 */
export function pdfSrcFor(href: string): string {
  return `${href}#toolbar=0&navpanes=0&zoom=page-width`;
}

function stampHtml(card: ResumeCard, extraClass = "stamp"): string {
  return `<span class="${extraClass} state-${card.stamp.kind}">${escapeHtml(card.stamp.text)}</span>`;
}

/** The tab column: the name, the binder tab, then one tab per positioning. */
function tabsHtml(model: ResumeIndexModel, selectedId: string): string {
  const tabs = model.cards.map((card) => {
    const selected = card.id === selectedId;
    return `<button type="button" role="tab" class="tab ${stateClass(card)}" data-resume="${escapeHtml(card.id)}"`
      + ` aria-selected="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}"`
      + ` title="${escapeHtml(railState(card))}${card.active ? "" : ", not active"}">`
      + `<span class="tab-label">${escapeHtml(card.label)}</span></button>`;
  }).join("");

  return `<nav class="tabs" role="tablist" aria-label="Positionings" aria-orientation="vertical">`
    + `<p class="who">${escapeHtml(model.profileName)}</p>`
    + `<button type="button" role="tab" class="tab tab-binder" data-view="binder" aria-selected="false" tabindex="-1">`
    + `<span class="tab-label">Binder</span></button>`
    + tabs
    + `</nav>`;
}

/**
 * The header: state at a glance. The positioning name and the approval stamp
 * on one line, the page-fill bars under them, and the single next move as one
 * sentence. The sentence about the shape of the paper is what the bars draw,
 * so it is their label rather than a second line of prose.
 */
function headHtml(card: ResumeCard): string {
  const sentences = readinessSentences(card);
  const shape = sentences.length > 1 ? sentences[0] : "";
  const next = sentences[sentences.length - 1] ?? "";
  const bars = fillsHtml(card, 4, shape);
  return `<header class="brief-head">`
    + `<div class="brief-headline"><h1 class="brief-title">${escapeHtml(card.label)}</h1>${stampHtml(card)}</div>`
    + (card.active ? "" : `<p class="brief-note">Not active in resumes.yaml.</p>`)
    + (bars || (shape ? `<p class="brief-next">${escapeHtml(shape)}</p>` : ""))
    + (next ? `<p class="brief-next">${escapeHtml(next)}</p>` : "")
    + `</header>`;
}

/** The composition bar: featured, mentioned and dropped roles as one segment each. */
function shapeHtml(card: ResumeCard): string {
  const featured = card.counts.featured ?? 0;
  const mentioned = card.counts.mentioned ?? 0;
  const dropped = card.counts.dropped ?? 0;
  const total = featured + mentioned + dropped;
  if (!total) return "";
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  const bits = [`${words(featured)} featured`, `${words(mentioned)} mentioned`, dropped ? `${words(dropped)} dropped` : "none dropped"];
  const unsupported = card.counts.unsupported_claims ?? 0;
  if (unsupported > 0) bits.push(`${words(unsupported)} unsupported ${unsupported === 1 ? "claim" : "claims"}`);
  if (card.failCount > 0) bits.push(`${words(card.failCount)} ${card.failCount === 1 ? "failure" : "failures"}`);
  if (card.warnCount > 0) bits.push(`${words(card.warnCount)} ${card.warnCount === 1 ? "warn" : "warns"}`);
  return `<div class="shape-bar" aria-hidden="true">`
    + `<span class="featured" style="width:${pct(featured)}"></span>`
    + `<span class="mentioned" style="width:${pct(mentioned)}"></span>`
    + `<span class="dropped" style="width:${pct(dropped)}"></span>`
    + `</div>`
    + `<p class="shape-line">${escapeHtml(upperFirst(joinList(bits)))}.</p>`;
}

/** The one panel: Gates, Review and Terms behind three small tabs. */
function checksHtml(card: ResumeCard): string {
  // Preserve's reason is the featured / mentioned / dropped tally, which the
  // Pages section already prints under its composition bar. One of the two.
  const composed = (card.counts.featured ?? 0) + (card.counts.mentioned ?? 0) + (card.counts.dropped ?? 0) > 0;
  const rows = card.checks.map((check) => {
    // A tick already says nothing is wrong, so a passing check only earns a
    // reason when the reason carries something the tick does not.
    const spoken = check.reason === "nothing to fix" || check.reason === "pass"
      || (check.key === "preserve" && composed);
    const raw = check.reason && !spoken ? check.reason : null;
    const why = raw ?? (check.verdict === "pass" ? "" : verdictWords(check.verdict));
    return `<li class="mark mark-${check.verdict}">`
      + `<span class="mark-name">${MARKS[check.verdict]}${escapeHtml(check.label)}</span>`
      + `<span class="mark-why">${escapeHtml(why ? upperFirst(why) : "")}</span>`
      + `</li>`;
  }).join("");
  // The critic's words are the only thing in this section a machine did not
  // decide, and they run long. They sit behind a second tab so the tick column
  // stays compact and the sentence is still one click away.
  const findings = card.openFindings.length
    ? `<ul class="review-findings">${card.openFindings.map((f) => `<li>${escapeHtml(upperFirst(f))}</li>`).join("")}</ul>`
    : "";
  const summary = card.review.summary ? `<p class="review-summary">${escapeHtml(card.review.summary)}</p>` : "";
  const reviewBody = summary || findings
    ? `${summary}${findings}`
    : `<p class="brief-note">Not reviewed yet.</p>`;
  const openCount = card.openFindings.length;
  const reviewLabel = `Review${openCount ? ` (${openCount})` : ""}`;
  const paneId = `checks-${card.id}`;
  const tab = (key: string, label: string, selected: boolean) =>
    `<button type="button" role="tab" class="pane-tab" aria-selected="${selected ? "true" : "false"}"`
    + ` aria-controls="${escapeHtml(paneId)}-${key}" data-pane="${key}">${escapeHtml(label)}</button>`;
  const pane = (key: string, body: string, hidden: boolean) =>
    `<div class="pane" id="${escapeHtml(paneId)}-${key}" role="tabpanel" data-pane="${key}"${hidden ? " hidden" : ""}>${body}</div>`;
  return section("checks", "",
    `<div class="pane-set">`
    + `<div class="pane-tabs" role="tablist" aria-label="Checks">`
    + tab("gates", "Gates", true) + tab("review", reviewLabel, false) + tab("terms", "Terms", false)
    + `</div>`
    + pane("gates", `<ul class="marks">${rows}</ul>${shapeHtml(card)}`, false)
    + pane("review", reviewBody, true)
    + pane("terms", termsHtml(card), true)
    + `</div>`);
}

/** The sentence above the cloud bars: what landed, and what had to. */
export function coverageSummarySentence(plan: ResumeCard["keywordPlan"]): string | null {
  if (!plan) return null;
  const surfaced = plan.surfaced_total;
  const renderable = plan.renderable_total;
  if (surfaced == null || renderable == null || renderable === 0) return null;
  const familiarity = plan.familiarity_total ?? 0;
  const framed = familiarity ? `, ${familiarity} of them as familiarity` : "";
  const must = plan.must_have_surfaced != null && plan.must_have_renderable
    ? ` Must-have terms: ${plan.must_have_surfaced} of ${plan.must_have_renderable}.`
    : "";
  return `${surfaced} of ${renderable} source-backed terms appear in the CV${framed}.${must}`;
}

/** The three groups behind one cloud row, as short comma-separated lines. */
function cloudTermsHtml(c: KeywordCloudRow): string {
  const groups: Array<[string, string[]]> = [
    ["In the CV", c.terms.surfaced],
    ["Source-backed, not yet in the CV", c.terms.renderable],
    ["Not in the source", c.terms.absent],
  ];
  const lines = groups
    .filter(([, terms]) => terms.length)
    .map(([head, terms]) => `<p><span class="term-head">${escapeHtml(head)}:</span> ${escapeHtml(terms.join(", "))}</p>`)
    .join("");
  return lines || `<p>No terms in this cloud yet.</p>`;
}

/** "skills 4, experience 3, summary 1": where a cloud's surfaced terms sit. Zero places are left out. */
export function cloudWhereText(c: KeywordCloudRow): string {
  const parts: string[] = [];
  if (c.where.skills) parts.push(`skills ${c.where.skills}`);
  if (c.where.experience) parts.push(`experience ${c.where.experience}`);
  if (c.where.summary) parts.push(`summary ${c.where.summary}`);
  return parts.join(", ");
}

/** The Terms tab: the summary, the legend, then either view of the same terms. */
function termsHtml(card: ResumeCard): string {
  const sentence = coverageSummarySentence(card.keywordPlan);
  const viewId = `terms-${card.id}`;
  const toggle = `<div class="view-toggle" role="group" aria-label="Term view">`
    + `<button type="button" class="view-button" data-terms-view="clouds" aria-pressed="true"`
    + ` aria-controls="${escapeHtml(viewId)}-clouds">By cloud</button>`
    + `<button type="button" class="view-button" data-terms-view="used" aria-pressed="false"`
    + ` aria-controls="${escapeHtml(viewId)}-used">Used / not used</button>`
    + `</div>`;
  return `<div class="terms-set">`
    + (sentence ? `<p class="coverage-summary">${escapeHtml(sentence)}</p>` : "")
    + `<p class="coverage-legend">`
    + `<span><span class="swatch surfaced"></span>in the CV</span>`
    + `<span><span class="swatch renderable"></span>source-backed, not yet in the CV</span>`
    + `<span><span class="swatch absent"></span>not in the source</span>`
    + `</p>`
    + toggle
    + `<div class="terms-view" id="${escapeHtml(viewId)}-clouds" data-terms-view="clouds">${cloudsViewHtml(card)}</div>`
    + `<div class="terms-view" id="${escapeHtml(viewId)}-used" data-terms-view="used" hidden>${usedViewHtml(card)}</div>`
    + `</div>`;
}

/** One chip: the term, a dot when it is a must-have, a familiarity note when framed. */
function chipHtml(chip: TermChip, kind: string): string {
  return `<li><span class="chip chip-${kind}${chip.mustHave ? " is-must" : ""}"`
    + (chip.cloud ? ` title="${escapeHtml(chip.cloud)}"` : "")
    + `>`
    + (chip.mustHave ? `<span class="chip-dot" aria-hidden="true"></span>` : "")
    + escapeHtml(chip.term)
    + (chip.familiarity ? `<span class="chip-note">familiarity</span>` : "")
    + `</span></li>`;
}

/**
 * Used / not used: every renderable term in the plan as a chip, in two groups,
 * so the question "which terms did this CV actually carry" is answered without
 * opening a single cloud. What the source never had sits behind one quiet line.
 */
function usedViewHtml(card: ResumeCard): string {
  const { used, unused, absent } = termChips(card);
  if (!used.length && !unused.length && !absent.length) {
    return `<p class="brief-note">No named keyword terms in the plan yet.</p>`;
  }
  const group = (head: string, items: TermChip[], kind: string) =>
    `<div class="chip-group">`
    + `<p class="chip-head">${escapeHtml(head)}<span class="chip-count">${items.length}</span></p>`
    + (items.length ? `<ul class="chips">${items.map((c) => chipHtml(c, kind)).join("")}</ul>` : `<p class="brief-note">None.</p>`)
    + `</div>`;
  const panelId = `absent-${card.id}`;
  const more = absent.length
    ? `<button type="button" class="disclose" aria-expanded="false" aria-controls="${escapeHtml(panelId)}">`
      + `Not in the source: ${absent.length} ${absent.length === 1 ? "term" : "terms"}</button>`
      + `<div class="absent-panel" id="${escapeHtml(panelId)}" hidden>`
      + `<ul class="chips">${absent.map((c) => chipHtml(c, "gone")).join("")}</ul></div>`
    : "";
  return `<div class="chip-columns">`
    + group("In the CV", used, "used")
    + group("Not yet in the CV", unused, "unused")
    + `</div>${more}`;
}

/** By cloud: a bar per keyword cloud, the counts, and any open questions. */
function cloudsViewHtml(card: ResumeCard): string {
  if (card.keywordClouds.length) {
    const rows = card.keywordClouds.map((c) => {
      const total = Math.max(c.total, c.renderable, c.surfaced, 1);
      const pct = (n: number) => `${((Math.max(0, n) / total) * 100).toFixed(2)}%`;
      const amber = Math.max(0, Math.min(c.renderable, total) - c.surfaced);
      const panelId = `cloud-${card.id}-${c.id}`;
      const bar = `<span class="cloud-bar" aria-hidden="true">`
        + `<span class="surfaced" style="width:${pct(c.surfaced)}"></span>`
        + `<span class="renderable" style="width:${pct(amber)}"></span>`
        + `</span>`;
      return `<li class="cloud">`
        + `<button type="button" class="cloud-row" aria-expanded="false" aria-controls="${escapeHtml(panelId)}">`
        + `<span class="cloud-name">${escapeHtml(c.label)}<span class="cloud-weight">weight ${c.weight}</span></span>`
        + bar
        + `<span class="cloud-count">${c.surfaced} of ${c.total}</span>`
        + `<span class="cloud-where">${cloudWhereText(c)}</span>`
        + `</button>`
        + `<div class="cloud-terms" id="${escapeHtml(panelId)}" hidden>${cloudTermsHtml(c)}</div>`
        + `</li>`;
    }).join("");
    let body = `<ul class="clouds">${rows}</ul>`;
    if (card.openQuestions.length) {
      const n = card.openQuestions.length;
      body += `<p>${upperFirst(words(n))} open ${n === 1 ? "question" : "questions"} on the keyword plan.</p>`
        + `<ul class="questions">${card.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
    }
    return body;
  }
  const dots = card.keywordDots;
  const kind = card.keywordDotKind === "renderable" ? "renderable" : "must-have";
  let body: string;
  if (!dots.length) {
    body = `<p>No keyword terms in the plan yet.</p>`;
  } else {
    const surfaced = dots.filter((d) => d.state === "surfaced").length;
    const row = dots.map((d) => `<li class="${d.state}"${d.term ? ` title="${escapeHtml(d.term)}"` : ""}></li>`).join("");
    // A long row still gets one dot per term; the dots shrink so it stays two lines.
    const dense = dots.length > 40 ? " is-dense" : "";
    body = `<ul class="dots${dense}" aria-label="${upperFirst(kind)} keyword coverage">${row}</ul>`
      + `<p>${surfaced} of ${dots.length} ${kind} ${dots.length === 1 ? "term" : "terms"} surfaced.</p>`;
  }
  if (card.openQuestions.length) {
    const n = card.openQuestions.length;
    body += `<p>${upperFirst(words(n))} open ${n === 1 ? "question" : "questions"} on the keyword plan.</p>`
      + `<ul class="questions">${card.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
  }
  return body;
}

/** Fill bars: one per page, amber when the page misses its own floor. */
function fillsHtml(card: ResumeCard, limit = 4, label = ""): string {
  const pages = card.pages.slice(0, limit);
  if (!pages.length) return "";
  const bars = pages.map((page, i) => {
    const fill = Math.max(0, Math.min(100, page.fill ?? 0));
    const label = page.fill == null ? `Page ${i + 1}` : `Page ${i + 1}, filled to ${Math.round(page.fill)} percent`;
    return `<span class="fill" title="${escapeHtml(label)}">`
      + `<span class="fill-bar"><span class="${page.low ? "is-low" : ""}" style="width:${fill.toFixed(2)}%"></span></span>`
      + `<span class="fill-pct">${page.fill == null ? "" : `${Math.round(page.fill)}%`}</span>`
      + `</span>`;
  }).join("");
  const labelled = label ? ` role="img" aria-label="${escapeHtml(label)}"` : "";
  return `<div class="fills"${labelled}>${bars}</div>`;
}

/**
 * Icons for the Files row. Inline SVG, 24-unit box, stroked in the current
 * colour, drawn from Lucide (ISC licence) so the shapes read as the ones people
 * already know rather than as something invented here.
 */
const FILE_ICONS: Record<string, string> = {
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`,
  print: `<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>`,
  pdf: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>`,
  docx: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>`,
  html: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  md: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>`,
  composition: `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.48 1.59a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83L17.9 9.5"/><path d="m6.08 14.5-3.48 1.59a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.53-1.6"/>`,
  provenance: `<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
  audit: `<path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1Z"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>`,
  keyword_plan: `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><path d="M7.5 7.5h.01"/>`,
  metadata: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,
};

function iconSvg(key: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"`
    + ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${FILE_ICONS[key] ?? ""}</svg>`;
}

/**
 * The artefacts as an icon row: the two actions on the PDF, the four readable
 * formats, a hairline, then the working sidecars. Every icon carries its own
 * caption, so nothing here asks the reader to recognise a glyph cold.
 */
function filesHtml(card: ResumeCard): string {
  const readable: Array<[string, string]> = [
    ["pdf", "Open PDF"],
    ["docx", "Word"],
    ["html", "Web page"],
    ["md", "Markdown"],
  ];
  const sidecars: Array<[string, string]> = [
    ["composition", "Composition"],
    ["provenance", "Provenance"],
    ["audit", "Audit"],
    ["keyword_plan", "Keyword plan"],
    ["metadata", "Metadata"],
  ];
  const iconLink = (href: string, label: string, key: string, opts: { download?: boolean; quiet?: boolean } = {}) =>
    `<a class="file-icon${opts.quiet ? " is-quiet" : ""}" href="${escapeHtml(href)}"`
    + (opts.download ? " download" : ` target="_blank" rel="noopener"`)
    + ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">`
    + iconSvg(key)
    + `<span class="file-caption">${escapeHtml(label)}</span></a>`;

  const loud: string[] = [];
  // Two actions on the PDF itself lead the row: the viewer's own toolbar is
  // hidden, so this page has to offer the save and the print in its place.
  if (card.links.pdf) {
    loud.push(iconLink(card.links.pdf, "Download PDF", "download", { download: true }));
    loud.push(`<button type="button" class="file-icon file-action" data-print data-target="${escapeHtml(card.id)}"`
      + ` aria-label="Print" title="Print">${iconSvg("print")}<span class="file-caption">Print</span></button>`);
  }
  for (const [key, label] of readable) {
    if (card.links[key]) loud.push(iconLink(card.links[key]!, label, key));
  }
  const quiet = sidecars
    .filter(([key]) => card.links[key])
    .map(([key, label]) => iconLink(card.links[key]!, label, key, { quiet: true }));

  if (!loud.length && !quiet.length) return section("files", "", `<p>No files to open yet.</p>`, "Files");
  const divider = loud.length && quiet.length ? `<span class="file-divider" aria-hidden="true"></span>` : "";
  return section("files", "", `<div class="files">${loud.join("")}${divider}${quiet.join("")}</div>`, "Files");
}

function section(id: string, heading: string, body: string, label = ""): string {
  const attr = label ? ` aria-label="${escapeHtml(label)}"` : "";
  return `<section class="brief-section" data-section="${escapeHtml(id)}"${attr}>`
    + (heading ? `<h2>${escapeHtml(heading)}</h2>` : "") + body + `</section>`;
}

/** The left page: the printed brief for one positioning. */
function briefHtml(model: ResumeIndexModel, card: ResumeCard, current: boolean): string {
  const foot = model.headerLinks.length
    ? `<footer class="brief-foot">${model.headerLinks
        .map((l) => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`)
        .join("")}</footer>`
    : "";
  return `<section class="page brief" data-resume="${escapeHtml(card.id)}"${current ? "" : " hidden"}>`
    + headHtml(card)
    + checksHtml(card)
    + filesHtml(card)
    + foot
    + `</section>`;
}

/** The right page: the browser's own PDF viewer, toolbar and all. */
function pdfPageHtml(card: ResumeCard, current: boolean): string {
  const attrs = `class="page pdf-page" data-resume="${escapeHtml(card.id)}"${current ? "" : " hidden"}`;
  if (!card.links.pdf) {
    return `<section ${attrs}><p class="empty">No render yet. Run /resume-render ${escapeHtml(card.id)}.</p></section>`;
  }
  const src = pdfSrcFor(card.links.pdf);
  const srcAttr = current ? ` src="${escapeHtml(src)}"` : "";
  return `<section ${attrs}>`
    + `<iframe title="${escapeHtml(card.label)}, rendered CV" data-src="${escapeHtml(src)}"${srcAttr}></iframe>`
    + `</section>`;
}

/** The closed binder: every positioning as a sheet on the desk. */
function binderViewHtml(model: ResumeIndexModel, hidden: boolean): string {
  const sheets = model.cards.map((card) => {
    const first = card.pages[0]?.src ?? card.pngs[0] ?? null;
    const image = first
      ? `<img src="${escapeHtml(first)}" alt="" loading="lazy">`
      : `<span class="sheet-blank">No render yet</span>`;
    const marks = card.checks
      .map((c) => `<span class="mark-${c.verdict}" title="${escapeHtml(`${c.label}, ${verdictWords(c.verdict)}`)}">${MARKS[c.verdict]}</span>`)
      .join("");
    return `<button type="button" class="sheet ${stateClass(card)}" data-resume="${escapeHtml(card.id)}">`
      + `<span class="sheet-name">${escapeHtml(card.label)}</span>`
      + image
      + stampHtml(card, "sheet-stamp")
      + fillsHtml(card)
      + `<span class="sheet-marks">${marks}</span>`
      + `</button>`;
  }).join("");
  const active = model.cards.filter((c) => c.active).length;
  const lede = `${upperFirst(words(active))} active ${active === 1 ? "positioning" : "positionings"} of ${words(model.cards.length)}. Pick one to open it.`;
  return `<section class="binder-view" data-view="binder"${hidden ? " hidden" : ""}>`
    + `<h1>${escapeHtml(model.profileName)}</h1><p class="binder-lede">${escapeHtml(lede)}</p>`
    + `<div class="sheets">${sheets}</div>`
    + `</section>`;
}

function binderData(model: ResumeIndexModel, selectedId: string): string {
  const payload = {
    profileName: model.profileName,
    profileId: model.profileId,
    selected: selectedId,
    resumes: model.cards.map((card) => ({ id: card.id, label: card.label, pdf: card.links.pdf })),
  };
  // Keep the JSON inert inside <script>: no raw angle brackets or ampersands.
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function shell(title: string, body: string, tail = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
${tail}</body>
</html>
`;
}

export async function renderResumeIndexHtml(model: ResumeIndexModel): Promise<string> {
  const title = `${model.profileName}, resumes`;

  if (!model.cards.length) {
    return shell(title, `<div class="binder"><div class="spread"><section class="page brief">`
      + `<p class="empty">No positionings under ${escapeHtml(model.resumesDir)}. Run /onboarding to set some up.</p>`
      + `</section></div></div>`);
  }

  // Server-rendered landing: the first active positioning. The script swaps to
  // the last one read, or to whatever the hash asks for, as soon as it runs.
  const selected = (model.cards.find((c) => c.active) ?? model.cards[0]).id;
  const briefs = model.cards.map((card) => briefHtml(model, card, card.id === selected)).join("");
  const pages = model.cards.map((card) => pdfPageHtml(card, card.id === selected)).join("");

  const body = `<div class="binder">`
    + tabsHtml(model, selected)
    + `<div class="spread">${briefs}${pages}</div>`
    + binderViewHtml(model, true)
    + `</div>`;

  const tail = `<script type="application/json" id="binder-model">${binderData(model, selected)}</script>\n`
    + `<script>${SCRIPT}</script>\n`;
  return shell(title, body, tail);
}

/** Build the model, render it, write index.html. Returns the model. */
export async function writeResumeIndex(options: { profileId?: string | null; outPath?: string } = {}): Promise<ResumeIndexModel> {
  const model = await buildResumeIndexModel(options);
  await fs.mkdir(path.dirname(model.outPath), { recursive: true });
  await fs.writeFile(model.outPath, await renderResumeIndexHtml(model), "utf8");
  return model;
}
