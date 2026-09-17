/*
 * app.js - the whole local harness UI. No framework, no build step, no CDN.
 * One ES module, fetched from the same local origin that serves /api, so
 * nothing about the person's pipeline leaves the machine.
 *
 * AGENTS.md rules encoded here, each marked again at the point it bites:
 * section 2, this UI never submits: every button posts a decision to the local
 * pipeline, and the kill switch and autopilot state are always on screen.
 * Section 9, keyword confirmations use exactly four fixed answers, recommended
 * first, in bundles of at most four. Section 3, no em or en dashes, and
 * Australian English throughout.
 */

// --- Constants ---

/** Hash routes: #/queue, #/row/<id>, #/keywords, #/today, #/digest. */
const ROUTES = ["queue", "row", "keywords", "today", "digest"];

/** Queue tabs. Submitted is capped at the most recent 30 rows. */
const TABS = [
  { key: "awaiting", label: "Awaiting", status: "awaiting_approval" },
  { key: "manual", label: "Manual", status: "manual_action_needed" },
  { key: "shortlisted", label: "Shortlisted", status: "shortlisted" },
  { key: "parked", label: "Parked", status: "parked" },
  { key: "submitted", label: "Submitted", status: "submitted", limit: 30 },
];

/** The counts strip in the header, in pipeline order. */
const COUNT_KEYS = [
  ["shortlisted", "shortlisted"],
  ["awaiting_approval", "awaiting"],
  ["manual_action_needed", "manual"],
  ["submitted", "submitted"],
  ["parked", "parked"],
];

/** The person's five decisions on a row. The server maps each to a transition. */
const ACTIONS = [
  { key: "approve", label: "Approve", primary: true },
  { key: "retry", label: "Retry" },
  { key: "reject", label: "Reject" },
  { key: "hold", label: "Hold" },
  { key: "withdraw", label: "Withdraw" },
];

/*
 * AGENTS.md section 9: keyword and market-lens confirmations use four fixed
 * answers and no others, recommended first. The labels are verbatim; the values
 * are what POST /api/keywords/record expects.
 */
const KEYWORD_OPTIONS = [
  { value: "confirm", label: "Confirm and update source (Recommended)" },
  { value: "na", label: "Not applicable" },
  { value: "familiarity", label: "Bring in as familiarity" },
  { value: "pending", label: "Unsure / keep pending" },
];

/** AGENTS.md section 9: never ask more than four at a time. */
const KEYWORD_BUNDLE = 4;

const APPLY_METHODS = {
  quick_apply: "Quick Apply",
  easy_apply: "Easy Apply",
  external: "External",
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
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      for (const [d, v] of Object.entries(value)) node.dataset[d] = String(v);
    } else node.setAttribute(key, value === true ? "" : String(value));
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

function badge(text, tone) {
  return h("span", { class: tone ? `badge ${tone}` : "badge", text });
}

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
  } catch (error) {
    throw new ApiError(0, `Cannot reach the harness server. Is it running? (${error.message})`);
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

// --- Minimal markdown: paragraphs and line breaks for letters, plus headings,
// --- lists and preformatted tables for the journal. Text nodes only.

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
  return out.length ? out : [h("p", { class: "muted", text: "(empty)" })];
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
  const flushTable = () => {
    if (!table) return;
    out.push(h("pre", { text: table.join("\n") })); // tables render as preformatted
    table = null;
  };
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
  return out.length ? out : [h("p", { class: "muted", text: "(empty)" })];
}

/** Package fields arrive as strings or as objects; show something either way. */
function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// --- Header ---

let summary = null;

async function loadSummary() {
  try {
    summary = await api("summary");
  } catch (error) {
    summary = null;
    renderHeader(error);
    return;
  }
  renderHeader(null);
}

