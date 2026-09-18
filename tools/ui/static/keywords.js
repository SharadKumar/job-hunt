/*
 * keywords.js - the Resumes screen's "Evidence questions" tab: the keyword
 * ledger, as a list the person can walk down and answer.
 *
 * A pending term is the ledger asking whether a term the market wants is
 * actually true of this person, which is a question about their CV. The
 * Resumes screen draws the page header and hands its lede down, so
 * `viewKeywords` renders under that title when it is given one and draws its
 * own when it is not.
 *
 * The shape is the list row every other screen uses (the brief, section 7):
 * the term, where it came from on the meta line, and the four fixed answers as
 * four secondary buttons under it. One press records one term, so a decision
 * lands the moment it is made and the row leaves the list.
 *
 * AGENTS.md section 9: four fixed answers, verbatim, no default and no fifth.
 * A confirmed term authorises nothing on its own; the fact still has to be
 * written into the CV source, which is what the line under the list says.
 */

import {
  api, clear, errorBox, h, loadError, pageHeader, placeholderRows, render, toast,
} from "./app.js";

/* AGENTS.md section 9: four fixed answers and no others, recommended first.
 * The labels are verbatim; the values are what POST /api/keywords/record wants. */
const KEYWORD_OPTIONS = [
  { value: "confirm", label: "Confirm and update source" },
  { value: "na", label: "Not applicable" },
  { value: "familiarity", label: "Bring in as familiarity" },
  { value: "pending", label: "Unsure / keep pending" },
];

/**
 * The ledger recommends an answer per term, and the tag goes on that answer
 * rather than always on the first one: "AGSVA" is a clearance, not a skill, and
 * recommending "Confirm and update source" for it is how the queue filled up
 * with rows nobody should have been asked about. Nothing is pre-selected: the
 * tag is a hint, not a default.
 */
const RECOMMENDED = " (Recommended)";
const recommendedAnswer = (item) => {
  const answer = String((item.recommendation && item.recommendation.answer) || "").trim().toLowerCase();
  return KEYWORD_OPTIONS.some((option) => option.value === answer) ? answer : "";
};

/** How many rows are drawn before "Show all". Hundreds at once is a page
 * nobody reaches the end of, and every one of them carries four buttons. */
const PAGE_SIZE = 40;

/**
 * Past this many pending terms the ledger is mostly rows that are not skills at
 * all, and answering them one at a time is the wrong job: /keyword-triage
 * clears those deterministically and leaves the real questions behind.
 */
const TRIAGE_THRESHOLD = 40;

const KEYWORD_SESSION = "harnessKeywordSession";

function readKeywordSession() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEYWORD_SESSION) || "null");
    if (raw && Array.isArray(raw.decided)) return { decided: raw.decided, skipped: raw.skipped || [] };
  } catch { /* blocked or corrupt storage just starts a fresh pass */ }
  return { decided: [], skipped: [] };
}

const saveKeywordSession = (state) => {
  try { sessionStorage.setItem(KEYWORD_SESSION, JSON.stringify(state)); } catch { /* private mode: memory only */ }
};

/** The four words the ledger uses for what a term is. Anything else, or a term
 * the API does not classify, shows no word rather than a guessed one. */
const CATEGORIES = ["tool", "method", "certification", "concept"];

const categoryOf = (item) => {
  const raw = String(item.category ?? item.kind ?? "").trim().toLowerCase();
  return CATEGORIES.includes(raw) ? raw : "";
};

/** True when any plan behind the term calls it must-have. The ledger may say so
 * on the term or on the pending rows it groups. */
const mustHave = (item) => item.must_have === true || item.tier === "must_have"
  || (item.plans || []).some((plan) => plan && (plan.must_have === true || plan.tier === "must_have"));

/**
 * The roles an evidence hint names. The hint is written for a tool
 * ("cv-source.md:25,118 (Principal Consultant, Example Corp; ...)"), and the
 * file and the line numbers are no help to a person deciding whether they have
 * done a thing, so only the names in the brackets are shown.
 */
function evidenceRoles(hint) {
  const inside = /\(([^()]+)\)\s*$/.exec(String(hint || ""));
  const said = inside ? inside[1].trim() : "";
  return /^[\s\d,:.]*$/.test(said) ? "" : said;
}

/** Which adverts asked for this term, said as adverts: a title and a company,
 * never the opportunity id the ledger files them under. */
function askedBy(item) {
  const rows = Array.isArray(item.opportunities) ? item.opportunities : [];
  const said = rows.slice(0, 2)
    .map((row) => (row ? [row.title, row.company].filter(Boolean).join(" at ") : ""))
    .filter(Boolean);
  return said.length ? `Asked by ${said.join("; ")}` : "";
}

/** Where the term came from, as the meta line under it. */
function contextOf(item) {
  const roles = evidenceRoles(item.evidence_hint);
  return [
    categoryOf(item),
    item.count === 1 ? "seen once" : `seen ${item.count} times`,
    (item.resumes || []).join(", "),
    askedBy(item),
    roles ? `Evidence: ${roles}` : "",
  ].filter(Boolean).join(", ");
}

/**
 * One pending term as a list row: the term and its pills on line one, where it
 * came from on line two, the ledger's own note on line three, and the four
 * answers as four secondary buttons on a full-width line under them.
 */
