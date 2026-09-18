/*
 * runs.js - what the daily run did: the list (#/runs) and one run (#/runs/<date>).
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
  clockTime, dayStamp, duration, fetchInto, h, pageHeader, placeholderRows, richMarkdown, when, whenFull,
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
  if (run.exit_code === 0) return h("span", { class: "pill pill-pass", text: "Finished" });
  if (typeof run.exit_code === "number") {
    return h("span", { class: "pill pill-fail", text: `Failed, exit ${run.exit_code}` });
  }
  return h("span", { class: "pill pill-none", text: run.has_log ? "No finish line" : "No log" });
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
// The list
// ---------------------------------------------------------------------------

/** One day. The whole row is the link, so the date, the tally and the verdict
 * are one keyboard target rather than three. */
function runRow(run) {
  const row = h("a", { class: "list-row run-row", href: `#/runs/${encodeURIComponent(run.date)}` });
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

async function viewRunList(view) {
  const count = h("p", { class: "page-count" });
  view.append(pageHeader({ title: "Runs", lede: count }));
  const host = h("div", {});
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
    host.append(h("p", { class: "empty", text: "No runs yet. Start one with npm run daily." }));
    return;
  }
  const list = h("div", { class: "list" });
  for (const run of runs) list.append(runRow(run));
  host.append(list);
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
    for (const entry of group.rows) list.append(rowFor(entry, entry.next ? `next: ${entry.next}` : null));
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

/** A fold, with the thing and its size named on the summary line. */
function fold(label, body, open) {
  const box = h("details", { class: "disclosure run-fold", open: open === true });
  box.append(h("summary", { text: label }));
  box.append(body);
  return box;
}

/** The letters an unattended run sent, each under the line that names the send. */
function lettersFold(letters) {
  const body = h("div", { class: "run-letters" });
  for (const entry of letters) {
    const block = h("article", { class: "run-letter" });
    block.append(h("p", { class: "run-letter-head", text: entry.title }));
    if (entry.letter) block.append(h("div", { class: "prose" }, richMarkdown(entry.letter)));
    else block.append(h("p", { class: "grey small", text: "The journal records the send but not the letter text." }));
    body.append(block);
  }
  return fold(`Letters sent unattended, ${letters.length}`, body);
}

/** What the page says under the title: the verdict, in a sentence. */
function runLede(run) {
  if (run.running) {
    const going = soFar(run.duration_s);
    return `Still running${run.started_at ? `, started ${when(run.started_at)}` : ""}${going ? `, ${going}` : ""}.`;
  }
  const took = duration(run.duration_s);
  const verdict = run.exit_code === 0
    ? "Finished cleanly"
    : typeof run.exit_code === "number"
      ? `Failed, exit ${run.exit_code}`
      : run.has_log ? "Wrote no finish line, so it was stopped before it could" : "Left no log";
  return `${verdict}${took ? ` in ${took}` : ""}${run.started_at ? `, started ${when(run.started_at)}` : ""}.`;
}

async function viewRunDetail(view, date) {
  const head = pageHeader({
    title: `Run on ${runDay(date)}`,
    back: h("a", { href: "#/runs", text: "Runs" }),
  });
  view.append(head);
  const host = h("div", {});
  host.append(placeholderRows(3));
  view.append(host);

  const data = await fetchInto(host, `runs/${encodeURIComponent(date)}`, `Could not load the run for ${runDay(date)}.`);
  if (!data) return;

  const run = data.run || { date, running: false, exit_code: null, has_log: false, has_summary: false };
  head.append(h("div", { class: "page-aside" }, verdictPill(run)));
  head.append(h("p", { class: "lede", text: runLede(run) }));

  if (!run.has_summary && !run.has_log) {
    host.append(h("p", { class: "empty", text: "Nothing was written for this day. A run writes its summary when it finishes." }));
    return;
  }
  if (run.running) {
    host.append(h("p", {
      class: "empty",
      text: "This run is still working, so what follows is only what it has written so far.",
    }));
  }
  if (data.from_audit) {
    host.append(h("p", {
      class: "empty",
      text: "No summary was written for this day, so what follows is read from the audit log.",
    }));
  }

  host.append(sentSection(data.sent || [], data.from_audit === true));
  host.append(stoppedSection(data.stopped || []));
  const numbers = numbersSection(data.numbers || []);
  if (numbers) host.append(numbers);

  const folds = h("section", { class: "run-section" });
  const letters = data.letters_sent || [];
  if (letters.length) folds.append(lettersFold(letters));
  if (data.markdown) {
    folds.append(fold("Raw summary", h("div", { class: "prose" }, richMarkdown(data.markdown))));
  }
  if (data.log) {
    const body = h("div", {});
    if (data.log_truncated) {
      body.append(h("p", { class: "grey small", text: "The middle of this log is not read: only the two ends are." }));
    }
    body.append(h("pre", { class: "run-log", text: data.log }));
    if (data.log_path) body.append(h("p", { class: "grey small", text: data.log_path }));
    folds.append(fold("Raw log", body));
  }
  if (data.summary_path || run.summary_path) {
    folds.append(h("p", { class: "grey small", text: data.summary_path || run.summary_path }));
  }
  if (folds.childNodes.length) host.append(folds);
}

export async function viewRuns(view, id) {
  if (id) await viewRunDetail(view, id);
  else await viewRunList(view);
}
