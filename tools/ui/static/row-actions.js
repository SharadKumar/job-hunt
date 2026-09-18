/*
 * row-actions.js - every control on the row page that does something: the one
 * primary action the server decided, the send that goes out through autopilot,
 * the moves the state machine still allows, and the two small forms (ask the
 * next run for a new letter, record an application sent by hand).
 *
 * AGENTS.md section 2: exactly one control in this file can cause a
 * submission. "Send now via autopilot" runs tools/autopilot-submit.ts for this
 * row, and that tool owns the letter-critic and the submission gate, so the
 * button adds no authority. It says what it will do before it is pressed, it
 * confirms once, and it is never pressed from code: banking a screening answer
 * enables it and puts the focus on it, and the person's own press is the one
 * that sends. Everything else here moves a row in the local pipeline, which is
 * the same thing the Sheet's Tray column does, and contacts nothing.
 *
 * The docs: docs/ui-redesign-2026-09-18.md sections 4 and 7.
 */

import { api, busy, channelLabel, confirmButton, h, shortDate, statusLabel, toast } from "./app.js";

/** How often a started job is polled, and how long that may go on for. A
 * letter-critic pass plus the gate and the adapter is a minute or two. */
const POLL_MS = 2000;
const POLL_LIMIT = 150;

const MISSING_ROUTE = "This build of the harness has no such route yet. Nothing was run.";

// ---------------------------------------------------------------------------
// What the state machine allows
// ---------------------------------------------------------------------------

/*
 * `VALID_TRANSITIONS` in tools/pipeline.ts, mirrored here and documented in
 * docs/pipeline-state-machine.md. The row page offers only the moves this
 * table allows from the status the row is actually in: a button that always
 * comes back 409 is a lie about what the person may do. The server refuses an
 * illegal move whatever this table says, so the two can only disagree by
 * showing one button too few.
 */
const VALID_TRANSITIONS = {
  discovered: ["shortlisted", "parked", "awaiting_external", "rejected", "manual_action_needed"],
  awaiting_external: ["shortlisted", "rejected", "withdrawn"],
  shortlisted: ["drafted", "parked", "discovered", "rejected", "withdrawn"],
  parked: ["shortlisted", "discovered", "rejected", "withdrawn"],
  drafted: ["awaiting_approval", "rejected", "withdrawn"],
  awaiting_approval: ["approved", "rejected", "withdrawn", "manual_action_needed"],
  approved: ["submission_pending", "submitted", "manual_action_needed", "withdrawn"],
  submission_pending: ["submitted", "manual_action_needed", "withdrawn"],
  submitted: ["responded", "rejected", "withdrawn"],
  responded: ["interview", "rejected", "withdrawn"],
  interview: ["offered", "rejected", "withdrawn"],
  offered: ["won", "rejected", "withdrawn"],
  won: [],
  rejected: ["discovered"],
  withdrawn: ["discovered"],
  manual_action_needed: ["approved", "submitted", "rejected", "withdrawn"],
};

export const allows = (status, next) => (VALID_TRANSITIONS[String(status || "")] || []).includes(next);

/**
 * Hold is not a transition: it parks the run off this row and leaves the
 * status where it is. It only means something while a run could still pick the
 * row up, so it is offered on the statuses before a send and on no others.
 */
const HOLDABLE = new Set([
  "discovered", "shortlisted", "drafted", "awaiting_approval", "approved",
  "submission_pending", "manual_action_needed", "parked", "awaiting_external",
]);

export const canHold = (status) => HOLDABLE.has(String(status || ""));

// ---------------------------------------------------------------------------
// Posting a move
// ---------------------------------------------------------------------------

/** The route and body one move posts, by the kind of move it is. */
const POSTS = {
  action: (id, body) => api(`rows/${encodeURIComponent(id)}/action`, { method: "POST", body }),
  unpark: (id, body) => api(`rows/${encodeURIComponent(id)}/unpark`, { method: "POST", body }),
  outcome: (id, body) => api(`rows/${encodeURIComponent(id)}/outcome`, { method: "POST", body }),
};

/**
 * One move, as a button. `spec.confirm` is the word the armed state uses
 * ("Confirm reject"); without it the button acts on the first press, because
 * section 7 arms a destructive or a sending action and nothing else.
 *
 * The toast names the outcome in the same words as the button, and a refusal
 * is shown in the server's own words rather than narrated into something
 * softer (AGENTS.md section 3.8).
 */
