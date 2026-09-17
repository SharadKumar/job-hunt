/*
 * home.js - the default screen: one card per thing that might want the person,
 * each a summary that links to the screen which can actually do the work.
 *
 * Nothing on Home acts. It reads the harness's own health, the pipeline, the
 * resumes, the evidence questions, the critic digest and the last run, and says
 * in one line each what state they are in. AGENTS.md section 2: the lane in
 * force is the first line of the first card, so nobody has to guess whether the
 * machine is sending this morning. It is said there and nowhere else: a lede
 * under the title repeated the Harness card word for word.
 *
 * Everything on this page is written in the person's words, not the machine's.
 * `plainReason` is where that happens: a parked row's reason is a run stamp, a
 * quoted question and a parenthetical about which YAML file was appended to,
 * and none of that is the sentence the person needs. Package (b) imports it
 * from here so the applications board says the same thing.
 */

import { api, clockTime, dayStamp, getPolicy, getSummary, h, isPolicyAvailable, localDay, pageHeader, render, richMarkdown, shortDate } from "./app.js";

/** The hour scripts/install-launchd.sh puts the daily run at. */
const RUN_SCHEDULE = "The daily run is at 07:00.";

/** One dashboard card: a heading, a body, and the screen it opens. */
function card(title, href, linkText, body, note) {
  const section = h("article", { class: "card home-card" });
  section.append(h("h2", { text: title }));
  section.append(body);
  if (note) section.append(h("p", { class: "grey small", text: note }));
  section.append(h("p", { class: "home-more" }, h("a", { href, text: linkText })));
  return section;
}

const line = (text, className) => h("p", { class: className || "home-line", text });

/** A card whose fetch failed still says what is missing, in its own box. */
const failure = (what) => h("p", { class: "grey", text: what });

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
 * One parked reason, said the way the person would say it.
 *
 * The run stamps its own id on the front (`[autopilot daily-2026-09-17]`) and
 * the tools append a parenthetical about which file they wrote to. Both are
 * for the log, not for the page. What is left is then matched against the five
 * shapes the daily run actually produces; anything else is returned cleaned up
 * rather than mangled, because an unrecognised reason is still a sentence
 * somebody wrote on purpose.
 */
export function plainReason(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/^\[autopilot [^\]]*\]\s*/i, "");
  s = s.replace(/^autopilot [\w-]*\d{4}-\d{2}-\d{2}:\s*/i, "");
  s = s.replace(/^daily[- ]\d{4}-\d{2}-\d{2}:\s*/i, "");
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

/**
 * What the page says instead of "Home". Four pools by the hour the person is
 * actually in, because a harness that ran at 07:00 is read at 07:10 and at
 * 23:40 by the same person, and "Home" tells them nothing either time.
 */
const GREETINGS = {
  morning: ["Good morning, {name}", "Morning, {name}", "Early start, {name}"],
  afternoon: ["Good afternoon, {name}", "Afternoon, {name}", "Back at it, {name}"],
  evening: ["Good evening, {name}", "Evening, {name}", "Winding down, {name}?"],
  night: ["Burning the midnight oil, {name}?", "Still up, {name}?", "Late one, {name}"],
};

/** A line the day of the week earns, which takes the pick one time in three. */
const WEEKDAY_FLAVOUR = {
  0: "Weekend check-in, {name}",
  1: "New week, {name}",
  5: "Happy Friday, {name}",
  6: "Weekend check-in, {name}",
};

const poolFor = (hour) => {
  if (hour >= 5 && hour <= 11) return GREETINGS.morning;
  if (hour >= 12 && hour <= 16) return GREETINGS.afternoon;
  if (hour >= 17 && hour <= 21) return GREETINGS.evening;
  return GREETINGS.night;
};

/**
 * The greeting for one moment, with no clock and no randomness of its own: the
 * same date and hour always give the same line, so the page does not reshuffle
 * itself every time a card refreshes.
 */
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
// The cards
// ---------------------------------------------------------------------------

/** The lane in force, in one sentence. */
function standing() {
  const summary = getSummary();
  const policy = getPolicy();
  const sent = summary ? summary.sent_today ?? 0 : 0;
  if (!isPolicyAvailable() || !policy) {
    const on = summary && summary.autopilot_enabled;
    return `Autopilot ${on ? "on" : "off"}, ${sent} sent today. The policy API is not answering, so the kill switch cannot be read. ${RUN_SCHEDULE}`;
  }
  const cap = typeof policy.max_per_day === "number" ? ` of ${policy.max_per_day}` : "";
  return `Autopilot ${policy.autopilot_enabled ? "on" : "off"}, ${sent}${cap} sent today. `
    + `Kill switch ${policy.kill_switch ? "on" : "off"}. ${RUN_SCHEDULE}`;
}

