/*
 * today-lists.js - the lists under the brief on Today (#/today): the Needs you
 * groups, what went out overnight, and the four reference lines at the bottom.
 *
 * It is a second module rather than more of home.js because no module in this
 * front end may pass 500 lines: home.js owns the greeting, the brief and the
 * view, and this owns everything the view draws under them. The two import
 * from each other, which is safe for the same reason app.js and the screens do
 * it: nothing here touches an imported binding at module scope.
 *
 * The contract is docs/ui-redesign-2026-09-18.md, sections 4, 6 and 7. Every
 * row on this page is the shared `.list-row` from app.css, every count is the
 * length of the list under it, and nothing here sends.
 */

import {
  APPLY_METHODS, channelLabel, h, laneLabel, localDay, scoreCell, when, whenFull,
} from "./app.js";
import { dayTime, duration, groupHead, plainReason, plural, sectionHead, soFar, themeWords } from "./home.js";

/** No group lists more than this; the rest are one link away. */
const GROUP_CAP = 8;

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

/**
 * Which of the four groups a row is in. This mirrors `needsYouGroup` in
 * tools/ui/rows-ext-api.ts, which is what counted the numbers in the brief: the
 * classification is the server's, read back off the action it already made, so
 * the group heading and the number above it can never disagree.
 */
const GROUP_OF_KIND = {
  answer: "answer_question",
  decide: "decide",
  gate_refused: "decide",
  portal: "open_portal",
  mark_sent: "open_portal",
  retry: "waiting_redraft",
};

export function needsYouGroup(action) {
  const kind = action && action.kind;
  if (!kind || kind === "in_flight" || kind === "none") return null;
  return GROUP_OF_KIND[kind] || null;
}

/** The four groups, in the order section 4 fixes, with the person's heading. */
const GROUPS = [
  { key: "answer_question", title: "Answer a question" },
  { key: "decide", title: "Decide" },
  { key: "open_portal", title: "Open a portal" },
  { key: "waiting_redraft", title: "Waiting on a redraft" },
];

/** What the one button on a row says, named by what will happen. A row whose
 * work is done on the row page opens it; a portal row opens the advert, which
 * is the action itself. */
const OPENS_ROW = { answer: "Answer and retry", decide: "Decide", gate_refused: "Decide" };

function rowAction(row) {
  const action = row.action || {};
  if (action.kind === "portal") {
    const href = action.href || row.url;
    if (href) {
      return h("a", {
        class: "btn btn-primary", href, target: "_blank", rel: "noreferrer noopener",
        text: "Open portal",
      });
    }
  }
  const label = OPENS_ROW[action.kind];
  if (!label) return null;
  return h("a", { class: "btn btn-primary", href: `#/row/${encodeURIComponent(row.id)}`, text: label });
}

/** Employer, location, channel: facts, on one 13 px line. */
function metaLine(row) {
  const method = APPLY_METHODS[String(row.applyMethod || "")] || "";
  return [row.company, row.location, channelLabel(row.channel), method].filter(Boolean).join(", ");
}

/** The lane, and whether the person saved the job themselves. Nothing else
 * earns a pill (section 6, Global components). */
function rowPills(row) {
  const pills = [];
  const lane = laneLabel(row.lane);
  if (lane) pills.push(h("span", { class: row.lane === "attended" ? "pill pill-you" : "pill pill-autopilot", text: lane }));
  if (row.userSaved === true) pills.push(h("span", { class: "pill", text: "Saved by you" }));
  return pills.length ? h("span", { class: "list-pills" }, pills) : null;
}

function listRow(row, extras) {
  const item = h("div", { class: "list-row" });
  const main = h("div", { class: "list-main" });
  main.append(h("a", { class: "list-title", href: `#/row/${encodeURIComponent(row.id)}`, text: row.title || "Untitled role" }));
  const pills = rowPills(row);
  if (pills) main.append(pills);
  const meta = [metaLine(row), extras || ""].filter(Boolean).join(", ");
  if (meta) main.append(h("p", { class: "list-meta", text: meta }));
  const reason = plainReason(row.reason);
  if (reason) main.append(h("p", { class: "list-reason", text: reason }));
  item.append(main, scoreCell(row.score));
  const action = rowAction(row);
  if (action) item.append(h("div", { class: "list-action" }, action));
  return item;
}

/**
 * The compact work queue on the left of Today. Selecting a row changes only
 * the URL and the detail beside it. It never changes pipeline state.
 */
