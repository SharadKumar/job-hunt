/*
 * pipeline-rows.js - one row of the Pipeline, and every control a row can
 * carry.
 *
 * The screen itself (the segment strip, the chips, the groups) is
 * applications.js; this is the half of it that draws a row and the controls a
 * row carries, so neither file has to be read end to end to change the other.
 *
 * Two rules run through the whole file. The first is that the server decides:
 * which single button a row earns is `action` from GET /api/rows, and nothing
 * here re-derives it from the reason text. The second is AGENTS.md section 2:
 * no button in this file sends anything to a channel. They move a row in the
 * local pipeline, which is the same thing the Sheet Tray's Action column does.
 */

import {
  $, APPLY_METHODS, api, channelLabel, guarded, h, laneLabel, scoreCell, statusLabel, toast, busy,
} from "./app.js";
import { markSentControl } from "./row-actions.js";

/** Where the row detail looks for a request to open with the screening panel
 * focused. A hash carries the id and nothing else, so the intent travels here. */
export const FOCUS_KEY = "jobHuntFocusScreening";

/** The one channel label, from app.js. Re-exported because the row detail
 * reads it from this module's family alongside the rest of the helpers. */
export { channelLabel };

// ---------------------------------------------------------------------------
// The reason, in the person's words
// ---------------------------------------------------------------------------

/** home.js owns the plain rewrite of a run's reason; use it when it is there.
 * Until it lands, strip the run stamp the daily writes and show the rest. */
let plainReasonFn = null;
export async function loadReasonHelper() {
  if (plainReasonFn) return;
  const mod = await import("./home.js").catch(() => null);
  if (mod && typeof mod.plainReason === "function") plainReasonFn = mod.plainReason;
}

export function plainReasonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (plainReasonFn) {
    try { return String(plainReasonFn(raw) || "").trim() || raw; } catch { /* fall through */ }
  }
  return raw.replace(/^\[[^\]]*\]\s*/, "").trim();
}

/** The one clause of a refusal note the row page's fact line has room for.
 * The list itself shows the note in full: truncation is banned (section 6). */
export function firstClause(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const match = /^[^.;]+[.;]/.exec(raw);
  return match ? `${match[0].slice(0, -1).trim()}.` : raw;
}

// ---------------------------------------------------------------------------
// The controls
// ---------------------------------------------------------------------------

/**
 * A decision button: armed on the first press, committed on the second, and
 * posted to the local pipeline. It never submits to a channel (AGENTS.md
 * section 2); the worst it can do is move a row.
 */
export function actionButton(row, action, fields, done) {
  const classes = ["btn", action.primary ? "primary" : "", action.danger ? "danger" : "", action.small ? "sm" : ""];
  const button = h("button", { type: "button", class: classes.filter(Boolean).join(" "), text: action.label });
  // What the move does, in plain words, for whoever hovers or reads it out.
  if (action.title) button.setAttribute("title", action.title);
  guarded(button, action.label, async () => {
    const restore = busy(button, "Saving");
    const body = { action: action.key, ...(fields ? fields() : {}) };
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/action`, { method: "POST", body });
      toast(`${action.label}: the row is now ${statusLabel(result.status_after)}.`);
      restore();
      done();
    } catch (error) {
      // 409 means the state machine refused the move. Show the server's reason.
      restore();
      toast(error.status === 409 ? `Refused. ${error.message}` : error.message, "bad");
    }
  });
  return button;
}

/** A button that posts to one of the row routes this package adds (unpark,
 * reopen, outcome). Same two-press arming as a Tray decision. */
export function routeButton(row, spec, done) {
  const classes = ["btn", spec.primary ? "primary" : "", spec.danger ? "danger" : "", spec.small ? "sm" : ""];
  const button = h("button", { type: "button", class: classes.filter(Boolean).join(" "), text: spec.label });
  guarded(button, spec.label, async () => {
    const restore = busy(button, "Saving");
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/${spec.path}`, { method: "POST", body: spec.body });
      toast(`${spec.label}: the row is now ${statusLabel(result.status_after)}.`);
      restore();
      done();
    } catch (error) {
      restore();
      toast(error.status === 409 ? `Refused. ${error.message}` : error.message, "bad");
    }
  });
  return button;
}

/**
 * Open the row with the screening panel focused. On the row itself the address
 * is already right, so the press scrolls to the panel rather than doing
 * nothing: setting the same hash fires no hashchange.
 */
export function openScreening(id) {
  const target = `#/row/${encodeURIComponent(id)}`;
  const slot = document.querySelector(".screening-slot");
  if (location.hash === target && slot && slot.childElementCount) {
    slot.scrollIntoView({ block: "center" });
    const focusable = slot.querySelector("input, textarea, button, select");
    if (focusable) focusable.focus();
    return;
  }
  try { sessionStorage.setItem(FOCUS_KEY, id); } catch { /* private mode: the panel still mounts */ }
  location.hash = target;
}