/** "1h 32m", "4m 20s", or nothing when the run never said. */
export function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How long a run in progress has been going, in the units someone watching it
 * thinks in. A run that is still working is read in minutes, never in seconds:
 * "24 min so far" is the answer to the question being asked, and "24m 07s"
 * pretends to a precision that a moving number does not have.
 */
export function soFar(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute so far";
  if (minutes < 60) return `${minutes} min so far`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min so far`;
}

/**
 * The colour a run in progress is said in: the amber token, #B45309 in light
 * mode. A run that is still going is not a failure, and red said it was. The
 * style is inline because no stylesheet in this package owns these two spans.
 */
export const RUNNING_COLOUR = "color: var(--amber);";

/** A day and time the way the person reads it: "Thu 18 Sep, 07:00". */
export function dayTime(iso, withTime) {
  return dayStamp(iso, withTime);
}

/** Channel ids are module names; say them the way the site is named. */
const CHANNEL_LABELS = { seek: "SEEK", linkedin_jobs: "LinkedIn jobs", linkedin_posts: "LinkedIn posts", hn: "Hacker News" };
export const channelLabel = (id) => CHANNEL_LABELS[id] || upperFirst(String(id || "").replace(/_/g, " "));

/**
 * Is the machine running, and can it still sign in? The first card, because
 * every other card on this page is downstream of the answer: a harness whose
 * schedule was never installed has an empty queue for a reason no queue screen
 * can explain.
 */
function healthCard(result) {
  if (result.status !== "fulfilled") {
    return card("Harness", "#/settings", "Open Settings", failure("Could not read the harness health."));
  }
  const health = result.value;
  const body = h("div", {});
  body.append(line(standing(), "home-line"));

  const last = health.last_run;
  if (!last) body.append(line("No run has been logged yet.", "home-line grey"));
  else if (last.running) {
    // The run happening right now is not last night's verdict, and it is not
    // red: it has not failed, it has not finished, it is working.
    const started = clockTime(last.started_at);
    const going = soFar(last.duration_seconds);
    const said = `Running now${started ? `, started ${started}` : ""}${going ? `, ${going}` : ""}`;
    body.append(h("p", { class: "home-line" }, h("span", { style: RUNNING_COLOUR, text: said })));
  } else {
    const clean = last.exit_code === 0;
    const took = duration(last.duration_seconds);
    const verdict = last.exit_code === null
      ? "did not finish"
      : clean ? "finished cleanly" : `exited ${last.exit_code}`;
    body.append(h("p", { class: "home-line" },
      h("span", { text: `Last run ${dayTime(last.started_at || `${last.date}T00:00:00`, false) || last.date}: ` }),
      h("span", { class: clean ? "ok" : "alarm", text: verdict }),
      h("span", { class: "grey", text: took ? `, ${took}` : "" })));
  }

  if (health.next_run) body.append(line(`Next run ${dayTime(health.next_run, true)}.`, "home-line grey"));
  else body.append(line("No schedule is installed, so nothing runs on its own.", "home-line alarm"));

  // What has gone out against the cap is in the first line already.

  if (!health.channels.length) body.append(line("No channel is switched on.", "home-line alarm"));
  for (const channel of health.channels) {
    body.append(h("p", { class: "home-line small" },
      h("span", { text: `${channelLabel(channel.id)}: ` }),
      h("span", { class: channel.state === "ok" ? "grey" : "alarm", text: channel.note })));
  }
  return card("Harness", "#/settings", "Open Settings", body);
}

/** Top five rows the run could not finish, with the reason each is stuck. */
function needsCard(result) {
  if (result.status !== "fulfilled") return card("Blocked", "#/applications/needs", "Open Applications", failure("Could not load the blocked rows."));
  const rows = result.value.rows || [];
  const body = h("div", {});
  body.append(line("The run could not finish these: a blocked letter, an unanswered question or an external portal.", "home-line grey"));
  if (!rows.length) body.append(line("Nothing is blocked.", "home-line grey"));
  for (const row of rows.slice(0, 5)) {
    const item = h("div", { class: "home-row" });
    item.append(h("a", { class: "home-row-title", href: `#/row/${encodeURIComponent(row.id)}`, text: row.title || "Untitled role" }));
    if (row.company) item.append(h("span", { class: "grey small", text: row.company }));
    item.append(h("p", { class: "grey small", text: plainReason(row.reason) || "No reason recorded." }));
    body.append(item);
  }
  return card("Blocked", "#/applications/needs", rows.length > 5 ? `See all ${rows.length}` : "Open Applications", body);
}

