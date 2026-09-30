/*
 * runs.js - what the daily schedule did: the list (#/schedules) and one run
 * (#/schedules/<date>). The API still calls each execution a run.
 *
 * AGENTS.md section 3.9: an unattended run says what it did in the journal,
 * including the full text of anything it sent. This screen is the reading end
 * of that, and only the reading end: it writes nothing and it retries nothing.
 *
 * What the redesign changed (docs/ui-redesign-2026-09-18.md, sections 4 and 6):
 * a run used to be an accordion that dumped the summary markdown, so the rows
 * it sent and the rows it stopped on were prose nobody could click. A run is
 * now a page: Sent, Stopped grouped by kind, Numbers, and the raw summary and
 * log folded away underneath. "exit 0" in green and "exit 1" in red are one
 * verdict pill that carries the word as well as the colour, and a run that is
 * still going is its own state rather than a failure.
 */

import {
  api, clockTime, dayStamp, duration, fetchInto, h, pageHeader, placeholderRows, richMarkdown, when, whenFull,
} from "./app.js";
import { soFar } from "./home.js";

/** A run is a day, so it is named by its day. The clock beside it is the
 * instant the log's start line carries, and the whole instant is in the row's
 * title attribute. */
const runDay = (date) => dayStamp(`${date}T00:00:00`) || String(date);

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * How the run ended, as one pill. The word is in the text, never the colour
 * alone, and a run with no exit code says which of the two reasons it has
 * rather than claiming a verdict it does not hold (section 6, Runs).
 */
export function verdictPill(run) {
  if (run.running) return h("span", { class: "pill pill-you", text: "Running" });
  if (run.exit_code === 0 && run.preparation_issues) return h("span", { class: "pill pill-warn", text: "Finished with issues" });
  if (run.exit_code === 0) return h("span", { class: "pill pill-pass", text: "Finished" });
  if (typeof run.exit_code === "number") {
    return h("span", { class: "pill pill-fail", text: `Failed, exit ${run.exit_code}` });
  }
  return h("span", { class: "pill pill-none", text: run.has_log ? "Progress unconfirmed" : "No log" });
}