/**
 * Putting a closed row back in front of the hunt. The reason is asked for
 * rather than assumed: a reopen is read months later, and "reopened" on its
 * own tells the person nothing about why they changed their mind. The row
 * re-enters at discovered and has to earn the queue again.
 *
 * It posts the server's own `reopen` action, the same one the row page's
 * decision card posts, so a reopen from the list and a reopen from the row
 * write the same history entry and are refused in the same words.
 */
export function reopenControl(row, done, { small = true } = {}) {
  const form = h("div", { class: "mark-sent", hidden: true });
  const reason = h("input", { type: "text", "aria-label": "Reason", placeholder: "e.g. the agency dropped the exclusive" });
  const problem = h("p", { class: "job-line alarm", hidden: true });
  const save = h("button", { type: "button", class: small ? "btn primary sm" : "btn primary", text: "Reopen" });
  const cancel = h("button", { type: "button", class: small ? "btn sm" : "btn", text: "Cancel" });
  const button = h("button", { type: "button", class: small ? "btn sm" : "btn", text: "Reopen",
    title: "Put this row back at discovered, where it has to earn the queue again" });

  guarded(save, "Reopen", async () => {
    const restore = busy(save, "Reopening");
    problem.hidden = true;
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/action`, {
        method: "POST", body: { action: "reopen", reason: reason.value.trim() },
      });
      toast(`Reopened. The row is now ${statusLabel(result.status_after) || "discovered"}.`);
      restore();
      done();
    } catch (error) {
      restore();
      problem.hidden = false;
      problem.textContent = error.message;
    }
  });
  cancel.addEventListener("click", () => { form.hidden = true; button.focus(); });
  button.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) reason.focus();
  });
  reason.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });
  form.append(
    h("div", { class: "field" }, h("label", { class: "field-label", text: "Reason" }), reason),
    h("div", { class: "action-buttons" }, save, cancel), problem,
  );
  return { button, extra: form };
}

/**
 * The one contextual control a row earns, from the server's derivation. A row
 * with nothing to decide gets nothing at all rather than a button that would
 * be refused.
 */
export function contextualControl(row, done, { small = true } = {}) {
  const act = row.action || { kind: "none" };
  const cls = small ? "btn sm" : "btn";
  // `decide` is the server saying there is no one obvious move: the choices it
  // offers all sit in `also`, and none of them is the primary.
  if (act.kind === "decide") return null;
  // A gate refusal is the server saying there is no move at all on this board:
  // no button here changes a policy, and a retry would hit the same gate.
  if (act.kind === "gate_refused") return null;
  if (act.kind === "portal") {
    return h("a", { class: cls, href: act.href || row.url, target: "_blank", rel: "noreferrer noopener", text: act.label || "Open portal" });
  }
  // A reopen asks for a reason, so it opens a small form under the row rather
  // than posting on the second press like the other moves.
  if (act.kind === "reopen") return null;
  if (act.kind === "answer") {
    return h("button", { type: "button", class: `${cls} primary`, text: act.label || "Answer and retry", onClick: () => openScreening(row.id) });
  }
  if (act.post) return actionButton(row, { key: act.post, label: act.label, primary: act.primary, danger: act.danger, small }, null, done);
  if (act.kind === "unpark") return routeButton(row, { label: act.label || "Unpark", path: "unpark", body: { reason: "unparked from the pipeline" }, small }, done);
  if (act.kind === "outcome") {
    return routeButton(row, { label: act.label, path: "outcome", body: { status: act.outcome, note: "recorded from the pipeline" }, primary: act.primary, small }, done);
  }
  return null;
}

/** An `also` entry, or a row's own apply method, that means the person sent
 * this one themselves somewhere the harness cannot reach. */
const SELF_SENT = new Set(["mark-sent", "mark_sent", "applied", "self"]);

/**
 * The secondary controls that sit after the primary: whatever the server hung
 * off `action.also`, plus the one the list owes an external row even when the
 * server is an older build that does not send it.
 *
 * Buttons and the things they open are returned apart, because a form belongs
 * under a row rather than inside its line of buttons.
 */
export function alsoControls(row, done, { small = true } = {}) {
  const act = row.action || { kind: "none" };
  const cls = small ? "btn sm" : "btn";
  const buttons = [];
  const extras = [];
  let selfSent = false;
  for (const spec of Array.isArray(act.also) ? act.also : []) {
    if (!spec) continue;
    if (SELF_SENT.has(String(spec.kind || ""))) {
      selfSent = true;
      const control = markSentControl(row, done, { small });
      if (spec.label) control.button.textContent = spec.label;
      buttons.push(control.button);
      extras.push(control.extra);
    } else if (spec.href || spec.kind === "portal") {
      buttons.push(h("a", { class: cls, href: spec.href || row.url, target: "_blank",
        rel: "noreferrer noopener", text: spec.label || "Open portal" }));
    } else if (spec.post) {
      buttons.push(actionButton(row, { key: spec.post, label: spec.label || spec.post, danger: spec.danger, small }, null, done));
    }
  }
  // An external portal row is one the person has to finish in their own
  // browser, so it always earns the way to say they did (AGENTS.md section 2).
  const external = act.kind === "portal" || row.applyMethod === "external"
    || (Array.isArray(act.also) && act.also.some((spec) => spec && spec.kind === "portal"));
  if (external && !selfSent) {
    const control = markSentControl(row, done, { small });
    buttons.push(control.button);
    extras.push(control.extra);
  }
  return { buttons, extras };
}

// ---------------------------------------------------------------------------
// The row itself
// ---------------------------------------------------------------------------

/**
 * The apply method, when it is the fact that decides the lane. On SEEK there
 * is one adapter and it is Quick Apply, so saying so on every row is noise;
 * on LinkedIn the method is what separates an Easy Apply row from one the
 * person has to finish themselves, and an external method is that everywhere
 * (the brief, section 6: a pill exists only where it tells two rows apart).
 */
function methodPill(row) {
  const method = String(row.applyMethod || "");
  const decides = method === "external" || String(row.channel || "") === "linkedin_jobs";
  if (!decides || !method) return null;
  const said = APPLY_METHODS[method] || method.replace(/_/g, " ");
  return h("span", { class: "pill", text: said });
}

/**
 * One row. Three cells, exactly as section 7 fixes them: the main cell with
 * the title, its pills, one meta line and the reason in full; the score on the
 * title's baseline; and one action, vertically centred.
 *
 * `lanePill` and `statusPill` are off by default because a pill is only worth
 * its space where it tells two rows apart: in the queue, where the lane is the
 * difference between a row the run will send and a row waiting on the person.
 */
export function pipelineRow(row, refresh, { lanePill = false, statusPill = false, action = true } = {}) {
  const article = h("article", { class: "list-row", dataset: { row: row.id } });
  const main = h("div", { class: "list-main" });
  main.append(h("a", { class: "list-title", href: `#/row/${encodeURIComponent(row.id)}`, text: row.title || "Untitled role" }));

  const pills = h("span", { class: "list-pills" });
  if (lanePill && row.lane) {
    pills.append(h("span", {
      class: row.lane === "autopilot" ? "pill pill-autopilot" : "pill pill-you",
      text: laneLabel(row.lane), title: row.lane_reason || "",
    }));
  }
  // A job the person saved on the channel is an order to apply (AGENTS.md
  // section 2), so it is said on the row rather than buried in the detail.
  if (row.userSaved) pills.append(h("span", { class: "pill", text: "saved by you" }));
  const method = methodPill(row);
  if (method) pills.append(method);
  if (statusPill && row.status) pills.append(h("span", { class: "pill pill-status", text: statusLabel(row.status) }));
  if (pills.childElementCount) main.append(pills);

  // Employer, location and channel, in one 13 px line. The channel is text
  // here rather than a pill: a channel is not a state (section 6).
  const meta = [row.company, row.location, channelLabel(row.channel)].filter(Boolean).join(", ");
  if (meta) main.append(h("p", { class: "list-meta", text: meta }));

  const act = row.action || { kind: "none" };
  // A refused row reads as what stopped it, in the server's own plain words,
  // rather than as the gate's stamp. In full, wrapping: a reason the person
  // cannot read is a row they have to open for no good reason.
  const reason = act.kind === "gate_refused" && act.note ? act.note : plainReasonText(row.reason);
  if (reason) main.append(h("p", { class: "list-reason", text: reason }));

  article.append(main, scoreCell(row.score));

  if (action) {
    const control = h("div", { class: "list-action" });
    const done = () => refresh(row.id);
    const button = contextualControl(row, done);
    if (button) control.append(button);
    const { buttons, extras } = alsoControls(row, done);
    for (const extra of buttons) control.append(extra);
    if (control.childElementCount) article.append(control);
    // A form a secondary button opens runs the width of the row, under it.
    for (const extra of extras) article.append(h("div", { class: "row-extra" }, extra));
  }
  return article;
}

// ---------------------------------------------------------------------------
// The row the person just acted on
// ---------------------------------------------------------------------------

/** How long the mark on a row the person just acted on stays up (section 7). */
const ACTED_MS = 3000;
let actedTimer = 0;

/**
 * Mark a row for three seconds after an action landed on it, so the person can
 * see which line moved when the list came back with a different order. A 2 px
 * bar in the person's own colour, drawn in the row's own box: this UI has no
 * shadows and no flashes.
 */
export function markActed(id) {
  if (!id) return;
  clearTimeout(actedTimer);
  for (const node of document.querySelectorAll(".list-row.just-acted")) node.classList.remove("just-acted");
  const row = $(`.list-row[data-row="${CSS.escape(String(id))}"]`);
  if (!row) return;
  row.classList.add("just-acted");
  actedTimer = setTimeout(() => row.classList.remove("just-acted"), ACTED_MS);
}