/** What went out today, by title. The count is the summary's own figure. */
function sentCard(result) {
  const summary = getSummary();
  const count = summary ? summary.sent_today ?? 0 : 0;
  if (result.status !== "fulfilled") {
    return card("Sent today", "#/applications/sent", "Open Sent", failure("Could not load what was sent."));
  }
  const today = localDay();
  const rows = (result.value.rows || []).filter((row) => localDay(row.updated_at) === today);
  const body = h("div", {});
  body.append(line(count === 1 ? "1 application sent today." : `${count} applications sent today.`));
  for (const row of rows.slice(0, 6)) {
    body.append(h("p", { class: "home-row" },
      h("a", { href: `#/row/${encodeURIComponent(row.id)}`, text: row.title || "Untitled role" }),
      row.company ? h("span", { class: "grey small", text: ` ${row.company}` }) : null));
  }
  if (!rows.length && !count) body.append(line("Nothing has gone out yet today.", "home-line grey"));
  return card("Sent today", "#/applications/sent", "Open Sent", body);
}

/** How many prepared packages are waiting on the person to say yes. */
function waitingCard() {
  const summary = getSummary();
  const count = summary ? (summary.counts || {}).awaiting_approval ?? 0 : 0;
  const body = h("div", {});
  body.append(h("p", { class: "home-big", text: String(count) }));
  body.append(line("Packages ready to send once you say yes.", "home-line grey"));
  return card("To approve", "#/applications/waiting", "Open To approve", body);
}

/**
 * One line per positioning: approved and when, in green, or what still needs
 * reading, in amber. The stamp is the fixed one from the resume index, which
 * now follows the hashes rather than the artefact mtimes.
 */
function resumesCard(result) {
  if (result.status !== "fulfilled") return card("Resumes", "#/resumes", "Open Resumes", failure("Could not load the positionings."));
  const items = result.value.resumes || [];
  const body = h("div", {});
  if (!items.length) body.append(line("No positionings yet. Run /onboarding, then /resume-review.", "home-line grey"));
  for (const item of items) {
    const stamp = item.stamp || { kind: "missing", text: "No render" };
    const critic = item.critic || {};
    const findings = critic.findings_count ?? 0;
    const approved = stamp.kind === "approved";
    const said = approved
      ? stamp.text.replace(/^Approved/, "approved")
      : findings
        ? `needs review, ${findings} ${findings === 1 ? "finding" : "findings"}`
        : stamp.text.toLowerCase();
    body.append(h("p", { class: "home-row" },
      h("span", { class: "home-row-title", text: item.label || item.id }),
      h("span", { class: `stamp ${approved ? "approved" : "stale"}`, text: said })));
  }
  return card("Resumes", "#/resumes", "Open Resumes", body);
}

/**
 * The evidence questions: terms the market wants that the CV source has not
 * answered for yet. They live under Resumes, because that is what they are
 * about, so the card and its button both go there.
 */
function evidenceCard(result) {
  const where = "#/resumes/evidence";
  if (result.status !== "fulfilled") return card("Evidence questions", where, "Open the questions", failure("Could not load the pending terms."));
  const total = result.value.term_total ?? 0;
  const body = h("div", {});
  body.append(line(total === 1 ? "1 term pending" : `${total} terms pending`));
  body.append(h("p", { class: "home-actions" },
    h("a", { class: "btn primary", href: where, text: "Start deciding" })));
  return card("Evidence questions", where, "Open the questions", body);
}

/** The three themes the critic keeps raising. AGENTS.md section 5: they become
 * editorial rules in an attended session, never from here. */
function digestCard(result) {
  if (result.status !== "fulfilled") return card("Recurring critic themes", "#/rules", "Open Rules", failure("Could not load the critic digest."));
  const themes = (result.value.themes || []).slice(0, 3);
  const body = h("div", {});
  if (!themes.length) body.append(line("No recurring themes in the last 14 days.", "home-line grey"));
  for (const theme of themes) {
    body.append(h("p", { class: "home-row" },
      h("span", { class: "digest-count", text: String(theme.count ?? 0) }),
      h("span", { text: themeWords(theme.key) })));
  }
  return card("Recurring critic themes", "#/rules", "Open Rules", body);
}

