/*
 * app.js - the whole local harness UI. No framework, no build step, no CDN.
 * One ES module, fetched from the same local origin that serves /api, so
 * nothing about the person's pipeline leaves the machine.
 *
 * The shape of the thing: a plain job board for an autonomous job applicant.
 * The queue is a list of cards with a filter column beside it, and a row is a
 * detail page whose first line of numbers says whether the letter may go out:
 * the score, the critic verdict, the gate.
 *
 * AGENTS.md rules encoded here, marked again where they bite: section 2, this
 * UI never submits, and the kill switch is always on screen; section 9,
 * keyword confirmations use four fixed answers in bundles of at most four;
 * section 3, no em or en dashes, and Australian English throughout.
 */

// --- Constants ---

/** Hash routes: #/queue, #/row/<id>, #/keywords, #/today, #/digest. */
const ROUTES = ["queue", "row", "keywords", "today", "digest", "settings"];

/** Queue tabs, in the order the person works them. Sent is capped at 30 rows.
 * `label` is the short name, `long` is how the filter column says it. */
const TABS = [
  { key: "needs", label: "Needs you", long: "Needs you", status: "manual_action_needed", action: "retry" },
  { key: "waiting", label: "Waiting", long: "Waiting for you", status: "awaiting_approval", action: "approve" },
  { key: "shortlisted", label: "Shortlisted", long: "Shortlisted", status: "shortlisted", action: "approve" },
  { key: "parked", label: "Parked", long: "Parked", status: "parked", action: "retry" },
  { key: "sent", label: "Sent", long: "Sent", status: "submitted", limit: 30 },
];

/** What each tab says when it is empty: direction, not a shrug. */
const EMPTY = {
  needs: "Nothing needs you. The morning run adds rows here when a letter is blocked or a question is unanswered.",
  waiting: "Nothing is waiting on a decision. Prepared packages land here before they go out.",
  shortlisted: "Nothing is shortlisted. The hunt adds roles here once they fit and nothing blocks them.",
  parked: "Nothing is parked. Roles that do not fit, or cannot be done from Sydney, end up here.",
  sent: "Nothing has been sent yet. Submitted applications appear here, most recent first.",
};

/** The person's five decisions on a row. The server maps each to a transition. */
const ACTIONS = [
  { key: "approve", label: "Approve", primary: true }, { key: "retry", label: "Retry" },
  { key: "hold", label: "Hold" }, { key: "reject", label: "Reject", danger: true },
  { key: "withdraw", label: "Withdraw", danger: true },
];

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

/** Pipeline status in plain words. The raw keys are machinery: nobody reads
 * "manual_action_needed to manual_action_needed" and learns anything. */
const STATUS_LABELS = {
  discovered: "discovered", shortlisted: "shortlisted", drafted: "drafted",
  awaiting_approval: "waiting for you", approved: "approved", submission_pending: "sending",
  submitted: "sent", responded: "responded", interview: "interview", offered: "offered",
  won: "won", rejected: "rejected", withdrawn: "withdrawn", parked: "parked",
  awaiting_external: "waiting on them", manual_action_needed: "needs you",
};

/** A status the map has not met yet still reads as words, not as a key. */
function statusLabel(status) {
  if (!status) return "";
  return STATUS_LABELS[status] || String(status).replace(/_/g, " ");
}

/** Apply method in plain words, the way the person would say it out loud. */
const APPLY_METHODS = {
  quick_apply: "quick apply",
  easy_apply: "easy apply",
  external: "external",
};

// --- Tiny DOM helpers. Nodes only, never an HTML string, so a company name
// --- or a JD can never become markup.
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("raw html is not allowed");
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") for (const [d, v] of Object.entries(value)) node.dataset[d] = String(v);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);

function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}

/** A small uppercase section label, as the reference board uses. */
const eyebrow = (text) => h("p", { class: "eyebrow", text });

/** Local time, short. Falls back to the raw string when it is not a date. */
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

let toastTimer = 0;
function toast(message, tone) {
  const box = $("#toast");
  box.className = tone === "bad" ? "toast bad" : "toast";
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, tone === "bad" ? 8000 : 4000);
}

// --- Token and fetch ---

