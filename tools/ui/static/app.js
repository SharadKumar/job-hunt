/*
 * app.js - the router, the header and the helpers every screen shares.
 *
 * No framework, no build step, no CDN. The screens live in their own modules
 * beside this one (home.js, applications.js, row.js, keywords.js, resumes.js,
 * runs.js, rules.js, settings.js) and import what they need from here, so no
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
import { viewRuns } from "./runs.js";
import { viewRules } from "./rules.js";
import { viewSettings } from "./settings.js";
import { loadShellHealth, renderShellStatus } from "./shell.js";
// --- The shared vocabulary ---
/*
 * How a channel, a status, a lane, a date and a length of time are said. They
 * live in labels.js and are exported again here, because app.js is what every
 * screen imports from and one import list is easier to keep honest than eight.
 */
import {
  APPLY_METHODS, channelLabel, clockTime, dayStamp, duration, laneLabel, localDay, shortDate, statusLabel,
  when, whenFull,
} from "./labels.js";
import { asText, paragraphs, richMarkdown } from "./markdown.js";
export {
  APPLY_METHODS, channelLabel, clockTime, dayStamp, duration, laneLabel, localDay, shortDate, statusLabel,
  when, whenFull, asText, paragraphs, richMarkdown,
};

// --- Constants ---

/** Hash routes, in nav order, plus the row detail the nav does not show. */
export const ROUTES = ["today", "pipeline", "row", "resumes", "guardrails", "runs", "settings"];

/**
 * Addresses that moved, and where they moved to. Home became Today,
 * Applications became Pipeline, Rules became Guardrails, Queue is an older
 * name for the same board, Keywords became the Resumes screen's second tab
 * (they are evidence questions about a CV, not a screen of their own) and
 * Digest is now part of Guardrails. Every one of them is still a working
 * address: they are in the person's history and in the journal.
 *
 * `#/today` is deliberately absent. It used to mean the Runs screen; it now
 * means the Today screen, so the route owns the address and there is nothing
 * to forward.
 */
export const REDIRECTS = {
  home: "#/today",
  applications: "#/pipeline",
  queue: "#/pipeline",
  rules: "#/guardrails",
  keywords: "#/resumes/evidence",
  digest: "#/guardrails",
};

/**
 * The score cell on a list row: a whole number in ink, tabular, right aligned,
 * and nothing at all when the row was never scored. Never green: green is a
 * verdict, and a score is not one.
 */
export function scoreCell(score) {
  const value = typeof score === "number" && Number.isFinite(score) ? String(Math.round(score)) : "";
  // No score, no cell: the row then starts where the heading starts.
  if (!value) return document.createTextNode("");
  return h("span", { class: "list-score", text: value });
}

// --- Tiny DOM helpers. Nodes only, never an HTML string, so a JD can never become markup.
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

/**
 * One status line at a time, for four seconds, naming the outcome in the same
 * words the button used ("Rejected", "Answer banked"). It is `role="status"`
 * in the markup, so a screen reader hears it without the focus moving.
 *
 * A toast is for something that happened. A load that failed is said in place,
 * with `loadError` below: a toast disappears before the person has read it.
 */
const TOAST_MS = 4000;
let toastTimer = 0;

export function toast(message, tone) {
  const box = $("#toast");
  box.className = tone === "bad" ? "toast bad" : "toast";
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, TOAST_MS);
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

/**
 * Fetch an API route. The path is absolute (`/api/...`), not relative: the
 * server serves the shell for every extensionless path, so on a deep address
 * like `#/row/abc` a relative `api/...` resolved against the wrong base and
 * every call came back as the HTML shell. A pasted token goes out as a bearer
 * header.
 */
