/*
 * applications.js - the applications board: a list of job cards with a filter
 * column beside it.
 *
 * AGENTS.md section 2: nothing here sends. The buttons on a card move a row in
 * the local pipeline, which is the same thing the Sheet's Tray column does.
 */

import {
  $, APPLY_METHODS, api, clear, eyebrow, fetchInto, getSummary, guarded, h, pageHeader, render, statusLabel, toast, when,
} from "./app.js";

/** Application tabs, in the order the person works them. Sent is capped at 30 rows.
 * `label` is the short name, `long` is how the filter column says it. */
export const TABS = [
  { key: "needs", label: "Blocked", long: "Blocked", status: "manual_action_needed", action: "retry" },
  { key: "waiting", label: "To approve", long: "To approve", status: "awaiting_approval", action: "approve" },
  { key: "shortlisted", label: "Shortlisted", long: "Shortlisted", status: "shortlisted", action: "approve" },
  { key: "parked", label: "Parked", long: "Parked", status: "parked", action: "retry" },
  { key: "sent", label: "Sent", long: "Sent", status: "submitted", limit: 30 },
];

/** What each tab says when it is empty: direction, not a shrug. */
const EMPTY = {
  needs: "Nothing is blocked. The morning run adds rows here when a letter is blocked or a question is unanswered.",
  waiting: "Nothing is waiting on your yes. Prepared packages land here before they go out.",
  shortlisted: "Nothing is shortlisted. The hunt adds roles here once they fit and nothing blocks them.",
  parked: "Nothing is parked. Roles that do not fit, or cannot be done from Sydney, end up here.",
  sent: "Nothing has been sent yet. Submitted applications appear here, most recent first.",
};

/** The person's five decisions on a row. The server maps each to a transition. */
export const ACTIONS = [
  { key: "approve", label: "Approve", primary: true }, { key: "retry", label: "Retry" },
  { key: "hold", label: "Hold" }, { key: "reject", label: "Reject", danger: true },
  { key: "withdraw", label: "Withdraw", danger: true },
];

/** A decision button: armed on the first press, committed on the second, and
 * posted to the local pipeline. It never submits to a channel (AGENTS.md
 * section 2); the worst it can do is move a row. */
