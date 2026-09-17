/*
 * row-actions.js - the three controls on a row that do something other than
 * move it one step along the pipeline: run the gate again now, ask the next
 * run to rewrite the letter, and record an application the person sent
 * themselves in their own browser.
 *
 * Each one returns `{ button, extra }`. The button belongs in the decision bar
 * beside the other buttons; `extra` is the line or the small form it writes
 * underneath. That keeps the bar one row of buttons however much any one
 * control has to say, and lets the applications board reuse the same control
 * inside a compact row.
 *
 * AGENTS.md section 2: nothing here sends an application. "Retry now" runs the
 * harness's own critic and submission gate on this machine, which either lets
 * the autopilot lane have the row or blocks it again with a reason; "I applied
 * myself" records something the person already did somewhere else.
 *
 * Every route here is new in this wave, so a 404 is read as "this build has no
 * such route yet" and said plainly, rather than shown as a failure.
 */

import { api, h, guarded, shortDate, statusLabel, toast } from "./app.js";

/** How often the job is polled while it runs, and how long that is allowed to
 * go on for. A letter-critic pass plus the gate is a minute or two. */
const POLL_MS = 2000;
const POLL_LIMIT = 150;

const MISSING_ROUTE = "This build of the harness has no such route yet. Nothing was run.";

/** The last thing the job said, as one line. */
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

/** What the tool said when it stopped: the status it left the row in, and its
 * own message. Neither is narrated into something softer (AGENTS.md 3.8). */
function jobResult(job) {
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const said = String(result.message ?? (typeof job.result === "string" ? job.result : "") ?? "").trim() || lastLine(job.tail);
  const status = result.status_after ? `The row is now ${statusLabel(result.status_after)}.` : "";
  return [status, said].filter(Boolean).join(" ") || `The run finished, exit ${job.exit_code}.`;
}

/**
 * Run the critic and the submission gate against this row now, rather than
 * waiting for the morning. The button arms first, then posts, then follows the
 * job: a progress line while it runs, the tool's own verdict when it stops.
 */
export function retryNowControl(row, refresh, { small = false } = {}) {
  const line = h("p", { class: "job-line grey small", hidden: true });
  const button = h("button", { type: "button", class: small ? "btn primary sm" : "btn primary", text: "Retry now" });
  const say = (text, tone) => {
    line.hidden = false;
    line.className = tone === "bad" ? "job-line alarm" : "job-line grey small";
    line.textContent = text;
  };
  const reload = h("button", { type: "button", class: "btn sm", text: "Reload the row", hidden: true });
  reload.addEventListener("click", () => refresh());

  guarded(button, "Retry now", async () => {
    button.disabled = true;
    reload.hidden = true;
    say("Running the critic and the gate.");
    let started = null;
    try {
      started = await api(`rows/${encodeURIComponent(row.id)}/retry-now`, { method: "POST", body: {} });
    } catch (error) {
      button.disabled = false;
      // 409 is the server refusing the run, and its reason is the answer.
      return say(error.status === 404 ? MISSING_ROUTE : `Refused. ${error.message}`, "bad");
    }
    const outcome = await pollJob(started.job_id, (tail) => say(tail || "Running the critic and the gate."));
    button.disabled = false;
    if (outcome.error) return say(`Lost track of the run. ${outcome.error.message}`, "bad");
    if (outcome.timeout) return say("The run is still going. Open Runs to watch the rest of it.", "bad");
    const clean = outcome.job.exit_code === 0;
    say(jobResult(outcome.job), clean ? "" : "bad");
    reload.hidden = false;
  });
  return { button, extra: h("div", { class: "job-progress" }, line, reload) };
}

/**
 * Ask the next run to write the letter again with the critic's findings in
 * front of it. Nothing is rewritten here: the letter that goes out is written
 * by cover-letter-writer in the run, not by a browser (AGENTS.md section 5).
 */
export function redraftControl(row, requested, getReason, { small = false } = {}) {
  const line = h("p", { class: "job-line grey small" });
  const stamp = requested && requested.at ? shortDate(requested.at) : "";
  line.textContent = stamp ? `Redraft requested ${stamp}. The next run rewrites the letter with the critic findings.` : "";
  line.hidden = !stamp;
  const button = h("button", { type: "button", class: small ? "btn sm" : "btn", text: "Redraft letter" });
  guarded(button, "Redraft letter", async () => {
    button.disabled = true;
    const reason = getReason ? String(getReason() || "").trim() : "";
    try {
      await api(`rows/${encodeURIComponent(row.id)}/redraft`, { method: "POST", body: reason ? { reason } : {} });
      line.hidden = false;
      line.className = "job-line grey small";
      line.textContent = `Redraft requested ${shortDate(new Date())}. The next run rewrites the letter with the critic findings.`;
      toast("Redraft requested. The next run rewrites the letter.");
    } catch (error) {
      line.hidden = false;
      line.className = "job-line alarm";
      line.textContent = error.status === 404 ? MISSING_ROUTE : error.message;
    }
    button.disabled = false;
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
  const reference = h("input", { type: "text", "aria-label": "Confirmation reference, optional",
    placeholder: "Confirmation reference, optional" });
  const note = h("input", { type: "text", "aria-label": "Note, optional", placeholder: "Note, optional" });
  const problem = h("p", { class: "job-line alarm", hidden: true });
  const save = h("button", { type: "button", class: "btn primary sm", text: "Mark as sent" });
  const cancel = h("button", { type: "button", class: "btn sm", text: "Cancel" });
  const button = h("button", { type: "button", class: small ? "btn sm" : "btn", text: "I applied myself",
    title: "Record that you sent it through the portal" });

  guarded(save, "Mark as sent", async () => {
    save.disabled = true;
    problem.hidden = true;
    const body = {
      ...(reference.value.trim() ? { confirmation: reference.value.trim() } : {}),
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
    };
    try {
      const result = await api(`rows/${encodeURIComponent(row.id)}/mark-sent`, { method: "POST", body });
      toast(`Recorded. The row is now ${statusLabel(result.status_after) || "sent"}.`);
      refresh();
    } catch (error) {
      save.disabled = false;
      problem.hidden = false;
      problem.textContent = error.status === 404 ? MISSING_ROUTE : error.message;
    }
  });
  cancel.addEventListener("click", () => { form.hidden = true; button.focus(); });
  button.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) reference.focus();
  });
  form.append(h("p", { class: "grey small", text: "Recording an application you sent yourself. Nothing is submitted from here." }),
    h("div", { class: "mark-sent-fields" }, reference, note),
    h("div", { class: "action-buttons" }, save, cancel), problem);
  return { button, extra: form };
}