/**
 * The last run the harness logged, as its own tally: the day, what went out,
 * what it left blocked, how it exited and how long it took. A run that has no
 * row yet falls back to the head of today's journal, read as markdown, so the
 * card says something on a machine whose runs index is not written yet.
 */
function latestRunCard(runs, journal) {
  const body = h("div", {});
  const run = runs.status === "fulfilled" ? (runs.value.runs || [])[0] : null;
  if (run && run.running) {
    // Same state as the Harness card, said the same way, because the two cards
    // are read one under the other and must not disagree about this morning.
    const going = soFar(run.duration_s ?? run.duration_seconds);
    body.append(h("p", { class: "home-line" },
      h("span", { text: `${shortDate(run.date) || run.date}: ` }),
      h("span", { style: RUNNING_COLOUR, text: `running now${going ? `, ${going}` : ""}` })));
  } else if (run) {
    const bits = [];
    if (typeof run.sent === "number") bits.push(`${run.sent} sent`);
    if (typeof run.blocked === "number") bits.push(`${run.blocked} blocked`);
    const clean = run.exit_code === 0;
    // "no log" is only true when there is no log. A log that is there and a
    // summary that is not yet written is a different thing, and says so.
    const missing = run.has_log ? "no summary yet" : "no log";
    const exit = run.exit_code === null || run.exit_code === undefined ? missing : `exit ${run.exit_code}`;
    const took = duration(run.duration_s ?? run.duration_seconds);
    body.append(h("p", { class: "home-line" },
      h("span", { text: `${shortDate(run.date) || run.date}: ` }),
      h("span", { text: bits.length ? `${bits.join(", ")}, ` : "" }),
      h("span", { class: clean ? "ok" : "alarm", text: exit }),
      h("span", { class: "grey", text: took ? `, ${took}` : "" })));
  } else {
    const markdown = journal.status === "fulfilled" ? String(journal.value.markdown || "").trim() : "";
    if (markdown) body.append(h("div", { class: "home-journal" }, richMarkdown(markdown.split("\n").slice(0, 12).join("\n"))));
    else body.append(line("No run has been logged yet. The morning run writes one when it finishes.", "home-line grey"));
  }
  return card("Latest run", "#/runs", "Open Runs", body);
}

export async function viewHome(view) {
  // The greeting is drawn before the name is known and filled in when it
  // arrives; the pick does not depend on the name, so the line does not jump.
  const now = new Date();
  const head = pageHeader({ title: greetingFor(now, "") });
  const title = head.querySelector("h1");
  // A screen reader should not read a rhetorical question mark out as one.
  const say = (text) => { title.textContent = text; title.setAttribute("aria-label", text.replace(/\?/g, "")); };
  say(greetingFor(now, ""));
  view.append(head);
  // The quotation pool is loaded when the page is drawn rather than imported at
  // the top, so this module stays a module about the dashboard.
  const quotes = await import("./quotes.js").catch(() => null);
  if (quotes) {
    const saying = quotes.quoteFor(Math.random);
    head.append(h("div", { class: "lede quote" },
      h("p", { class: "quote-text", text: `"${saying.text}"` }),
      h("p", { class: "quote-by", text: saying.by })));
  }
  const grid = h("div", { class: "home-grid" });
  grid.append(h("p", { class: "empty", text: "Loading the dashboard." }));
  view.append(grid);

  const results = await Promise.allSettled([
    api("rows?status=manual_action_needed"),
    api("rows?status=submitted&limit=30"),
    api("resumes"),
    api("keywords/pending?limit=1"),
    api("critic/digest?since=14d"),
    api("journal/today"),
    api("health"),
    api("runs?limit=1"),
  ]);
  const [needs, sent, resumes, keywords, digest, journal, health, runs] = results;
  const name = firstName(resumes);
  if (name) say(greetingFor(now, name));
  while (grid.firstChild) grid.firstChild.remove();
  // The machine's own state comes first: whether it ran, when it runs next and
  // whether it can still sign in decides what every card below is worth.
  grid.append(healthCard(health));
  // Then reading order is priority order: what is stuck, what is waiting on a
  // decision, then the backlog, then what has already happened.
  grid.append(
    needsCard(needs),
    waitingCard(),
    evidenceCard(keywords),
    sentCard(sent),
    resumesCard(resumes),
    digestCard(digest),
    latestRunCard(runs, journal),
  );
  if (results.every((r) => r.status === "rejected")) {
    view.append(h("p", { class: "home-actions" },
      h("button", { type: "button", class: "btn", text: "Try again", onClick: () => render() })));
  }
}