export function actionButton(row, action, fields, done) {
  const classes = ["btn", action.primary ? "primary" : "", action.danger ? "danger" : ""];
  const button = h("button", { type: "button", class: classes.filter(Boolean).join(" "), text: action.label });
  guarded(button, action.label, async () => {
    button.disabled = true;
    const body = { action: action.key, ...(fields ? fields() : {}) };
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/action`, { method: "POST", body });
      toast(`${action.label}: the row is now ${statusLabel(result.status_after)}.`);
      done();
    } catch (error) {
      // 409 means the state machine refused the move. Show the server's reason.
      toast(error.status === 409 ? `Refused. ${error.message}` : error.message, "bad");
      button.disabled = false;
    }
  });
  return button;
}

const appState = { tab: "needs", sort: "score", channels: new Set(), minScore: "", filtersOpen: false };

/** One job card: title and score, who and where, the tags, why it is here,
 * and the two things the person can do about it. */
function jobCard(row, tab, refresh) {
  const card = h("article", { class: "card job" });
  const head = h("div", { class: "job-head" });
  head.append(h("a", { class: "job-title", href: `#/row/${encodeURIComponent(row.id)}`, text: row.title || "Untitled role" }));
  if (typeof row.score === "number") head.append(h("span", { class: "score", text: `${Math.round(row.score)} score` }));
  card.append(head);
  const meta = [row.company, row.location].filter(Boolean).join(", ");
  if (meta) card.append(h("p", { class: "job-meta", text: meta }));
  const pills = h("div", { class: "pills" });
  // A job the person saved on the channel is an order to apply (AGENTS.md
  // section 2), so it is said on the card rather than buried in the detail.
  for (const tag of [row.channel, APPLY_METHODS[row.applyMethod] || row.applyMethod, row.userSaved ? "saved by you" : null]) {
    if (tag) pills.append(h("span", { class: "pill", text: tag }));
  }
  if (pills.childElementCount) card.append(pills);
  card.append(h("hr", { class: "rule" }), eyebrow("Why it is here"),
    h("p", { class: "why", text: row.reason || "No reason recorded. Open the row to read its history." }));
  const buttons = h("div", { class: "foot-actions" },
    h("a", { class: "btn", href: `#/row/${encodeURIComponent(row.id)}`, text: "Details" }));
  const contextual = ACTIONS.find((a) => a.key === tab.action);
  if (contextual) buttons.append(actionButton(row, { ...contextual, primary: true, danger: false }, null, refresh));
  card.append(h("div", { class: "job-foot" },
    h("span", { class: "when", text: row.updated_at ? `Updated ${when(row.updated_at)}` : "Never updated" }), buttons));
  return card;
}

/** The filter column: the five statuses with their counts, the channels the
 * loaded rows actually use, and a floor on the score. */
function filterCard(rows, repaint) {
  const card = h("aside", { class: "card filter-card", id: "filter-card" });
  card.hidden = !appState.filtersOpen && window.innerWidth < 900;
  const body = h("div", { class: "filters" });
  card.append(h("h2", { text: "Filters" }), body);
  const summary = getSummary();
  const counts = (summary && summary.counts) || {};
  const statuses = h("div", { class: "filter-group" });
  statuses.append(eyebrow("Status"));
  for (const tab of TABS) {
    const input = h("input", { type: "radio", name: "status-tab", checked: tab.key === appState.tab });
    input.addEventListener("change", () => { location.hash = `#/applications/${tab.key}`; });
    statuses.append(h("label", { class: "choice" }, input, h("span", { text: tab.long }),
      h("span", { class: "tally", text: String(counts[tab.status] ?? 0) })));
  }
  body.append(statuses);
  const channels = [...new Set(rows.map((r) => r.channel).filter(Boolean))].sort();
  if (channels.length > 1) {
    const group = h("div", { class: "filter-group" });
    group.append(eyebrow("Channel"));
    for (const channel of channels) {
      const input = h("input", { type: "checkbox", checked: appState.channels.has(channel) });
      input.addEventListener("change", () => {
        if (input.checked) appState.channels.add(channel); else appState.channels.delete(channel);
        repaint();
      });
      group.append(h("label", { class: "choice" }, input, h("span", { text: channel }),
        h("span", { class: "tally", text: String(rows.filter((r) => r.channel === channel).length) })));
    }
    body.append(group);
  }
  const score = h("div", { class: "filter-group" });
  score.append(eyebrow("Minimum score"));
  const input = h("input", { type: "number", min: "0", max: "100", step: "1", value: appState.minScore, placeholder: "Any" });
  input.addEventListener("input", () => { appState.minScore = input.value; repaint(); });
  body.append(score);
  score.append(input);
  return card;
}

/** Sort and floor the fetched rows the way the filter column says. */
function visibleRows(rows) {
  const floor = Number(appState.minScore);
  const out = rows.filter((row) => {
    if (appState.channels.size && !appState.channels.has(row.channel)) return false;
    if (appState.minScore !== "" && Number.isFinite(floor) && (row.score ?? 0) < floor) return false;
    return true;
  });
  return appState.sort === "updated"
    ? out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    : out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** `which` is the tab key from the address (#/applications/waiting), so Home
 * can link straight at the bucket it is talking about. */
export async function viewApplications(view, which) {
  if (which && TABS.some((t) => t.key === which)) appState.tab = which;
  const tab = TABS.find((t) => t.key === appState.tab) || TABS[0];
  const count = h("p", { class: "page-count", id: "row-count",
    text: "Job Hunt drafts and sends applications overnight. Decide here on anything it could not send." });
  const toggle = h("button", { type: "button", class: "btn filters-toggle", text: "Filters" });
  toggle.addEventListener("click", () => {
    appState.filtersOpen = !appState.filtersOpen;
    if ($("#filter-card")) $("#filter-card").hidden = !appState.filtersOpen;
  });
  const sort = h("select", { "aria-label": "Sort rows" });
  for (const [value, label] of [["score", "Score"], ["updated", "Updated"]]) {
    sort.append(h("option", { value, selected: appState.sort === value, text: label }));
  }
  sort.addEventListener("change", () => { appState.sort = sort.value; render(); });
  const head = pageHeader({
    title: tab.long,
    lede: count,
    aside: h("div", { class: "sorter" }, toggle, h("span", { text: "Sort" }), sort),
  });
  const layout = h("div", { class: "layout" });
  const list = h("div", { class: "cards" });
  list.append(h("p", { class: "empty", text: "Loading rows." }));
  layout.append(list);
  view.append(head, layout);

  const params = new URLSearchParams({ status: tab.status });
  if (tab.limit) params.set("limit", String(tab.limit));
  const data = await fetchInto(list, `rows?${params.toString()}`, "Could not load rows.");
  if (!data) return;
  const rows = data.rows || [];
  const paint = () => {
    clear(list);
    const shown = visibleRows(rows);
    $("#row-count").textContent = shown.length === 1 ? "1 row" : `${shown.length} rows`;
    if (!shown.length) {
      list.append(h("p", { class: "empty", text: rows.length ? "No row matches these filters. Widen them to see more." : EMPTY[tab.key] }));
      return;
    }
    for (const row of shown) list.append(jobCard(row, tab, () => render()));
  };
  layout.prepend(filterCard(rows, paint));
  paint();
}