/** The one meta line a list row shows: what it did, and how long it took. */
export function runLine(run) {
  const bits = [];
  // The row's own title is the day, so the start is a clock and nothing else:
  // "Mon 14 Sep" over "Mon 06:33" says Monday twice.
  if (run.started_at) bits.push(clockTime(run.started_at));
  if (typeof run.sent === "number") bits.push(`${run.sent} sent`);
  if (typeof run.blocked === "number") bits.push(`${run.blocked} stopped`);
  if (run.running) {
    const going = soFar(run.duration_s);
    if (going) bits.push(going);
  } else {
    const took = duration(run.duration_s);
    if (took) bits.push(took);
    if (!run.has_summary) bits.push("no summary");
  }
  return bits.filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Run browser
// ---------------------------------------------------------------------------

/** One day. The whole row is the link, so the date, the tally and the verdict
 * are one keyboard target rather than three. */
function runRow(run, selected) {
  const row = h("a", {
    class: selected ? "list-row run-row selected" : "list-row run-row",
    href: `#/schedules/${encodeURIComponent(run.date)}`,
  });
  const main = h("div", { class: "list-main" });
  main.append(h("span", { class: "list-title", text: runDay(run.date) }));
  main.append(h("span", { class: "list-pills" }, verdictPill(run)));
  main.append(h("p", {
    class: "list-meta",
    title: run.started_at ? whenFull(run.started_at) : null,
    text: runLine(run),
  }));
  row.append(main);
  return row;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/** A section heading with the count of the list under it. */
const sectionHead = (text, tally) =>
  h("div", { class: "section-head" }, h("h2", {}, text), tally === null || tally === undefined ? null : h("span", { class: "tally", text: String(tally) }));

/**
 * A row this run touched. It links to the application when the run named one,
 * and stays plain text when it did not: a link to a row that is not this one
 * would be worse than no link. Not every line in a run's own record is about a
 * row at all (a channel that needs signing in is about the machine), and one
 * with no title is its reason and nothing else rather than a made up name.
 *
 * Order: the title, the facts under it, then what the run said, then the way
 * out. The longest string is last, because a "next" clause two lines long
 * above a six word reason buries the reason.
 */
function rowFor(entry, extra) {
  const row = h("div", { class: "list-row" });
  const main = h("div", { class: "list-main" });
  const title = entry.title || entry.id || "";
  if (title) {
    main.append(entry.id
      ? h("a", { class: "list-title", href: `#/row/${encodeURIComponent(entry.id)}`, text: title })
      : h("span", { class: "list-title", text: title }));
  }
  const meta = [entry.company, entry.location, entry.at].filter(Boolean).join(", ");
  if (meta) main.append(h("p", { class: "list-meta", text: meta }));
  if (entry.reason) main.append(h("p", { class: "list-reason", text: entry.reason }));
  if (extra) main.append(h("p", { class: "list-meta", text: extra }));
  row.append(main);
  return row;
}

function sentSection(sent, fromAudit) {
  const box = h("section", { class: "run-section" });
  box.append(sectionHead("Sent", sent.length));
  if (!sent.length) {
    box.append(h("p", { class: "empty", text: "This run sent nothing. Autopilot sends only what its gates pass." }));
    return box;
  }
  const list = h("div", { class: "list" });
  for (const entry of sent) list.append(rowFor(entry, fromAudit ? null : entry.note));
  box.append(list);
  return box;
}

function stoppedSection(groups) {
  const total = groups.reduce((n, group) => n + group.rows.length, 0);
  const box = h("section", { class: "run-section" });
  box.append(sectionHead("Stopped", total));
  if (!total) {
    box.append(h("p", { class: "empty", text: "This run stopped on nothing." }));
    return box;
  }
  for (const group of groups) {
    const section = h("section", {});
    section.append(h("h3", { class: "group-heading" },
      h("span", {}, group.label, h("span", { class: "tally", text: ` ${group.rows.length}` }))));
    const list = h("div", { class: "list" });
    const next = {
      question: "Answer the screening question in Needs you.",
      letter: "The daily run will rewrite and recheck the letter.",
      portal: "Open the advert and complete the application on the employer's portal.",
      duplicate: "Review the row and choose whether to continue or close it.",
      gate: "Review the row and choose whether to continue or close it.",
      channel: "Sign in to the channel before the next run.",
      sending: "Check whether the channel recorded the application before retrying.",
    }[group.kind] || null;
    for (const entry of group.rows) list.append(rowFor(entry, next));
    section.append(list);
    box.append(section);
  }
  return box;
}

/** The run's own arithmetic, in the order it wrote it. Never re-counted from
 * the pipeline: that would answer what is true now, not what this run did. */
function numbersSection(numbers) {
  if (!numbers.length) return null;
  const box = h("section", { class: "run-section" });
  box.append(sectionHead("Numbers", null));
  const grid = h("div", { class: "run-numbers" });
  for (const entry of numbers) {
    grid.append(h("span", { class: "run-number-key", text: entry.label }));
    grid.append(h("span", { class: "run-number-value", text: entry.value }));
  }
  box.append(grid);
  return box;
}

/** The letters an unattended run sent, each under the line that names the send. */
function lettersPanel(letters) {
  const body = h("div", { class: "run-letters" });
  if (!letters.length) {
    body.append(h("p", { class: "empty", text: "This run recorded no unattended letters." }));
    return body;
  }
  for (const entry of letters) {
    const block = h("article", { class: "run-letter" });
    block.append(h("p", { class: "run-letter-head", text: entry.title }));
    if (entry.letter) block.append(h("div", { class: "prose" }, richMarkdown(entry.letter)));
    else block.append(h("p", { class: "grey small", text: "The journal records the send but not the letter text." }));
    body.append(block);
  }
  return body;
}

/** What the page says under the title: the verdict, in a sentence. */
function runLede(run) {
  if (run.running) {
    const going = soFar(run.duration_s);
    return `Still running${run.started_at ? `, started ${when(run.started_at)}` : ""}${going ? `, ${going}` : ""}.`;
  }
  if (run.exit_code === null && run.has_log) {
    return `Started ${run.started_at ? when(run.started_at) : "at an unknown time"}. No completion recorded. The log alone cannot tell whether work is still running or has stopped.`;
  }
  const took = duration(run.duration_s);
  const verdict = run.exit_code === 0
    ? "Run wrapper finished"
    : typeof run.exit_code === "number"
      ? `Failed, exit ${run.exit_code}`
      : run.has_log ? "No completion recorded. The log alone cannot tell whether work is still running or has stopped" : "Left no log";
  return `${verdict}${took ? ` in ${took}` : ""}${run.started_at ? `, started ${when(run.started_at)}` : ""}.`;
}

function runOverview(data, date) {
  const run = data.run || { date, running: false, exit_code: null, has_log: false, has_summary: false };
  const panel = h("section", { class: "run-overview", "aria-label": "Run overview" });
  const current = data.current_pipeline;
  const live = h("section", { class: "run-section" }, sectionHead("Pipeline now", null));
  live.append(h("p", { class: "list-meta", text: current
    ? `Updated ${when(current.generated_at)}. Current totals, not changes caused by this run.`
    : "Current pipeline counts are unavailable. This does not mean the queue is empty." }));
  if (current) {
    const grid = h("div", { class: "run-numbers" });
    for (const [label, value, href] of [
      ["Queued", current.segments?.queue, "#/pipeline/queue"],
      ["Needs you", current.needs_you, "#/pipeline/needs"],
      ["Parked", current.segments?.parked, "#/pipeline/parked"],
      ["Sent today", current.sent_today, "#/pipeline/sent"],
    ]) {
      grid.append(h("a", { href, text: label }), h("span", { text: typeof value === "number" ? String(value) : "Unavailable" }));
    }
    live.append(grid);
  }
  panel.append(live);
  if (run.last_activity_at) panel.append(h("p", { class: "list-meta", text: `Last log update: ${whenFull(run.last_activity_at)}. Log activity is not a process heartbeat.` }));
  if (run.exit_code === null && !run.running && run.has_log) {
    panel.append(h("p", { class: "empty", text: "Next: the harness needs to check the running process and last completed stage before any retry. Do not start a second run based on this status alone." }));
  }
  if (!run.has_summary && !run.has_log) {
    panel.append(h("p", { class: "empty", text: "Nothing was written for this day. A run writes its summary when it finishes." }));
    return panel;
  }
  if (run.running) {
    panel.append(h("p", {
      class: "empty",
      text: "This run is still working, so what follows is only what it has written so far.",
    }));
  }
  if (!run.running && run.has_summary) {
    panel.append(h("p", {
      class: "empty",
      text: "Historical snapshot from this run. Today and Pipeline show the work that is current now.",
    }));
  }
  if (data.front_half) {
    const front = data.front_half;
    const stages = h("section", { class: "run-section" }, sectionHead("Discovery and preparation", null));
    if (front.running && front.current_step) stages.append(h("p", { class: "list-reason", text: `Last reported stage: ${String(front.current_step).replaceAll("_", " ")}. Heartbeats confirm the worker is present, not that useful work has completed.` }));
    if (front.error) stages.append(h("p", { class: "list-reason", text: `Preparation stopped: ${front.error}` }));
    const names = { sheet_pull: "Read saved decisions", seek_saved: "Import saved jobs", expire_closed_openings: "Close expired openings", jev_classify_score: "Classify and score", tag_duplicates: "Check exact duplicates", fuzzy_duplicate_candidates: "Check similar openings", flush_old_unclassified: "Clear old unclassified openings", state_sync: "Synchronise pipeline" };
    for (const entry of front.steps || []) {
      stages.append(h("p", { class: "list-reason", text: `${names[entry.name] || (entry.name.startsWith("hunt:") ? `Search ${entry.name.slice(5).replaceAll("_", " ")}` : entry.name)}: ${entry.ok === false ? "Failed" : entry.partial ? "Partial, remaining work deferred" : entry.ok === true ? "Completed" : "Unconfirmed"}${typeof entry.duration_ms === "number" ? ` (${duration(entry.duration_ms / 1000)})` : ""}` }));
    }
    panel.append(stages);
    const step = (front.steps || []).find((entry) => entry.name === "jev_classify_score");
    const result = step && step.result ? step.result : front.classification_progress || {};
    const box = h("section", { class: "run-section" });
    box.append(sectionHead("Decision layer", null));
    box.append(h("p", { class: "list-meta", text: [
      !step ? "Classification not finished" : step.ok === false ? "Classification needs attention" : step.partial ? "Classification partially completed" : "Classification completed",
      `${result.requested ?? "Unknown"} calls`,
      `${result.cache_hits ?? "Unknown"} cache hits`,
      `${result.automatic ?? "Unknown"} automatic`,
      `${result.uncertain ?? "Unknown"} uncertain`,
      `${result.degraded ?? "Unknown"} failed decisions`,
      `${result.deferred ?? "Not recorded"} deferred`,
      typeof result.estimated_cost_usd === "number" ? `US$${result.estimated_cost_usd.toFixed(4)}` : "Cost unavailable",
    ].join(", ") }));
    const telemetry = front.telemetry || {};
    box.append(h("p", { class: "list-reason", text: `${telemetry.rows_seen ?? "Unknown"} pipeline rows examined; ${telemetry.new_or_unclassified ?? "unknown"} lacked a classification. Calls and failures are not counts of new openings.` }));
    if (telemetry.eligible_rows != null) box.append(h("p", { class: "list-meta", text: `${telemetry.eligible_rows} active candidates; ${telemetry.excluded_rows} completed, closed or held rows excluded. Up to ${result.request_limit ?? telemetry.request_limit ?? "unlimited"} new requests per run; valid cache hits do not use this allowance.` }));
    if (result.circuit_open) box.append(h("p", { class: "list-reason", text: "Repeated service failures stopped further calls. Unfinished work is retained for a later run; send gates remain in force." }));
    const reasons = result.cache_miss_reasons || telemetry.cache_miss_reasons || {};
    const reasonNames = { new_or_changed_content: "New or changed advert", previous_service_failure: "Previous service failure", decision_policy_changed: "Decision rules changed", profile_evidence_changed: "Profile evidence changed", resume_choices_changed: "CV choices changed", question_contract_changed: "Classification questions changed", model_or_route_changed: "Model or route changed", forced_refresh: "Explicit refresh" };
    for (const [reason, count] of Object.entries(reasons)) box.append(h("p", { class: "list-meta", text: `${reasonNames[reason] || reason.replaceAll("_", " ")}: ${count} cache misses (first mismatch per row).` }));
    panel.append(box);
  }
  if (run.has_summary) {
    panel.append(sentSection(data.sent || [], data.from_audit === true));
    panel.append(stoppedSection(data.stopped || []));
  } else {
    panel.append(h("p", { class: "empty", text: "No completed run summary yet. Run-specific sends, blocked work and queue movement are unconfirmed, not zero. Day-level audit events are not proof that this run caused them." }));
  }
  const numbers = numbersSection(data.numbers || []);
  if (numbers) panel.append(numbers);
  return panel;
}

function runSelected(data, date, query) {
  const active = ["summary", "log", "letters"].includes(query.get("panel")) ? query.get("panel") : "overview";
  const run = data.run || { date, running: false, exit_code: null, has_log: false, has_summary: false };
  const panel = h("section", { class: "run-selected", "aria-label": "Selected run" });
  const head = h("header", { class: "run-selected-head" },
    h("div", {}, h("p", { class: "eyebrow", text: "Selected run" }), h("h2", { text: runDay(run.date || date) })),
    verdictPill(run), h("p", { class: "run-meta", text: runLede(run) }));
  const tabs = h("nav", { class: "tabs run-selected-tabs", "aria-label": "Selected run tabs" });
  for (const tab of [{ key: "overview", label: "Overview" }, { key: "summary", label: "Summary" }, { key: "log", label: "Log" }, { key: "letters", label: "Letters" }]) {
    const q = new URLSearchParams(query);
    if (tab.key === "overview") q.delete("panel");
    else q.set("panel", tab.key);
    const link = h("a", { href: `#/schedules/${encodeURIComponent(date)}${q.toString() ? `?${q}` : ""}`, text: tab.label });
    if (tab.key === active) link.setAttribute("aria-current", "page");
    tabs.append(link);
  }
  const body = h("section", { class: "run-inspector-body" });
  if (active === "overview") {
    body.append(runOverview(data, date));
  } else if (active === "letters") {
    body.append(lettersPanel(data.letters_sent || []));
  } else if (active === "log") {
    if (!data.log) body.append(h("p", { class: "empty", text: "This run has no log." }));
    else {
    if (data.log_truncated) {
      body.append(h("p", { class: "grey small", text: "The middle of this log is not read: only the two ends are." }));
    }
    body.append(h("pre", { class: "run-log", text: data.log }));
    }
  } else if (data.markdown) {
    body.append(h("div", { class: "prose" }, richMarkdown(data.markdown)));
  } else {
    body.append(h("p", { class: "empty", text: "This run has no written summary." }));
  }
  panel.append(head, tabs, body);
  return panel;
}

export async function viewRuns(view, id, query) {
  const count = h("p", { class: "page-count" });
  view.append(pageHeader({ title: "Schedules", lede: count }));
  const host = h("div", { class: "runs-stage" });
  host.append(placeholderRows(3));
  view.append(host);
  const data = await fetchInto(host, "runs?limit=30", "Could not load the runs.");
  if (!data) return;
  const runs = data.runs || [];
  const total = data.total ?? runs.length;
  count.textContent = runs.length
    ? `${total > runs.length ? `Last ${runs.length} of ${total} runs` : plural(runs.length, "run")}, newest first.`
    : "";
  if (!runs.length) {
    host.append(h("p", { class: "empty", text: "No runs yet. The first scheduled run will appear here." }));
    return;
  }
  const selected = runs.find((run) => run.date === id) || runs[0];
  if (id !== selected.date) history.replaceState(null, "", `#/schedules/${encodeURIComponent(selected.date)}`);
  const loading = h("div", {});
  loading.append(placeholderRows(3));
  host.append(loading);
  const detail = await fetchInto(loading, `runs/${encodeURIComponent(selected.date)}`, `Could not load the run for ${runDay(selected.date)}.`);
  if (!detail) return;
  detail.current_pipeline = await api("summary").catch(() => null);
  loading.remove();
  const browser = h("section", { class: "run-browser", "aria-label": "Run history" },
    h("header", { class: "run-browser-head" }, h("p", { class: "eyebrow", text: "History" }), h("h2", { text: "Daily runs" })),
    h("nav", { class: "run-browser-list" }));
  const list = browser.querySelector(".run-browser-list");
  for (const run of runs) list.append(runRow(run, run.date === selected.date));
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  host.append(h("div", { class: "runs-workbench" }, browser, runSelected(detail, selected.date, params)));
}
