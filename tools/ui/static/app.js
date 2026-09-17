/*
 * app.js - the router, the header and the helpers every screen shares.
 *
 * No framework, no build step, no CDN. The screens live in their own modules
 * beside this one (home.js, applications.js, row.js, keywords.js, resumes.js,
 * today.js, digest.js, settings.js) and import what they need from here, so no
 * single file has to be read end to end to change one screen.
 *
 * The import graph is a cycle on purpose: this module imports each view, each
 * view imports these helpers back. That is safe only because nothing here or
 * there touches an imported binding at module scope; every use is inside a
 * function that runs after both modules have finished evaluating.
 *
 * AGENTS.md rules encoded here, marked again where they bite: section 2, this
 * UI never submits, and autopilot can be switched off from the header while the
 * kill switch sits on Settings behind an armed press; section 9, keyword
 * confirmations use four fixed answers; section 3, no em or en dashes, and
 * Australian English throughout.
 */

import { viewHome } from "./home.js";
import { viewApplications } from "./applications.js";
import { viewRow } from "./row.js";
import { viewResumes } from "./resumes.js";
import { viewKeywords } from "./keywords.js";
import { viewToday } from "./today.js";
import { viewDigest } from "./digest.js";
import { viewSettings } from "./settings.js";

// --- Constants ---

/** Hash routes, in nav order. #/queue is the old address for #/applications. */
export const ROUTES = ["home", "applications", "queue", "row", "resumes", "keywords", "today", "digest", "settings"];

/** Pipeline status in plain words. The raw keys are machinery: nobody reads
 * "manual_action_needed to manual_action_needed" and learns anything. */
const STATUS_LABELS = {
  discovered: "discovered", shortlisted: "shortlisted", drafted: "drafted",
  awaiting_approval: "to approve", approved: "approved", submission_pending: "sending",
  submitted: "sent", responded: "responded", interview: "interview", offered: "offered",
  won: "won", rejected: "rejected", withdrawn: "withdrawn", parked: "parked",
  awaiting_external: "waiting on them", manual_action_needed: "blocked",
};

/** A status the map has not met yet still reads as words, not as a key. */
export function statusLabel(status) {
  if (!status) return "";
  return STATUS_LABELS[status] || String(status).replace(/_/g, " ");
}

/** Apply method in plain words, the way the person would say it out loud. */
export const APPLY_METHODS = {
  quick_apply: "quick apply",
  easy_apply: "easy apply",
  external: "external",
};

// --- Tiny DOM helpers. Nodes only, never an HTML string, so a company name
// --- or a JD can never become markup.
export function h(tag, props, ...children) {
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

export const $ = (sel) => document.querySelector(sel);

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}

/** A small uppercase section label, as the reference board uses. */
export const eyebrow = (text) => h("p", { class: "eyebrow", text });

/** A titled card. Every screen builds its sections out of this one shape. */
export function panel(title, body) {
  const card = h("section", { class: "card" });
  card.append(h("h2", { text: title }), body);
  return card;
}

/**
 * The one page header. Every screen draws its title through this, so the top of
 * every screen has the same shape: an optional grey back link, the 26 px title,
 * an optional aside (a sort control, a filter toggle, a primary button) on the
 * title's baseline, and an optional lede under it.
 *
 * `lede` and `aside` take a node as readily as a string, because a screen that
 * updates its count line keeps the node it passed in and writes to it.
 */
export function pageHeader({ title, lede, aside, back } = {}) {
  const head = h("header", { class: "page-header" });
  if (back) head.append(h("p", { class: "backlink" }, back));
  head.append(h("h1", { text: title || "" }));
  if (aside) head.append(h("div", { class: "page-aside" }, aside));
  if (lede) head.append(lede instanceof Node ? lede : h("p", { class: "lede", text: lede }));
  return head;
}

/** Local time, short. Falls back to the raw string when it is not a date. */
export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The person's own day as YYYY-MM-DD, so "sent today" means what they mean. */
export const localDay = (value) => {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA");
};

let toastTimer = 0;
export function toast(message, tone) {
  const box = $("#toast");
  box.className = tone === "bad" ? "toast bad" : "toast";
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, tone === "bad" ? 8000 : 4000);
}

