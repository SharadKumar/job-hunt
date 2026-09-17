/*
 * keywords.js - draining the pending keyword confirmations, one term at a time.
 *
 * Hundreds of terms sit pending, so the view keeps its own pass: the order to
 * work through, where the person is in it, what they settled and what they put
 * off. It lives in sessionStorage, so a refresh does not lose the place.
 *
 * AGENTS.md section 9: four fixed answers, no default, and never more than four
 * questions on screen at once. Each term is recorded on its own, so a decision
 * lands the moment it is made and the freed slot fills from the queue behind it.
 */

import { api, clear, errorBox, h, panel, render, toast } from "./app.js";

/* AGENTS.md section 9: four fixed answers and no others, recommended first.
 * The labels are verbatim; the values are what POST /api/keywords/record wants. */
const KEYWORD_OPTIONS = [
  { value: "confirm", label: "Confirm and update source (Recommended)" },
  { value: "na", label: "Not applicable" },
  { value: "familiarity", label: "Bring in as familiarity" },
  { value: "pending", label: "Unsure / keep pending" },
];

/** AGENTS.md section 9: never ask more than four at a time. */
const KEYWORD_BUNDLE = 4;

/**
 * "Unsure / keep pending" is the same decision as Skip, so it needs no button
 * press: the card leaves on its own. It waits this long first, so a mis-click
 * can be changed by picking another answer before the card goes.
 */
const PENDING_SKIP_MS = 400;

const KEYWORD_SESSION = "harnessKeywordSession";
const blankPass = () => ({ pass: [], cursor: 0, decided: [], skipped: [], requeued: [] });

function readKeywordSession() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEYWORD_SESSION) || "null");
    if (raw && Array.isArray(raw.pass)) return { ...blankPass(), ...raw };
  } catch { /* blocked or corrupt storage just starts a fresh pass */ }
  return blankPass();
}

const saveKeywordSession = (state) => {
  try { sessionStorage.setItem(KEYWORD_SESSION, JSON.stringify(state)); } catch { /* private mode: memory only */ }
};

/**
 * One question: the term, what it was asked against, the four answers, and the
 * two buttons that resolve it. Record is black and stays disabled until an
 * answer other than "Unsure / keep pending" is picked; Skip puts the term to
 * the back of the pass. 1 to 4 pick an answer while the focus is in the card.
 */
function termCard(item, handlers) {
  const set = h("fieldset", { class: "term" }, h("legend", { text: item.term }));
  const facts = [item.count === 1 ? "seen once" : `seen ${item.count} times`,
    (item.resumes || []).join(", "), item.context].filter(Boolean);
  set.append(h("p", { class: "context", text: facts.join(". ") }));
  const options = h("div", { class: "options" });
  for (const option of KEYWORD_OPTIONS) {
    options.append(h("label", {}, h("input", { type: "radio", name: `term:${item.term}`, value: option.value, dataset: { term: item.term } }),
      h("span", { text: option.label })));
  }
  set.append(options);

  const problem = h("div", {});
  const record = h("button", { type: "button", class: "btn primary", text: "Record", disabled: true });
  const skip = h("button", { type: "button", class: "btn", text: "Skip" });
  let pendingTimer = 0;
  const answerOf = () => {
    const picked = options.querySelector("input[type=radio]:checked");
    return picked ? picked.value : "";
  };
  options.addEventListener("change", () => {
    clearTimeout(pendingTimer);
    const answer = answerOf();
    record.disabled = !answer || answer === "pending";
    // The mis-click window: another answer inside it cancels the departure.
    if (answer === "pending") pendingTimer = setTimeout(() => handlers.onSkip(item.term), PENDING_SKIP_MS);
  });
  set.addEventListener("keydown", (event) => {
    const n = Number(event.key);
    if (!(n >= 1 && n <= KEYWORD_OPTIONS.length) || event.metaKey || event.ctrlKey) return;
    const input = options.querySelectorAll("input")[n - 1];
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    event.preventDefault(); // 1 to 4 answer the term the focus is in
  });
  skip.addEventListener("click", () => { clearTimeout(pendingTimer); handlers.onSkip(item.term); });
  record.addEventListener("click", async () => {
    const answer = answerOf();
    if (!answer || answer === "pending") return;
    record.disabled = true;
    clear(problem);
    const failure = await handlers.onRecord(item.term, answer);
    // The answer stays on screen when the write failed: nobody picks it twice.
    if (failure) {
      record.disabled = false;
      problem.append(errorBox(failure, "Could not record this answer. Nothing was written.", null));
    }
  });
  set.append(h("div", { class: "action-buttons term-actions" }, record, skip), problem);
  return set;
}