function termRow(item, handlers) {
  const row = h("div", { class: "list-row term-row" });
  const main = h("div", { class: "list-main" });
  const title = h("p", { class: "list-title term-name", text: item.term });
  if (mustHave(item)) {
    title.append(h("span", { class: "list-pills" }, h("span", { class: "pill", text: "Must have" })));
  }
  main.append(title);
  const context = contextOf(item);
  if (context) main.append(h("p", { class: "list-meta", text: context }));
  const advice = String((item.recommendation && item.recommendation.note) || "").trim();
  if (advice) main.append(h("p", { class: "list-reason", text: advice }));
  row.append(main);

  const answers = h("div", { class: "row-extra answers" });
  const problem = h("div", { class: "row-extra" });
  const advised = recommendedAnswer(item);
  const buttons = [];
  for (const option of KEYWORD_OPTIONS) {
    const button = h("button", {
      type: "button",
      class: "btn",
      text: option.value === advised ? `${option.label}${RECOMMENDED}` : option.label,
    });
    button.addEventListener("click", async () => {
      for (const other of buttons) other.disabled = true;
      clear(problem);
      const failure = await handlers.onAnswer(item.term, option.value);
      // The row stays on screen when the write failed: nobody answers twice.
      if (failure) {
        for (const other of buttons) other.disabled = false;
        problem.append(errorBox(failure, "Could not record this answer. Nothing was written.", null));
      }
    });
    buttons.push(button);
    answers.append(button);
  }
  row.append(answers, problem);
  return row;
}

export async function viewKeywords(view, opts) {
  const options = opts || {};
  const count = options.lede || h("p", { class: "page-count" });
  if (!options.lede) view.append(pageHeader({ title: "Evidence questions", lede: count }));

  const banner = h("p", { class: "triage-banner", hidden: true });
  const search = h("input", {
    type: "search", id: "term-search", placeholder: "e.g. Kafka", "aria-label": "Search the pending terms",
  });
  const controls = h("div", { class: "field term-search" },
    h("label", { class: "field-label", for: "term-search", text: "Search" }), search);
  const progress = h("p", { class: "progress-line" });
  const host = h("div", {});
  host.append(placeholderRows(3));
  view.append(banner, controls, progress, host);

  const session = readKeywordSession();
  const decided = new Set(session.decided);
  const skipped = new Set(session.skipped);
  let terms = [];
  let showAll = false;

  const load = async () => {
    const data = await api("keywords/pending?all=1");
    terms = data.terms || [];
    const pending = data.term_total ?? terms.length;
    count.textContent = pending === 1 ? "1 term pending" : `${pending} terms pending`;
    banner.hidden = pending <= TRIAGE_THRESHOLD;
    banner.textContent = banner.hidden
      ? ""
      : `Run /keyword-triage first: it clears rows that are not skills. ${pending} pending.`;
  };

  const retry = () => render();
  try {
    await load();
  } catch (error) {
    clear(host);
    host.append(loadError("the pending terms", error, retry));
    return;
  }

  /** Answer one term. Returns the error on failure so the row can show it. */
  const answer = async (term, value) => {
    try {
      const result = await api("keywords/record", { method: "POST", body: { answers: { [term]: value } } });
      const n = (v) => (Array.isArray(v) ? v.length : v ?? 0);
      toast([`Recorded ${term}.`, n(result.skipped_already_answered) ? "Already answered." : "",
        n(result.unmatched) ? "Unmatched." : ""].filter(Boolean).join(" "));
      if (value === "pending") skipped.add(term); else decided.add(term);
      saveKeywordSession({ decided: [...decided], skipped: [...skipped] });
      await load();
      paint();
      return null;
    } catch (error) {
      return error;
    }
  };

  function paint() {
    clear(host);
    const needle = search.value.trim().toLowerCase();
    const live = terms.filter((item) => !skipped.has(item.term));
    const matching = needle ? live.filter((item) => item.term.toLowerCase().includes(needle)) : live;
    progress.textContent = `Decided ${decided.size}, skipped ${skipped.size}, ${live.length} to go.`;

    if (!terms.length) {
      host.append(h("p", { class: "empty",
        text: "Nothing pending. Every term the hunt mined has an answer. The next run adds more." }));
      return;
    }
    if (!matching.length) {
      host.append(h("p", { class: "empty", text: needle
        ? `No pending term matches "${search.value.trim()}". Clear the search to see the rest.`
        : "Nothing left in this pass. Reopen the screen to see the terms you put off." }));
      return;
    }

    const shown = showAll ? matching : matching.slice(0, PAGE_SIZE);
    if (matching.length > shown.length) {
      const more = h("button", { type: "button", class: "btn-text", text: "Show all" });
      more.addEventListener("click", () => { showAll = true; paint(); });
      host.append(h("p", { class: "group-heading" },
        h("span", { class: "tally", text: `Showing ${shown.length} of ${matching.length}` }), more));
    }
    const list = h("div", { class: "list terms" });
    for (const item of shown) list.append(termRow(item, { onAnswer: answer }));
    host.append(list);
    host.append(h("p", { class: "grey small measure",
      text: "A confirmed term authorises nothing on its own. The fact still has to be written into the CV source." }));
  }

  search.addEventListener("input", () => { showAll = false; paint(); });
  paint();
}
