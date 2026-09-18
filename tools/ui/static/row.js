/*
 * row.js - one application, read end to end (#/row/<id>).
 *
 * The page answers four questions in this order: what is this, how far did it
 * get, may the letter go out, and what is left for the person to do. So it is
 * the breadcrumb and the title, then the facts, then the timeline, then the
 * reason it stopped if it stopped, then the gates, then the letter beside the
 * job description, then the question in the way, the decision, and the history
 * last (docs/ui-redesign-2026-09-18.md, sections 4, 6 and 7).
 *
 * Two rules from AGENTS.md bite hardest here. Section 8: a verdict that was
 * never run is shown as missing, never read as a pass, so every chip in the
 * gates strip is quoted off a recorded verdict and a gate with no record says
 * "not run". Section 2: the only control on this page that can put an
 * application in front of an advertiser is "Send now via autopilot", it says
 * so, and it is never pressed from code.
 */

import {
  APPLY_METHODS, api, askForToken, asText, clear, h, isUnauthorised, laneLabel, loadError,
  pageHeader, placeholderRows, render, statusLabel, when, whenFull,
} from "./app.js";
import { decisionCard, primaryControl, redraftControl, sendNowControl } from "./row-actions.js";
import { gatesStrip, letterCard, letterEditable } from "./row-letter.js";

/** Where the pipeline leaves a request to open this row with the question
 * focused. The board writes the same key; one string, two screens. */
const FOCUS_KEY = "jobHuntFocusScreening";

/** The reason that means a person has to answer something before the run can
 * finish. The same family of wording the daily writes into a row's notes. */
const UNANSWERED_QUESTION = /screening question|unanswered question|question is not in/i;

// ---------------------------------------------------------------------------
// Where this row sits, and how far it got
// ---------------------------------------------------------------------------

/** The Pipeline segments, as api.ts SEGMENTS has them. The breadcrumb goes to
 * the one this row is in, so the way back is the list it came from. */
const SEGMENTS = [
  { key: "needs", label: "Needs you", statuses: ["manual_action_needed"] },
  { key: "queue", label: "Queue", statuses: ["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending"] },
  { key: "parked", label: "Parked", statuses: ["parked"] },
  { key: "sent", label: "Sent", statuses: ["submitted"] },
  { key: "replies", label: "Replies", statuses: ["responded", "interview", "offered", "won"] },
  { key: "closed", label: "Closed", statuses: ["rejected", "withdrawn"] },
];

function segmentOf(status) {
  return SEGMENTS.find((segment) => segment.statuses.includes(String(status || ""))) || null;
}

/** The linear queue as the person reads it. A status that is a hold or an exit
 * is not a seventh step: it is a branch off the step it left. */
const STEPS = [
  { label: "discovered", statuses: ["discovered"] },
  { label: "shortlisted", statuses: ["shortlisted"] },
  { label: "drafted", statuses: ["drafted", "awaiting_approval"] },
  { label: "approved", statuses: ["approved", "submission_pending"] },
  { label: "sent", statuses: ["submitted"] },
  { label: "reply", statuses: ["responded", "interview", "offered", "won"] },
];

const STEP_OF = {};
STEPS.forEach((step, index) => { for (const status of step.statuses) STEP_OF[status] = index; });

/** A hold or an exit, in the person's vocabulary. */
const BRANCHES = {
  parked: "Parked",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  awaiting_external: "Waiting on them",
  manual_action_needed: "Stopped",
};

/** What stopped it, named by the work the server says is left. */
const STOPPED_BY = {
  answer: "Stopped: question unanswered",
  portal: "Stopped: a portal to open",
  retry: "Stopped: letter blocked",
  decide: "Stopped: needs a decision",
  gate_refused: "Stopped: outside the autopilot lane",
  mark_sent: "Stopped: a portal to open",
};

function branchLabel(row, act) {
  const status = String(row.status || "");
  if (status !== "manual_action_needed") return BRANCHES[status] || "";
  return STOPPED_BY[(act && act.kind) || ""] || "Stopped";
}

/**
 * The timeline: six steps, the step the row is on filled in the person's
 * colour, and a hold or an exit as a labelled branch under the step it left.
 * How far it got is read off the history, so a row that came back from a stop
 * still shows the ground it covered.
 */
