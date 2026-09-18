/* shell.js - live status for the persistent desktop navigation shell. */

import { $, api, clear, dayStamp, getPolicy, getSummary, h } from "./app.js";

let health = null;

export async function loadShellHealth() {
  try { health = await api("health"); } catch { health = null; }
}

export function renderShellStatus() {
  const box = $("#shell-status");
  if (!box) return;
  const summary = getSummary();
  const policy = getPolicy();
  const today = new Intl.DateTimeFormat("en-AU", {
    weekday: "long", day: "numeric", month: "long",
  }).format(new Date());
  const sent = summary && typeof summary.sent_today === "number" ? summary.sent_today : 0;
  const cap = policy && typeof policy.max_per_day === "number" ? ` of ${policy.max_per_day}` : "";
  const lane = policy && policy.kill_switch === true
    ? "Kill switch on"
    : policy ? `Autopilot ${policy.autopilot_enabled ? "on" : "off"}` : "Policy unavailable";
  const next = health && health.next_run ? dayStamp(health.next_run, true) : "No run scheduled";
  clear(box);
  box.append(
    h("span", { class: "shell-date", text: today }),
    h("span", { class: "shell-state" },
      h("span", { class: "shell-lane", text: `${lane}, ${sent}${cap} sent today` }),
      h("span", { class: "shell-next", text: health && health.next_run ? `Next run ${next}` : next })),
  );
}
