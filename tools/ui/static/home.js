/*
 * home.js - Today (#/today): the morning brief, and the work queue under it.
 *
 * One person, in the morning, after an unattended run, with three questions in
 * this order: what did the machine do under my name overnight, what does it
 * need from me, and can I see exactly what was sent. The screen answers them in
 * that order and in one column: a written paragraph whose numbers are live
 * links, then one of two peer tabs: the Needs you workspace or what went out
 * overnight. Only the active tab is drawn, so Today remains a single screen.
 *
 * The contract is docs/ui-redesign-2026-09-18.md, sections 3, 4, 6 and 7. What
 * it changed here: the eight dashboard cards and the two column flow are gone
 * (a short card left a hole beside a tall one), the big-number tile is gone,
 * the quotation moved into the persistent sidebar, and every count on the page
 * now comes from the one server call that the Pipeline tabs read, so no two
 * lines can disagree.
 *
 * Nothing on this screen sends. The only control that leaves the browser is
 * Open portal, which opens the advertiser's own page (AGENTS.md section 2).
 */

import {
  api, channelLabel, dayStamp, duration, getPolicy, getSummary, h, isPolicyAvailable, loadError,
  pageHeader, parseHash, placeholderRows, render,
} from "./app.js";
import {
  needsYouGroup, needsYouQueue, overnightFrom, sentQueue, sentSince,
} from "./today-lists.js";
import { todayWorkDetail } from "./today-workbench.js";

/** The statuses the summary counts its Needs you groups over, so the lists on
 * this page and the numbers in the brief are the same query. */
const WORKED = "manual_action_needed,shortlisted,drafted,awaiting_approval,approved,submission_pending";

/* How many sent rows are read to find the ones that went out overnight. The
 * rows API orders by status and then by score, not by when a row was sent, so
 * asking for the last thirty returns the thirty best scoring applications ever
 * lodged and misses a row the run sent at 07:26 with a score of 60. The window
 * is the whole sent list instead, and the filter is done here. */
const SENT_LOOKBACK = 500;

// ---------------------------------------------------------------------------
// Reasons in plain words
// ---------------------------------------------------------------------------

/** Short acronyms a capitalised subject must keep. */
const ACRONYMS = new Set(["jd", "ba", "ai", "cv", "sow", "ats", "api", "nsw", "pm", "rte"]);

/** What the critic's verb is, said as a noun. */
const VERB_NOUNS = {
  invent: "invention",
  misattribut: "misattribution",
  misattribute: "misattribution",
  inflate: "inflation",
  conflate: "conflation",
  contradict: "contradiction",
  duplicate: "duplication",
  overstate: "overstatement",
  omit: "omission",
  other: "unsupported claim",
};

const upperFirst = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * A critic theme key as a phrase. The keys are `<subject>:<verb>`, built for
 * grouping rather than for reading: `standing-rule-4:other` is a rule number,
 * and `ba:inflate` is an acronym plus a verb stem.
 */
export function themeWords(key) {
  const raw = String(key || "").trim();
  if (!raw) return "Unnamed theme";
  const at = raw.lastIndexOf(":");
  const subject = at === -1 ? raw : raw.slice(0, at);
  const verb = at === -1 ? "" : raw.slice(at + 1);
  const rule = /^standing-rule-(\d+)$/.exec(subject);
  if (rule) return `Standing rule ${rule[1]}`;
  const said = subject
    .split(/([\s-]+)/)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join("");
  const noun = VERB_NOUNS[verb] || verb;
  return noun ? `${upperFirst(said)}: ${noun}` : upperFirst(said);
}

/**
 * One parked reason, said the way the person would say it. The run stamps its
 * own id on the front and the tools append a parenthetical about which file
 * they wrote to; both are for the log. What is left is matched against the
 * shapes the daily run produces, and anything else comes back cleaned up
 * rather than mangled.
 */
