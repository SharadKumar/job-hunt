/*
 * applications.js - the Pipeline screen (#/pipeline/<segment>), which is every
 * row the harness holds, cut into the six segments the person works.
 *
 * The address is the state (the redesign brief, section 3, principle 4): the
 * segment, the channel chips, the minimum score and the sort all live in the
 * hash query, so a deep link lands on exactly the list that was shared and the
 * back button walks the filters as well as the screens.
 *
 * Every count comes from one place. The segment strip reads GET /api/summary,
 * and the list header reads the same number back, so a tab that says 90 is
 * never sitting above a list header that says 30 without saying which is which.
 *
 * Which single button a row earns is the server's `action`, never a regex here
 * (rows-ext-api.ts owns it). The row anatomy and the controls a row carries
 * are in pipeline-rows.js, so neither file has to be read end to end to change
 * the other.
 *
 * AGENTS.md section 2: nothing on this screen sends. The buttons move a row in
 * the local pipeline, which is the same thing the Sheet Tray's Action column
 * does.
 */

import {
  $, api, clear, getSummary, h, loadError, loadSummary, pageHeader, parseHash, placeholderRows, setQuery,
} from "./app.js";
import {
  channelLabel, loadReasonHelper, markActed, pipelineRow, reopenControl, routeButton,
} from "./pipeline-rows.js";

/**
 * The six segments, with the statuses behind each one. They are the same six
 * the server counts in SEGMENTS (tools/ui/api.ts): `discovered` and
 * `awaiting_external` belong to none of them on purpose, because neither is a
 * queue the person works and putting them in one would make a tab disagree
 * with the list behind it.
 *
 * Sent is capped at 30 rows on the server, because the archive grows without
 * end and nobody reads the ninetieth. The cap is said out loud in the header,
 * with the way to drop it.
 */
export const SEGMENTS = [
  { key: "needs", label: "Needs you", status: "manual_action_needed" },
  { key: "queue", label: "Queue", status: "shortlisted,drafted,awaiting_approval,approved,submission_pending" },
  { key: "parked", label: "Parked", status: "parked" },
  { key: "sent", label: "Sent", status: "submitted", limit: 30 },
  { key: "replies", label: "Replies", status: "responded,interview,offered,won" },
  { key: "closed", label: "Closed", status: "rejected,withdrawn" },
];

/** What each segment says when it is empty: direction, not a shrug. */
const EMPTY = {
  needs: "Nothing needs you. The run adds rows here when it cannot finish one on its own.",
  queue: "Nothing is in the queue. The hunt adds roles here once they fit and nothing blocks them.",
  parked: "Nothing parked. Rows land here when a role is interstate and the ad does not say it is flexible.",
  sent: "Nothing has been sent yet. Submitted applications appear here, most recent first.",
  replies: "No replies yet. A row moves here when you record a response, an interview, an offer or a win.",
  closed: "Nothing closed. Rows you reject or withdraw are kept here, and can be reopened.",
};

/**
 * The four kinds of work the Needs you segment groups by, in the order the
 * brief fixes (section 4). The id on each heading is the anchor Today links
 * at, so "12 are portals you open" opens this screen at that group.
 */
const GROUPS = [
  { key: "answer_question", label: "Answer a question" },
  { key: "decide", label: "Decide" },
  { key: "open_portal", label: "Open a portal" },
  // Waiting on the run, not on the person: these rows are listed and left
  // alone, with no button to press (section 4).
  { key: "waiting_redraft", label: "Waiting on a redraft", quiet: true },
  { key: "other", label: "Other" },
];

/** How many stale applications the Sent segment shows before it offers the rest. */
const FOLLOW_UP_SHOWN = 8;

// ---------------------------------------------------------------------------
// The address is the state
// ---------------------------------------------------------------------------

/**
 * The screen's whole state, read off the address. `which` is the segment from
 * the path and may carry an anchor (`needs#open_portal`), because that is how
 * Today links at one group of a segment.
 */
