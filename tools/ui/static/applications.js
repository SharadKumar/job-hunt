/*
 * applications.js - the applications board: one compact row per job, with a
 * filter column beside it.
 *
 * A row is two lines. The first says what the job is and what it scored, the
 * second says why it is sitting here and offers the single thing the person can
 * do about it. Which button that is comes from the server (GET /api/rows
 * returns `action`), so the list, the row detail and the tests all read one
 * derivation instead of three copies of a regex.
 *
 * AGENTS.md section 2: nothing here sends. The buttons move a row in the local
 * pipeline, which is the same thing the Sheet's Tray column does.
 */

import {
  $, APPLY_METHODS, api, clear, eyebrow, fetchInto, getSummary, guarded, h, pageHeader, panel, render, statusLabel, toast,
} from "./app.js";
import { markSentControl } from "./row-actions.js";

/** Application tabs, in the order the person works them. Sent is capped at 30 rows.
 * `label` is the short name, `long` is how the filter column says it. */
export const TABS = [
  { key: "needs", label: "Blocked", long: "Blocked", status: "manual_action_needed" },
  { key: "waiting", label: "To approve", long: "To approve", status: "awaiting_approval" },
  { key: "shortlisted", label: "Shortlisted", long: "Shortlisted", status: "shortlisted" },
  { key: "parked", label: "Parked", long: "Parked", status: "parked" },
  { key: "sent", label: "Sent", long: "Sent", status: "submitted", limit: 30 },
  { key: "responses", label: "Responses", long: "Responses", status: "responded,interview,offered,won" },
];

/** What each tab says when it is empty: direction, not a shrug. */
const EMPTY = {
  needs: "Nothing is blocked. The morning run adds rows here when a letter is blocked or a question is unanswered.",
  waiting: "Nothing is waiting on your yes. Prepared packages land here before they go out.",
  shortlisted: "Nothing is shortlisted. The hunt adds roles here once they fit and nothing blocks them.",
  parked: "Nothing is parked. Roles that do not fit, or cannot be done from Sydney, end up here.",
  sent: "Nothing has been sent yet. Submitted applications appear here, most recent first.",
  responses: "No replies yet. A row moves here when you record a response, an interview, an offer or a win.",
};

/** Where the row detail looks for a request to open with the screening panel
 * focused. A hash carries the id and nothing else, so the intent travels here. */
export const FOCUS_KEY = "jobHuntFocusScreening";

/** A channel key as the person says it out loud. */
export function channelLabel(channel) {
  const key = String(channel || "").toLowerCase();
  if (key === "seek") return "SEEK";
  if (key === "linkedin_jobs" || key === "linkedin") return "LinkedIn";
  return key.split(/[_\s-]+/).filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** home.js owns the plain rewrite of a run's reason; use it when it is there.
 * Until it lands, strip the run stamp the daily writes and show the rest. */
let plainReasonFn = null;
export async function loadReasonHelper() {
  if (plainReasonFn) return;
  const mod = await import("./home.js").catch(() => null);
  if (mod && typeof mod.plainReason === "function") plainReasonFn = mod.plainReason;
}
export function plainReasonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (plainReasonFn) {
    try { return String(plainReasonFn(raw) || "").trim() || raw; } catch { /* fall through */ }
  }
  return raw.replace(/^\[[^\]]*\]\s*/, "").trim();
}

/** A decision button: armed on the first press, committed on the second, and
 * posted to the local pipeline. It never submits to a channel (AGENTS.md
 * section 2); the worst it can do is move a row. */
