/*
 * app.js - the whole local harness UI. No framework, no build step, no CDN.
 * One ES module, fetched from the same local origin that serves /api, so
 * nothing about the person's pipeline leaves the machine.
 *
 * The shape of the thing: a control room for an autonomous job applicant. The
 * queue is a ledger, a row is a dossier, and the gate strip at the top of the
 * dossier is the part the person reads first: did the critic pass, did slop and
 * voice pass, is the gate open. Everything else is supporting detail.
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

/** Queue tabs, in the order the person works them. Sent is capped at 30 rows. */
const TABS = [
  { key: "needs", label: "Needs you", status: "manual_action_needed" },
  { key: "waiting", label: "Waiting", status: "awaiting_approval" },
  { key: "shortlisted", label: "Shortlisted", status: "shortlisted" },
  { key: "parked", label: "Parked", status: "parked" },
  { key: "sent", label: "Sent", status: "submitted", limit: 30 },
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
  { key: "approve", label: "Approve" },
  { key: "retry", label: "Retry" },
  { key: "reject", label: "Reject", danger: true },
  { key: "hold", label: "Hold" },
  { key: "withdraw", label: "Withdraw", danger: true },
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

/**
 * Pipeline status in plain words. The raw keys are machinery: nobody reads
 * "manual_action_needed to manual_action_needed" and learns anything. One map,
 * used everywhere a status reaches the page.
 */
const STATUS_LABELS = {
  discovered: "discovered",
  shortlisted: "shortlisted",
  drafted: "drafted",
  awaiting_approval: "waiting for you",
  approved: "approved",
  submission_pending: "sending",
  submitted: "sent",
  responded: "responded",
  interview: "interview",
  offered: "offered",
  won: "won",
  rejected: "rejected",
  withdrawn: "withdrawn",
  parked: "parked",
  awaiting_external: "waiting on them",
  manual_action_needed: "needs you",
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
  return out.length ? out : [h("p", { class: "slate", text: "(empty)" })];
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
  return out.length ? out : [h("p", { class: "slate", text: "(empty)" })];
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

function setupHeader() {
  const input = $("#token-input");
  const state = $("#token-state");
  const paint = () => {
    const token = readToken();
    state.textContent = token ? "Saved in this browser." : "Not set.";
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
 * is only ever reached from a second, deliberate press. The arming is a label
 * change and a fill, never an animation. */
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

// --- View: queue ---

const queueState = { tab: "needs" };

/** Score as a number and a short bar. Scores are 0 to 100 in the pipeline, but
 * an older 0 to 10 row should not draw a full bar, so scale on what is there. */
function scoreBar(score) {
  const scale = score > 10 ? 100 : 10;
  const pct = Math.max(0, Math.min(100, (score / scale) * 100));
  const box = h("span", { class: "score" });
  box.append(
    h("span", { text: String(Math.round(score)) }),
    h("span", { class: "track", role: "img", "aria-label": `score ${Math.round(score)} of ${scale}` },
      h("span", { class: "fill", style: `width: ${pct.toFixed(0)}%` })),
  );
  return box;
}

/** One ledger line: two rows of type, a hairline, and nothing else. */
function entry(row) {
  const link = h("a", { class: "entry", href: `#/row/${encodeURIComponent(row.id)}` });
  const head = h("div", { class: "entry-head" });
  const main = h("div", { class: "entry-main" });
  main.append(h("span", { class: "entry-title", text: row.title || "Untitled role" }));
  const bits = [row.company, row.location, APPLY_METHODS[row.applyMethod] || row.applyMethod]
    .filter(Boolean).join(", ");
  // A job the person saved on the channel is an order to apply (AGENTS.md
  // section 2), so it is said on the line rather than buried in the detail.
  const line = row.userSaved ? `${bits}, saved by you` : bits;
  if (line) main.append(h("span", { class: "entry-bits", text: line }));
  head.append(main);
  if (typeof row.score === "number") head.append(scoreBar(row.score));
  link.append(head);
  link.append(h("p", { class: "entry-reason", text: row.reason || `Updated ${when(row.updated_at) || "at an unknown time"}.` }));
  return link;
}

async function viewQueue(view) {
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Queue" });
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
  const list = h("div", { class: "ledger" });
  list.append(h("p", { class: "empty", text: "Loading rows." }));
  view.append(tabs, list);
  const tab = TABS.find((t) => t.key === queueState.tab) || TABS[0];
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
  clear(list);
  const rows = data.rows || [];
  if (!rows.length) {
    list.append(h("p", { class: "empty", text: EMPTY[tab.key] }));
    return;
  }
  for (const row of rows) list.append(entry(row));
}

/** Errors say what happened and what to do about it. */
function errorBox(error, what, retry) {
  const box = h("div", { class: "error" });
  const unauthorised = error instanceof ApiError && (error.status === 401 || error.status === 403);
  box.append(h("p", {
    text: unauthorised
      ? `${what} The server refused the request. Open API token in the header, paste the token, then try again.`
      : `${what} ${error.message}`,
  }));
  if (retry) box.append(h("button", { type: "button", text: "Try again", onClick: retry }));
  return box;
}

// --- View: row detail ---

/** One stamped entry on the gate strip. */
function gate(text, failed) {
  return h("span", { class: failed ? "gate fail" : "gate", text });
}

/**
 * The gate strip: the four machine verdicts that decide whether a letter may go
 * out, read left to right in the order they run. A missing verdict says so; it
 * is never quietly read as a pass (AGENTS.md section 8).
 */
function gateStrip(row, pkg) {
  const strip = h("div", { class: "gate-strip", "aria-label": "Gates" });
  const critic = pkg.letter_critic;
  if (!critic) {
    strip.append(gate("Critic not run", false));
  } else {
    const findings = Array.isArray(critic.findings) ? critic.findings : [];
    const fails = findings.filter((f) => f && f.severity === "fail").length;
    const warns = findings.filter((f) => f && f.severity === "warn").length;
    const blocked = String(critic.verdict || "").toLowerCase() !== "pass";
    strip.append(blocked
      ? gate(`Critic blocked, ${fails} fail`, true)
      : gate(`Critic pass, ${warns} warn`, false));
  }
  const quality = (pkg.metadata && typeof pkg.metadata === "object" && pkg.metadata.quality) || {};
  for (const [label, keys] of [["Slop", ["slop", "slopKiller", "slop_killer"]], ["Voice", ["voice", "voiceCheck", "voice_check"]]]) {
    const raw = keys.map((k) => quality[k]).find((v) => v !== undefined && v !== null);
    if (raw === undefined) strip.append(gate(`${label} not recorded`, false));
    else {
      const passed = raw === true || String(raw).toLowerCase() === "pass";
      strip.append(gate(`${label} ${passed ? "pass" : "fail"}`, !passed));
    }
  }
  strip.append(gate(row.status === "submitted"
    ? "Gate passed"
    : `Gate waiting, ${statusLabel(row.status)}`, false));
  return strip;
}

function findingsBlock(critic) {
  const findings = critic && Array.isArray(critic.findings) ? critic.findings : [];
  if (!findings.length) return null;
  const block = h("section", { class: "block" });
  block.append(h("h2", { text: "Critic findings" }));
  const ul = h("ul", { class: "findings" });
  for (const finding of findings) {
    const text = typeof finding === "string" ? finding : [
      finding.severity === "fail" ? "Fail" : finding.severity === "warn" ? "Warn" : finding.severity,
      finding.issue || finding.message,
      finding.fix,
    ].filter(Boolean).map((part) => String(part).trim().replace(/\.+$/, "")).join(". ") + ".";
    ul.append(h("li", { text: text || asText(finding) }));
  }
  block.append(ul);
  return block;
}

function historyBlock(history) {
  const block = h("section", { class: "block" });
  block.append(h("h2", { text: "History" }));
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) {
    block.append(h("p", { class: "slate", text: "No transitions recorded on this row yet." }));
    return block;
  }
  const ul = h("ul", { class: "history" });
  for (const item of [...entries].reverse()) {
    const li = h("li", {});
    const from = item.from ? statusLabel(item.from) : "new";
    li.append(h("span", { class: "at", text: `${when(item.at)}  ` }), `${from} to ${statusLabel(item.to) || "unknown"}`);
    // A field_update entry is an enrichment pass, not a decision: say which
    // fields moved and keep the raw machinery off the page.
    const fields = /^field_update:\s*([^([]*)/.exec(item.reason || "");
    if (fields) li.append(h("div", { class: "slate", text: `updated ${fields[1].trim() || "some fields"}` }));
    else if (item.reason) li.append(h("div", { class: "slate", text: item.reason }));
    ul.append(li);
  }
  block.append(ul);
  return block;
}

function actionBar(row, onDone) {
  const bar = h("section", { class: "actions" });
  bar.append(h("h2", { text: "Your decision" }));
  const buttons = h("div", { class: "action-buttons" });
  const reason = h("input", { type: "text", "aria-label": "Reason, optional", placeholder: "Reason, optional" });
  const edits = h("textarea", { "aria-label": "Edits, optional", placeholder: "Edits to the letter or package, optional" });
  const all = [];
  for (const action of ACTIONS) {
    const button = h("button", { type: "button", class: action.danger ? "danger" : "", text: action.label });
    all.push(button);
    guarded(button, action.label, async () => {
      for (const b of all) b.disabled = true;
      try {
        const body = { action: action.key };
        if (reason.value.trim()) body.reason = reason.value.trim();
        if (edits.value.trim()) body.edits = edits.value.trim();
        const result = await api(`rows/${encodeURIComponent(row.id)}/action`, { method: "POST", body });
        toast(`${action.label}: the row is now ${statusLabel(result.status_after)}.`);
        onDone();
      } catch (error) {
        // 409 means the pipeline state machine refused the transition. Show the
        // server's own reason rather than guessing at one.
        toast(error.status === 409 ? `Refused. ${error.message}` : error.message, "bad");
        for (const b of all) b.disabled = false;
      }
    });
    buttons.append(button);
  }
  bar.append(buttons);
  bar.append(h("div", { class: "action-fields" }, reason, edits));
  bar.append(h("p", {
    class: "slate small",
    text: "Each button asks twice: press, then press Confirm. Nothing is sent to a channel from here.",
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
      h("p", { class: "backlink" }, h("a", { href: "#/queue", text: "Back to the queue" })),
      errorBox(error, "Could not load this row.", () => render()),
    );
    return;
  }
  clear(view);
  const row = data.row || {};
  const pkg = data.package || {};
  view.append(h("p", { class: "backlink" }, h("a", { href: "#/queue", text: "Back to the queue" })));
  view.append(h("h1", { class: "dossier-title", text: row.title || "Untitled role" }));

  // The top block is one sentence, the way the person would say it.
  const facts = [
    row.company,
    row.location,
    row.classification?.work_arrangement || row.workArrangement,
    APPLY_METHODS[row.applyMethod] || row.applyMethod,
    typeof row.score === "number" ? `score ${Math.round(row.score)}` : null,
    row.userSaved ? "saved by you" : null,
    statusLabel(row.status) || null,
  ].filter(Boolean);
  const line = h("p", { class: "dossier-line", text: `${facts.join(", ")}. ` });
  if (row.url) line.append(h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" }));
  view.append(line);
  const reasonLine = data.reason || row.reason;
  if (reasonLine) view.append(h("p", { class: "dossier-reason", text: reasonLine }));

  view.append(gateStrip(row, pkg));

  // Letter left at reading measure, JD right and quieter. Stacked on a phone,
  // letter first, because the letter is what the decision is about.
  const columns = h("div", { class: "columns" });
  const letterText = asText(pkg.cover_letter);
  const letter = h("section", {});
  letter.append(h("h2", { text: "Cover letter" }), letterText.trim()
    ? h("div", { class: "letter" }, paragraphs(letterText))
    : h("p", { class: "slate", text: "No cover letter in this package. Retry to have the harness draft one." }));
  const jdText = asText(row.description || pkg.jd);
  const jd = h("section", {});
  jd.append(h("h2", { text: "Job description" }), jdText.trim()
    ? h("div", { class: "jd" }, h("pre", { text: jdText }))
    : h("p", { class: "slate", text: "No job description stored for this row. Open the advert to read it." }));
  columns.append(letter, jd);
  view.append(columns);

  const findings = findingsBlock(pkg.letter_critic);
  if (findings) view.append(findings);
  view.append(historyBlock(row.history));
  view.append(actionBar(row, () => {
    location.hash = "#/queue";
    render();
  }));
}

// --- View: keywords ---

async function viewKeywords(view) {
  view.append(h("h1", { text: "Keywords" }));
  const host = h("div", {});
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
  form.append(submit);
  form.append(h("p", { class: "slate small", text: `${total} pending.` }));
  form.append(h("p", {
    class: "slate small",
    text: "A confirmed term authorises nothing on its own. The fact still has to be written into the CV source.",
  }));
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
  if (data.date) host.append(h("p", { class: "slate small", text: data.date }));
  host.append(h("div", { class: "prose" }, richMarkdown(markdown)));
}

// --- View: digest ---

function copyButton(text) {
  const button = h("button", { type: "button", class: "quiet", text: "Copy rule" });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Rule copied.");
    } catch {
      toast("This browser blocked the clipboard. Select the rule and copy it.", "bad");
    }
  });
  return button;
}

async function viewDigest(view) {
  view.append(h("h1", { text: "Digest" }));
  const host = h("div", {});
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
  host.append(h("p", { class: "slate small", text: `Last 14 days. ${data.verdicts ?? 0} verdicts, ${data.blocked ?? 0} blocked.` }));
  if (!themes.length) {
    host.append(h("p", { class: "empty", text: "No recurring themes in this window. Nothing to promote into the editorial rules." }));
    return;
  }
  const list = h("ul", { class: "digest" });
  for (const theme of themes) {
    const li = h("li", {});
    li.append(h("div", {},
      h("span", { class: "count", text: String(theme.count ?? 0) }),
      h("span", { text: theme.key || "unnamed theme" })));
    if (theme.sample) li.append(h("p", { class: "sample", text: theme.sample }));
    if (theme.proposed_rule) {
      li.append(h("div", { class: "rule" }, h("div", { text: theme.proposed_rule }), copyButton(theme.proposed_rule)));
    }
    list.append(li);
  }
  host.append(list);
  // AGENTS.md section 5: recurring findings become editorial rules, but the
  // person promotes them in an attended session. This view copies, never writes.
  host.append(h("p", {
    class: "slate small",
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
    view.append(errorBox(error, "Could not draw this view.", () => render()));
  }
}

window.addEventListener("hashchange", () => {
  document.getElementById("view").focus({ preventScroll: true });
  render();
});

setupHeader();
if (!location.hash) location.hash = "#/queue";
render();