function stateFrom(which, query) {
  // The router hands the fragment over on its own (`#/pipeline/needs#open_portal`
  // is the segment `needs` and the fragment `open_portal`). An older router
  // left it on the id, and a link may carry it as `?group=` instead, so all
  // three are read and the segment resolves either way.
  const [key, inId] = String(which || "").split("#");
  const segment = SEGMENTS.find((s) => s.key === key) || SEGMENTS[0];
  const q = query instanceof URLSearchParams ? query : new URLSearchParams();
  const anchor = (parseHash().fragment || inId || q.get("group") || "").trim();
  return {
    segment,
    anchor: GROUPS.some((g) => g.key === anchor) ? anchor : "",
    channels: (q.get("channel") || "").split(",").map((c) => c.trim()).filter(Boolean),
    min: (q.get("min") || "").trim(),
    sort: q.get("sort") === "updated" ? "updated" : "score",
    all: q.get("all") === "1",
  };
}

/** The strip: one tab per segment, each carrying the count the list behind it
 * will show, so a count is never a dead end (section 3, principle 1). */
function segmentStrip(state) {
  const summary = getSummary();
  const counts = (summary && summary.segments) || {};
  const strip = h("nav", { class: "segments", "aria-label": "Pipeline segments" });
  for (const segment of SEGMENTS) {
    const here = segment.key === state.segment.key;
    const tab = h("a", { href: `#/pipeline/${segment.key}`, text: segment.label });
    tab.append(h("span", { class: "tally", text: String(counts[segment.key] ?? 0) }));
    if (here) tab.setAttribute("aria-current", "page");
    strip.append(tab);
  }
  return strip;
}

/**
 * The filters: a chip per channel, the score floor and the sort, all of them
 * written to the hash query and read back from it on the next load. The old
 * filter column was module state, so a deep link landed on whichever bucket
 * was last chosen by whoever last used the tab.
 */
function filterChips(state, channels) {
  const row = h("div", { class: "chips" });
  if (channels.length > 1) {
    const group = h("div", { class: "chip-group", role: "group", "aria-label": "Channel" });
    for (const channel of channels) {
      const on = state.channels.includes(channel);
      const chip = h("button", { type: "button", class: "chip", "aria-pressed": on ? "true" : "false", text: channelLabel(channel) });
      chip.addEventListener("click", () => {
        const next = on ? state.channels.filter((c) => c !== channel) : [...state.channels, channel];
        setQuery({ channel: next.join(",") });
      });
      group.append(chip);
    }
    row.append(group);
  }

  const min = h("input", { type: "number", min: "0", max: "100", step: "1", value: state.min, placeholder: "Any", id: "min-score" });
  min.addEventListener("change", () => setQuery({ min: min.value.trim() }));
  row.append(h("label", { class: "inline-field", for: "min-score" }, h("span", { text: "Min score" }), min));

  const sort = h("select", { id: "sort-rows" });
  for (const [value, label] of [["score", "Score"], ["updated", "Updated"]]) {
    sort.append(h("option", { value, selected: state.sort === value, text: label }));
  }
  sort.addEventListener("change", () => setQuery({ sort: sort.value === "score" ? null : sort.value }));
  row.append(h("label", { class: "inline-field", for: "sort-rows" }, h("span", { text: "Sort" }), sort));
  return row;
}