// --- Token and fetch ---

const TOKEN_KEY = "harnessUiToken";

export function readToken() {
  // Private mode, or storage disabled: carry on without a token.
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

export function writeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY);
  } catch { toast("This browser will not let the page store the token.", "bad"); }
}

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body || {};
  }
}

/** Fetch /api/... relative to the page, so the UI works on whatever host and
 * port the local server picked. A pasted token goes out as a bearer header. */
export async function api(path, options) {
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
    try { data = JSON.parse(text); }
    catch { throw new ApiError(response.status, `The server replied with something that is not JSON (${response.status}).`); }
  }
  if (!response.ok) {
    const detail = data.error || data.message || `request failed (${response.status})`;
    throw new ApiError(response.status, detail, data);
  }
  return data;
}

// --- Minimal markdown: paragraphs for letters, plus headings, lists and
// --- preformatted tables for the journal. Text nodes only.
export function paragraphs(source) {
  const out = [];
  for (const block of String(source).replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const p = h("p", {});
    lines.forEach((line, i) => { if (i) p.append(h("br", {})); p.append(document.createTextNode(line.trim())); });
    out.push(p);
  }
  return out.length ? out : [h("p", { class: "grey", text: "(empty)" })];
}

export function richMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null, table = null, para = [];
  const flushPara = () => { if (para.length) { out.push(...paragraphs(para.join("\n"))); para = []; } };
  const flushList = () => { if (list) { out.push(list); list = null; } };
  // A markdown table renders as preformatted text rather than as a grid.
  const flushTable = () => { if (table) { out.push(h("pre", { text: table.join("\n") })); table = null; } };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    // A table line is collected until the block ends; see flushTable.
    if (line.trim().startsWith("|")) { flushPara(); flushList(); (table = table || []).push(line); continue; }
    flushTable();
    if (heading) { // h1 is the view title, so a document heading starts at h2
      flushAll();
      out.push(h(`h${Math.min(3, heading[1].length + 1)}`, { text: heading[2].trim() }));
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      (list = list || h("ul", {})).append(h("li", { text: (bullet ? bullet[1] : numbered[1]).trim() }));
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
export function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// --- Errors ---

/** Errors say what happened and what to do about it. */
export function errorBox(error, what, retry) {
  const box = h("div", { class: "error" });
  const unauthorised = error instanceof ApiError && (error.status === 401 || error.status === 403);
  box.append(h("p", { text: unauthorised
    ? `${what} The server refused it. Open Settings from the header, paste the token, then try again.`
    : `${what} ${error.message}` }));
  if (retry) box.append(h("button", { type: "button", class: "btn", text: "Try again", onClick: retry }));
  return box;
}

/** Fetch for a view: on failure the host says what happened and offers a retry,
 * and null tells the caller to stop. The host is cleared either way. */
export async function fetchInto(host, path, what) {
  try {
    const data = await api(path);
    clear(host);
    return data;
  } catch (error) {
    clear(host);
    host.append(errorBox(error, what, () => render()));
    return null;
  }
}

// --- Inline confirm: the first press arms the button, a second press within
// --- the window commits. No browser dialogs anywhere.

const ARM_WINDOW_MS = 6000;
let armed = null;

export function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.button.classList.remove("armed");
  armed.button.textContent = armed.restore;
  armed.button.setAttribute("aria-label", armed.restore);
  armed = null;
}

/**
 * Wire a button so the first press arms it and the second runs `run`, which is
 * only ever reached from a second, deliberate press. `label` is the verb the
 * armed state confirms ("Confirm turn off"); `restore` is what the button says
 * when it is not armed, which for a switch is not the same string.
 */
