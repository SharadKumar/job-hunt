/*
 * settings.js - the token this browser holds, the safety control, whether the
 * harness itself is running, and the ways to start this server.
 *
 * AGENTS.md section 2: the kill switch halts every unattended send, so it lives
 * here rather than in the header, behind an armed press. Autopilot is the
 * everyday switch and sits in the header; this one is the brake.
 *
 * The Harness block is a two-column definition list, read only. Everything it
 * reports is changed by editing the policy file or re-running the setup skill,
 * never by a browser, so a file path is a title attribute on the value rather
 * than a second grey line under it (the brief, section 6, Settings).
 */

import {
  api, channelLabel, clear, confirmButton, duration, getPolicy, guarded, h, isPolicyAvailable, loadPolicy,
  pageHeader, panel, readToken, render, toast, TOKEN_FOCUS_KEY, when, whenFull, writeToken,
} from "./app.js";

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
    h("p", { class: "grey small", text: `This browser is using ${location.origin}. The long version is in README, Local UI.` })));
}

/** The environment variable scripts/daily.sh posts its one-line summary to. */
const NOTIFY_HELP = "Set HARNESS_NOTIFY_URL to an ntfy topic url, or any url that accepts a POST body, "
  + "and the daily run posts one line to it when it finishes: how many went out, how many are blocked, and the exit code. "
  + "Unset, nothing is posted and nothing fails.";

/**
 * The token card. Save is the primary; showing the token is an eye inside the
 * field rather than a third button competing with it; clearing it is
 * destructive and confirms once.
 */
function tokenCard(asked) {
  const input = h("input", { type: "password", id: "token-input", autocomplete: "off",
    spellcheck: "false", placeholder: "Paste once", "aria-label": "API token" });
  input.value = readToken();

  const eye = h("button", { type: "button", class: "btn-text eye", "aria-pressed": "false", text: "Show" });
  eye.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    eye.textContent = hidden ? "Hide" : "Show";
    eye.setAttribute("aria-pressed", hidden ? "true" : "false");
    input.focus();
  });

  const state = h("p", { class: "field-help", id: "token-state" });
  const paint = () => {
    state.textContent = readToken() ? "A token is set in this browser." : "No token is set in this browser.";
  };
  paint();

  const save = h("button", { type: "button", class: "btn btn-primary", text: "Save token" });
  save.addEventListener("click", () => {
    const value = input.value.trim();
    writeToken(value);
    paint();
    toast(value ? "Token saved." : "Token cleared.");
  });
  const wipe = confirmButton("Clear token", "Confirm clear token", () => {
    writeToken("");
    input.value = "";
    paint();
    toast("Token cleared.");
  }, { class: "btn btn-danger" });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });

  return panel("API token", h("div", {},
    asked ? h("p", { class: "measure", text: asked }) : null,
    h("p", { class: "grey small measure", text: "Stored in this browser only and sent as a bearer header on every call. It is needed only when the server is reached from another device, such as a phone over Tailscale." }),
    h("div", { class: "field token-field" },
      h("label", { class: "field-label", for: "token-input", text: "Token" }),
      h("span", { class: "token-box" }, input, eye),
      state),
    h("div", { class: "action-buttons" }, save, wipe)));
}

/**
 * The kill switch. Two presses, and the state is re-read from the server
 * afterwards rather than assumed from the click. A plain card: a red left
 * border on a card that is not an alarm said more than the truth.
 */
function safetyCard() {
  const body = h("div", { class: "safety" });
  const policy = getPolicy();
  if (!isPolicyAvailable() || !policy) {
    body.append(h("p", { class: "grey", text: "The policy API is not answering, so the kill switch cannot be read or moved." }),
      h("p", { class: "measure", text: "The kill switch halts every unattended send. With it on, no autopilot submission runs, whatever else the policy says." }),
      h("div", { class: "action-buttons" },
        h("button", { type: "button", class: "btn btn-danger", disabled: true, text: "Kill switch unavailable" })));
    return panel("Safety", body);
  }
  const on = policy.kill_switch === true;
  const resting = on ? "Turn kill switch off" : "Turn kill switch on";
  const note = h("p", { class: "field-help" });
  const button = h("button", { type: "button", class: "btn btn-danger kill", text: resting });
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
  body.append(
    h("p", { class: on ? "safety-state alarm" : "safety-state", text: `The kill switch is ${on ? "on" : "off"}.` }),
    h("p", { class: "measure", text: "The kill switch halts every unattended send. With it on, no autopilot submission runs, whatever else the policy says." }),
    h("div", { class: "action-buttons" }, button), note);
  return panel("Safety", body);
}