function renderHeader(error) {
  const flags = $("#flags");
  const counts = $("#counts");
  clear(flags);
  clear(counts);
  if (!summary) {
    flags.append(badge(error ? "server unreachable" : "no summary", "bad"));
    return;
  }

  // AGENTS.md section 2: the kill switch and autopilot state are defence in
  // depth, so the person should never have to guess which lane is live.
  flags.append(
    summary.kill_switch ? badge("kill switch ON", "bad") : badge("kill switch off", "ok"),
    summary.autopilot_enabled ? badge("autopilot on", "ok") : badge("autopilot off", "warn"),
    badge(`sent today ${summary.sent_today ?? 0}`),
  );
  const byStatus = summary.counts || {};
  for (const [status, label] of COUNT_KEYS) {
    const count = h("span", { class: "count" });
    count.append(h("b", { text: String(byStatus[status] ?? 0) }), ` ${label}`);
    counts.append(count);
  }
  counts.append(h("span", { class: "count", text: `total ${summary.total ?? 0}` }));
  if (summary.generated_at) {
    counts.append(h("span", { class: "count", text: `as at ${when(summary.generated_at)}` }));
  }
}

function markNav(route) {
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function setupHeader() {
  const input = $("#token-input");
  const state = $("#token-state");
  const paint = () => {
    const token = readToken();
    state.textContent = token ? "saved in this browser" : "not set";
    if (token) $("#token-box").removeAttribute("open");
  };
  input.value = readToken();
  paint();
  $("#token-save").addEventListener("click", () => {
    writeToken(input.value.trim());
    paint();
    toast(input.value.trim() ? "Token saved." : "Token cleared.");
    render();
  });
  $("#token-clear").addEventListener("click", () => {
    writeToken("");
    input.value = "";
    paint();
    toast("Token cleared.");
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#token-save").click();
  });
  $("#refresh").addEventListener("click", () => { render(); });
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

/** Wire a button so the first press arms it and the second runs `run`. `run`
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
    button.textContent = `Confirm: ${label}`;
    button.setAttribute("aria-label", `Confirm ${label}. Press again to apply.`);
    button.focus();
  });
  return button;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") disarm();
});

// --- View: queue ---

const queueState = { tab: "awaiting", q: "", refocusFilter: false };

function applyMethodBadge(method) {
  if (!method) return null;
  const tone = method === "external" ? "warn" : "ok";
  return badge(APPLY_METHODS[method] || method, tone);
}

function rowCard(row) {
  const card = h("a", { class: "card", href: `#/row/${encodeURIComponent(row.id)}` });
  const bits = [row.company, row.location, row.channel].filter(Boolean);
  card.append(h("h3", { text: row.title || "(untitled role)" }),
    h("div", { class: "sub", text: bits.join(" / ") || "no company or location on the row" }));
  const meta = h("div", { class: "meta" });
  if (typeof row.score === "number") meta.append(badge(`score ${row.score.toFixed(1)}`));
  const method = applyMethodBadge(row.applyMethod);
  if (method) meta.append(method);
  // A job the person saved on the channel is an order to apply (AGENTS.md
  // section 2), so it is flagged on the card rather than buried in the detail.
  if (row.userSaved) meta.append(badge("saved", "star"));
  if (row.workArrangement) meta.append(badge(row.workArrangement));
  if (row.status) meta.append(badge(row.status));
  card.append(meta);
  if (row.reason) card.append(h("p", { class: "reason", text: row.reason }));
  card.append(h("p", { class: "reason", text: `updated ${when(row.updated_at) || "unknown"}` }));
  return card;
}

async function viewQueue(view) {
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Queue tabs" });
  for (const tab of TABS) {
    tabs.append(h("button", {
      type: "button",
      role: "tab",
      "aria-selected": String(tab.key === queueState.tab),
      text: tab.label,
      onClick: () => {
        queueState.tab = tab.key;
        render();
      },
    }));
  }
  const filter = h("input", {
    type: "search",
    class: "filter",
    placeholder: "Filter by title, company or location",
    "aria-label": "Filter the queue",
    value: queueState.q,
  });
  let debounce = 0;
  filter.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      queueState.q = filter.value.trim();
      queueState.refocusFilter = true; // the view is rebuilt, so put the caret back
      render();
    }, 250);
  });
  const list = h("div", { class: "cards" });
  list.append(h("p", { class: "empty", text: "Loading rows." }));
  view.append(h("h1", { text: "Queue" }), tabs, filter, list);
  if (queueState.refocusFilter) {
    queueState.refocusFilter = false;
    filter.focus();
    const end = filter.value.length;
    filter.setSelectionRange(end, end);
  }
  const tab = TABS.find((t) => t.key === queueState.tab) || TABS[0];
  const params = new URLSearchParams({ status: tab.status });
  if (tab.limit) params.set("limit", String(tab.limit));
  if (queueState.q) params.set("q", queueState.q);
  let data;
  try {
    data = await api(`rows?${params.toString()}`);
  } catch (error) {
    clear(list);
    list.append(errorBox(error, () => render()));
    return;
  }
  clear(list);
  const rows = data.rows || [];
  if (!rows.length) {
    list.append(h("p", {
      class: "empty",
      text: queueState.q
        ? `Nothing in ${tab.label.toLowerCase()} matches "${queueState.q}".`
        : `Nothing in ${tab.label.toLowerCase()} right now.`,
    }));
    return;
  }
  for (const row of rows) list.append(rowCard(row));
}

function errorBox(error, retry) {
  const box = h("div", { class: "error" });
  const unauthorised = error instanceof ApiError && (error.status === 401 || error.status === 403);
  box.append(h("p", { text: unauthorised
    ? "The server refused the request. Paste the API token in the header, then try again."
    : error.message }));
  if (retry) box.append(h("button", { type: "button", text: "Try again", onClick: retry }));
  return box;
}

// --- View: row detail ---

function criticPanel(critic) {
  const panel = h("section", { class: "panel" });
  panel.append(h("h2", { text: "Letter critic" }));
  if (!critic) {
    panel.append(h("p", { class: "muted", text: "No letter-critic verdict on this package yet." }));
    return panel;
  }
  const verdict = String(critic.verdict || critic.result || (critic.pass ? "pass" : "block")).toLowerCase();
  const pass = verdict === "pass" || critic.pass === true;
  panel.append(h("div", { class: "facts" }, badge(pass ? "pass" : "block", pass ? "ok" : "bad")));
  const findings = critic.findings || critic.issues || [];
  if (Array.isArray(findings) && findings.length) {
    const ul = h("ul", { class: "findings" });
    for (const finding of findings) {
      const text = typeof finding === "string" ? finding
        : [finding.severity, finding.rule || finding.kind, finding.message || finding.detail].filter(Boolean).join(": ");
      ul.append(h("li", { text: text || asText(finding) }));
    }
    panel.append(ul);
  } else if (!pass) {
    panel.append(h("p", { class: "muted", text: "Blocked, but the report listed no findings." }));
  } else {
    panel.append(h("p", { class: "muted", text: "No findings." }));
  }
  return panel;
}

function metadataPanel(row, metadata) {
  const panel = h("section", { class: "panel" });
  panel.append(h("h2", { text: "Package" }));
  const meta = (metadata && typeof metadata === "object") ? metadata : {};
  const pairs = [  // whatever the package recorded; blanks are dropped
    ["Resume", row.resumeId || meta.resume_id || meta.resumeId],
    ["Mode", meta.mode || meta.letter_mode],
    ["Template", meta.template],
    ["CV sha256", meta.resume_sha256 || meta.cv_sha256],
    ["Draft dir", row.draftDir],
    ["Apply method", APPLY_METHODS[row.applyMethod] || row.applyMethod],
    ["Channel", row.channel],
  ].filter(([, value]) => value);
  if (!pairs.length) {
    panel.append(h("p", { class: "muted", text: "No package metadata on this row." }));
  } else {
    const dl = h("dl", { class: "kv" });
    for (const [key, value] of pairs) {
      dl.append(h("dt", { text: key }), h("dd", { text: String(value) }));
    }
    panel.append(dl);
  }
  if (row.url) {
    panel.append(h("p", {}, h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" })));
  }
  return panel;
}

function historyPanel(history) {
  const panel = h("section", { class: "panel" });
  panel.append(h("h2", { text: "History" }));
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) {
    panel.append(h("p", { class: "muted", text: "No transitions recorded." }));
    return panel;
  }
  const ul = h("ul", { class: "history" });
  for (const entry of [...entries].reverse()) {
    const line = `${when(entry.at)}  ${entry.from || "?"} to ${entry.to || "?"}`;
    const li = h("li", { text: line });
    if (entry.reason) li.append(h("div", { text: entry.reason }));
    ul.append(li);
  }
  panel.append(ul);
  return panel;
}

function actionBar(row, onDone) {
  const bar = h("section", { class: "actions" });
  bar.append(h("h2", { text: "Your decision" }));
  const reason = h("input", { type: "text", "aria-label": "Reason (optional)", placeholder: "Reason (optional)" });
  const edits = h("textarea", { "aria-label": "Edits (optional)", placeholder: "Edits to the letter or package (optional)" });
  bar.append(h("div", { class: "action-fields" }, reason, edits));
  const buttons = h("div", { class: "action-buttons" });
  const all = [];
  for (const action of ACTIONS) {
    const button = h("button", { type: "button", class: action.primary ? "primary" : "", text: action.label });
    all.push(button);
    guarded(button, action.label, async () => {
      for (const b of all) b.disabled = true;
      try {
        const body = { action: action.key };
        if (reason.value.trim()) body.reason = reason.value.trim();
        if (edits.value.trim()) body.edits = edits.value.trim();
        const result = await api(`rows/${encodeURIComponent(row.id)}/action`, { method: "POST", body });
        toast(`${action.label}: now ${result.status_after}${result.queued ? " (queued)" : ""}.`);
        onDone();
      } catch (error) {
        // 409 means the pipeline state machine refused the transition. Show the
        // server's own reason rather than guessing at one.
        toast(error.status === 409 ? `Refused: ${error.message}` : error.message, "bad");
        for (const b of all) b.disabled = false;
      }
    });
    buttons.append(button);
  }
  bar.append(buttons);
  bar.append(h("p", {
    class: "muted",
    text: "Each button asks once: press, then press Confirm. Nothing is sent to a channel from here.",
  }));
  return bar;
}

async function viewRow(view, id) {
  view.append(h("p", { class: "empty", text: "Loading the row." }));
  let data;
  try {
    data = await api(`rows/${encodeURIComponent(id)}`);
  } catch (error) {
    clear(view);
    view.append(
      h("p", {}, h("a", { href: "#/queue", text: "Back to the queue" })),
      errorBox(error, () => render()),
    );
    return;
  }
  clear(view);
  const row = data.row || {};
  const pkg = data.package || {};
  view.append(h("p", {}, h("a", { href: "#/queue", text: "Back to the queue" })));
  view.append(h("h1", { text: row.title || "(untitled role)" }));
  view.append(h("p", { class: "muted", text: [row.company, row.location, row.channel].filter(Boolean).join(" / ") }));
  const facts = h("div", { class: "facts" });
  if (row.status) facts.append(badge(row.status));
  if (typeof row.score === "number") facts.append(badge(`score ${row.score.toFixed(1)}`));
  const method = applyMethodBadge(row.applyMethod);
  if (method) facts.append(method);
  if (row.userSaved) facts.append(badge("saved by you", "star"));
  if (row.workArrangement) facts.append(badge(row.workArrangement));
  if (row.first_seen_at) facts.append(badge(`first seen ${when(row.first_seen_at)}`));
  if (row.updated_at) facts.append(badge(`updated ${when(row.updated_at)}`));
  view.append(facts);
  if (row.reason) view.append(h("p", { class: "muted", text: row.reason }));

  // Side by side on a desktop, stacked on a phone (see .panels in app.css).
  const panels = h("div", { class: "panels" });
  const letter = h("section", { class: "panel" });
  const letterText = asText(pkg.cover_letter);
  letter.append(h("h2", { text: "Cover letter" }), letterText.trim()
    ? h("div", { class: "body" }, paragraphs(letterText))
    : h("p", { class: "muted", text: "No cover letter in this package." }));
  const jd = h("section", { class: "panel" });
  const jdText = asText(row.description || pkg.jd);
  jd.append(h("h2", { text: "Job description" }), jdText.trim()
    ? h("div", { class: "body" }, h("pre", { text: jdText }))
    : h("p", { class: "muted", text: "No job description stored for this row." }));
  panels.append(letter, jd);
  view.append(panels);
  const lower = h("div", { class: "panels" });
  lower.append(criticPanel(pkg.letter_critic), metadataPanel(row, pkg.metadata));
  view.append(lower);
  if (pkg.confirmation) {
    const conf = h("section", { class: "panel" });
    conf.append(h("h2", { text: "Confirmation" }), h("pre", { text: asText(pkg.confirmation) }));
    view.append(conf);
  }
  view.append(historyPanel(row.history));
  view.append(actionBar(row, () => {
    location.hash = "#/queue";
    render();
  }));
}

// --- View: keywords ---

async function viewKeywords(view) {
  view.append(h("h1", { text: "Keyword confirmations" }));
  const host = h("div", {});
  host.append(h("p", { class: "empty", text: "Loading pending terms." }));
  view.append(host);
  let data;
  try {
    data = await api(`keywords/pending?limit=${KEYWORD_BUNDLE}`);
  } catch (error) {
    clear(host);
    host.append(errorBox(error, () => render()));
    return;
  }
  clear(host);
  const terms = (data.terms || []).slice(0, KEYWORD_BUNDLE);
  const total = data.pending_total ?? terms.length;
  if (!terms.length) {
    host.append(h("p", { class: "empty", text: "Nothing pending. Every mined term has an answer." }));
    return;
  }
  host.append(h("p", { class: "muted", text: `${total} pending in all. Showing ${terms.length}, the most this UI will ask at once.` }));
  const form = h("form", {});
  form.addEventListener("submit", (event) => event.preventDefault());
  for (const item of terms) {
    const set = h("fieldset", { class: "term" });
    set.append(h("legend", { text: item.term }));
    const facts = [];
    if (item.count) facts.push(`seen ${item.count} times`);
    if (Array.isArray(item.resumes) && item.resumes.length) facts.push(`resumes: ${item.resumes.join(", ")}`);
    if (facts.length) set.append(h("p", { class: "muted", text: facts.join(" / ") }));
    if (item.context) set.append(h("p", { class: "muted", text: item.context }));
    const options = h("div", { class: "options" });
    // AGENTS.md section 9: exactly these four, recommended first, no free text.
    for (const option of KEYWORD_OPTIONS) {
      const input = h("input", {
        type: "radio",
        name: `term:${item.term}`,
        value: option.value,
        dataset: { term: item.term },
      });
      options.append(h("label", {}, input, h("span", { text: option.label })));
    }
    set.append(options);
    form.append(set);
  }
  const submit = h("button", { type: "button", class: "primary", text: "Record these" });
  guarded(submit, "Record these", async () => {
    const answers = {};
    for (const input of form.querySelectorAll("input[type=radio]:checked")) {
      answers[input.dataset.term] = input.value;
    }
    if (!Object.keys(answers).length) {
      toast("Choose an answer for at least one term first.", "bad");
      return;
    }
    submit.disabled = true;
    try {
      const result = await api("keywords/record", { method: "POST", body: { answers } });
      const parts = [`recorded ${result.recorded ?? 0}`];
      if (result.skipped_already_answered) parts.push(`${result.skipped_already_answered} already answered`);
      if (result.unmatched) parts.push(`${result.unmatched} unmatched`);
      if (result.invalid) parts.push(`${result.invalid} invalid`);
      toast(parts.join(", "));
      render(); // pull the next bundle
    } catch (error) {
      toast(error.message, "bad");
      submit.disabled = false;
    }
  });
  form.append(submit);
  form.append(h("p", {
    class: "muted",
    text: "A confirmed term authorises nothing on its own. The fact still has to be written into the CV source.",
  }));
  host.append(form);
}

// --- View: today ---

async function viewToday(view) {
  view.append(h("h1", { text: "Today" }));
  const host = h("div", { class: "panel" });
  host.append(h("p", { class: "muted", text: "Loading the journal." }));
  view.append(host);
  let data;
  try {
    data = await api("journal/today");
  } catch (error) {
    clear(host);
    host.append(errorBox(error, () => render()));
    return;
  }
  clear(host);
  if (data.date) host.append(h("p", { class: "muted", text: data.date }));  // the journal date the server used
  const markdown = String(data.markdown || "").trim();
  if (!markdown) {
    host.append(h("p", { class: "empty", text: "No journal entry for today yet." }));
    return;
  }
  host.append(h("div", { class: "markdown" }, richMarkdown(markdown)));
}

// --- View: digest ---

function copyButton(text) {
  const button = h("button", { type: "button", class: "ghost", text: "Copy" });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      toast("This browser blocked the clipboard. Select the text and copy it.", "bad");
    }
  });
  return button;
}

async function viewDigest(view) {
  view.append(h("h1", { text: "Critic digest" }));
  const host = h("div", {});
  host.append(h("p", { class: "empty", text: "Loading the digest." }));
  view.append(host);
  let data;
  try {
    data = await api("critic/digest?since=14d");
  } catch (error) {
    clear(host);
    host.append(errorBox(error, () => render()));
    return;
  }
  clear(host);
  host.append(h("div", { class: "facts" },
    badge(`since ${data.since || "14d"}`),
    badge(`verdicts ${data.verdicts ?? 0}`),
    badge(`blocked ${data.blocked ?? 0}`, data.blocked ? "warn" : "ok"),
  ));
  const themes = data.themes || [];
  if (!themes.length) {
    host.append(h("p", { class: "empty", text: "No recurring themes in this window." }));
    return;
  }
  const table = h("table", {});
  table.append(h("thead", {}, h("tr", {},
    h("th", { text: "Theme" }),
    h("th", { text: "Count" }),
    h("th", { text: "Sample" }),
    h("th", { text: "Proposed rule" }),
  )));
  const body = h("tbody", {});
  for (const theme of themes) {
    const ids = Array.isArray(theme.opportunity_ids) ? theme.opportunity_ids : [];
    const first = h("td", {}, h("div", { text: theme.key || "(unnamed)" }));
    if (ids.length) first.append(h("div", { class: "muted", text: ids.slice(0, 4).join(", ") }));
    const rule = h("td", {});
    if (theme.proposed_rule) {
      rule.append(h("div", { text: theme.proposed_rule }), copyButton(theme.proposed_rule));
    } else {
      rule.append(h("span", { class: "muted", text: "none proposed" }));
    }
    body.append(h("tr", {}, first,
      h("td", { text: String(theme.count ?? 0) }),
      h("td", { text: theme.sample || "" }),
      rule));
  }
  table.append(body);
  host.append(h("div", { class: "table-wrap" }, table));
  // AGENTS.md section 5: recurring findings become editorial rules, but the
  // person promotes them in an attended session. This view copies, never writes.
  host.append(h("p", {
    class: "muted",
    text: "Nothing here is written to the editorial rules. Copy a rule and promote it in an attended session.",
  }));
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
      if (!id) {
        view.append(h("p", { class: "empty", text: "No row id in the address. Pick one from the queue." }));
      } else {
        await viewRow(view, id);
      }
    } else if (route === "keywords") await viewKeywords(view);
    else if (route === "today") await viewToday(view);
    else if (route === "digest") await viewDigest(view);
    else await viewQueue(view);
  } catch (error) {
    if (mine !== renderToken) return;
    clear(view);
    view.append(errorBox(error, () => render()));
  }
}

window.addEventListener("hashchange", () => {
  document.getElementById("view").focus({ preventScroll: true });
  render();
});

setupHeader();
if (!location.hash) location.hash = "#/queue";
render();