/** Sort and floor the fetched rows the way the chips say. */
function visibleRows(rows, state) {
  const floor = Number(state.min);
  const out = rows.filter((row) => {
    if (state.channels.length && !state.channels.includes(row.channel)) return false;
    if (state.min !== "" && Number.isFinite(floor) && (row.score ?? 0) < floor) return false;
    return true;
  });
  return state.sort === "updated"
    ? out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    : out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/**
 * A group heading: the name, its count, and whatever the group offers on the
 * same line (the way to see the rest of a capped group). The id is the anchor
 * Today links at, so `#/pipeline/needs#open_portal` opens this screen with
 * that heading at the top of the view.
 */
function groupHeading(id, label, count, aside) {
  const head = h("h3", { class: "group-heading", id: id || null });
  head.append(h("span", {}, label, h("span", { class: "tally", text: ` ${count}` })));
  if (aside) head.append(aside);
  return head;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * `which` is the segment from the address, optionally with the anchor of one
 * Needs you group; `query` is the hash query, which carries the channel chips,
 * the score floor and the sort.
 */
export async function viewApplications(view, which, query) {
  const state = stateFrom(which, query);
  await loadReasonHelper();

  const count = h("p", { class: "page-count pipeline-count" });
  const head = pageHeader({ title: "Pipeline", lede: count });
  const strip = segmentStrip(state);
  const chips = h("div", { class: "chips-slot" });
  const list = h("div", { class: "list" });
  list.append(placeholderRows(3));
  view.append(head, strip, chips, list);

  /** Fetch the segment and repaint the list in place, without moving the page.
   * `acted` is the row an action just landed on, marked for three seconds. */
  const refresh = async (acted) => {
    // The list and the strip are refetched together: an action that moves a
    // row moves it between two segments, and a stale tab count beside a fresh
    // list is the disagreement this screen was rebuilt to end.
    const [data] = await Promise.all([fetchSegment(state), loadSummary()]);
    clear(strip);
    for (const tab of [...segmentStrip(state).children]) strip.append(tab);
    paint(data);
    markActed(acted);
  };

  const paint = (data) => {
    clear(list);
    if (data.error) {
      list.append(loadError("the pipeline", data.error, () => refresh()));
      count.textContent = "";
      return;
    }
    // The chips are the channels this segment actually holds, plus whatever
    // the address already selected, so a chip from a shared link never
    // disappears because today's rows happen not to use that channel.
    clear(chips);
    chips.append(filterChips(state, [...new Set([...data.rows.map((r) => r.channel), ...state.channels])].filter(Boolean).sort()));
    const rows = visibleRows(data.rows, state);
    const summary = getSummary();
    const total = (summary && summary.segments && summary.segments[state.segment.key]) ?? data.total ?? rows.length;
    writeCount(count, rows.length, total, data);
    if (!rows.length && !(data.followups || []).length) {
      list.append(h("p", { class: "empty", text: data.rows.length ? "No row matches these filters. Widen them to see more." : EMPTY[state.segment.key] }));
      return;
    }
    for (const section of sections(state, rows, data, refresh)) list.append(section);
    // Today links at one group ("12 are portals you open"). Land on that
    // heading and give it the focus, so it is read out rather than left to be
    // found by eye.
    if (state.anchor) {
      const target = $(`#${CSS.escape(state.anchor)}`);
      if (target) {
        target.setAttribute("tabindex", "-1");
        target.scrollIntoView({ block: "start" });
        target.focus({ preventScroll: true });
      }
    }
  };

  paint(await fetchSegment(state));
}

/**
 * The list header count. It is the segment count when the list is whole, and
 * says which of the two numbers is which when it is not: "Showing 30 of 90",
 * with the way to see the rest when it was the server that capped it.
 */
function writeCount(node, shown, total, data) {
  clear(node);
  if (shown === total) {
    node.append(h("span", { text: shown === 1 ? "1 row" : `${total} rows` }));
    return;
  }
  node.append(h("span", { text: `Showing ${shown} of ${total}` }));
  if (data.capped) {
    node.append(h("button", { type: "button", class: "btn-text", text: "Show all", onClick: () => setQuery({ all: "1" }) }));
  }
}

/** One fetch of the segment, plus the follow-ups the Sent segment groups by.
 * A failure comes back as data rather than as a throw, so the header and the
 * strip stay on screen and the retry is in the list where it failed. */
async function fetchSegment(state) {
  const params = new URLSearchParams({ status: state.segment.status });
  if (state.segment.limit && !state.all) params.set("limit", String(state.segment.limit));
  try {
    const [data, follow] = await Promise.all([
      api(`rows?${params.toString()}`),
      state.segment.key === "sent" ? api("followups?days=7").catch(() => null) : Promise.resolve(null),
    ]);
    const rows = data.rows || [];
    return {
      rows,
      total: typeof data.total === "number" ? data.total : rows.length,
      capped: typeof data.total === "number" && data.total > rows.length,
      followups: (follow && follow.rows) || [],
      error: null,
    };
  } catch (error) {
    return { rows: [], total: 0, capped: false, followups: [], error };
  }
}

/** The list, in sections: the Needs you groups, the Sent follow-ups, or one
 * flat run of rows for every other segment. */
function sections(state, rows, data, refresh) {
  if (state.segment.key === "needs") return needsSections(rows, refresh);
  if (state.segment.key === "sent") return sentSections(rows, data.followups, refresh);
  const out = [];
  const section = h("section");
  for (const row of rows) section.append(rowFor(state, row, refresh));
  out.push(section);
  return out;
}

/**
 * One row, dressed the way its segment reads. The queue is the one place the
 * lane and the machine's own status earn their pills: it is the difference
 * between a row the run will send and a row waiting on the person.
 *
 * A reopen is the server's own action (`kind: "reopen"`), and it is the one
 * move that asks for a reason before it posts, so it opens a form under the
 * row instead of arming in place.
 */
function rowFor(state, row, refresh) {
  const queue = state.segment.key === "queue";
  const article = pipelineRow(row, refresh, { lanePill: queue, statusPill: queue });
  if ((row.action || {}).kind === "reopen") {
    const control = reopenControl(row, () => refresh(row.id));
    // One action cell per row: a closed row that also offers Mark as applied
    // already has one, and a second would sit on top of it in the same slot.
    let cell = article.querySelector(":scope > .list-action");
    if (!cell) { cell = h("div", { class: "list-action" }); article.append(cell); }
    cell.append(control.button);
    article.append(h("div", { class: "row-extra" }, control.extra));
  }
  return article;
}

/** Needs you, grouped by what the row actually needs, with an anchor per group
 * so Today can link straight at one of them. */
function needsSections(rows, refresh) {
  const out = [];
  // A server that sends no groups (an older process still running) gets a
  // flat list rather than every row under a made-up heading.
  if (!rows.some((row) => row.needs_you_group)) {
    const section = h("section");
    for (const row of rows) section.append(rowFor({ segment: { key: "needs" } }, row, refresh));
    return [section];
  }
  for (const group of GROUPS) {
    const mine = rows.filter((row) => (row.needs_you_group || "other") === group.key);
    if (!mine.length) continue;
    const section = h("section", { "aria-labelledby": group.key });
    // The heading carries the anchor id itself, so Today's link lands on the
    // heading rather than on an empty span above it.
    section.append(groupHeading(group.key, group.label, mine.length));
    for (const row of mine) {
      // A row waiting on a redraft is waiting on the run, not on the person:
      // it is listed, quietly, and there is nothing to press.
      section.append(pipelineRow(row, refresh, { action: !group.quiet }));
    }
    out.push(section);
  }
  return out;
}

/** Sent, with the applications that have gone quiet grouped above the rest in
 * the same row style. Nothing here sends: Mark responded records what the
 * person already heard back. */
function sentSections(rows, followups, refresh) {
  const out = [];
  if (followups.length) {
    const section = h("section", { "aria-labelledby": "followups-heading" });
    const body = h("div");
    const showAll = followups.length > FOLLOW_UP_SHOWN
      ? h("button", { type: "button", class: "btn-text", text: "Show all" })
      : null;
    const heading = groupHeading("followups", `No reply after 7 days`, followups.length, showAll);
    heading.id = "followups-heading";
    if (showAll) {
      showAll.addEventListener("click", () => {
        showAll.remove();
        for (const item of followups.slice(FOLLOW_UP_SHOWN)) body.append(followUpRow(item, refresh));
      });
    }
    for (const item of followups.slice(0, FOLLOW_UP_SHOWN)) body.append(followUpRow(item, refresh));
    section.append(heading, body);
    out.push(section);
  }
  const section = h("section", { "aria-labelledby": "sent-heading" });
  if (followups.length) {
    const heading = groupHeading("", "Sent", rows.length);
    heading.id = "sent-heading";
    section.append(heading);
  }
  for (const row of rows) section.append(pipelineRow(row, refresh));
  out.push(section);
  return out;
}

/** One application that has gone quiet, in the same row style as the rest of
 * the segment, with the one thing the person can record about it. */
function followUpRow(item, refresh) {
  const days = item.days_since === 1 ? "1 day" : `${item.days_since} days`;
  const article = pipelineRow({ ...item, reason: `${days} since it went out, no reply.` }, refresh, { action: false });
  const button = routeButton(item, {
    label: "Mark responded", path: "outcome", body: { status: "responded", note: "recorded from the pipeline" }, small: true,
  }, () => refresh(item.id));
  article.append(h("div", { class: "list-action" }, button));
  return article;
}