export function guarded(button, label, run, restore) {
  const resting = restore === undefined ? label : restore;
  button.addEventListener("click", () => {
    if (armed && armed.button === button) {
      disarm();
      run();
      return;
    }
    disarm();
    armed = { button, restore: resting, timer: setTimeout(() => { disarm(); }, ARM_WINDOW_MS) };
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

// --- Summary and policy: read once per render, shared by every screen ---

let summary = null;
let policy = null;
/** False once GET /api/policy has answered 404: the API is not there yet. */
let policyAvailable = true;

export const getSummary = () => summary;
export const getPolicy = () => policy;
export const isPolicyAvailable = () => policyAvailable;

export async function loadSummary() {
  try { summary = await api("summary"); } catch { summary = null; }
}

/**
 * The submission policy. A 404 is not an error here: the policy API may not be
 * running yet, and the header then shows a disabled switch rather than a lie
 * about which lane is live.
 */
export async function loadPolicy() {
  try {
    policy = await api("policy");
    policyAvailable = true;
  } catch (error) {
    policy = null;
    if (error instanceof ApiError && error.status === 404) policyAvailable = false;
  }
  return policy;
}

/** POST a policy change, then re-read the policy so the header shows the truth
 * the file holds rather than the truth the click intended. */
async function postPolicy(path, enabled) {
  await api(path, { method: "POST", body: { enabled, reason: "ui toggle" } });
  await loadPolicy();
}

/**
 * The header switch. AGENTS.md section 2: autopilot is the lane that sends
 * without the person, so turning it on or off is an armed, two-press action,
 * and the state on the button is re-read from the server after every change.
 */
function autopilotSwitch(onChange) {
  const slot = $("#autopilot-slot");
  if (!slot) return;
  clear(slot);
  if (!policyAvailable || !policy) {
    slot.append(h("button", {
      type: "button", class: "switch unknown", disabled: true,
      title: "policy API unavailable", "aria-label": "Autopilot, policy API unavailable",
      text: "Autopilot unavailable",
    }));
    return;
  }
  // The dot carries the state, so the label is just the word. A screen reader
  // gets the state and the consequence in the aria-label instead.
  const on = policy.autopilot_enabled === true;
  const resting = "Autopilot";
  const button = h("button", {
    type: "button", class: on ? "switch on" : "switch off", "aria-pressed": on ? "true" : "false",
    "aria-label": `Autopilot ${on ? "on" : "off"}. Press to turn ${on ? "off" : "on"}.`,
    title: on ? "Turn autopilot off" : "Turn autopilot on", text: resting,
  });
  const note = h("span", { class: "switch-note grey small" });
  guarded(button, on ? "Turn off" : "Turn on", async () => {
    button.disabled = true;
    clear(note);
    try {
      await postPolicy("policy/autopilot", !on);
      toast(`Autopilot is ${policy && policy.autopilot_enabled ? "on" : "off"}.`);
      onChange();
    } catch (error) {
      button.disabled = false;
      note.textContent = error.message;
    }
  }, resting);
  slot.append(button, note);
}

function markNav(route) {
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

// --- Router ---

export function parseHash() {
  const raw = (location.hash || "#/home").replace(/^#\/?/, "");
  const [name, ...rest] = raw.split("/");
  // #/queue is where the applications screen used to live. Move the address on.
  if (name === "queue") history.replaceState(null, "", "#/applications");
  if (name === "queue") return { route: "applications", id: rest.length ? decodeURIComponent(rest.join("/")) : "" };
  const route = !name || !ROUTES.includes(name) ? "home" : name;
  return { route, id: rest.length ? decodeURIComponent(rest.join("/")) : "" };
}

let renderToken = 0;

export async function render() {
  disarm();
  const mine = ++renderToken;
  const { route, id } = parseHash();
  markNav(route === "row" ? "applications" : route);
  const view = $("#view");
  clear(view);
  await Promise.all([loadSummary(), loadPolicy()]);
  if (mine !== renderToken) return;
  autopilotSwitch(() => render());
  const ui = { h, panel, fetchInto, pageHeader };
  try {
    if (route === "row") {
      if (id) await viewRow(view, id);
      else view.append(h("p", { class: "empty", text: "No row id in the address. Pick one from the applications list." }));
    } else if (route === "applications") await viewApplications(view, id);
    else if (route === "resumes") await viewResumes(view, ui);
    else if (route === "keywords") await viewKeywords(view);
    else if (route === "today") await viewToday(view);
    else if (route === "digest") await viewDigest(view);
    else if (route === "settings") viewSettings(view);
    else await viewHome(view);
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

if (!location.hash) location.hash = "#/home";
render();