export function needsYouQueue(rows, health, selectedId) {
  const ordered = [];
  for (const group of GROUPS) {
    for (const row of rows.filter((item) => needsYouGroup(item.action) === group.key)) {
      ordered.push({ row, group });
    }
  }
  const box = h("section", { class: "today-queue", "aria-label": "Needs your attention" });
  const head = h("div", { class: "queue-head" });
  head.append(h("div", {}, h("p", { class: "eyebrow", text: "Work queue" }),
    h("h2", { text: "Needs your attention" })),
  h("span", { class: "queue-count", text: String(ordered.length) }));
  box.append(head);
  if (!ordered.length) {
    const next = health && health.next_run ? dayTime(health.next_run, true) : "";
    box.append(h("p", { class: "empty", text: next ? `Nothing needs you. The next run is ${next}.` : "Nothing needs you." }));
    return box;
  }
  const list = h("div", { class: "queue-list" });
  for (const { row, group } of ordered.slice(0, 12)) {
    const selected = row.id === selectedId;
    const link = h("a", {
      class: selected ? "queue-item selected" : "queue-item",
      href: `#/today?selected=${encodeURIComponent(row.id)}`,
      "aria-current": selected ? "true" : null,
    });
    link.append(
      h("span", { class: "queue-score", text: typeof row.score === "number" ? String(Math.round(row.score)) : "?" }),
      h("span", { class: "queue-copy" },
        h("span", { class: "queue-title", text: row.title || "Untitled role" }),
        h("span", { class: "queue-company", text: [row.company, row.location].filter(Boolean).join(", ") }),
        h("span", { class: "queue-reason", text: plainReason(row.reason) || group.title })),
      h("span", { class: "queue-action", text: group.title }),
    );
    list.append(link);
  }
  box.append(list);
  if (ordered.length > 12) box.append(h("a", { class: "queue-more", href: "#/pipeline/needs", text: `Show all ${ordered.length}` }));
  return box;
}

/** The whole Needs you block: four sections, each capped, each with a link to
 * the segment behind it. */
export function needsYouSection(rows, health) {
  const box = h("section", { class: "today-section" });
  box.append(sectionHead("Needs you", null, null));
  const groups = new Map(GROUPS.map((group) => [group.key, []]));
  for (const row of rows) {
    const key = needsYouGroup(row.action);
    if (key && groups.has(key)) groups.get(key).push(row);
  }
  let drawn = 0;
  for (const group of GROUPS) {
    const found = groups.get(group.key);
    if (!found.length) continue;
    drawn += 1;
    const more = found.length > GROUP_CAP
      ? h("a", { class: "linkish", href: `#/pipeline/needs#${group.key}`, text: `Show all ${found.length}` })
      : null;
    const section = h("section", {});
    section.append(groupHead(group.title, found.length, more));
    const list = h("div", { class: "list" });
    // The redraft group is the run's work, not the person's, so it is quiet:
    // listRow gives it no button because its action has none in the map.
    for (const row of found.slice(0, GROUP_CAP)) list.append(listRow(row));
    section.append(list);
    box.append(section);
  }
  if (!drawn) {
    const next = health && health.next_run ? dayTime(health.next_run, true) : "";
    box.append(h("p", { class: "empty", text: next ? `Nothing needs you. The next run is ${next}.` : "Nothing needs you." }));
  }
  return box;
}

// ---------------------------------------------------------------------------
// Sent overnight
// ---------------------------------------------------------------------------

/** When a row was actually sent. `updated_at` is the last touch of any kind. */
const sentAt = (row) => row.submittedAt || row.submitted_at || row.updated_at;

/** The instant the last run started, which is what "overnight" means. With no
 * run on file the day is the person's own calendar day. */
export function overnightFrom(health, runs) {
  const last = health && health.last_run ? health.last_run.started_at : null;
  if (last) return last;
  const run = runs && runs.length ? runs[0].started_at : null;
  return run || null;
}

export function sentSince(rows, since) {
  if (!since) {
    const today = localDay();
    return rows.filter((row) => localDay(sentAt(row)) === today);
  }
  return rows.filter((row) => {
    const at = sentAt(row);
    return Boolean(at) && String(at) >= String(since);
  });
}

export function sentSection(rows) {
  const box = h("section", { class: "today-section" });
  const more = rows.length ? h("a", { class: "linkish", href: "#/pipeline/sent", text: "Show all" }) : null;
  box.append(sectionHead("Sent overnight", rows.length, more));
  if (!rows.length) {
    box.append(h("p", { class: "empty", text: "Nothing went out overnight. The run sends on the autopilot lane only." }));
    return box;
  }
  const list = h("div", { class: "list" });
  for (const row of rows) {
    const at = sentAt(row);
    list.append(listRow(row, at ? when(at) : ""));
  }
  box.append(list);
  return box;
}

// ---------------------------------------------------------------------------
// The reference lines at the bottom
// ---------------------------------------------------------------------------