const TOKEN_KEY = "harnessUiToken";

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // private mode, or storage disabled: carry on without a token.
  }
}

function writeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    toast("This browser will not let the page store the token.", "bad");
  }
}

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body || {};
  }
}

/** Fetch /api/... relative to the page, so the UI works on whatever host and
 * port the local server picked. A pasted token goes out as a bearer header. */
async function api(path, options) {
  const opts = options || {};
  const headers = { Accept: "application/json" };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`api/${path.replace(/^\/?api\/?/, "").replace(/^\//, "")}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, "Could not reach the harness. Is the UI server still running? Refresh to try again.");
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, `The server replied with something that is not JSON (${response.status}).`);
    }
  }
  if (!response.ok) {
    const detail = data.error || data.message || `request failed (${response.status})`;
    throw new ApiError(response.status, detail, data);
  }
  return data;
}

// --- Minimal markdown: paragraphs for letters, plus headings, lists and
// --- preformatted tables for the journal. Text nodes only.
function paragraphs(source) {
  const out = [];
  for (const block of String(source).replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const p = h("p", {});
    lines.forEach((line, i) => {
      if (i) p.append(h("br", {}));
      p.append(document.createTextNode(line.trim()));
    });
    out.push(p);
  }
  return out.length ? out : [h("p", { class: "grey", text: "(empty)" })];
}

function richMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;
  let table = null;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push(...paragraphs(para.join("\n")));
    para = [];
  };
  const flushList = () => { if (list) { out.push(list); list = null; } };
  // A markdown table renders as preformatted text rather than as a grid.
  const flushTable = () => { if (table) { out.push(h("pre", { text: table.join("\n") })); table = null; } };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (line.trim().startsWith("|")) {
      flushPara();
      flushList();
      (table = table || []).push(line);
      continue;
    }
    flushTable();
    if (heading) {
      flushAll();
      const level = Math.min(3, heading[1].length + 1); // h1 is the view title
      out.push(h(`h${level}`, { text: heading[2].trim() }));
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      list = list || h("ul", {});
      list.append(h("li", { text: (bullet ? bullet[1] : numbered[1]).trim() }));
      continue;
    }
    flushList();
    if (line.trim() === "") flushPara();
    else para.push(line);
  }
  flushAll();
  return out.length ? out : [h("p", { class: "grey", text: "(empty)" })];
}

/** Package fields arrive as strings or as objects; show something either way. */
function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// --- Header ---

let summary = null;

async function loadSummary() {
  try {
    summary = await api("summary");
  } catch {
    summary = null;
  }
  renderHeader();
}

/** One sentence of counts: what needs the person, what is in flight, and which
 * lane is live. AGENTS.md section 2: the kill switch is never a click away. */
function renderHeader() {
  const standing = $("#standing");
  clear(standing);
  if (!summary) {
    standing.append(h("span", { class: "alarm", text: "Counts unavailable. Refresh to try again." }));
    return;
  }
  const c = summary.counts || {};
  const n = (key) => c[key] ?? 0;
  standing.append(
    `${n("manual_action_needed")} need you, ${n("awaiting_approval")} waiting, `
    + `${n("submitted")} sent, ${n("parked")} parked, `,
    summary.kill_switch
      ? h("span", { class: "alarm", text: "kill switch on" })
      : `autopilot ${summary.autopilot_enabled ? "on" : "off"}`,
  );
}

function markNav(route) {
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

// --- Inline confirm: the first press arms the button, a second press within
// --- the window commits. No browser dialogs anywhere.

const ARM_WINDOW_MS = 6000;
let armed = null;

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.button.classList.remove("armed");
  armed.button.textContent = armed.label;
  armed.button.setAttribute("aria-label", armed.label);
  armed = null;
}

/** Wire a button so the first press arms it and the second runs `run`, which
 * is only ever reached from a second, deliberate press. */
function guarded(button, label, run) {
  button.addEventListener("click", () => {
    if (armed && armed.button === button) {
      disarm();
      run();
      return;
    }
    disarm();
    armed = {
      button,
      label,
      timer: setTimeout(() => { disarm(); }, ARM_WINDOW_MS),
    };
    button.classList.add("armed");
    button.textContent = `Confirm ${label.toLowerCase()}`;
    button.setAttribute("aria-label", `Confirm ${label.toLowerCase()}. Press again to apply.`);
    button.focus();
  });
  return button;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") disarm();
});

/** A decision button: armed on the first press, committed on the second, and
 * posted to the local pipeline. It never submits to a channel (AGENTS.md
 * section 2); the worst it can do is move a row. */
function actionButton(row, action, fields, done) {
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

// --- View: queue ---

const queueState = { tab: "needs", sort: "score", channels: new Set(), minScore: "", filtersOpen: false };

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
  card.hidden = !queueState.filtersOpen && window.innerWidth < 900;
  const body = h("div", { class: "filters" });
  card.append(h("h2", { text: "Filters" }), body);
  const counts = (summary && summary.counts) || {};
  const statuses = h("div", { class: "filter-group" });
  statuses.append(eyebrow("Status"));
  for (const tab of TABS) {
    const input = h("input", { type: "radio", name: "queue-tab", checked: tab.key === queueState.tab });
    input.addEventListener("change", () => { queueState.tab = tab.key; render(); });
    statuses.append(h("label", { class: "choice" }, input, h("span", { text: tab.long }),
      h("span", { class: "tally", text: String(counts[tab.status] ?? 0) })));
  }
  body.append(statuses);
  const channels = [...new Set(rows.map((r) => r.channel).filter(Boolean))].sort();
  if (channels.length > 1) {
    const group = h("div", { class: "filter-group" });
    group.append(eyebrow("Channel"));
    for (const channel of channels) {
      const input = h("input", { type: "checkbox", checked: queueState.channels.has(channel) });
      input.addEventListener("change", () => {
        if (input.checked) queueState.channels.add(channel); else queueState.channels.delete(channel);
        repaint();
      });
      group.append(h("label", { class: "choice" }, input, h("span", { text: channel }),
        h("span", { class: "tally", text: String(rows.filter((r) => r.channel === channel).length) })));
    }
    body.append(group);
  }
  const score = h("div", { class: "filter-group" });
  score.append(eyebrow("Minimum score"));
  const input = h("input", { type: "number", min: "0", max: "100", step: "1", value: queueState.minScore, placeholder: "Any" });
  input.addEventListener("input", () => { queueState.minScore = input.value; repaint(); });
  body.append(score);
  score.append(input);
  return card;
}

/** Sort and floor the fetched rows the way the filter column says. */
function visibleRows(rows) {
  const floor = Number(queueState.minScore);
  const out = rows.filter((row) => {
    if (queueState.channels.size && !queueState.channels.has(row.channel)) return false;
    if (queueState.minScore !== "" && Number.isFinite(floor) && (row.score ?? 0) < floor) return false;
    return true;
  });
  return queueState.sort === "updated"
    ? out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    : out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

async function viewQueue(view) {
  const tab = TABS.find((t) => t.key === queueState.tab) || TABS[0];
  view.append(h("p", {
    class: "lede",
    text: "Job Hunt drafts and sends applications overnight. Decide here on anything it could not send.",
  }));
  const head = h("div", { class: "page-head" }, h("div", {},
    h("h1", { text: tab.long }), h("p", { class: "page-count", id: "row-count", text: "Loading rows." })));
  const toggle = h("button", { type: "button", class: "btn filters-toggle", text: "Filters" });
  toggle.addEventListener("click", () => {
    queueState.filtersOpen = !queueState.filtersOpen;
    const card = $("#filter-card");
    if (card) card.hidden = !queueState.filtersOpen;
  });
  const sort = h("select", { "aria-label": "Sort rows" });
  for (const [value, label] of [["score", "Score"], ["updated", "Updated"]]) {
    sort.append(h("option", { value, selected: queueState.sort === value, text: label }));
  }
  sort.addEventListener("change", () => { queueState.sort = sort.value; render(); });
  head.append(h("div", { class: "sorter" }, toggle, h("span", { text: "Sort" }), sort));
  const layout = h("div", { class: "layout" });
  const list = h("div", { class: "cards" });
  list.append(h("p", { class: "empty", text: "Loading rows." }));
  layout.append(list);
  view.append(head, layout);

  const params = new URLSearchParams({ status: tab.status });
  if (tab.limit) params.set("limit", String(tab.limit));
  let data;
  try {
    data = await api(`rows?${params.toString()}`);
  } catch (error) {
    clear(list);
    list.append(errorBox(error, "Could not load rows.", () => render()));
    return;
  }
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

/** Errors say what happened and what to do about it. */
function errorBox(error, what, retry) {
  const box = h("div", { class: "error" });
  const unauthorised = error instanceof ApiError && (error.status === 401 || error.status === 403);
  box.append(h("p", {
    text: unauthorised
      ? `${what} The server refused it. Open Settings from the header, paste the token, then try again.`
      : `${what} ${error.message}`,
  }));
  if (retry) box.append(h("button", { type: "button", class: "btn", text: "Try again", onClick: retry }));
  return box;
}

// --- View: row detail ---

/** One small card in the stats row: a label, a verdict, and a quiet note. */
function stat(label, value, tone, note) {
  const card = h("div", { class: tone ? `card stat ${tone}` : "card stat" });
  card.append(eyebrow(label), h("p", { class: "value", text: value }));
  if (note) card.append(h("p", { class: "note", text: note }));
  return card;
}


/** The stats row: the machine verdicts that decide whether a letter may go out.
 * A missing verdict says so; it is never read as a pass (AGENTS.md section 8). */
function statsRow(row, pkg) {
  const stats = h("div", { class: "stats", "aria-label": "Gates" });
  stats.append(typeof row.score === "number"
    ? stat("Score", String(Math.round(row.score)), "good")
    : stat("Score", "Not scored", ""));
  const critic = pkg.letter_critic;
  if (!critic) stats.append(stat("Critic", "Critic not run", "", "No letter has been critiqued on this row."));
  else {
    const findings = Array.isArray(critic.findings) ? critic.findings : [];
    const count = (severity) => findings.filter((f) => f && f.severity === severity).length;
    stats.append(String(critic.verdict || "").toLowerCase() !== "pass"
      ? stat("Critic", `Critic blocked, ${count("fail")} fail`, "bad")
      : stat("Critic", `Critic pass, ${count("warn")} warn`, "good"));
  }
  const quality = (pkg.metadata && typeof pkg.metadata === "object" && pkg.metadata.quality) || {};
  const notes = [];
  for (const [label, keys] of [["Slop", ["slop", "slopKiller", "slop_killer"]], ["Voice", ["voice", "voiceCheck", "voice_check"]]]) {
    const raw = keys.map((k) => quality[k]).find((v) => v !== undefined && v !== null);
    if (raw === undefined) notes.push(`${label} not recorded`);
    else notes.push(`${label} ${raw === true || String(raw).toLowerCase() === "pass" ? "pass" : "fail"}`);
  }
  const sent = row.status === "submitted";
  stats.append(stat("Gate", sent ? "Gate passed" : `Gate waiting, ${statusLabel(row.status)}`, sent ? "good" : "", notes.join(". ") + "."));
  return stats;
}

function panel(title, body) {
  const card = h("section", { class: "card" });
  card.append(h("h2", { text: title }), body);
  return card;
}

function findingsBlock(critic) {
  const findings = critic && Array.isArray(critic.findings) ? critic.findings : [];
  if (!findings.length) return null;
  const ul = h("ul", { class: "findings" });
  for (const finding of findings) {
    const text = typeof finding === "string" ? finding : [
      finding.severity === "fail" ? "Fail" : finding.severity === "warn" ? "Warn" : finding.severity,
      finding.issue || finding.message,
      finding.fix,
    ].filter(Boolean).map((part) => String(part).trim().replace(/\.+$/, "")).join(". ") + ".";
    ul.append(h("li", { text: text || asText(finding) }));
  }
  return panel("Critic findings", ul);
}

function historyBlock(history) {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) return panel("History", h("p", { class: "grey", text: "No transitions recorded on this row yet." }));
  const ul = h("ul", { class: "history" });
  for (const item of [...entries].reverse()) {
    const li = h("li", {});
    const from = item.from ? statusLabel(item.from) : "new";
    li.append(h("span", { class: "at", text: `${when(item.at)}  ` }), `${from} to ${statusLabel(item.to) || "unknown"}`);
    // A field_update entry is an enrichment pass, not a decision: say which
    // fields moved and keep the raw machinery off the page.
    const fields = /^field_update:\s*([^([]*)/.exec(item.reason || "");
    if (fields) li.append(h("div", { class: "grey small", text: `updated ${fields[1].trim() || "some fields"}` }));
    else if (item.reason) li.append(h("div", { class: "grey small", text: item.reason }));
    ul.append(li);
  }
  return panel("History", ul);
}

function actionBar(row, onDone) {
  const buttons = h("div", { class: "action-buttons" });
  const reason = h("input", { type: "text", "aria-label": "Reason, optional", placeholder: "Reason, optional" });
  const edits = h("textarea", { "aria-label": "Edits, optional", placeholder: "Edits to the letter or package, optional" });
  const fields = () => {
    const out = {};
    if (reason.value.trim()) out.reason = reason.value.trim();
    if (edits.value.trim()) out.edits = edits.value.trim();
    return out;
  };
  for (const action of ACTIONS) buttons.append(actionButton(row, action, fields, onDone));
  return panel("Your decision", h("div", {}, buttons, h("div", { class: "action-fields" }, reason, edits),
    h("p", { class: "grey small", text: "Each button asks twice: press, then press Confirm. Nothing is sent to a channel from here." })));
}

async function viewRow(view, id) {
  view.append(h("p", { class: "empty", text: "Loading the row." }));
  let data;
  try {
    data = await api(`rows/${encodeURIComponent(id)}`);
  } catch (error) {
    clear(view);
    view.append(h("p", { class: "backlink" }, h("a", { href: "#/queue", text: "Queue" })),
      errorBox(error, "Could not load this row.", () => render()));
    return;
  }
  clear(view);
  const row = data.row || {};
  const pkg = data.package || {};
  view.append(h("p", { class: "backlink" }, h("a", { href: "#/queue", text: "Queue" })),
    h("h1", { text: row.title || "Untitled role" }));
  const facts = [
    row.company, row.location, row.classification?.work_arrangement || row.workArrangement,
    APPLY_METHODS[row.applyMethod] || row.applyMethod,
    row.userSaved ? "saved by you" : null, statusLabel(row.status) || null,
  ].filter(Boolean);
  const line = h("p", { class: "detail-meta", text: `${facts.join(", ")}. ` });
  if (row.url) line.append(h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" }));
  view.append(line);
  const reasonLine = data.reason || row.reason;
  if (reasonLine) view.append(h("p", { class: "detail-reason", text: reasonLine }));

  view.append(statsRow(row, pkg));

  // Letter left at reading measure, JD right and quieter. Stacked on a phone,
  // letter first, because the letter is what the decision is about.
  const columns = h("div", { class: "columns" });
  const letterText = asText(pkg.cover_letter);
  columns.append(panel("Cover letter", letterText.trim()
    ? h("div", { class: "letter" }, paragraphs(letterText))
    : h("p", { class: "grey", text: "No cover letter in this package. Retry to have the harness draft one." })));
  const jdText = asText(row.description || pkg.jd);
  columns.append(panel("Job description", jdText.trim()
    ? h("div", { class: "jd" }, h("pre", { text: jdText }))
    : h("p", { class: "grey", text: "No job description stored for this row. Open the advert to read it." })));
  view.append(columns);

  const rest = h("div", { class: "stack" });
  const findings = findingsBlock(pkg.letter_critic);
  if (findings) rest.append(findings);
  rest.append(historyBlock(row.history), actionBar(row, () => { location.hash = "#/queue"; render(); }));
  view.append(rest);
}

// --- View: keywords ---

async function viewKeywords(view) {
  view.append(h("h1", { text: "Keywords" }));
  const host = h("div", { class: "stack" });
  host.append(h("p", { class: "empty", text: "Loading pending terms." }));
  view.append(host);
  let data;
  try {
    data = await api(`keywords/pending?limit=${KEYWORD_BUNDLE}`);
  } catch (error) {
    clear(host);
    host.append(errorBox(error, "Could not load the pending terms.", () => render()));
    return;
  }
  clear(host);
  const terms = (data.terms || []).slice(0, KEYWORD_BUNDLE);
  const total = data.pending_total ?? terms.length;
  if (!terms.length) {
    host.append(h("p", { class: "empty", text: "Nothing pending. Every mined term has an answer. The next hunt will add more." }));
    return;
  }

  view.insertBefore(h("p", { class: "page-count", text: `${total} pending.` }), host);
  const form = h("form", {});
  form.addEventListener("submit", (event) => event.preventDefault());
  for (const item of terms) {
    const set = h("fieldset", { class: "term" });
    set.append(h("legend", { text: item.term }));
    const facts = [];
    if (item.count) facts.push(item.count === 1 ? "seen once" : `seen ${item.count} times`);
    if (Array.isArray(item.resumes) && item.resumes.length) facts.push(item.resumes.join(", "));
    if (item.context) facts.push(item.context);
    if (facts.length) set.append(h("p", { class: "context", text: facts.join(". ") }));
    const options = h("div", { class: "options" });
    // AGENTS.md section 9: exactly these four, recommended first, no free text.
    for (const option of KEYWORD_OPTIONS) {
      const input = h("input", { type: "radio", name: `term:${item.term}`, value: option.value, dataset: { term: item.term } });
      options.append(h("label", {}, input, h("span", { text: option.label })));
    }
    set.append(options);
    form.append(set);
  }
  const submit = h("button", { type: "button", class: "btn primary", text: "Record these" });
  guarded(submit, "Record these", async () => {
    const answers = {};
    for (const input of form.querySelectorAll("input[type=radio]:checked")) answers[input.dataset.term] = input.value;
    if (!Object.keys(answers).length) return toast("Choose an answer for at least one term first.", "bad");
    submit.disabled = true;
    try {
      const result = await api("keywords/record", { method: "POST", body: { answers } });
      const parts = [`Recorded ${result.recorded ?? 0}.`];
      if (result.skipped_already_answered) parts.push(`${result.skipped_already_answered} already answered.`);
      if (result.unmatched) parts.push(`${result.unmatched} unmatched.`);
      toast(parts.join(" "));
      render(); // pull the next bundle
    } catch (error) {
      toast(error.message, "bad");
      submit.disabled = false;
    }
  });
  form.append(submit, h("p", { class: "grey small",
    text: "A confirmed term authorises nothing on its own. The fact still has to be written into the CV source." }));
  host.append(form);
}

// --- View: today ---

async function viewToday(view) {
  view.append(h("h1", { text: "Today" }));
  const host = h("div", {});
  host.append(h("p", { class: "empty", text: "Loading the journal." }));
  view.append(host);
  let data;
  try {
    data = await api("journal/today");
  } catch (error) {
    clear(host);
    host.append(errorBox(error, "Could not load today's summary.", () => render()));
    return;
  }
  clear(host);
  const markdown = String(data.markdown || "").trim();
  if (!markdown) {
    host.append(h("p", { class: "empty", text: "No entry for today yet. The morning run writes one when it finishes." }));
    return;
  }
  if (data.date) view.insertBefore(h("p", { class: "page-count", text: data.date }), host);
  host.append(panel("Journal", h("div", { class: "prose" }, richMarkdown(markdown))));
}

// --- View: digest ---

function copyButton(text) {
  const button = h("button", { type: "button", class: "btn", text: "Copy rule" });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Rule copied.");
    } catch { toast("This browser blocked the clipboard. Select the rule and copy it.", "bad"); }
  });
  return button;
}

async function viewDigest(view) {
  view.append(h("h1", { text: "Digest" }));
  const host = h("div", { class: "cards" });
  host.append(h("p", { class: "empty", text: "Loading the digest." }));
  view.append(host);
  let data;
  try {
    data = await api("critic/digest?since=14d");
  } catch (error) {
    clear(host);
    host.append(errorBox(error, "Could not load the critic digest.", () => render()));
    return;
  }
  clear(host);
  const themes = data.themes || [];
  view.insertBefore(h("p", { class: "page-count",
    text: `Last 14 days. ${data.verdicts ?? 0} verdicts, ${data.blocked ?? 0} blocked.` }), host);
  if (!themes.length) {
    host.append(h("p", { class: "empty", text: "No recurring themes in this window. Nothing to promote into the editorial rules." }));
    return;
  }
  for (const theme of themes) {
    const card = h("article", { class: "card" });
    card.append(h("h3", {}, h("span", { class: "digest-count", text: String(theme.count ?? 0) }),
      h("span", { text: theme.key || "unnamed theme" })));
    if (theme.sample) card.append(h("p", { class: "sample", text: theme.sample }));
    if (theme.proposed_rule) {
      card.append(h("div", { class: "proposed" }, h("div", { text: theme.proposed_rule }), copyButton(theme.proposed_rule)));
    }
    host.append(card);
  }
  // AGENTS.md section 5: recurring findings become editorial rules, but the
  // person promotes them in an attended session. This view copies, never writes.
  host.append(h("p", {
    class: "grey small",
    text: "Nothing here is written to the editorial rules. Copy a rule and promote it in an attended session.",
  }));
}

// --- View: settings ---

/** The commands the README gives for running this UI. */
const COMMANDS = [
  "npm run ui -- --open",
  "bash scripts/install-ui-launchd.sh",
  "npm run ui -- --host 100.x.y.z   # a Tailscale address, with HARNESS_UI_TOKEN set",
  "sheet:\n  enabled: false   # the local UI is the approval surface",
];

function viewSettings(view) {
  view.append(h("h1", { text: "Settings" }));
  const stack = h("div", { class: "stack" });
  const input = h("input", { type: "password", id: "token-input", autocomplete: "off",
    spellcheck: "false", placeholder: "Paste once", "aria-label": "API token" });
  input.value = readToken();
  const state = h("p", { class: "grey small", id: "token-state" });
  const paint = () => {
    state.textContent = readToken() ? "A token is set in this browser." : "No token is set in this browser.";
  };
  paint();

  const show = h("button", { type: "button", class: "btn", text: "Show" });
  show.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    show.textContent = hidden ? "Hide" : "Show";
  });
  const save = h("button", { type: "button", class: "btn primary", text: "Save" });
  save.addEventListener("click", () => {
    writeToken(input.value.trim());
    paint();
    toast(input.value.trim() ? "Token saved." : "Token cleared.");
  });
  const wipe = h("button", { type: "button", class: "btn", text: "Clear" });
  wipe.addEventListener("click", () => { writeToken(""); input.value = ""; paint(); toast("Token cleared."); });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });
  const token = h("div", {},
    h("p", { class: "grey small measure", text: "Stored in this browser only and sent as a bearer header on every call. It is needed only when the server is reached from another device, such as a phone over Tailscale." }),
    h("div", { class: "token-fields" }, input, h("div", { class: "action-buttons" }, save, wipe, show)),
    state);
  stack.append(panel("API token", token));
  stack.append(panel("This browser", h("ul", { class: "history" },
    h("li", { text: `Serving from ${location.origin}` }),
    h("li", { text: readToken() ? "This browser holds a token." : "This browser holds no token." }))));
  stack.append(panel("About", h("pre", { class: "commands", text: COMMANDS.join("\n\n") })));
  view.append(stack);
}

// --- Router ---

function parseHash() {
  const raw = (location.hash || "#/queue").replace(/^#\/?/, "");
  const [name, ...rest] = raw.split("/");
  const route = ROUTES.includes(name) ? name : "queue";
  return { route, id: rest.length ? decodeURIComponent(rest.join("/")) : "" };
}

let renderToken = 0;

async function render() {
  disarm();
  const mine = ++renderToken;
  const { route, id } = parseHash();
  markNav(route === "row" ? "queue" : route);
  const view = $("#view");
  clear(view);
  await loadSummary();
  if (mine !== renderToken) return;
  try {
    if (route === "row") {
      if (id) await viewRow(view, id);
      else view.append(h("p", { class: "empty", text: "No row id in the address. Pick one from the queue." }));
    } else if (route === "keywords") await viewKeywords(view);
    else if (route === "today") await viewToday(view);
    else if (route === "digest") await viewDigest(view);
    else if (route === "settings") viewSettings(view);
    else await viewQueue(view);
  } catch (error) {
    if (mine !== renderToken) return;
    clear(view);
    view.append(errorBox(error, "Could not draw this view.", () => render()));
  }
}

window.addEventListener("hashchange", () => {
  document.getElementById("view").focus({ preventScroll: true });
  render();
});

if (!location.hash) location.hash = "#/queue";
render();
