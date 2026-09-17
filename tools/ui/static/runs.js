/*
 * runs.js - what the daily run did, one row per day, newest first.
 *
 * AGENTS.md section 3.9: an unattended run says what it did in the journal,
 * including the full text of anything it sent. This screen is the reading end
 * of that, and only the reading end: it writes nothing and it retries nothing.
 *
 * The list row is the machine's own tally (what the summary's Numbers table
 * says the run sent and left blocked, plus the exit code and the wall time from
 * the launchd log). Opening a row fetches the summary markdown and the letters
 * that went out unattended, so a day nobody opens costs one small request.
 */

import { api, clear, errorBox, fetchInto, h, pageHeader, panel, richMarkdown } from "./app.js";
import { RUNNING_COLOUR, soFar } from "./home.js";

/**
 * A run in progress, in the amber the Harness card uses, with a dot rather
 * than an exit pill: there is no exit code yet, and a grey "no log" pill over
 * a log that is being written to this minute is simply false. The dot carries
 * its own box because the stylesheet only shapes `.dot` inside a chip.
 */
function runningPill(run) {
  const going = soFar(run.duration_s);
  return h("span", { class: "run-exit", style: RUNNING_COLOUR },
    h("span", {
      class: "dot",
      "aria-hidden": "true",
      style: "display:inline-block;width:8px;height:8px;border-radius:8px;background:var(--amber);margin-right:6px;vertical-align:middle;",
    }),
    going ? `running, ${going}` : "running");
}

/** A run that exited nonzero is red, a clean one green, an unknown one grey. */
function exitPill(run) {
  if (run.running) return runningPill(run);
  if (run.exit_code === null || run.exit_code === undefined) {
    // "no log" when there is none, and the log's own reason when there is one.
    return h("span", { class: "run-exit grey", text: run.note || (run.has_log ? "no finish line" : "no log") });
  }
  const ok = run.exit_code === 0;
  return h("span", {
    class: ok ? "run-exit good" : "run-exit bad",
    text: ok ? "exit 0" : `exit ${run.exit_code}`,
  });
}

/** "1 h 13 m", "4 m 12 s", "48 s", or nothing when the log did not say. */
export function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(Math.round(seconds % 60)).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/** The one line a row shows before it is opened. */
function runLine(run) {
  const bits = [];
  if (typeof run.sent === "number") bits.push(`${run.sent} sent`);
  if (typeof run.blocked === "number") bits.push(`${run.blocked} blocked`);
  // A run that is still going has no wall time and no summary yet, and the
  // pill beside this line already says how long it has been working.
  if (run.running) return bits.join(", ");
  const took = duration(run.duration_s);
  if (took) bits.push(`took ${took}`);
  if (!run.has_summary) bits.push("no summary written");
  return bits.join(", ");
}

/** The letters an unattended run sent, each under the line that names the send. */
function lettersPanel(letters) {
  const body = h("div", { class: "letters" });
  for (const entry of letters) {
    const block = h("article", { class: "letter" });
    block.append(h("p", { class: "letter-head", text: entry.title }));
    if (entry.letter) block.append(h("div", { class: "prose" }, richMarkdown(entry.letter)));
    else block.append(h("p", { class: "grey small", text: "The journal records the send but not the letter text." }));
    body.append(block);
  }
  return panel(`Sent unattended (${letters.length})`, body);
}

/**
 * One day. The header is a button so the whole row is one keyboard target, and
 * the detail is fetched the first time it is opened and kept after that.
 */
function runRow(run) {
  const row = h("article", { class: "run" });
  const detail = h("div", { class: "run-detail", hidden: true });
  const head = h("button", { type: "button", class: "run-head", "aria-expanded": "false" },
    h("span", { class: "run-date", text: run.date }),
    h("span", { class: "run-line grey small", text: runLine(run) }),
    exitPill(run),
    h("span", { class: "run-chevron", "aria-hidden": "true", text: "›" }));

  let loaded = false;
  head.addEventListener("click", async () => {
    const open = detail.hidden;
    detail.hidden = !open;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    row.classList.toggle("open", open);
    if (!open || loaded) return;
    loaded = true;
    clear(detail);
    detail.append(h("p", { class: "empty", text: "Loading the summary." }));
    let data;
    try {
      data = await api(`runs/${encodeURIComponent(run.date)}`);
    } catch (error) {
      loaded = false;
      clear(detail);
      detail.append(errorBox(error, `Could not load the run for ${run.date}.`, null));
      return;
    }
    clear(detail);
    const markdown = String(data.markdown || "").trim();
    if (markdown) detail.append(panel("Summary", h("div", { class: "prose" }, richMarkdown(markdown))));
    else detail.append(h("p", { class: "empty", text: "No summary for this day. The launchd log is all this run left." }));
    const letters = data.letters_sent || [];
    if (letters.length) detail.append(lettersPanel(letters));
    if (run.summary_path) detail.append(h("p", { class: "grey small", text: run.summary_path }));
  });

  row.append(head, detail);
  return row;
}

export async function viewRuns(view) {
  const count = h("p", { class: "page-count", text: "Loading the runs." });
  view.append(pageHeader({ title: "Runs", lede: count }));
  const host = h("div", {});
  host.append(h("p", { class: "empty", text: "Loading the runs." }));
  view.append(host);

  const data = await fetchInto(host, "runs?limit=30", "Could not load the runs.");
  if (!data) { count.textContent = ""; return; }

  const runs = data.runs || [];
  const total = data.total ?? runs.length;
  count.textContent = runs.length
    ? `${total > runs.length ? `Last ${runs.length} of ${total} runs` : plural(runs.length, "run")}, newest first.`
    : "";
  if (!runs.length) {
    host.append(h("p", { class: "empty", text: "No runs yet. The first daily run writes one at 07:00." }));
    return;
  }
  const list = h("div", { class: "runs" });
  for (const run of runs) list.append(runRow(run));
  host.append(list);
}