export function timeline(row, act) {
  const status = String(row.status || "");
  const history = Array.isArray(row.history) ? row.history : [];
  let reached = STEP_OF[status] ?? -1;
  let left = -1;
  for (const entry of history) {
    const at = STEP_OF[String(entry && entry.to)] ?? -1;
    if (at > reached) reached = at;
    if (String(entry && entry.to) === status && (STEP_OF[String(entry.from)] ?? -1) > left) left = STEP_OF[String(entry.from)];
  }
  const branch = branchLabel(row, act);
  // A branched row sits at the step it left, or at the furthest it reached
  // when the history does not say where it came from.
  const current = branch ? Math.max(left, reached, 0) : Math.max(reached, 0);
  const list = h("ol", { class: "timeline", "aria-label": "Progress" });
  STEPS.forEach((step, index) => {
    const state = index === current ? "current" : index < current ? "done" : "";
    const li = h("li", { class: state }, h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "step-label", text: step.label }));
    if (branch && index === current) li.append(h("span", { class: "branch", text: branch }));
    list.append(li);
  });
  return list;
}

// ---------------------------------------------------------------------------
// Why it stopped
// ---------------------------------------------------------------------------

/** The run stamp the daily writes in front of a reason is machinery. */
const plainReason = (text) => String(text || "").replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();

/**
 * The reason, in full.
 *
 * `GET /api/rows/:id` caps `reason` at 160 characters and marks the cut. The
 * whole sentence is on the row, in the history entry the cap was taken from,
 * so a capped reason is completed from there rather than shown with its tail
 * missing: section 6 bans a truncated reason outright.
 */
function fullReason(data, row) {
  const shown = plainReason(data.reason);
  if (!shown.endsWith("…")) return shown || plainReason(row.notes) || plainReason(row.parkedReason);
  const head = shown.slice(0, -1);
  const key = head.slice(0, 40);
  const entries = Array.isArray(row.history) ? row.history : [];
  const found = [...entries].reverse()
    .map((entry) => plainReason(entry && entry.reason))
    .find((text) => text.length > head.length && text.includes(key));
  return found || (plainReason(row.notes).includes(key) ? plainReason(row.notes) : head);
}

/** "Why it stopped", in the serif, when the row stopped on something. */
function stoppedLede(data, row) {
  const act = data.action || {};
  const refused = act.kind === "gate_refused";
  if (String(row.status) !== "manual_action_needed" && !refused) return null;
  const note = refused ? String(act.note || "").trim() : "";
  const text = [note, fullReason(data, row)].filter(Boolean).join(" ");
  if (!text) return null;
  return h("p", { class: "row-why" }, h("span", { class: "row-why-label", text: "Why it stopped: " }), text);
}

// ---------------------------------------------------------------------------
// The job description
// ---------------------------------------------------------------------------

/** How much of the description is shown before the fold. */
const JD_LINES = 12;

/**
 * The advert, folded rather than scrolled. There is no inner scroll region
 * anywhere in this UI: a nested scroll inside a page that already scrolls is a
 * trap. The fold remembers itself per row for the session, so a person who
 * opened it once does not open it again on every action.
 */
function jdCard(row, pkg) {
  const card = h("section", { class: "card jd-card" },
    h("div", { class: "card-head" }, h("h2", { text: "Job description" })));
  const text = asText(row.description || pkg.jd).trim();
  if (!text) {
    card.append(h("p", { class: "grey", text: "No job description stored for this row. Open the advert to read it." }));
    return card;
  }
  const lines = text.split("\n");
  if (lines.length <= JD_LINES) {
    card.append(h("div", { class: "jd" }, h("pre", { text })));
    return card;
  }
  const preview = h("div", { class: "jd" }, h("pre", { text: lines.slice(0, JD_LINES).join("\n") }));
  const fold = h("details", { class: "disclosure jd-fold" },
    h("summary", { text: "Show full description" }), h("div", { class: "jd" }, h("pre", { text })));
  const key = `jobHuntJd:${row.id}`;
  try { if (sessionStorage.getItem(key) === "open") fold.open = true; } catch { /* storage is off */ }
  preview.hidden = fold.open;
  fold.addEventListener("toggle", () => {
    preview.hidden = fold.open;
    try { sessionStorage.setItem(key, fold.open ? "open" : "shut"); } catch { /* storage is off */ }
  });
  card.append(preview, fold);
  return card;
}

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

/** Each move in the person's vocabulary. The machine's own word for it goes in
 * the pill after it, once (the brief, section 3, principle 5). */
const MOVES = {
  discovered: "Found on the channel",
  shortlisted: "Into the queue",
  drafted: "Package drafted",
  awaiting_approval: "Ready for a decision",
  approved: "Approved",
  submission_pending: "Being sent",
  submitted: "Sent",
  responded: "Replied",
  interview: "Interview",
  offered: "Offer",
  won: "Won",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  parked: "Parked",
  awaiting_external: "Waiting on them",
  manual_action_needed: "Stopped",
};