/** One line: a name on the left, a value on the right, the whole row a link.
 * `stamp` is the whole instant behind a date, for the hover. */
function pair(href, key, value, options) {
  const opts = options || {};
  const row = h(href ? "a" : "div", { class: "today-pair", href: href || null, title: opts.stamp || null });
  row.append(h("span", { class: "today-key", text: key }));
  row.append(h("span", { class: opts.ink ? "today-value digest-count" : "today-value", text: value }));
  return row;
}

/** What the last run did, in one sentence, and where to read it. */
function lastRunLine(health, runs, journalHeadline) {
  const run = runs && runs.length ? runs[0] : null;
  const last = health && health.last_run ? health.last_run : null;
  if (!run && !last) {
    return pair("#/runs", "Last run", journalHeadline || "No run has been logged yet");
  }
  const date = (run && run.date) || (last && last.date) || "";
  const started = (last && last.started_at) || (run && run.started_at) || null;
  const stamp = started ? when(started) : dayTime(`${date}T00:00:00`, false);
  const running = Boolean((run && run.running) || (last && last.running));
  const hover = started ? whenFull(started) : "";
  if (running) {
    const going = soFar((run && run.duration_s) ?? (last && last.duration_seconds));
    return pair(`#/runs/${date}`, "Last run", `${stamp}, running now${going ? `, ${going}` : ""}`, { stamp: hover });
  }
  const exit = (last && last.exit_code) ?? (run && run.exit_code) ?? null;
  const took = duration((last && last.duration_seconds) ?? (run && run.duration_s));
  const verdict = exit === null ? "did not write a finish line" : exit === 0 ? "finished cleanly" : `failed, exit ${exit}`;
  return pair(`#/runs/${date}`, "Last run", `${stamp}, ${verdict}${took ? ` in ${took}` : ""}`, { stamp: hover });
}

/** Whether each channel the profile switched on can still sign in. */
function channelsLine(health) {
  const channels = (health && health.channels) || [];
  if (!channels.length) return pair("#/settings", "Channels", "None switched on");
  const ok = channels.filter((channel) => channel.state === "ok").map((channel) => channelLabel(channel.id));
  const bad = channels.filter((channel) => channel.state !== "ok").map((channel) => channelLabel(channel.id));
  const said = [];
  if (ok.length) said.push(`${ok.join(" and ")} signed in`);
  if (bad.length) said.push(`${bad.join(" and ")} needs signing in`);
  return pair("#/settings", "Channels", said.join(", "));
}

export function referenceSection(summary, keywords, health, runs, journalHeadline) {
  const box = h("section", { class: "today-section" });
  box.append(sectionHead("Also", null, null));
  const list = h("div", { class: "today-list" });
  const replies = summary ? (summary.segments || {}).replies ?? 0 : 0;
  const pending = keywords.status === "fulfilled" ? keywords.value.term_total ?? 0 : 0;
  list.append(pair("#/pipeline/replies", "Replies", String(replies), { ink: true }));
  list.append(pair("#/resumes/evidence", "Evidence questions", String(pending), { ink: true }));
  list.append(lastRunLine(health, runs, journalHeadline));
  list.append(channelsLine(health));
  box.append(list);
  return box;
}

/** One line per positioning: the name, and when it was approved. */
export function resumesSection(result) {
  const items = result.status === "fulfilled" ? result.value.resumes || [] : [];
  const box = h("section", { class: "today-section" });
  box.append(sectionHead("Resumes", null, null));
  if (!items.length) {
    box.append(h("p", { class: "empty", text: "No positionings yet. Run /onboarding, then /resume-review." }));
    return box;
  }
  const list = h("div", { class: "today-list" });
  for (const item of items) {
    const stamp = item.stamp || { kind: "missing", text: "No render" };
    const findings = (item.critic || {}).findings_count ?? 0;
    const said = stamp.kind === "approved"
      ? stamp.text.replace(/^Approved/, "approved")
      : findings
        ? `needs review, ${findings} ${plural(findings, "finding")}`
        : String(stamp.text).toLowerCase();
    list.append(pair("#/resumes", item.label || item.id, said));
  }
  box.append(list);
  return box;
}

/** The themes the critic keeps raising. AGENTS.md section 5: they become
 * editorial rules in an attended session, never from here. */
export function themesSection(result) {
  const themes = result.status === "fulfilled" ? (result.value.themes || []).slice(0, 3) : [];
  if (!themes.length) return null;
  const box = h("section", { class: "today-section" });
  box.append(sectionHead("Recurring critic themes", null, null));
  const list = h("div", { class: "today-list" });
  for (const theme of themes) list.append(pair("#/guardrails", themeWords(theme.key), String(theme.count ?? 0), { ink: true }));
  box.append(list);
  return box;
}
