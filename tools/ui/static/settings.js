/*
 * settings.js - the token this browser holds, the safety control, whether the
 * harness itself is running, and the four ways to start this server.
 *
 * AGENTS.md section 2: the kill switch halts every unattended send, so it lives
 * here rather than in the header, behind an armed press and in red. Autopilot
 * is the everyday switch and sits in the header; this one is the brake.
 *
 * The Harness card is the same reading as the Home card, with the policy file's
 * own numbers beside it: the caps, the channels the policy names, the Sheet
 * flag and the schedule. It is read only. Everything it reports is changed by
 * editing the policy file or re-running the setup skill, not by a browser.
 */

import {
  api, clear, getPolicy, guarded, h, isPolicyAvailable, loadPolicy, pageHeader, panel, readToken, render, toast, writeToken,
} from "./app.js";
import { channelLabel, dayTime, duration } from "./home.js";

/** Where the person reads the long version. A path, not a link off this machine. */
const DOCS_LINE = "Docs: README, Local UI section.";

/**
 * The ways to run this UI, best first. The portless way is the one to use day
 * to day: it puts the page on a name instead of a port, so nothing has to be
 * remembered. Only the last-but-one line, the one that binds to another
 * address, needs the token, which is why the token card sits above this one.
 */
const COMMANDS = [
  "npm run ui:portless            # https://job-hunt.localhost, no port to remember",
  "npm run ui -- --open           # the plain port way, http://127.0.0.1:7788",
  "bash scripts/install-ui-launchd.sh   # keep it running across logins",
  "npm run ui -- --host 100.x.y.z   # a Tailscale address, with HARNESS_UI_TOKEN set",
  "sheet:\n  enabled: false   # the local UI is the approval surface, not the Sheet",
];

function howToRunCard() {
  return panel("How to run", h("div", {},
    h("p", { class: "grey small measure", text: "The portless way is the one to use day to day: it puts the UI on a name instead of a port." }),
    h("pre", { class: "commands", text: COMMANDS.join("\n\n") }),
    h("p", { class: "grey small", text: `This browser is using ${location.origin}` }),
    h("p", { class: "grey small", text: DOCS_LINE })));
}

/** The environment variable scripts/daily.sh posts its one-line summary to. */
const NOTIFY_HELP = "Set HARNESS_NOTIFY_URL to an ntfy topic url, or any url that accepts a POST body, "
  + "and the daily run posts one line to it when it finishes: how many went out, how many are blocked, and the exit code. "
  + "Unset, nothing is posted and nothing fails.";

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

/** One `label: value` row, with the value in red when it wants attention. */
function row(label, value, bad) {
  return h("p", { class: "setting-row" },
    h("span", { class: "setting-label", text: label }),
    h("span", { class: bad ? "alarm" : "", text: value }));
}

/** The same stamp Home uses, and "never" when there is no date at all. */
const when = (iso, withTime) => (iso ? (dayTime(iso, withTime) || String(iso)) : "never");

/** The machine's state, filled in once GET /api/health answers. */
function harnessCard() {
  const body = h("div", { class: "harness" });
  body.append(h("p", { class: "grey", text: "Reading the harness state." }));

  (async () => {
    let health = null;
    try { health = await api("health"); } catch (error) {
      clear(body);
      body.append(h("p", { class: "grey", text: `Could not read the harness health. ${error.message}` }));
      return;
    }
    const policy = getPolicy();
    clear(body);

    const last = health.last_run;
    if (!last) body.append(row("Last run", "nothing logged yet", true));
    else {
      const verdict = last.exit_code === null
        ? "did not finish"
        : last.exit_code === 0 ? "finished cleanly" : `exited ${last.exit_code}`;
      const took = duration(last.duration_seconds);
      body.append(row("Last run", `${when(last.started_at || `${last.date}T00:00:00`, true)}, ${verdict}${took ? `, ${took}` : ""}`, last.exit_code !== 0));
      body.append(h("p", { class: "grey small", text: last.log }));
    }

    body.append(row("Next run", health.next_run ? when(health.next_run, true) : "nothing scheduled", !health.next_run));
    body.append(row("Schedule", health.schedule.installed
      ? `installed, ${health.schedule.at || "no time in the plist"}`
      : "not installed; run bash scripts/install-launchd.sh", !health.schedule.installed));

    const cap = typeof health.caps.max_per_day === "number" ? ` of ${health.caps.max_per_day}` : "";
    body.append(row("Sent today", `${health.caps.sent_today}${cap}`));
    body.append(row("Autopilot", health.caps.autopilot_enabled ? "on" : "off"));
    body.append(row("Kill switch", health.caps.kill_switch ? "on" : "off", health.caps.kill_switch));

    if (policy) {
      body.append(row("Autopilot channels", policy.channels && policy.channels.length ? policy.channels.join(", ") : "none"));
      body.append(row("Google Sheet", policy.sheet_enabled ? "mirroring" : "off, this UI is the approval surface"));
      body.append(h("p", { class: "grey small", text: policy.path }));
    }

    for (const channel of health.channels || []) {
      body.append(row(`Login: ${channelLabel(channel.id)}`, channel.note, channel.state !== "ok"));
    }
    if (!(health.channels || []).length) body.append(row("Logins", "no channel is switched on", true));

    body.append(row("Notifications", health.notify_url_set ? "HARNESS_NOTIFY_URL is set" : "HARNESS_NOTIFY_URL is not set"));
    body.append(h("p", { class: "grey small measure", text: NOTIFY_HELP }));
  })();

  return panel("Harness", body);
}

export function viewSettings(view) {
  view.append(pageHeader({ title: "Settings", lede: "The token, the kill switch, whether the harness is running, and how to start it." }));
  const stack = h("div", { class: "stack" });
  stack.append(tokenCard(), safetyCard(), harnessCard(), howToRunCard());
  view.append(stack);
}