export function moveButton(row, spec, getFields, onDone) {
  const classes = ["btn", spec.primary ? "btn-primary" : "", spec.danger ? "btn-danger" : ""].filter(Boolean).join(" ");
  const run = async (button) => {
    const done = busy(button, spec.busy || "Saving");
    try {
      const body = { ...(spec.body || {}), ...(getFields ? getFields() : {}) };
      const result = await POSTS[spec.route || "action"](row.id, body);
      toast(result && result.status_after ? `${spec.toast || spec.label}: the row is now ${statusLabel(result.status_after)}.` : `${spec.toast || spec.label}.`);
      if (onDone) onDone();
    } catch (error) {
      done();
      toast(error.status === 409 ? `Refused. ${error.message}` : error.message, "bad");
    }
  };
  if (spec.confirm) {
    const box = confirmButton(spec.label, spec.confirm, () => run(box.button), { class: classes });
    return box;
  }
  const button = h("button", { type: "button", class: classes, text: spec.label });
  button.addEventListener("click", () => run(button));
  return button;
}

// ---------------------------------------------------------------------------
// Send now via autopilot
// ---------------------------------------------------------------------------

/** The last thing a job said, as one line. */
function lastLine(tail) {
  const lines = String(tail || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 160) : "";
}

const finished = (job) => Boolean(job && (job.finished_at || (job.exit_code !== null && job.exit_code !== undefined)));

/** Poll GET /api/jobs/:id until it stops, telling the caller what it says. */
async function pollJob(id, onTick) {
  for (let tick = 0; tick < POLL_LIMIT; tick += 1) {
    await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
    let job = null;
    try { job = await api(`jobs/${encodeURIComponent(id)}`); } catch (error) { return { error }; }
    if (finished(job)) return { job };
    onTick(lastLine(job.tail));
  }
  return { timeout: true };
}

/** What the tool said when it stopped: the status it left the row in and its
 * own message. Neither is narrated into a pass (AGENTS.md section 3.8). */
function jobResult(job) {
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const said = String(result.message ?? (typeof job.result === "string" ? job.result : "") ?? "").trim() || lastLine(job.tail);
  const status = result.status_after ? `The row is now ${statusLabel(result.status_after)}.` : "";
  return [status, said].filter(Boolean).join(" ") || `The run finished, exit ${job.exit_code}.`;
}

/** The channel and method an unattended send would go out through. */
const SEND_METHOD = { easy_apply: "Easy Apply", quick_apply: "Quick Apply" };

export function sendsThrough(row) {
  const method = SEND_METHOD[row.applyMethod];
  return method ? `${channelLabel(row.channel)} ${method}` : channelLabel(row.channel) || "the channel it came from";
}

/**
 * The one control that can put an application in front of an advertiser.
 *
 * It runs tools/autopilot-submit.ts for this row: the letter-critic against
 * the bytes that would go out, the submission gate, and then the channel's own
 * one-click adapter. So it says which channel it would go through before it is
 * pressed, arms on the first press and sends on the second, and reports what
 * the tool said, including a refusal.
 */
export function sendNowControl(row, refresh, { enabled = true } = {}) {
  const line = h("p", { class: "job-line field-help", role: "status", hidden: true });
  const box = confirmButton("Send now via autopilot", "Confirm send", () => start(), { class: "btn btn-primary" });
  const button = box.button;
  button.disabled = !enabled;
  const help = h("p", { class: "field-help", text: `This submits through ${sendsThrough(row)}. Send?` });
  const say = (text, tone) => {
    line.hidden = false;
    line.className = tone === "bad" ? "job-line field-error" : "job-line field-help";
    line.textContent = text;
  };

  async function start() {
    const done = busy(button, "Sending via autopilot");
    say("Running the critic and the gate.");
    let started = null;
    try {
      started = await api(`rows/${encodeURIComponent(row.id)}/retry-now`, { method: "POST", body: {} });
    } catch (error) {
      done();
      return say(error.status === 404 ? MISSING_ROUTE : `Refused. ${error.message}`, "bad");
    }
    const outcome = await pollJob(started.job_id, (tail) => say(tail || "Running the critic and the gate."));
    done();
    if (outcome.error) return say(`Lost track of the run. ${outcome.error.message}`, "bad");
    if (outcome.timeout) return say("The run is still going. Open Schedules to watch the rest of it.", "bad");
    const said = jobResult(outcome.job);
    say(said, outcome.job.exit_code === 0 ? "" : "bad");
    toast(said, outcome.job.exit_code === 0 ? "" : "bad");
    // The row moved, or it did not: either way what is on the page is now old.
    if (refresh) refresh();
  }

  return { node: box, button, line, help };
}

// ---------------------------------------------------------------------------
// The primary action, from the server's own derivation
// ---------------------------------------------------------------------------

/**
 * The one button at the top right. Which button it is comes from the server's
 * `action` field and from nothing else: the list, this page and the tests all
 * read one derivation instead of three copies of a regex in the browser.
 *
 * `hooks.onAnswer` is how an "answer" action reaches the screening card that is
 * already on the page.
 */