export function plainReason(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/^\[autopilot [^\]]*\]\s*/i, "");
  s = s.replace(/^autopilot [\w-]*\d{4}-\d{2}-\d{2}:\s*/i, "");
  s = s.replace(/^daily[- ]\d{4}-\d{2}-\d{2}:\s*/i, "");
  // A reason the harness wrote may carry a dash the house style bans; the
  // daily summary replaces it with a comma, so this reads it the same way.
  s = s.replace(/\s*[\u2014\u2013]\s*/g, ", ");
  s = s.replace(/\s*\([^()]*\)\s*$/, "").trim();

  const question = /^unknown screening question:\s*"([^"]+)"/i.exec(s);
  if (question) return `Unanswered question: ${question[1].trim()}`;
  const portal = /^external ATS:\s*(\S+)/i.exec(s);
  if (portal) return `External portal: ${portal[1]}`;
  const letter = /letter-critic block \((\d+) fail/i.exec(s);
  if (letter) return `Letter blocked: ${letter[1]} ${Number(letter[1]) === 1 ? "finding" : "findings"}`;
  if (/letter-critic block/i.test(s)) return "Letter blocked";
  const duplicate = /already submitted .*within (\d+) days/i.exec(s);
  if (duplicate) return `Duplicate of a role sent within ${duplicate[1]} days`;
  if (/not a quick apply|not easy apply|apply on (the )?company website/i.test(s)) return "Portal needs a login";
  return s;
}

// ---------------------------------------------------------------------------
// The greeting
// ---------------------------------------------------------------------------

/** Four pools by the hour the person is actually in: a harness that ran at
 * 07:00 is read at 07:10 and at 23:40 by the same person. */
const GREETINGS = {
  morning: ["Good morning, {name}", "Morning, {name}", "Early start, {name}"],
  afternoon: ["Good afternoon, {name}", "Afternoon, {name}", "Back at it, {name}"],
  evening: ["Good evening, {name}", "Evening, {name}", "Winding down, {name}?"],
  night: ["Burning the midnight oil, {name}?", "Still up, {name}?", "Late one, {name}"],
};

/** A line the day of the week earns, which takes the pick one time in three. */
const WEEKDAY_FLAVOUR = {
  0: "Weekend check-in, {name}", 1: "New week, {name}",
  5: "Happy Friday, {name}", 6: "Weekend check-in, {name}",
};

const poolFor = (hour) => {
  if (hour >= 5 && hour <= 11) return GREETINGS.morning;
  if (hour >= 12 && hour <= 16) return GREETINGS.afternoon;
  if (hour >= 17 && hour <= 21) return GREETINGS.evening;
  return GREETINGS.night;
};

/** The greeting for one moment, with no clock and no randomness of its own: the
 * same date and hour always give the same line, so the page does not reshuffle
 * itself every time something refreshes. */