/**
 * One reading in the definition list: a 13 px key, a 15 px value, and the file
 * behind it on the value's title rather than as a grey line of its own.
 */
function reading(list, label, value, options) {
  const opts = options || {};
  list.append(h("dt", { text: label }));
  list.append(h("dd", { class: opts.bad ? "alarm" : "", title: opts.title || "", text: value }));
}

/** A stamp, said the way every other time in the UI is said. */
const stamp = (iso) => (iso ? (when(iso) || String(iso)) : "never");

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
    const list = h("dl", { class: "readings" });

    const last = health.last_run;
    if (!last) reading(list, "Last run", "nothing logged yet", { bad: true });
    else {
      const verdict = last.exit_code === null
        ? "did not finish"
        : last.exit_code === 0 ? "finished cleanly" : `exited ${last.exit_code}`;
      const took = duration(last.duration_seconds);
      const at = last.started_at || `${last.date}T00:00:00`;
      reading(list, "Last run", `${stamp(at)}, ${verdict}${took ? `, ${took}` : ""}`, {
        bad: last.exit_code !== 0, title: `${whenFull(at)}. ${last.log || ""}`.trim(),
      });
    }

    reading(list, "Next run", health.next_run ? stamp(health.next_run) : "nothing scheduled", {
      bad: !health.next_run, title: whenFull(health.next_run),
    });
    reading(list, "Schedule", health.schedule.installed
      ? `installed, ${health.schedule.at || "no time in the plist"}`
      : "not installed; run bash scripts/install-launchd.sh", { bad: !health.schedule.installed });

    const cap = typeof health.caps.max_per_day === "number" ? ` of ${health.caps.max_per_day}` : "";
    reading(list, "Sent today", `${health.caps.sent_today}${cap}`);
    reading(list, "Autopilot", health.caps.autopilot_enabled ? "on" : "off");
    reading(list, "Kill switch", health.caps.kill_switch ? "on" : "off", { bad: health.caps.kill_switch });

    if (policy) {
      reading(list, "Autopilot channels",
        policy.channels && policy.channels.length ? policy.channels.map(channelLabel).join(", ") : "none",
        { title: policy.path });
      reading(list, "Google Sheet", policy.sheet_enabled ? "mirroring" : "off, this UI is the approval surface",
        { title: policy.path });
    }

    for (const channel of health.channels || []) {
      reading(list, `Signed in to ${channelLabel(channel.id)}`, channel.note, { bad: channel.state !== "ok" });
    }
    if (!(health.channels || []).length) reading(list, "Signed in", "no channel is switched on", { bad: true });

    reading(list, "Notify url", health.notify_url_set ? "HARNESS_NOTIFY_URL is set" : "HARNESS_NOTIFY_URL is not set");
    body.append(list, h("p", { class: "grey small measure", text: NOTIFY_HELP }));
  })();

  return panel("Harness", body);
}

/**
 * A 401 anywhere in the UI sends the person here rather than explaining itself
 * on whichever screen happened to ask (the brief, section 7, Loading and
 * errors). `askForToken` in controls.js leaves the reason behind; this reads
 * it once, says it above the field and puts the cursor in the field.
 */
function takeTokenRequest() {
  try {
    const asked = sessionStorage.getItem(TOKEN_FOCUS_KEY);
    if (asked) sessionStorage.removeItem(TOKEN_FOCUS_KEY);
    return asked || "";
  } catch { return ""; }
}

export function viewSettings(view) {
  view.append(pageHeader({ title: "Settings", lede: "The token, the kill switch, whether the harness is running, and how to start it." }));
  const stack = h("div", { class: "cards" });
  const asked = takeTokenRequest();
  stack.append(tokenCard(asked), safetyCard(), harnessCard(), howToRunCard());
  view.append(stack);
  if (asked) {
    const field = view.querySelector("#token-input");
    if (field) field.focus();
  }
}