export function primaryControl(data, row, onDone, hooks = {}) {
  const act = (data && data.action) || { kind: "none" };
  const label = act.label || "";
  if (act.kind === "portal") {
    return { node: h("a", { class: "btn btn-primary", href: act.href || row.url, target: "_blank", rel: "noreferrer noopener", text: label || "Open portal" }) };
  }
  if (act.kind === "answer") {
    const button = h("button", { type: "button", class: "btn btn-primary", text: label || "Answer" });
    button.addEventListener("click", () => { if (hooks.onAnswer) hooks.onAnswer(); });
    return { node: button };
  }
  if (act.kind === "mark_sent") {
    const control = markSentControl(row, onDone);
    control.button.classList.add("btn-primary");
    return { node: control.button, extra: control.extra };
  }
  if (act.kind === "unpark") {
    return { node: moveButton(row, { label: label || "Unpark", primary: true, route: "unpark", busy: "Unparking", body: { reason: "unparked from the row page" } }, null, onDone) };
  }
  if (act.kind === "outcome" && act.outcome) {
    return { node: moveButton(row, { label, primary: true, route: "outcome", busy: "Saving", body: { status: act.outcome, note: "recorded from the row page" } }, null, onDone) };
  }
  if (act.post) {
    const danger = act.danger === true;
    return {
      node: moveButton(row, {
        label, primary: !danger, danger, busy: "Saving",
        confirm: danger ? `Confirm ${label.toLowerCase()}` : null,
        body: { action: act.post },
      }, null, onDone),
    };
  }
  // in_flight, gate_refused and none: the run owns the row, or nothing on this
  // page moves it. The lede and the decision card say which.
  return null;
}

// ---------------------------------------------------------------------------
// The decision card
// ---------------------------------------------------------------------------

/** The standing moves, in the order they are offered, with what each posts. */
const DECISIONS = [
  { key: "hold", label: "Hold", toast: "Held" },
  { key: "reject", label: "Reject", to: "rejected", danger: true, confirm: "Confirm reject", toast: "Rejected" },
  { key: "withdraw", label: "Withdraw", to: "withdrawn", danger: true, confirm: "Confirm withdraw", toast: "Withdrawn" },
];

/** The rungs of the response ladder, each legal from exactly one status. */
const LADDER = [
  { from: "submitted", to: "responded", label: "Mark responded" },
  { from: "responded", to: "interview", label: "Interview" },
  { from: "interview", to: "offered", label: "Offer" },
  { from: "offered", to: "won", label: "Won" },
];

/** The reason a move carries into the row's history. */
function reasonField() {
  const input = h("input", { type: "text", id: "decide-reason", placeholder: "Optional" });
  const node = h("label", { class: "field", for: "decide-reason" },
    h("span", { class: "field-label", text: "Reason" }), input);
  return { node, values: () => (input.value.trim() ? { reason: input.value.trim() } : {}) };
}

/**
 * The moves this row still takes, and nothing else.
 *
 * Three sources, in this order: whatever the server hung off `action.also`
 * (the choices it decided a duplicate or an in-flight row is left with), the
 * standing decisions, and the next rung of the response ladder. Every one of
 * them is filtered through the state machine, and one that the primary button
 * already offers is not drawn twice.
 */
export function decisionCard(data, row, onDone) {
  const act = (data && data.action) || { kind: "none" };
  const status = String(row.status || "");
  const fields = reasonField();
  const buttons = h("div", { class: "action-buttons" });
  const extras = h("div", { class: "action-extra" });
  const drawn = new Set([act.post, act.outcome].filter(Boolean));

  for (const spec of Array.isArray(act.also) ? act.also : []) {
    if (!spec) continue;
    if (spec.kind === "mark_sent" || spec.post === "mark-sent") {
      if (!allows(status, "submitted") || drawn.has("mark_sent")) continue;
      drawn.add("mark_sent");
      // The label is the one section 7 fixes, not the server's older wording:
      // the button and the commit inside the form it opens have to agree.
      const control = markSentControl(row, onDone);
      buttons.append(control.button);
      extras.append(control.extra);
      continue;
    }
    if (spec.href || spec.kind === "portal") continue; // the advert is on the facts line
    if (!spec.post || drawn.has(spec.post)) continue;
    const move = DECISIONS.find((d) => d.key === spec.post);
    if (move && !legal(status, move)) continue;
    if (spec.post === "retry" && !allows(status, "approved")) continue;
    if (spec.post === "approve" && !allows(status, "approved")) continue;
    drawn.add(spec.post);
    buttons.append(moveButton(row, {
      label: spec.label || spec.post, danger: spec.danger === true, busy: "Saving",
      confirm: move && move.confirm ? move.confirm : null,
      toast: move ? move.toast : spec.label,
      body: { action: spec.post },
    }, fields.values, onDone));
  }

  for (const spec of DECISIONS) {
    if (drawn.has(spec.key) || !legal(status, spec)) continue;
    drawn.add(spec.key);
    buttons.append(moveButton(row, {
      label: spec.label, danger: spec.danger === true, busy: "Saving", confirm: spec.confirm || null,
      toast: spec.toast, body: { action: spec.key },
    }, fields.values, onDone));
  }

  for (const rung of LADDER) {
    if (status !== rung.from || drawn.has(rung.to) || !allows(status, rung.to)) continue;
    drawn.add(rung.to);
    buttons.append(moveButton(row, {
      label: rung.label, busy: "Saving", route: "outcome", toast: rung.label,
      body: { status: rung.to, note: "recorded from the row page" },
    }, null, onDone));
  }

  if (!buttons.childElementCount) return null;
  const card = h("section", { class: "card decide-card" }, h("h2", { text: "Decision" }));
  card.append(buttons, extras, fields.node,
    h("p", { class: "field-help", text: "Nothing is sent to a channel from here." }));
  return card;
}

