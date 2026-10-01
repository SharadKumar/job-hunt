/* today-workbench.js - the selected application beside Today's compact queue. */

import {
  api, channelLabel, h, laneLabel, loadError, render, statusLabel,
} from "./app.js";
import { gatesStrip } from "./row-letter.js";
import { timeline } from "./row.js";
import { screeningCard } from "./screening.js";
import { alsoControls, contextualControl, reopenControl, routeButton } from "./pipeline-rows.js";
import { plainReason } from "./home.js";

const ACTION_LABELS = {
  answer: "Answer a screening question",
  decide: "Make a decision",
  gate_refused: "Review the attended application",
  portal: "Continue in the external portal",
  mark_sent: "Confirm the external submission",
  retry: "Review the blocked letter",
};

function facts(row, data) {
  return [
    row.company,
    row.location,
    channelLabel(row.channel),
    laneLabel(["portal", "mark_sent"].includes((data.action || {}).kind) ? "attended" : data.lane),
    statusLabel(row.status),
  ].filter(Boolean).join("  /  ");
}

function stateNote(row, action) {
  const kind = String(action.kind || "none");
  if (kind === "in_flight" && action.note) return action.note;
  if (kind === "answer") return "The application is prepared and waiting for an answer. Saving an answer does not submit it.";
  if (kind === "portal" || kind === "mark_sent") return "This application stays attended. The external portal is the next step.";
  if (kind === "retry") return "The package is prepared, but the letter is blocked and needs review.";
  if (kind === "decide" || kind === "gate_refused") return "The package is prepared and waiting for your decision.";
  if (kind === "unpark") return "This application is parked. Unpark returns it to discovery for reconsideration.";
  if (kind === "reopen") return "This application is closed. Reopen returns it to discovery for reconsideration.";
  if (String(row.status) === "submitted") return "This application has been submitted.";
  return "Open the full application to review the package and its history.";
}

function actionLinks(row, action, changed, summary) {
  const links = h("div", { class: "workbench-actions" });
  // Row detail returns the resolved action beside the row, while list rows
  // carry it on the row itself. The shared controls read row.action, so join
  // the two shapes here before rendering the selected application's actions.
  const actionable = { ...row, action };
  const primary = action.kind === "answer" ? null : contextualControl(actionable, changed, { small: false });
  if (primary) {
    primary.classList.add("btn-primary");
    links.append(primary);
  }
  const more = alsoControls(actionable, changed, { small: false });
  for (const button of more.buttons) links.append(button);
  if (action.kind === "reopen") {
    const reopen = reopenControl(actionable, changed, { small: false });
    links.append(reopen.button);
    for (const extra of [reopen.extra]) links.append(extra);
  }
  if (summary && typeof summary.days_since === "number") {
    links.append(routeButton(actionable, {
      label: "Mark responded", path: "outcome",
      body: { status: "responded", note: "recorded from the pipeline" }, primary: true, small: false,
    }, changed));
  }
  links.append(h("a", {
    class: links.childElementCount ? "btn" : "btn btn-primary",
    href: `#/row/${encodeURIComponent(row.id)}`,
    text: "Review application",
  }));
  for (const extra of more.extras) links.append(extra);
  return links;
}

export async function todayWorkDetail(summary, changed = () => render(), { sentView = false } = {}) {
  const shell = h("section", { class: "today-detail", "aria-label": "Selected application" });
  if (!summary) {
    shell.append(h("div", { class: "workbench-empty" },
      h("p", { class: "eyebrow", text: sentView ? "Confirmed submissions" : "Application workflow" }),
      h("h2", { text: sentView ? "Nothing sent today yet" : "Nothing is waiting on you" }),
      h("p", { text: sentView ? "Confirmed submissions will appear here. Needs you is a separate queue." : "The next unattended run will add work here when it needs a decision." })));
    return shell;
  }

  let data;
  try { data = await api(`rows/${encodeURIComponent(summary.id)}`); }
  catch (error) {
    shell.append(loadError("the selected application", error, () => render()));
    return shell;
  }
  const row = data.row || summary;
  const action = data.action || summary.action || { kind: "none" };
  const eyebrow = String(row.status) === "submitted" ? "Submitted application" : ACTION_LABELS[action.kind] || "Application review";
  const top = h("header", { class: "workbench-header" });
  top.append(
    h("div", { class: "workbench-heading" },
      h("p", { class: "eyebrow", text: eyebrow }),
      h("h2", { text: row.title || "Untitled role" }),
      h("p", { class: "workbench-facts", text: facts(row, data) })),
    typeof row.score === "number" ? h("div", { class: "workbench-fit" },
      h("strong", { text: String(Math.round(row.score)) }), h("span", { text: "fit score" })) : null,
  );
  shell.append(top);
  if (action.kind !== "answer") shell.append(actionLinks(row, action, changed, summary));
  shell.append(h("div", { class: "workbench-state" },
    h("span", { class: "state-dot", "aria-hidden": "true" }),
    h("p", { text: stateNote(row, action) })));

  if (action.kind === "answer") {
    const question = await screeningCard({ row, reason: data.reason || row.notes, send: null, onBanked: () => render() });
    if (question) shell.append(question);
  } else if (data.reason) {
    const status = String(row.status);
    const heading = status === "submitted" ? "Submission record"
      : ["responded", "interview", "offered", "won"].includes(status) ? "Latest outcome"
      : ["rejected", "withdrawn"].includes(status) ? "Why it closed"
      : ["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending", "parked"].includes(status) ? "Latest activity"
      : "Why it stopped";
    const content = h("p", { text: plainReason(data.reason) });
    if (String(data.reason).length > 280) {
      shell.append(h("section", { class: "workbench-reason" },
        h("details", {}, h("summary", { text: heading }), content)));
    } else {
      shell.append(h("section", { class: "workbench-reason" },
        h("p", { class: "eyebrow", text: heading }), content));
    }
  }

  shell.append(h("div", { class: "workbench-timeline" }, timeline(row, action)));

  const pkg = data.package || {};
  shell.append(h("section", { class: "workbench-package" },
    h("div", { class: "workbench-section-head" },
      h("div", {}, h("p", { class: "eyebrow", text: "Application package" }), h("h3", { text: "Recorded checks and files" })),
      h("a", { href: `#/row/${encodeURIComponent(row.id)}`, text: "See full package" })),
    gatesStrip(pkg, data.package_files, { onFindings: () => { window.location.hash = `#/row/${encodeURIComponent(row.id)}`; } })));
  if (action.kind === "answer") shell.append(actionLinks(row, action, changed, summary));
  return shell;
}
