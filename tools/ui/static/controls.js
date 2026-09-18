/*
 * controls.js - the controls and the states every screen shares: the inline
 * confirm, the busy button, the placeholder rows a list stands in while it
 * loads, the inline load-error box, and the one route a 401 takes.
 *
 * All of it is exported again from app.js, which is what the screens import
 * from. It lives here because app.js is the router and the DOM helpers, and a
 * control is neither.
 *
 * The contract is docs/ui-redesign-2026-09-18.md, section 7. The rule that
 * governs the whole file: no browser dialog anywhere, ever. A destructive or
 * sending action confirms on itself, in place, and can always be backed out of.
 */

import { $, api, ApiError, clear, h, render } from "./app.js";

// --- Errors ---

/** Errors say what happened and what to do about it. A refusal for want of a
 * token says nothing on the page: it takes the person to Settings instead. */
export function errorBox(error, what, retry) {
  const box = h("div", { class: "error" });
  box.append(h("p", { text: isUnauthorised(error) ? `${what} ${TOKEN_PROMPT}` : `${what} ${error.message}` }));
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
    if (isUnauthorised(error)) { askForToken(); return null; }
    host.append(errorBox(error, what, () => render()));
    return null;
  }
}

// --- Inline confirm, busy and the shapes a screen shows while it waits ---

/*
 * No browser dialogs anywhere in this UI. A destructive or sending action arms
 * on the first press and commits on the second, with a Cancel beside it while
 * it is armed; Escape cancels; the armed state expires after eight seconds so
 * a button never sits waiting to fire at a press nobody meant
 * (docs/ui-redesign-2026-09-18.md, section 7, Button).
 */

const ARM_WINDOW_MS = 8000;
let armed = null;

export function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.button.classList.remove("armed");
  armed.button.textContent = armed.restore;
  armed.button.setAttribute("aria-label", armed.restore);
  if (armed.cancel) armed.cancel.remove();
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
    const cancel = h("button", { type: "button", class: "btn-text", text: "Cancel", onClick: () => disarm() });
    armed = { button, restore: resting, cancel, timer: setTimeout(() => { disarm(); }, ARM_WINDOW_MS) };
    button.classList.add("armed");
    button.textContent = `Confirm ${label.toLowerCase()}`;
    button.setAttribute("aria-label", `Confirm ${label.toLowerCase()}. Press again to apply.`);
    button.after(cancel);
    button.focus();
  });
  return button;
}

/**
 * A button that confirms itself. `label` is what it says at rest,
 * `confirmLabel` what it says once armed ("Reject" then "Confirm reject"), and
 * `onConfirm` runs only on the second press. Returns the span holding the
 * button, with the button on `.button`, so a caller can put it anywhere a node
 * goes and still reach the control.
 */
export function confirmButton(label, confirmLabel, onConfirm, options) {
  const opts = options || {};
  const box = h("span", { class: "confirm" });
  const button = h("button", { type: "button", class: opts.class || "btn", text: label });
  const spoken = String(confirmLabel || `Confirm ${label}`).replace(/^confirm\s+/i, "");
  guarded(button, spoken, onConfirm, label);
  box.append(button);
  box.button = button;
  return box;
}

/**
 * While a button's work is running: the label becomes the present participle
 * the caller names ("Sending", "Saving"), the width is locked so the row does
 * not jump, and `aria-busy` says so out loud. The returned function puts the
 * button back exactly as it was.
 */
export function busy(button, label) {
  const width = button.getBoundingClientRect().width;
  const wasText = button.textContent;
  const wasDisabled = button.disabled;
  if (width) button.style.minWidth = `${Math.ceil(width)}px`;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  if (label) button.textContent = label;
  return function done() {
    button.style.minWidth = "";
    button.removeAttribute("aria-busy");
    button.disabled = wasDisabled;
    button.textContent = wasText;
  };
}

/** The shape of a list, while the list is still being fetched. No spinner and
 * no "Loading." sentence: both say less than the shape of what is coming. */
export function placeholderRows(count) {
  const box = h("div", { class: "placeholder", "aria-hidden": "true" });
  for (let i = 0; i < (count || 3); i += 1) {
    box.append(h("div", { class: "placeholder-row" }, h("span", {}), h("span", {})));
  }
  return box;
}

/**
 * A load that failed, said in place at the top of the list it failed to fill,
 * with the retry beside it. `what` names the thing in the person's words: "the
 * pipeline", "this run".
 */
export function loadError(what, error, retry) {
  const box = h("div", { class: "load-error", role: "alert" });
  box.append(h("p", { text: `Could not load ${what}: ${error && error.message ? error.message : String(error)}.` }));
  if (retry) box.append(h("button", { type: "button", class: "btn-text", text: "Retry", onClick: retry }));
  return box;
}

/**
 * A 401 or 403 anywhere means one thing: this server was started with a token
 * and this browser has not been given it. Rather than say so on whichever
 * screen happened to ask, the person is taken to Settings with the field
 * waiting for them.
 */
export const TOKEN_PROMPT = "This server needs the API token.";
export const TOKEN_FOCUS_KEY = "jobHuntFocusToken";

export function isUnauthorised(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function askForToken() {
  try { sessionStorage.setItem(TOKEN_FOCUS_KEY, TOKEN_PROMPT); } catch { /* private mode */ }
  if (location.hash === "#/settings") render();
  else location.hash = "#/settings";
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") disarm();
});