/** Whether one standing decision is a move the row can actually make. */
function legal(status, spec) {
  if (spec.key === "hold") return canHold(status);
  return allows(status, spec.to);
}

// ---------------------------------------------------------------------------
// Redraft, and an application the person lodged themselves
// ---------------------------------------------------------------------------

/**
 * Ask the next run to write the letter again with the critic's findings in
 * front of it. Nothing is rewritten here: the letter that goes out is written
 * by cover-letter-writer in the run, not by a browser (AGENTS.md section 5).
 */
export function redraftControl(row, requested, getReason) {
  const line = h("p", { class: "job-line field-help" });
  const stamp = requested && requested.at ? shortDate(requested.at) : "";
  line.textContent = stamp ? `Redraft requested ${stamp}. The next run rewrites the letter with the critic findings.` : "";
  line.hidden = !stamp;
  const button = h("button", { type: "button", class: "btn", text: "Redraft letter" });
  button.addEventListener("click", async () => {
    const done = busy(button, "Asking");
    const reason = getReason ? String(getReason() || "").trim() : "";
    try {
      await api(`rows/${encodeURIComponent(row.id)}/redraft`, { method: "POST", body: reason ? { reason } : {} });
      line.hidden = false;
      line.className = "job-line field-help";
      line.textContent = `Redraft requested ${shortDate(new Date())}. The next run rewrites the letter with the critic findings.`;
      toast("Redraft requested. The next run rewrites the letter.");
    } catch (error) {
      line.hidden = false;
      line.className = "job-line field-error";
      line.textContent = error.status === 404 ? MISSING_ROUTE : error.message;
    }
    done();
  });
  return { button, extra: line };
}

/**
 * Record an application the person sent themselves through an external portal.
 * The button opens the form; the arming sits on the commit inside it, which is
 * the press that writes the row to sent.
 */
export function markSentControl(row, refresh, { small = false } = {}) {
  const form = h("div", { class: "mark-sent", hidden: true });
  const reference = h("input", { type: "text", id: `sent-ref-${row.id}`, placeholder: "e.g. APP-19423" });
  const note = h("input", { type: "text", id: `sent-note-${row.id}`, placeholder: "Optional" });
  const problem = h("p", { class: "field-error", hidden: true });
  const cancel = h("button", { type: "button", class: "btn", text: "Cancel" });
  const button = h("button", { type: "button", class: small ? "btn sm" : "btn", text: "Mark as applied",
    title: "Record that you sent it through the portal" });
  const save = confirmButton("Mark as applied", "Confirm mark as applied", async () => {
    const done = busy(save.button, "Saving");
    problem.hidden = true;
    const body = {
      ...(reference.value.trim() ? { confirmation: reference.value.trim() } : {}),
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
    };
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/mark-sent`, { method: "POST", body });
      toast(`Recorded. The row is now ${statusLabel(result.status_after) || "sent"}.`);
      if (refresh) refresh();
    } catch (error) {
      done();
      problem.hidden = false;
      problem.textContent = error.status === 404 ? MISSING_ROUTE : error.message;
    }
  }, { class: "btn btn-primary" });

  cancel.addEventListener("click", () => { form.hidden = true; button.focus(); });
  button.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) reference.focus();
  });
  const labelled = (control, text, help) => {
    const field = h("label", { class: "field", for: control.id }, h("span", { class: "field-label", text }), control);
    if (help) field.append(h("span", { class: "field-help", text: help }));
    return field;
  };
  form.append(h("p", { class: "field-help", text: "Recording an application you sent yourself. Nothing is submitted from here." }),
    h("div", { class: "action-fields" }, labelled(reference, "Confirmation reference", "Optional"), labelled(note, "Note")),
    h("div", { class: "action-buttons" }, save, cancel), problem);
  return { button, extra: form };
}