export async function viewKeywords(view) {
  view.append(h("h1", { text: "Keywords" }));
  const count = h("p", { class: "page-count", text: "Loading pending terms." });
  const layout = h("div", { class: "layout kw-layout" });
  const left = h("aside", { class: "card kw-list", id: "kw-list" });
  const right = h("div", { class: "stack" });
  view.append(count, layout);
  let terms = [];
  const load = async () => {
    const data = await api("keywords/pending?all=1");
    terms = data.terms || [];
    count.textContent = `${data.term_total ?? terms.length} terms pending, ${data.pending_total ?? 0} questions behind them.`;
  };
  try { await load(); } catch (error) { return layout.append(errorBox(error, "Could not load the pending terms.", () => render())); }
  layout.append(left, right);

  const state = readKeywordSession();
  const decided = new Set(state.decided), skipped = new Set(state.skipped), requeued = new Set(state.requeued);
  let listOpen = false;
  /** Keep the session order, drop what has since been answered, append what is new. */
  const reconcile = () => {
    const live = new Set(terms.map((t) => t.term));
    state.pass = state.pass.filter((t) => live.has(t));
    const seen = new Set(state.pass);
    for (const item of terms) if (!seen.has(item.term)) state.pass.push(item.term);
    for (const term of [...skipped]) if (!live.has(term)) skipped.delete(term);
    state.cursor = Math.max(0, Math.min(state.cursor, state.pass.length));
  };

  const repaint = () => {
    Object.assign(state, { decided: [...decided], skipped: [...skipped], requeued: [...requeued] });
    saveKeywordSession(state);
    paintBundle();
    paintList();
  };
  reconcile();

  const toggle = h("button", { type: "button", class: "btn terms-toggle", text: "All terms" });
  toggle.addEventListener("click", () => { listOpen = !listOpen; left.hidden = !listOpen; });
  const heading = h("h2", {});
  const search = h("input", { type: "search", placeholder: "Search terms", "aria-label": "Search terms" });
  const list = h("ul", { class: "kw-terms" });
  search.addEventListener("input", () => paintList());
  left.append(heading, search, list);

  function paintList() {
    heading.textContent = toggle.textContent = `All terms (${terms.length})`;
    left.hidden = !listOpen && window.innerWidth < 900;
    clear(list);
    const needle = search.value.trim().toLowerCase();
    const shown = needle ? terms.filter((t) => t.term.toLowerCase().includes(needle)) : terms;
    if (!shown.length) return list.append(h("li", { class: "grey small", text: needle ? "No term matches that search." : "Nothing pending." }));
    for (const item of shown) {
      const done = decided.has(item.term), put = skipped.has(item.term);
      const button = h("button", { type: "button", class: "kw-term", title: done ? "Decided this session" : put ? "Skipped this session" : item.term },
        h("span", { class: done ? "mark done" : put ? "mark put" : "mark", text: done ? "✓" : put ? "•" : "" }),
        h("span", { class: "name", text: item.term }), h("span", { class: "tally", text: String(item.count) }));
      // Jumping moves the window to start at that term, wherever the pass had it.
      button.addEventListener("click", () => {
        const at = state.pass.indexOf(item.term);
        if (at < 0) return;
        state.cursor = at; listOpen = false; repaint();
      });
      list.append(h("li", {}, button));
    }
  }

  /** Take a resolved term out of the pass, keeping the window where it is so
   * the freed slot fills from the queue behind it. */
  const drop = (term) => {
    const at = state.pass.indexOf(term);
    if (at < 0) return;
    state.pass.splice(at, 1);
    if (at < state.cursor) state.cursor -= 1;
  };

  /** Put one term off: it goes to the back of the pass once, so the pass still
   * ends, and the skipped ones are offered again as a fresh pass. */
  const skipTerm = (term) => {
    skipped.add(term);
    drop(term);
    if (!requeued.has(term)) { requeued.add(term); state.pass.push(term); }
    repaint();
  };

  /** Record one term. Returns the error on failure so the card can show it. */
  const recordTerm = async (term, answer) => {
    try {
      const result = await api("keywords/record", { method: "POST", body: { answers: { [term]: answer } } });
      const n = (value) => (Array.isArray(value) ? value.length : value ?? 0);
      toast([`Recorded ${term}.`, n(result.skipped_already_answered) ? "Already answered." : "",
        n(result.unmatched) ? "Unmatched." : ""].filter(Boolean).join(" "));
      decided.add(term);
      skipped.delete(term);
      drop(term);
      await load(); // the recorded term leaves the left list
      reconcile();
      repaint();
      return null;
    } catch (error) {
      return error;
    }
  };

  function paintBundle() {
    clear(right);
    const settled = decided.size + skipped.size;
    const togo = Math.max(0, terms.length - skipped.size);
    const pct = Math.round((settled * 100) / (decided.size + terms.length || 1));
    right.append(h("p", { class: "progress-line", text: `Decided ${decided.size}, skipped ${skipped.size}, ${togo} to go.` }),
      h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
        h("span", { style: `width: ${pct}%` })), toggle);
    const bundle = state.pass.slice(state.cursor, state.cursor + KEYWORD_BUNDLE)
      .map((term) => terms.find((item) => item.term === term)).filter(Boolean);
    if (!terms.length) return right.append(h("p", { class: "empty", text: "Nothing pending. Every mined term has an answer. The next hunt will add more." }));
    if (!bundle.length) {
      const again = h("button", { type: "button", class: "btn primary", text: "Start again with the skipped ones" });
      again.addEventListener("click", () => { state.pass = [...skipped]; state.cursor = 0; requeued.clear(); repaint(); });
      return right.append(panel("This pass is done", h("div", {},
        h("p", { text: `Every pending term has been seen this pass. ${skipped.size} skipped.` }),
        skipped.size ? again : h("p", { class: "grey small", text: "Nothing was put off. The next hunt mines more terms." }))));
    }
    const form = h("form", {});
    form.addEventListener("submit", (event) => event.preventDefault());
    for (const item of bundle) form.append(termCard(item, { onRecord: recordTerm, onSkip: skipTerm }));
    form.append(h("p", { class: "grey small measure",
      text: "A confirmed term authorises nothing on its own. The fact still has to be written into the CV source." }));
    right.append(form);
  }

  paintBundle();
  paintList();
}
