/*
 * home.js - the default screen: one card per thing that might want the person,
 * each a summary that links to the screen which can actually do the work.
 *
 * Nothing on Home acts. It reads the pipeline, the resumes, the keyword ledger,
 * the critic digest and today's journal, and says in one line each what state
 * they are in. AGENTS.md section 2: the lane in force is the first thing on the
 * page, so nobody has to guess whether the machine is sending this morning.
 */

import { api, getPolicy, getSummary, h, isPolicyAvailable, localDay, pageHeader, render, richMarkdown } from "./app.js";

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
    item.append(h("p", { class: "grey small", text: row.reason || "No reason recorded." }));
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

/** One line per positioning: what it is, its stamp, and the critic's verdict. */
function resumesCard(result) {
  if (result.status !== "fulfilled") return card("Resumes", "#/resumes", "Open Resumes", failure("Could not load the positionings."));
  const items = result.value.resumes || [];
  const body = h("div", {});
  if (!items.length) body.append(line("No positionings yet. Run /onboarding, then /resume-review.", "home-line grey"));
  for (const item of items) {
    const stamp = item.stamp || { kind: "missing", text: "No render" };
    const critic = item.critic && item.critic.verdict
      ? `critic ${item.critic.verdict === "block" ? "blocked" : item.critic.verdict}`
      : "critic not run";
    body.append(h("p", { class: "home-row" },
      h("span", { class: "home-row-title", text: item.label || item.id }),
      h("span", { class: `stamp ${stamp.kind}`, text: stamp.text }),
      h("span", { class: "grey small", text: critic })));
  }
  return card("Resumes", "#/resumes", "Open Resumes", body);
}

/** The keyword backlog, and the button that starts draining it. */
function keywordsCard(result) {
  if (result.status !== "fulfilled") return card("Keywords", "#/keywords", "Open Keywords", failure("Could not load the keyword backlog."));
  const total = result.value.term_total ?? 0;
  const body = h("div", {});
  body.append(line(total === 1 ? "1 term pending" : `${total} terms pending`));
  body.append(h("p", { class: "home-actions" },
    h("a", { class: "btn primary", href: "#/keywords", text: "Start deciding" })));
  return card("Keywords", "#/keywords", "Open Keywords", body);
}

/** The three themes the critic keeps raising. AGENTS.md section 5: they become
 * editorial rules in an attended session, never from here. */
function digestCard(result) {
  if (result.status !== "fulfilled") return card("Recurring critic themes", "#/digest", "Open Digest", failure("Could not load the critic digest."));
  const themes = (result.value.themes || []).slice(0, 3);
  const body = h("div", {});
  if (!themes.length) body.append(line("No recurring themes in the last 14 days.", "home-line grey"));
  for (const theme of themes) {
    body.append(h("p", { class: "home-row" },
      h("span", { class: "digest-count", text: String(theme.count ?? 0) }),
      h("span", { text: theme.key || "unnamed theme" })));
  }
  return card("Recurring critic themes", "#/digest", "Open Digest", body);
}

/** The head of today's journal: the first dozen lines, read as markdown.
 * Same renderer as the Today screen, so a heading is a heading here too and
 * nobody has to read `## What the run did` as raw source. */
function todayCard(result) {
  if (result.status !== "fulfilled") return card("Today's run", "#/today", "Read today", failure("Could not load today's summary."));
  const markdown = String(result.value.markdown || "").trim();
  const body = h("div", {});
  if (!markdown) body.append(line("No entry for today yet. The morning run writes one when it finishes.", "home-line grey"));
  else body.append(h("div", { class: "home-journal" }, richMarkdown(markdown.split("\n").slice(0, 12).join("\n"))));
  return card("Today's run", "#/today", "Read today", body);
}

export async function viewHome(view) {
  view.append(pageHeader({ title: "Home", lede: standing() }));
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
  ]);
  const [needs, sent, resumes, keywords, digest, journal] = results;
  while (grid.firstChild) grid.firstChild.remove();
  // Reading order is priority order: what is stuck, what is waiting on a
  // decision, then the backlog, then what has already happened.
  grid.append(
    needsCard(needs),
    waitingCard(),
    keywordsCard(keywords),
    sentCard(sent),
    resumesCard(resumes),
    digestCard(digest),
    todayCard(journal),
  );
  if (results.every((r) => r.status === "rejected")) {
    view.append(h("p", { class: "home-actions" },
      h("button", { type: "button", class: "btn", text: "Try again", onClick: () => render() })));
  }
}