export async function api(path, options) {
  const opts = options || {};
  const headers = { Accept: "application/json" };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`/api/${path.replace(/^\/?api\/?/, "").replace(/^\//, "")}`, {
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

// --- Markdown, and the shapes a package field can arrive in ---

// --- Controls, confirmation and the states a screen shows while it waits ---

/*
 * The inline confirm, the busy button, the placeholder rows, the load-error
 * box and the 401 route all live in controls.js and are exported again here,
 * because app.js is what every screen imports from.
 */
import {
  askForToken, busy, confirmButton, disarm, errorBox, fetchInto, guarded, isUnauthorised, loadError,
  placeholderRows, TOKEN_FOCUS_KEY, TOKEN_PROMPT,
} from "./controls.js";

export {
  askForToken, busy, confirmButton, disarm, errorBox, fetchInto, guarded, isUnauthorised, loadError,
  placeholderRows, TOKEN_FOCUS_KEY, TOKEN_PROMPT,
};

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
/**
 * The header switch. AGENTS.md section 2: autopilot is the lane that sends
 * without the person, so turning it on or off is an armed, two-press action,
 * and the state on the button is re-read from the server after every change.
 *
 * The state is in words, with today's cap beside it, because "Autopilot" alone
 * never answered the question the person actually has in the morning: how much
 * of today's allowance has already gone out. With the kill switch on nothing
 * sends whatever this button says, so the button says that instead and refuses
 * to be pressed.
 */
export function switchParts(policy, summary) {
  if (!policy) return { state: "Autopilot unavailable", tally: "" };
  if (policy.kill_switch === true) return { state: "Kill switch on", tally: "" };
  const sent = summary && typeof summary.sent_today === "number" ? summary.sent_today : 0;
  const cap = typeof policy.max_per_day === "number" ? policy.max_per_day : null;
  return {
    state: `Autopilot ${policy.autopilot_enabled ? "on" : "off"}`,
    tally: cap === null ? `, ${sent} today` : `, ${sent} of ${cap} today`,
  };
}

/** The same thing as one string, for a title and an accessible name. */
export function switchLabel(policy, summary) {
  const { state, tally } = switchParts(policy, summary);
  return `${state}${tally}`;
}

/** The state in words, with the cap in a span a phone drops. */
function switchText(policy, summary) {
  const { state, tally } = switchParts(policy, summary);
  return [state, tally ? h("span", { class: "switch-tally", text: tally }) : null];
}

function autopilotSwitch(onChange) {
  const slot = $("#autopilot-slot");
  if (!slot) return;
  clear(slot);
  if (!policyAvailable || !policy) {
    slot.append(h("button", {
      type: "button", class: "switch btn unknown", disabled: true,
      title: "policy API unavailable", "aria-label": "Autopilot, policy API unavailable",
      text: "Autopilot unavailable",
    }));
    return;
  }
  const on = policy.autopilot_enabled === true;
  const killed = policy.kill_switch === true;
  const resting = switchLabel(policy, summary);
  // The kill switch is the brake and it lives on Settings. While it is on the
  // header may not pretend autopilot is a live choice.
  if (killed) {
    slot.append(h("button", {
      type: "button", class: "switch btn off", disabled: true,
      title: "The kill switch halts every unattended send. Turn it off on Settings.",
      "aria-label": "Kill switch on. Nothing sends unattended. Turn it off on Settings.",
    }, switchText(policy, summary)));
    return;
  }
  const button = h("button", {
    type: "button", class: on ? "switch btn on" : "switch btn off", "aria-pressed": on ? "true" : "false",
    "aria-label": `${resting}. Press to turn autopilot ${on ? "off" : "on"}.`,
    title: on ? "Turn autopilot off" : "Turn autopilot on",
  }, switchText(policy, summary));
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

/**
 * `#/pipeline/needs?channel=seek&min=60` into its three parts. The query is
 * URL state, not module state: a deep link lands on exactly the list the
 * person shared, and the back button walks the filters as well as the screens
 * (the redesign brief, section 3, principle 4).
 */
function splitHash(hash) {
  const raw = String(hash).replace(/^#\/?/, "");
  // A second `#` names a fragment inside the screen (a group heading), and
  // is never part of the id: `#/pipeline/needs#open_portal?min=60`.
  const frag = raw.indexOf("#");
  const body = frag === -1 ? raw : raw.slice(0, frag);
  const tail = frag === -1 ? "" : raw.slice(frag + 1);
  const cut = body.indexOf("?");
  const path = cut === -1 ? body : body.slice(0, cut);
  let search = cut === -1 ? "" : body.slice(cut + 1);
  let fragment = tail;
  const tailCut = tail.indexOf("?");
  if (tailCut !== -1) { fragment = tail.slice(0, tailCut); search = search || tail.slice(tailCut + 1); }
  const [name, ...rest] = path.split("/");
  return { name, id: rest.length ? decodeURIComponent(rest.join("/")) : "", query: new URLSearchParams(search), fragment: decodeURIComponent(fragment) };
}

/** `#/pipeline/needs` and `#/pipeline/needs?sort=score` are the one address. */
function addressOf(route, id, query) {
  const qs = query instanceof URLSearchParams ? query.toString() : String(query || "");
  return `#/${route}${id ? `/${encodeURIComponent(id)}` : ""}${qs ? `?${qs}` : ""}`;
}

export function parseHash() {
  let { name, id, query, fragment } = splitHash(location.hash || "#/today");
  const moved = REDIRECTS[name];
  if (moved) {
    // Only the board tabs carry a segment worth keeping; the other old
    // addresses had none, so they land on the new screen's own default.
    const keepsSegment = name === "queue" || name === "applications" || name === "home";
    const qs = query.toString();
    const target = `${moved}${id && keepsSegment ? `/${encodeURIComponent(id)}` : ""}${qs ? `?${qs}` : ""}`;
    history.replaceState(null, "", target);
    ({ name, id, query, fragment } = splitHash(target));
  }
  const route = !name || !ROUTES.includes(name) ? "today" : name;
  return { route, id, query, fragment };
}

/**
 * Change the hash query without changing the screen, and without a reload
 * loop: `replaceState` fires no hashchange, so the one re-render is the one
 * asked for here. A key set to null, undefined or "" is dropped rather than
 * written as empty. Returns false when the address was already what was asked
 * for, so a caller can tell a real change from a no-op.
 */
export function setQuery(patch, options) {
  const { route, id, query } = parseHash();
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  const target = addressOf(route, id, next);
  if (target === (location.hash || "")) return false;
  history.replaceState(null, "", target);
  if (!options || options.render !== false) render();
  return true;
}

let renderToken = 0;
/** The screen the person was last on, so scroll is reset when they move
 * screens and left alone when only a filter changed. */
let lastPlace = null;

export async function render() {
  disarm();
  const mine = ++renderToken;
  const { route, id, query } = parseHash();
  markNav(route === "row" ? "pipeline" : route);
  closeMenu();
  const place = `${route}/${id}`;
  if (place !== lastPlace) {
    window.scrollTo(0, 0);
    lastPlace = place;
  }
  const view = $("#view");
  clear(view);
  view.dataset.route = route;
  await Promise.all([loadSummary(), loadPolicy(), loadShellHealth()]);
  if (mine !== renderToken) return;
  renderShellStatus();
  autopilotSwitch(() => render());
  try {
    if (route === "row") {
      if (id) await viewRow(view, id);
      else view.append(h("p", { class: "empty", text: "No row id in the address. Pick one from the pipeline." }));
    } else if (route === "pipeline") await viewApplications(view, id, query);
    // `id` is the Resumes tab: "" is Baselines, "evidence" is the questions.
    else if (route === "resumes") await viewResumes(view, id, query);
    else if (route === "guardrails") await viewRules(view);
    else if (route === "runs") await viewRuns(view, id, query);
    else if (route === "settings") viewSettings(view);
    else await viewHome(view);
  } catch (error) {
    if (mine !== renderToken) return;
    clear(view);
    view.append(errorBox(error, "Could not draw this view.", () => render()));
  }
}

/*
 * Under 720 px the five nav links fold behind a Menu button. The button is in
 * the markup rather than drawn here, so the header is complete before any
 * script runs; all this does is toggle the one class the stylesheet reads, and
 * say so in `aria-expanded`.
 */
const menuButton = document.getElementById("menu-toggle");
const navBar = document.getElementById("nav");

export function closeMenu() {
  if (!menuButton || !navBar) return;
  navBar.classList.add("closed");
  menuButton.setAttribute("aria-expanded", "false");
}

if (menuButton && navBar) {
  menuButton.addEventListener("click", () => {
    const open = navBar.classList.toggle("closed") === false;
    menuButton.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
window.addEventListener("hashchange", () => {
  document.getElementById("view").focus({ preventScroll: true });
  render();
});

if (!location.hash) location.hash = "#/today";
render();