export function greetingFor(date, name) {
  const at = date instanceof Date ? date : new Date(date);
  const hour = at.getHours();
  let hash = 0;
  for (const ch of `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}:${hour}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  const pool = poolFor(hour);
  const flavour = WEEKDAY_FLAVOUR[at.getDay()];
  const line = flavour && hash % 3 === 0 ? flavour : pool[hash % pool.length];
  // With no name on file the line still has to read as a sentence.
  return name ? line.replace("{name}", name) : line.replace(/,?\s*\{name\}/, "");
}

/** The first name the profile carries, or nothing to greet by. */
const firstName = (result) => {
  const profile = result.status === "fulfilled" && result.value ? result.value.profile : null;
  return String((profile && profile.name) || "").trim().split(/\s+/)[0] || "";
};

// ---------------------------------------------------------------------------
// Shared little things
// ---------------------------------------------------------------------------

/** How long a run has been going, in the units someone watching it thinks in:
 * "24 min so far", never "24 m 07 s", which pretends to a precision a moving
 * number does not have. Runs reads it from here. */
export function soFar(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute so far";
  if (minutes < 60) return `${minutes} min so far`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min so far`;
}

/** A day and time the way the person reads it: "Thu 18 Sep, 07:00". */
export const dayTime = (iso, withTime) => dayStamp(iso, withTime);

/** How long a run took, and how a channel is named. One definition for the
 * whole UI, from app.js; re-exported because Settings and Runs read them here. */
export { channelLabel, duration };

export const plural = (n, word) => `${n === 1 ? word : `${word}s`}`;

/** A live number in the brief. A zero is plain text: there is nothing behind
 * it to open (section 7, Brief). */
function num(value, href) {
  const text = String(value);
  return value > 0 && href ? h("a", { class: "brief-number", href, text }) : document.createTextNode(text);
}

/** The count beside a heading: the same number as the list under it. */
const tallyOf = (n) => (n === null || n === undefined ? null : h("span", { class: "tally", text: ` ${n}` }));

/** A section heading in the serif, with its count and, when the section is
 * capped, the link to the whole list on the same baseline. */
export function sectionHead(text, tally, more) {
  const head = h("div", { class: "section-head today-head" });
  head.append(h("h2", {}, text, tallyOf(tally)));
  if (more) head.append(more);
  return head;
}

/** A group heading inside a section: 15 px, the same shape, one step down. */
export function groupHead(text, tally, more) {
  const head = h("h3", { class: "group-heading" });
  head.append(h("span", {}, text, tallyOf(tally)));
  if (more) head.append(more);
  return head;
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/** The four clauses, in the order the brief says them. */
const CLAUSES = [
  { key: "answer_question", one: "needs an answer", many: "need an answer" },
  { key: "open_portal", one: "is a portal you open", many: "are portals you open" },
  { key: "waiting_redraft", one: "letter waits on a redraft", many: "letters wait on a redraft" },
  { key: "decide", one: "needs a decision", many: "need a decision" },
];

/** What the run did while nobody was watching. */
function overnightLine(sentCount, stopped) {
  if (!sentCount && !stopped) return ["The run sent nothing overnight and stopped on nothing."];
  const bits = ["Overnight the run "];
  if (sentCount) {
    bits.push("sent ", num(sentCount, "#/pipeline/sent"), ` ${plural(sentCount, "application")}`);
    if (stopped) bits.push(" and ");
  }
  if (stopped) bits.push("stopped on ", num(stopped, "#/pipeline/needs"));
  bits.push(".");
  return bits;
}

/** The four groups as one sentence, with every zero clause left out. */
function needsLine(groups) {
  const said = [];
  for (const clause of CLAUSES) {
    const n = Number(groups[clause.key] || 0);
    if (!n) continue;
    if (said.length) said.push(", ");
    said.push(num(n, `#/pipeline/needs#${clause.key}`), ` ${n === 1 ? clause.one : clause.many}`);
  }
  if (!said.length) return ["Nothing needs you."];
  said.push(".");
  return said;
}

/** The lane in force, and when the machine next wakes up. */
function laneLine(summary, policy, health) {
  const said = [];
  const sent = summary ? summary.sent_today ?? 0 : 0;
  if (!isPolicyAvailable() || !policy) {
    said.push("The policy API is not answering, so the lane in force cannot be read.");
  } else if (policy.kill_switch === true) {
    said.push("The kill switch is on, so nothing sends unattended.");
  } else {
    said.push(`Autopilot is ${policy.autopilot_enabled ? "on" : "off"}, `, num(sent, "#/pipeline/sent"));
    said.push(typeof policy.max_per_day === "number" ? ` of ${policy.max_per_day} today.` : " sent today.");
  }
  const next = health && health.next_run ? dayTime(health.next_run, true) : "";
  said.push(next ? ` Next run ${next}.` : " No schedule is installed, so nothing runs on its own.");
  return said;
}

/** The paragraph Today opens with: three sentences, every number a link. */
function brief(summary, policy, health, sentCount) {
  const box = h("div", { class: "brief" });
  const groups = (summary && summary.needs_you_groups) || {};
  const stopped = summary ? summary.needs_you ?? 0 : 0;
  box.append(h("p", {}, overnightLine(sentCount, stopped)));
  box.append(h("p", {}, needsLine(groups)));
  box.append(h("p", {}, laneLine(summary, policy, health)));
  return box;
}

/** The two parts of the morning review are peers in the title row. The query
 * is preserved so returning from Sent overnight restores the selected row. */
function todayTabs(active, query) {
  const nav = h("nav", { class: "tabs", "aria-label": "Today" });
  const links = {};
  for (const tab of [{ key: "needs", label: "Needs you" }, { key: "sent", label: "Sent overnight" }]) {
    const q = new URLSearchParams(query);
    if (tab.key === "sent") q.set("panel", "sent");
    else q.delete("panel");
    const link = h("a", { href: `#/today${q.toString() ? `?${q}` : ""}`, text: tab.label });
    if (tab.key === active) link.setAttribute("aria-current", "page");
    links[tab.key] = link;
    nav.append(link);
  }
  return { nav, links };
}


// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** The first line of the day's summary, for a machine whose runs index has not
 * been written yet. Headings and bullets are skipped: the headline is prose. */
export function journalHeadlineOf(markdown) {
  for (const line of String(markdown || "").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#") || text.startsWith("|") || /^[-*+]\s/.test(text)) continue;
    return text;
  }
  return "";
}

export async function viewHome(view) {
  // The greeting is drawn before the name is known and filled in when it
  // arrives; the pick does not depend on the name, so the line does not jump.
  const now = new Date();
  const query = parseHash().query;
  const active = query.get("panel") === "sent" ? "sent" : "needs";
  const tabs = todayTabs(active, query);
  const head = pageHeader({ title: greetingFor(now, ""), aside: tabs.nav });
  const title = head.querySelector("h1");
  // A screen reader should not read a rhetorical question mark out as one.
  const say = (text) => { title.textContent = text; title.setAttribute("aria-label", text.replace(/\?/g, "")); };
  say(greetingFor(now, ""));
  view.append(head);
  const body = h("div", { class: "today-body" });
  body.append(placeholderRows(3));
  view.append(body);

  const results = await Promise.allSettled([
    api("health"),
    api(`rows?status=${WORKED}`),
    api(`rows?status=submitted&limit=${SENT_LOOKBACK}`),
    api("resumes"),
    api("runs?limit=1"),
  ]);
  const [health, needs, sent, resumes, runs] = results;
  const name = firstName(resumes);
  if (name) say(greetingFor(now, name));

  while (body.firstChild) body.firstChild.remove();
  const baseSummary = getSummary();
  const healthValue = health.status === "fulfilled" ? health.value : null;
  const runRows = runs.status === "fulfilled" ? runs.value.runs || [] : [];
  const workRows = needs.status === "fulfilled" ? needs.value.rows || [] : [];
  const grouped = { answer_question: 0, decide: 0, open_portal: 0, waiting_redraft: 0 };
  for (const row of workRows) {
    const key = needsYouGroup(row.action);
    if (key) grouped[key] += 1;
  }
  const groupedTotal = Object.values(grouped).reduce((total, count) => total + count, 0);
  const summary = baseSummary && needs.status === "fulfilled"
    ? { ...baseSummary, needs_you: groupedTotal, needs_you_groups: grouped }
    : baseSummary;
  const sentRows = sent.status === "fulfilled"
    ? sentSince(sent.value.rows || [], overnightFrom(healthValue, runRows))
    : [];
  tabs.links.needs.textContent = `Needs you ${summary ? summary.needs_you ?? groupedTotal : groupedTotal}`;
  tabs.links.sent.textContent = `Sent overnight ${sentRows.length}`;
  body.append(brief(summary, getPolicy(), healthValue, sentRows.length));
  // The queue and the selected application stay in view together. Selecting a
  // row changes URL state only; the detail keeps save, review and send as
  // separate steps.
  if (active === "needs" && needs.status === "fulfilled") {
    const rows = workRows;
    const asked = parseHash().query.get("selected");
    const selected = rows.find((row) => row.id === asked) || rows[0] || null;
    const workbench = h("div", { class: "today-workbench" });
    workbench.append(needsYouQueue(rows, healthValue, selected && selected.id), await todayWorkDetail(selected));
    body.append(workbench);
  } else if (active === "needs") {
    body.append(h("section", { class: "today-section" }, loadError("the work queue", needs.reason, () => render())));
  }
  if (active === "sent" && sent.status === "fulfilled") {
    const asked = query.get("sent");
    const selected = sentRows.find((row) => row.id === asked) || sentRows[0] || null;
    const workbench = h("div", { class: "today-workbench" });
    workbench.append(sentQueue(sentRows, selected && selected.id, query), await todayWorkDetail(selected));
    body.append(workbench);
  } else if (active === "sent") {
    body.append(h("section", { class: "today-section" }, loadError("what was sent", sent.reason, () => render())));
  }
}