export function actionButton(row, action, fields, done) {
  const classes = ["btn", action.primary ? "primary" : "", action.danger ? "danger" : "", action.small ? "sm" : ""];
  const button = h("button", { type: "button", class: classes.filter(Boolean).join(" "), text: action.label });
  // What the move does, in plain words, for whoever hovers or reads it out.
  if (action.title) button.setAttribute("title", action.title);
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

/** A button that posts to one of the two extension routes this package adds
 * (unpark, outcome). Same two-press arming as a Tray decision. */
function routeButton(row, spec, done) {
  const classes = ["btn", spec.primary ? "primary" : "", spec.danger ? "danger" : "", spec.small ? "sm" : ""];
  const button = h("button", { type: "button", class: classes.filter(Boolean).join(" "), text: spec.label });
  guarded(button, spec.label, async () => {
    button.disabled = true;
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/${spec.path}`, { method: "POST", body: spec.body });
      toast(`${spec.label}: the row is now ${statusLabel(result.status_after)}.`);
      done();
    } catch (error) {
      toast(error.status === 409 ? `Refused. ${error.message}` : error.message, "bad");
      button.disabled = false;
    }
  });
  return button;
}

/**
 * Open the row with the screening panel focused. On the row itself the address
 * is already right, so the press scrolls to the panel rather than doing
 * nothing: setting the same hash fires no hashchange.
 */
export function openScreening(id) {
  const target = `#/row/${encodeURIComponent(id)}`;
  const slot = document.querySelector(".screening-slot");
  if (location.hash === target && slot && slot.childElementCount) {
    slot.scrollIntoView({ block: "center" });
    const focusable = slot.querySelector("input, textarea, button, select");
    if (focusable) focusable.focus();
    return;
  }
  try { sessionStorage.setItem(FOCUS_KEY, id); } catch { /* private mode: the panel still mounts */ }
  location.hash = target;
}

/**
 * The one contextual control a row earns, from the server's derivation. A row
 * with nothing to decide gets a quiet link to its details instead, and a sent
 * row gets nothing at all.
 */
export function contextualControl(row, done, { small = true } = {}) {
  const act = row.action || { kind: "none" };
  const cls = small ? "btn sm" : "btn";
  // `decide` is the server saying there is no one obvious move: the choices it
  // offers all sit in `also`, and none of them is the primary.
  if (act.kind === "decide") return null;
  // A gate refusal is the server saying there is no move at all on this board:
  // no button here changes a policy, and a retry would hit the same gate.
  if (act.kind === GATE_REFUSED) return null;
  if (act.kind === "portal") {
    return h("a", { class: cls, href: act.href || row.url, target: "_blank", rel: "noreferrer noopener", text: act.label || "Open portal" });
  }
  if (act.kind === "answer") {
    return h("button", { type: "button", class: `${cls} primary`, text: act.label || "Answer", onClick: () => openScreening(row.id) });
  }
  if (act.post) return actionButton(row, { key: act.post, label: act.label, primary: act.primary, danger: act.danger, small }, null, done);
  if (act.kind === "unpark") return routeButton(row, { label: act.label || "Unpark", path: "unpark", body: { reason: "unparked from the board" }, small }, done);
  if (act.kind === "outcome") {
    return routeButton(row, { label: act.label, path: "outcome", body: { status: act.outcome, note: "recorded from the board" }, primary: act.primary, small }, done);
  }
  return null;
}

/** The action kind the server sends when the submission gate refused a row on
 * policy (rows-ext-api.ts). The board reads it in two places, so it is named. */
export const GATE_REFUSED = "gate_refused";

/** The one clause of a refusal note the board has room for: what stopped it.
 * The rest of the note, the part that says what to do, is on the row page. */
export function firstClause(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const match = /^[^.;]+[.;]/.exec(raw);
  return match ? `${match[0].slice(0, -1).trim()}.` : raw;
}

/** An `also` entry, or a row's own apply method, that means the person sent
 * this one themselves somewhere the harness cannot reach. */
const SELF_SENT = new Set(["mark-sent", "mark_sent", "applied", "self"]);

/**
 * The secondary controls that sit after the primary: whatever the server hung
 * off `action.also`, plus the one the board owes an external row even when the
 * server is an older build that does not send it.
 *
 * Buttons and the things they open are returned apart, because a form belongs
 * under a row rather than inside its line of buttons.
 */
export function alsoControls(row, done, { small = true } = {}) {
  const act = row.action || { kind: "none" };
  const cls = small ? "btn sm" : "btn";
  const buttons = [];
  const extras = [];
  let selfSent = false;
  for (const spec of Array.isArray(act.also) ? act.also : []) {
    if (!spec) continue;
    if (SELF_SENT.has(String(spec.kind || ""))) {
      selfSent = true;
      const control = markSentControl(row, done, { small });
      if (spec.label) control.button.textContent = spec.label;
      buttons.push(control.button);
      extras.push(control.extra);
    } else if (spec.href || spec.kind === "portal") {
      buttons.push(h("a", { class: cls, href: spec.href || row.url, target: "_blank",
        rel: "noreferrer noopener", text: spec.label || "Open portal" }));
    } else if (spec.post) {
      buttons.push(actionButton(row, { key: spec.post, label: spec.label || spec.post, danger: spec.danger, small }, null, done));
    }
  }
  // An external portal row is one the person has to finish in their own
  // browser, so it always earns the way to say they did (AGENTS.md section 2).
  const external = act.kind === "portal" || row.applyMethod === "external"
    || (Array.isArray(act.also) && act.also.some((spec) => spec && spec.kind === "portal"));
  if (external && !selfSent) {
    const control = markSentControl(row, done, { small });
    buttons.push(control.button);
    extras.push(control.extra);
  }
  return { buttons, extras };
}

const appState = { tab: "needs", sort: "score", channels: new Set(), minScore: "", filtersOpen: false };

/**
 * The lane split the rows endpoint reports for awaiting_approval: how many
 * rows actually want the person, and how many the run is already carrying.
 * Held here because the filter column draws every tab's count from one place,
 * whichever tab is open.
 */
const laneCounts = { needs_you: null, in_flight: null };

/** Only the awaiting_approval response is the To approve tally. Every status
 * reports its own split, and the shortlisted one overwrote this with a figure
 * that belonged to a different tab. */
function rememberLaneCounts(status, data) {
  const counts = status === "awaiting_approval" && data ? data.counts : null;
  if (!counts) return;
  if (typeof counts.needs_you === "number") laneCounts.needs_you = counts.needs_you;
  if (typeof counts.in_flight === "number") laneCounts.in_flight = counts.in_flight;
}

/** A row that still wants a decision from the person. A server that does not
 * carry lanes says nothing, and then every awaiting row is theirs, exactly as
 * it was before the lanes existed. */
export const needsYou = (row) => row.needs_you !== false;

/** A row the run is already carrying. It is approved, it is going out, and it
 * is not a question (AGENTS.md section 2: the channel decides the lane). */
export const isInFlight = (row) => row.needs_you === false
  || Boolean(row.action && row.action.kind === "in_flight");

/** One job row: two lines, and at most one button. The whole row opens the
 * detail; the button inside it does its own thing. */
function jobRow(row, refresh) {
  const article = h("article", { class: "app-row" });
  const main = h("div", { class: "row-main" });
  main.append(h("a", { class: "row-title", href: `#/row/${encodeURIComponent(row.id)}`, text: row.title || "Untitled role" }));
  if (row.company) main.append(h("span", { class: "row-co", text: row.company }));
  if (row.location) main.append(h("span", { class: "row-where", text: row.location }));
  main.append(h("span", { class: "pill", text: channelLabel(row.channel) }));
  const method = APPLY_METHODS[row.applyMethod] || row.applyMethod;
  if (method) main.append(h("span", { class: "pill", text: method }));
  // A job the person saved on the channel is an order to apply (AGENTS.md
  // section 2), so it is said on the row rather than buried in the detail.
  if (row.userSaved) main.append(h("span", { class: "pill", text: "saved by you" }));
  // A row the run is carrying is read here rather than in To approve, so the
  // line has to say why it is sitting among the shortlist.
  if (isInFlight(row)) main.append(h("span", { class: "pill", text: "in flight" }));
  const score = h("span", { class: "row-score", text: typeof row.score === "number" ? String(Math.round(row.score)) : "" });
  const act = row.action || { kind: "none" };
  // A refused row reads as what stopped it, in the server's plain words, rather
  // than as the gate's own stamp. The board offers the one move it still takes:
  // drop it. Hold keeps it here, which is where it already is, so Hold and the
  // full explanation are left to the row page.
  const refused = act.kind === GATE_REFUSED;
  const shown = refused
    ? { ...row, action: { ...act, also: (Array.isArray(act.also) ? act.also : []).filter((spec) => spec && spec.post === "reject") } }
    : row;
  const reason = h("p", {
    class: "row-reason", "aria-label": "Why it is here",
    text: (refused ? firstClause(act.note) : plainReasonText(row.reason))
      || "No reason recorded. Open the row to read its history.",
  });
  const control = h("div", { class: "row-control" });
  const button = contextualControl(shown, refresh);
  if (button) control.append(button);
  const { buttons, extras } = alsoControls(shown, refresh);
  for (const extra of buttons) control.append(extra);
  if (!button && !buttons.length && row.status !== "submitted") {
    control.append(h("a", { class: "btn sm", href: `#/row/${encodeURIComponent(row.id)}`, text: "Details" }));
  }
  article.append(main, score, reason, control);
  // A form a secondary button opens runs the width of the row, under it.
  for (const extra of extras) article.append(h("div", { class: "row-extra" }, extra));
  article.addEventListener("click", (event) => {
    if (event.target.closest("a, button, input, select, textarea")) return;
    location.hash = `#/row/${encodeURIComponent(row.id)}`;
  });
  return article;
}

/** The filter column: the tabs with their counts, the channels the loaded rows
 * actually use, and a floor on the score. */
function filterCard(rows, repaint) {
  const card = h("aside", { class: "card filter-card", id: "filter-card" });
  card.hidden = !appState.filtersOpen && window.innerWidth < 900;
  const body = h("div", { class: "filters" });
  card.append(h("h2", { text: "Filters" }), body);
  const summary = getSummary();
  const counts = (summary && summary.counts) || {};
  // To approve counts only what wants the person; the rows the run is already
  // carrying are counted on the Shortlisted tab they are read on.
  const tally = (tab) => (tab.key === "waiting" && typeof laneCounts.needs_you === "number"
    ? laneCounts.needs_you
    : tab.status.split(",").reduce((n, s) => n + (counts[s] ?? 0), 0));
  const statuses = h("div", { class: "filter-group" });
  statuses.append(eyebrow("Status"));
  for (const tab of TABS) {
    const input = h("input", { type: "radio", name: "status-tab", checked: tab.key === appState.tab });
    input.addEventListener("change", () => { location.hash = `#/applications/${tab.key}`; });
    statuses.append(h("label", { class: "choice" }, input, h("span", { text: tab.long }),
      h("span", { class: "tally", text: String(tally(tab)) })));
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
      group.append(h("label", { class: "choice" }, input, h("span", { text: channelLabel(channel) }),
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

/** One stale application: what it was, how long ago, and the two quiet things
 * the person may do about it. Nothing here sends (AGENTS.md section 2). */
function followUpLine(item, refresh) {
  const line = h("div", { class: "nudge-row" });
  const main = h("div", { class: "row-main" });
  main.append(h("a", { class: "row-title", href: `#/row/${encodeURIComponent(item.id)}`, text: item.title || "Untitled role" }));
  if (item.company) main.append(h("span", { class: "row-co", text: item.company }));
  main.append(h("span", { class: "row-where", text: `${item.days_since} days, no reply` }));
  line.append(main);
  const buttons = h("div", { class: "row-control" });
  buttons.append(routeButton(item, {
    label: "Mark responded", path: "outcome", body: { status: "responded", note: "recorded from the follow-up strip" }, small: true,
  }, refresh));
  if (item.nudge) {
    const copy = h("button", { type: "button", class: "btn sm", text: "Copy nudge" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.nudge);
        toast("The nudge is on the clipboard. Send it yourself.");
      } catch { toast("This browser will not let the page write to the clipboard.", "bad"); }
    });
    buttons.append(copy);
  }
  line.append(buttons);
  return line;
}

/** How many stale applications the strip shows before it folds. Past this it
 * stops being a strip above the list and becomes a second list. */
const FOLLOW_UP_SHOWN = 8;

/** The strip above the Sent list: who has gone quiet. Drafts only. */
async function followUpStrip(refresh) {
  let data = null;
  try { data = await api("followups?days=7"); } catch { return null; }
  const rows = (data && data.rows) || [];
  if (!rows.length) return null;
  const body = h("div", { class: "nudges" });
  for (const item of rows.slice(0, FOLLOW_UP_SHOWN)) body.append(followUpLine(item, refresh));
  if (rows.length > FOLLOW_UP_SHOWN) {
    const more = h("button", { type: "button", class: "btn sm", text: `Show all ${rows.length}` });
    more.addEventListener("click", () => {
      more.remove();
      for (const item of rows.slice(FOLLOW_UP_SHOWN)) body.append(followUpLine(item, refresh));
    });
    body.append(more);
  }
  const title = rows.length === 1
    ? "1 application with no reply after 7 days"
    : `${rows.length} applications with no reply after 7 days`;
  const card = panel(title, body);
  card.classList.add("nudge-card");
  card.append(h("p", { class: "grey small", text: "Nothing is sent from here. Copy the nudge and send it yourself." }));
  return card;
}

/** `which` is the tab key from the address (#/applications/waiting), so Home
 * can link straight at the bucket it is talking about. */
export async function viewApplications(view, which) {
  if (which && TABS.some((t) => t.key === which)) appState.tab = which;
  const tab = TABS.find((t) => t.key === appState.tab) || TABS[0];
  await loadReasonHelper();
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
  const column = h("div", { class: "board" });
  const list = h("div", { class: "rows" });
  list.append(h("p", { class: "empty", text: "Loading rows." }));
  column.append(list);
  layout.append(column);
  view.append(head, layout);

  const params = new URLSearchParams({ status: tab.status });
  if (tab.limit) params.set("limit", String(tab.limit));
  const data = await fetchInto(list, `rows?${params.toString()}`, "Could not load rows.");
  if (!data) return;
  rememberLaneCounts(tab.status, data);
  let rows = data.rows || [];
  // To approve is the person's queue and nothing else.
  if (tab.key === "waiting") rows = rows.filter(needsYou);
  if (tab.key === "shortlisted") {
    // The approved rows the run is carrying are not waiting on anybody, so
    // they are read with the rest of the queue instead of in To approve.
    const carried = await api("rows?status=awaiting_approval").catch(() => null);
    rememberLaneCounts("awaiting_approval", carried);
    if (carried) rows = rows.concat((carried.rows || []).filter(isInFlight));
  }
  const paint = () => {
    clear(list);
    const shown = visibleRows(rows);
    $("#row-count").textContent = shown.length === 1 ? "1 row" : `${shown.length} rows`;
    if (!shown.length) {
      list.append(h("p", { class: "empty", text: rows.length ? "No row matches these filters. Widen them to see more." : EMPTY[tab.key] }));
      return;
    }
    for (const row of shown) list.append(jobRow(row, () => render()));
  };
  layout.prepend(filterCard(rows, paint));
  paint();
  if (tab.key === "sent") {
    const strip = await followUpStrip(() => render());
    if (strip) column.prepend(strip);
  }
}
