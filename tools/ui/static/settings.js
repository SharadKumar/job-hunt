/*
 * settings.js - the token this browser holds, the safety control, and how to
 * run the server.
 *
 * AGENTS.md section 2: the kill switch halts every unattended send, so it lives
 * here rather than in the header, behind an armed press and in red. Autopilot
 * is the everyday switch and sits in the header; this one is the brake.
 */

import {
  api, clear, getPolicy, guarded, h, isPolicyAvailable, loadPolicy, pageHeader, panel, readToken, render, toast, writeToken,
} from "./app.js";

/** The ways to run this UI, best first. */
const COMMANDS = [
  "npm run ui:portless            # https://job-hunt.localhost, no port to remember",
  "npm run ui -- --open           # the plain port way, http://127.0.0.1:7788",
  "bash scripts/install-ui-launchd.sh   # keep it running across logins",
  "npm run ui -- --host 100.x.y.z   # a Tailscale address, with HARNESS_UI_TOKEN set",
  "sheet:\n  enabled: false   # the local UI is the approval surface",
];

function tokenCard() {
  const input = h("input", { type: "password", id: "token-input", autocomplete: "off",
    spellcheck: "false", placeholder: "Paste once", "aria-label": "API token" });
  input.value = readToken();
  const state = h("p", { class: "grey small", id: "token-state" });
  const paint = () => { state.textContent = readToken() ? "A token is set in this browser." : "No token is set in this browser."; };
  paint();
  const show = h("button", { type: "button", class: "btn", text: "Show" });
  show.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    show.textContent = hidden ? "Hide" : "Show";
  });
  const save = h("button", { type: "button", class: "btn primary", text: "Save" });
  save.addEventListener("click", () => {
    writeToken(input.value.trim()); paint();
    toast(input.value.trim() ? "Token saved." : "Token cleared.");
  });
  const wipe = h("button", { type: "button", class: "btn", text: "Clear" });
  wipe.addEventListener("click", () => { writeToken(""); input.value = ""; paint(); toast("Token cleared."); });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });
  return panel("API token", h("div", {},
    h("p", { class: "grey small measure", text: "Stored in this browser only and sent as a bearer header on every call. It is needed only when the server is reached from another device, such as a phone over Tailscale." }),
    h("div", { class: "token-fields" }, input, h("div", { class: "action-buttons" }, save, wipe, show)),
    state));
}

/**
 * The kill switch. Two presses, red either way, and the state is re-read from
 * the server afterwards rather than assumed from the click.
 */
function safetyCard() {
  const body = h("div", { class: "safety" });
  body.append(h("p", { class: "measure",
    text: "The kill switch halts every unattended send. With it on, no autopilot submission runs, whatever else the policy says." }));
  const policy = getPolicy();
  if (!isPolicyAvailable() || !policy) {
    body.append(h("p", { class: "grey", text: "policy API unavailable" }),
      h("div", { class: "action-buttons" },
        h("button", { type: "button", class: "btn danger", disabled: true, text: "Kill switch unavailable" })));
    return panel("Safety", body);
  }
  const on = policy.kill_switch === true;
  const resting = on ? "Turn the kill switch off" : "Turn the kill switch on";
  const note = h("p", { class: "grey small" });
  const button = h("button", { type: "button", class: "btn danger kill", text: resting });
  guarded(button, on ? "Turn off" : "Turn on", async () => {
    button.disabled = true;
    clear(note);
    try {
      await api("policy/kill-switch", { method: "POST", body: { enabled: !on, reason: "ui toggle" } });
      await loadPolicy();
      const now = getPolicy();
      toast(`The kill switch is ${now && now.kill_switch ? "on" : "off"}.`);
      render();
    } catch (error) {
      button.disabled = false;
      note.textContent = error.message;
    }
  }, resting);
  body.append(h("p", { class: on ? "alarm" : "grey", text: `The kill switch is ${on ? "on" : "off"}.` }),
    h("div", { class: "action-buttons" }, button), note);
  return panel("Safety", body);
}

function browserCard() {
  return panel("This browser", h("ul", { class: "history" },
    h("li", { text: `This browser is using ${location.origin}` }),
    h("li", { text: readToken() ? "This browser holds a token." : "This browser holds no token." })));
}

export function viewSettings(view) {
  view.append(pageHeader({ title: "Settings", lede: "The token, the kill switch and how to reach this page." }));
  const stack = h("div", { class: "stack" });
  stack.append(tokenCard(), safetyCard(), browserCard());
  stack.append(panel("About", h("div", {},
    h("p", { class: "grey small measure", text: "The portless way is the one to use day to day: it puts the UI on a name instead of a port." }),
    h("pre", { class: "commands", text: COMMANDS.join("\n\n") }))));
  view.append(stack);
}