/** A reason longer than this is folded, with its first sentence on show. */
const REASON_FOLD = 240;

/** The reason under one entry, in full. A field_update entry is an enrichment
 * pass, not a decision, so it says which fields moved and keeps the machinery
 * off the page. */
function historyReason(item) {
  const fields = /^field_update:\s*([^([]*)/.exec(item.reason || "");
  if (fields) return h("p", { class: "hist-why", text: `Updated ${fields[1].trim() || "some fields"}.` });
  const full = plainReason(item.reason);
  if (!full) return null;
  if (full.length <= REASON_FOLD) return h("p", { class: "hist-why", text: full });
  const match = /^[^.!?]*[.!?](?=\s|$)/.exec(full);
  const first = match ? match[0] : `${full.slice(0, 120)}`;
  const fold = h("details", { class: "disclosure hist-fold" },
    h("summary", { text: "Show the full reason" }), h("p", { class: "hist-why", text: full }));
  return h("div", {}, h("p", { class: "hist-why", text: first }), fold);
}

/** The row's life, newest first: what moved, the machine's own transition in a
 * muted pill after it, and the reason in full under it. */
function historyCard(history) {
  const entries = Array.isArray(history) ? history.filter(Boolean) : [];
  const card = h("section", { class: "card history-card" }, h("h2", { text: "History" }));
  if (!entries.length) {
    card.append(h("p", { class: "grey", text: "No transitions recorded on this row yet." }));
    return card;
  }
  const list = h("ol", { class: "history" });
  for (const item of [...entries].reverse()) {
    const from = item.from || "new";
    const li = h("li", {});
    const head = h("p", { class: "hist-head" });
    head.append(h("span", { class: "hist-move", text: MOVES[item.to] || statusLabel(item.to) || "Moved" }));
    head.append(h("span", { class: "pill pill-status", text: `${from} to ${item.to || "unknown"}` }));
    head.append(h("span", { class: "hist-when", text: when(item.at), title: whenFull(item.at) }));
    li.append(head);
    const why = historyReason(item);
    if (why) li.append(why);
    list.append(li);
  }
  card.append(list);
  return card;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** The statuses tools/autopilot-submit.ts will start from, and the two apply
 * methods it has an adapter for (rows-ext-api.ts, postRetryNow). A send is
 * offered only where the server would accept one. */
const SEND_FROM = new Set(["manual_action_needed", "approved"]);
const ONE_CLICK = new Set(["quick_apply", "easy_apply"]);

const canSend = (row, lane) => lane === "autopilot" && SEND_FROM.has(String(row.status)) && ONE_CLICK.has(String(row.applyMethod));

/** The facts, in one line: what the job is and how it is applied for. The
 * status is not among them; it is on the timeline and in the status pill. */
function factsLine(row) {
  // "unknown" is the classifier saying it could not tell. Saying nothing is
  // the same fact without the machinery.
  const said = (value) => (value && String(value).toLowerCase() !== "unknown" ? value : null);
  const facts = [
    row.company,
    row.location,
    said(row.classification?.work_arrangement || row.workArrangement),
    said(APPLY_METHODS[row.applyMethod] || row.applyMethod),
  ].filter(Boolean);
  const line = h("p", { class: "detail-meta", text: facts.join(", ") });
  if (row.url) {
    line.append(document.createTextNode(facts.length ? ", " : ""),
      h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" }));
  }
  return line;
}

/** The pills a row wears: which lane has it, whether the person saved it, and
 * the machine's own status, said once. */
function pillLine(row, data) {
  const line = h("p", { class: "row-pills" });
  const lane = laneLabel(data.lane);
  if (lane) {
    const pill = h("span", { class: `pill ${data.lane === "attended" ? "pill-you" : "pill-autopilot"}`, text: lane });
    if (data.lane_reason) pill.setAttribute("title", data.lane_reason);
    line.append(pill);
  }
  if (row.userSaved) line.append(h("span", { class: "pill", text: "saved by you" }));
  const status = statusLabel(row.status);
  if (status) line.append(h("span", { class: "pill pill-status", text: status }));
  if (typeof row.score === "number" && Number.isFinite(row.score)) {
    line.append(h("span", { class: "row-score", text: `Score ${Math.round(row.score)}` }));
  }
  return line;
}

export async function viewRow(view, id) {
  const page = h("div", { class: "row-page" });
  view.append(page);
  page.append(pageHeader({ title: "Application", back: h("a", { href: "#/pipeline", text: "Pipeline" }) }));
  page.append(placeholderRows(3));

  let data = null;
  try {
    data = await api(`rows/${encodeURIComponent(id)}`);
  } catch (error) {
    if (isUnauthorised(error)) return askForToken();
    clear(page);
    page.append(pageHeader({ title: "Application", back: h("a", { href: "#/pipeline", text: "Pipeline" }) }));
    page.append(loadError("this row", error, () => render()));
    return;
  }

  clear(page);
  const row = data.row || {};
  const pkg = data.package || {};
  const act = data.action || { kind: "none" };
  const done = () => render();
  const segment = segmentOf(row.status);

  // The one control that can send, built once and mounted wherever the page
  // has a place for it: the top right when a send is the move, and the
  // screening card when a question is in the way of one.
  const sendable = canSend(row, data.lane);
  const send = sendable && (act.kind === "retry" || act.kind === "answer")
    ? sendNowControl(row, done, { enabled: act.kind === "retry" }) : null;

  const screeningSlot = h("div", { class: "screening-slot" });
  const focusQuestion = () => {
    screeningSlot.scrollIntoView({ block: "center", behavior: "auto" });
    const first = screeningSlot.querySelector("input, select, textarea, button");
    if (first) first.focus();
  };
  // A send says what it will do before it is pressed, so the button, the
  // sentence and the progress line stack together at the top right.
  const primary = send && act.kind === "retry"
    ? { node: h("div", { class: "send-aside" }, send.node, send.help, send.line) }
    : primaryControl(data, row, done, { onAnswer: focusQuestion });

  page.append(pageHeader({
    title: row.title || "Untitled role",
    back: h("a", { href: segment ? `#/pipeline/${segment.key}` : "#/pipeline",
      text: segment ? `Pipeline / ${segment.label}` : "Pipeline" }),
    aside: primary ? primary.node : null,
    lede: h("div", { class: "row-intro" }, pillLine(row, data), factsLine(row),
      primary && primary.extra ? primary.extra : null),
  }));
  page.append(timeline(row, act));

  const why = stoppedLede(data, row);
  if (why) page.append(why);

  page.append(gatesStrip(pkg, data.package_files));

  // The letter and the advert side by side from 960 up, letter first on a
  // phone, because the letter is what the decision is about.
  const redraft = redraftControl(row, data.redraft_requested, null);
  const hasLetter = asText(pkg.cover_letter).trim() !== "" || letterEditable(row.status);
  const columns = h("div", { class: hasLetter ? "columns" : "columns one" });
  if (hasLetter) columns.append(letterCard(row, pkg, redraft));
  columns.append(jdCard(row, pkg));
  page.append(columns);

  page.append(screeningSlot);
  const decision = decisionCard(data, row, done);
  if (decision) page.append(decision);
  page.append(historyCard(row.history));

  // The question in the way, if there is one on file. The card mounts itself
  // and answers for whether there is anything to ask, so the slot stays empty
  // rather than carrying an empty card.
  await mountScreening(screeningSlot, row, data, send);
  focusIfAsked(row, focusQuestion);
}

/**
 * The screening card, when a question is unanswered. `send` arrives disabled:
 * banking an answer enables it and puts the focus on it, and the person's own
 * press is the one that sends (AGENTS.md section 2).
 */
async function mountScreening(slot, row, data, send) {
  const act = data.action || {};
  const reason = data.reason || row.notes;
  if (act.kind !== "answer" && !UNANSWERED_QUESTION.test(String(reason || ""))) return;
  const mod = await import("./screening.js").catch(() => null);
  if (!mod || typeof mod.screeningCard !== "function") return;
  const card = await mod.screeningCard({
    row,
    reason,
    send: send && act.kind === "answer" ? send : null,
    onBanked: () => {
      if (!send) return;
      send.button.disabled = false;
      send.button.focus();
    },
  });
  if (card) return slot.append(card);
  if (act.kind !== "answer") return;
  // The run stopped on a question and the file has none: say so rather than
  // leave the person looking for a card that is not there.
  const note = h("section", { class: "card screening-card" }, h("h2", { text: "A question in the way" }),
    h("p", { text: "The run stopped on a question, and nothing unanswered is on file for this row. Open the advert to see what it asked." }));
  if (send) note.append(h("div", { class: "screening-send" }, send.node, send.help, send.line));
  slot.append(note);
}

/** A press on the board's Answer button opens this page with the question
 * already in view. The intent travels in sessionStorage, because a hash
 * carries the row id and nothing else. */
function focusIfAsked(row, focus) {
  try {
    if (sessionStorage.getItem(FOCUS_KEY) !== row.id) return;
    sessionStorage.removeItem(FOCUS_KEY);
    focus();
  } catch { /* storage is off; the card is still on the page */ }
}
