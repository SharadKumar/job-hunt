/*
 * row.js - one application, read end to end.
 *
 * The fact line says what the job is and what it scored. Three cards then say
 * whether the letter may go out: the critic's verdict, the mechanical gates,
 * and what is actually in the package. Then the letter beside the job
 * description, the history, and the decisions. AGENTS.md section 8: a verdict
 * that was never run is shown as missing, never read as a pass.
 *
 * The letter is editable on a blocked or to-approve row. Saving it rewrites
 * cover-letter.md in the package and runs the deterministic pre-checks only;
 * the model critic runs when the row is retried through autopilot, against the
 * bytes that would go out.
 */

import {
  actionButton, alsoControls, channelLabel, contextualControl, FOCUS_KEY, loadReasonHelper, plainReasonText,
} from "./applications.js";
import { api, APPLY_METHODS, asText, eyebrow, fetchInto, h, pageHeader, panel, render, statusLabel, when } from "./app.js";
import { redraftControl, retryNowControl } from "./row-actions.js";
import { letterCard } from "./row-letter.js";

/** The reason that means a person has to answer something before the run can
 * finish. Same family of wording the daily writes into the row's notes. */
const UNANSWERED_QUESTION = /screening question|unanswered question|question is not in/i;

/** One small card in the stats row: a label, a verdict, and a quiet note. */
function stat(label, value, tone, note) {
  const card = h("div", { class: tone ? `card stat ${tone}` : "card stat" });
  card.append(eyebrow(label), h("p", { class: "value", text: value }));
  if (note) card.append(h("p", { class: "note", text: note }));
  return card;
}

/** A gate value written a dozen ways across the archive, read one way here. */
function verdictWord(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === true) return "pass";
  if (raw === false) return "fail";
  const text = String(typeof raw === "object" ? raw.verdict ?? raw.status ?? "" : raw).trim().toLowerCase();
  if (text.startsWith("pass")) return "pass";
  if (text.startsWith("warn")) return "warn";
  if (text.startsWith("fail") || text.startsWith("block")) return "fail";
  return text || null;
}

/** The quality block, wherever a given run happened to put it. */
function qualityOf(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const quality = (meta.quality && typeof meta.quality === "object") ? meta.quality : {};
  const letter = (quality.coverLetter && typeof quality.coverLetter === "object") ? quality.coverLetter : {};
  const checks = (meta.cover_letter && meta.cover_letter.checks) || {};
  const pick = (...keys) => {
    for (const source of [quality, letter, checks]) {
      for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null && value !== "") return value;
      }
    }
    return undefined;
  };
  return {
    slop: verdictWord(pick("slop", "coverLetterSlop", "slopKiller", "slop_killer")),
    voice: verdictWord(pick("voice", "coverLetterVoice", "voiceCheck", "voice_check")),
    grounding: verdictWord(pick("termGrounding", "term_grounding", "termGroundingCheck")),
    words: Number(letter.words ?? (meta.cover_letter && meta.cover_letter.word_count)) || null,
  };
}

/** What the run put in the package, in the words the metadata uses. A run that
 * recorded the baseline approval check chose the baseline, and says so. */
function resumeOf(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const resume = (meta.resume && typeof meta.resume === "object") ? meta.resume : {};
  const inferred = resume.baselineApprovalCheck ? "baseline" : (resume.docx || resume.pdf ? "rendered" : "");
  const mode = String(resume.mode ?? resume.choice ?? inferred).toLowerCase();
  const ref = resume.ref ?? resume.resume_id ?? resume.id ?? resume.resumeId
    ?? (typeof resume.docx === "string" ? resume.docx.split("/").pop() : null);
  return { mode: mode || null, ref: ref ? String(ref) : null };
}

/** The stats row: the machine verdicts that decide whether a letter may go out.
 * A missing verdict says so; it is never read as a pass (AGENTS.md section 8). */
export function statsRow(row, pkg, files) {
  const stats = h("div", { class: "stats", "aria-label": "Gates" });
  const critic = pkg.letter_critic;
  if (!critic) stats.append(stat("Critic", "Critic not run", "", "No letter has been critiqued on this row."));
  else {
    const findings = Array.isArray(critic.findings) ? critic.findings : [];
    const count = (severity) => findings.filter((f) => f && f.severity === severity).length;
    stats.append(String(critic.verdict || "").toLowerCase() !== "pass"
      ? stat("Critic", `Critic blocked, ${count("fail")} fail`, "bad", `${findings.length} findings in total.`)
      : stat("Critic", `Critic pass, ${count("warn")} warn`, "good", `${findings.length} findings in total.`));
  }
  const quality = qualityOf(pkg.metadata);
  const notes = [
    `Slop ${quality.slop || "not recorded"}`,
    `Voice ${quality.voice || "not recorded"}`,
    `Term grounding ${quality.grounding || "not recorded"}`,
  ];
  // The gate has either let this row through or it has not. Saying "Gate
  // waiting, blocked" said the same thing twice and read as two verdicts.
  const sent = row.status === "submitted";
  stats.append(stat("Gates", sent ? "Gate passed" : "Gate waiting", sent ? "good" : "", `${notes.join(". ")}.`));
  const resume = resumeOf(pkg.metadata);
  const names = Array.isArray(files) ? files : [];
  const letterWords = quality.words
    || (pkg.cover_letter ? String(pkg.cover_letter).split(/\s+/).filter(Boolean).length : null);
  const packageNote = [
    resume.ref ? `CV ${resume.ref}` : null,
    letterWords ? `Letter ${letterWords} words` : "No letter in the package",
    names.length ? `${names.length} files` : "No files found",
  ].filter(Boolean).join(". ");
  const label = resume.mode === "tailored" ? "Tailored CV" : resume.mode === "baseline" ? "Baseline CV"
    : resume.mode ? "CV in the package" : "No CV recorded";
  stats.append(stat("Package", label, resume.mode ? "" : "bad", `${packageNote}.`));
  return stats;
}

/** The dot's colour: green when the row moved to sent, red when it moved to a
 * stop, ink for every ordinary step in between. */
function moveTone(to) {
  if (to === "submitted") return "good";
  if (to === "manual_action_needed" || to === "rejected" || to === "withdrawn" || to === "parked") return "bad";
  return "";
}

/** The reason under one entry: the first sentence, with the rest behind "more".
 * A field_update entry is an enrichment pass, not a decision, so it says which
 * fields moved and keeps the raw machinery off the page. */
function historyReason(item) {
  const fields = /^field_update:\s*([^([]*)/.exec(item.reason || "");
  if (fields) return h("p", { class: "tl-why", text: `updated ${fields[1].trim() || "some fields"}` });
  if (!item.reason) return null;
  const full = plainReasonText(item.reason);
  // The stop has to be followed by a space or the end of the line, or a reason
  // that names a host is cut to "External portal: rba.".
  const match = /^[^.!?]*[.!?](?=\s|$)/.exec(full);
  const first = match ? match[0] : full;
  const note = h("p", { class: "tl-why", text: first });
  if (first.length < full.length) {
    const more = h("button", { type: "button", class: "linkish", text: "more" });
    more.addEventListener("click", () => { note.textContent = full; more.remove(); });
    note.append(" ", more);
  }
  return note;
}

/** The row's life as a timeline, newest first: a rail, a dot per move, the
 * time, what moved, and why. */
function historyBlock(history) {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) return panel("History", h("p", { class: "grey", text: "No transitions recorded on this row yet." }));
  const ul = h("ul", { class: "timeline" });
  for (const item of [...entries].reverse()) {
    const tone = moveTone(item.to);
    const li = h("li", { class: tone ? `tl ${tone}` : "tl" });
    const from = item.from ? statusLabel(item.from) : "new";
    li.append(h("span", { class: "tl-dot", "aria-hidden": "true" }),
      h("p", { class: "tl-when", text: when(item.at) }),
      h("p", { class: "tl-move", text: `${from} to ${statusLabel(item.to) || "unknown"}` }));
    const why = historyReason(item);
    if (why) li.append(why);
    ul.append(li);
  }
  return panel("History", ul);
}

/**
 * Approve is a real move on a row that is waiting for one. On a blocked row it
 * is a trap: it marks the package approved, and the next run reads the same
 * finding, blocks it again and parks it. So it is offered on the statuses where
 * it means something and on no others.
 */
const APPROVABLE = new Set(["awaiting_approval", "shortlisted", "drafted"]);

/** The rows where asking for a fresh letter is worth anything: the letter has
 * not gone out, and there is still a run coming that could rewrite it. */
const REDRAFTABLE = new Set(["manual_action_needed", "awaiting_approval", "approved", "shortlisted", "parked"]);

/** The standing decisions, in the order they are offered. Approve is not one of
 * them: it is contextual, and only on a row that can take it. */
const DECISIONS = [
  { key: "hold", label: "Hold" },
  { key: "reject", label: "Reject", danger: true },
  { key: "withdraw", label: "Withdraw", danger: true },
];

/** A row the run is already carrying: it is not waiting on anybody here, and
 * the only thing left to decide is whether to pull it out of the run. */
const IN_FLIGHT = "in_flight";
/** A row that is ready but may only go out with the person in the chair. */
const ATTENDED_SEND = "attended_send";
/** The two decisions an in-flight row still takes. Approve is not one of them:
 * the run has already approved it, and there is nothing left to say yes to. */
const IN_FLIGHT_DECISIONS = new Set(["hold", "reject"]);

/** The lane table, read once a session. A row that does not carry its own lane
 * still has one, because the channel decides it (AGENTS.md section 2). */
let lanesRead = null;
const lanes = () => (lanesRead ||= api("lanes").catch(() => null));

/**
 * Which lane the row is in, as a pill on the fact line. Green is the
 * unattended lane, grey is the attended one, and why it landed there is the
 * pill's title. With neither the row's lane nor the table there is no pill:
 * better silent than guessing which lane would send this.
 */
function lanePill(row, table) {
  const of = (map) => (table && table[map] ? table[map][row.channel] : "");
  const said = row.lane || of("lane_of");
  const lane = said === "autopilot" || said === "attended" ? said : "";
  if (!lane) return null;
  const pill = h("span", { class: `pill lane-pill lane-pill-${lane}`, text: lane });
  const why = String(row.lane_reason || of("reason_of") || "").trim();
  if (why) pill.setAttribute("title", why);
  return pill;
}

/**
 * The banner over the decision card: which lane has this row, and what that
 * means for the person reading it. Only the two lane actions draw one; every
 * other row is a decision and says so with its buttons.
 */
function laneBanner(act, row) {
  const inFlight = act.kind === IN_FLIGHT;
  if (!inFlight && act.kind !== ATTENDED_SEND) return null;
  const box = h("section", { class: `lane-banner lane-banner-${inFlight ? "autopilot" : "attended"}`, role: "note" });
  if (inFlight) {
    box.append(h("p", { class: "lane-head", text: act.label || "Autopilot handles this" }));
    const note = String(act.note || row.lane_reason || "").trim();
    box.append(h("p", { class: "lane-note", text: note || `The next run sends it through ${sendsThrough(row)}.` }));
  } else {
    box.append(h("p", { class: "lane-head", text: "Ready to send in an attended session." }));
    box.append(h("p", { class: "lane-note", text: "Run /submit-approved with the person present." }));
  }
  return box;
}

const wantsRetry = (act) => act.kind === "retry" || act.post === "retry"
  || (Array.isArray(act.also) && act.also.some((spec) => spec && spec.post === "retry"));

/** What a decision does, in the words the person would use. The title is on
 * the button, so the explanation is there when it is wanted and silent when it
 * is not. */
const DECISION_HELP = {
  approve: "Let the next run send it",
  hold: "Keep it here",
  reject: "Not applying",
  withdraw: "Applied but pulling out",
  retry: "Put it back in the queue for the next run",
};

/** The channel and method an unattended send would go out through. */
const SEND_METHOD = { easy_apply: "Easy Apply", quick_apply: "Quick Apply" };
function sendsThrough(row) {
  const method = SEND_METHOD[row.applyMethod];
  return method ? `${channelLabel(row.channel)} ${method}` : "the channel it came from";
}

/** The two fields a decision can carry. The notes field is for the run to read,
 * so it only appears once a decision that a run acts on has been pressed. */
function decisionFields() {
  const reason = h("input", { type: "text", id: "decide-reason", placeholder: "Optional" });
  const notes = h("textarea", { id: "decide-notes", placeholder: "Optional" });
  // The aside belongs on the label's own line. A `.field` is a grid, so a
  // second span stacked "goes into the history" under "Reason" and made a
  // four-word hint look like a second field.
  const labelled = (control, text, help) => h("label", { class: "field", for: control.id },
    h("span", { class: "field-label", text: help ? `${text} (${help})` : text }), control);
  const notesField = labelled(notes, "Notes for the next run", "edits to the letter or package");
  notesField.hidden = true;
  return {
    reason,
    node: h("div", { class: "action-fields" }, labelled(reason, "Reason", "goes into the history"), notesField),
    reveal: () => { notesField.hidden = false; },
    values: () => ({
      ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
      ...(notes.value.trim() ? { edits: notes.value.trim() } : {}),
    }),
  };
}

/**
 * The decision card. "Retry now" is at the top, because it is the one control
 * that does something on this machine rather than moving a row. Under it the
 * moves: the one this row is waiting on, whatever else the server hung off it,
 * and the three standing decisions.
 *
 * `screeningOnPage` suppresses the Answer button, because the panel it would
 * scroll to is already on the page and the panel is the answer.
 */
function actionBar(data, row, onDone, { screeningOnPage = false, decision } = {}) {
  const body = h("div", {});
  const buttons = h("div", { class: "action-buttons" });
  const extras = h("div", { class: "action-extra" });
  const act = data.action || { kind: "none" };
  const fields = () => decision.values();
  // The run is carrying this one. Nothing here approves it again; the only
  // question left is whether to take it back out of the run.
  const inFlight = act.kind === IN_FLIGHT;
  // Whatever the server already hung off `also` is drawn once, so a standing
  // decision that is also an `also` entry is not offered twice.
  const alsoPosts = new Set((Array.isArray(act.also) ? act.also : [])
    .map((spec) => spec && spec.post).filter(Boolean));

  // The run again, here, now. It is not a move, so it sits above the moves.
  if (wantsRetry(act)) {
    const retry = retryNowControl(row, () => render());
    body.append(h("div", { class: "action-buttons" }, retry.button),
      h("p", { class: "grey small", text: `Runs the critic and the gate again and sends through ${sendsThrough(row)} if they pass.` }),
      retry.extra);
  }

  body.append(eyebrow(inFlight ? "Take it out of the run" : "Move this application"), buttons, extras);
  // With "Retry now" above it the tray retry is the slower of the two, so it
  // says which one it is and gives up the black button to the one that runs.
  const primary = wantsRetry(act) && act.post === "retry"
    ? { ...act, primary: false, label: "Retry in the next run" }
    : { ...act, primary: true };
  if (!(act.kind === "answer" && screeningOnPage)) {
    const contextual = contextualControl({ ...row, action: primary }, onDone, { small: false });
    if (contextual) {
      if (act.post && DECISION_HELP[act.post]) contextual.title = DECISION_HELP[act.post];
      buttons.append(contextual);
    }
  }
  const also = alsoControls({ ...row, action: act }, onDone, { small: false });
  for (const button of also.buttons) buttons.append(button);
  for (const extra of also.extras) extras.append(extra);

  if (APPROVABLE.has(row.status) && act.post !== "approve" && !inFlight) {
    const approve = actionButton(row, { key: "approve", label: "Approve", title: DECISION_HELP.approve,
      primary: !buttons.childElementCount }, fields, onDone);
    approve.addEventListener("click", decision.reveal);
    buttons.append(approve);
  }
  for (const spec of DECISIONS) {
    if (act.post === spec.key || alsoPosts.has(spec.key)) continue;
    if (inFlight && !IN_FLIGHT_DECISIONS.has(spec.key)) continue;
    const button = actionButton(row, { ...spec, title: DECISION_HELP[spec.key] }, fields, onDone);
    if (spec.key === "hold") button.addEventListener("click", decision.reveal);
    buttons.append(button);
  }
  body.append(decision.node,
    h("p", { class: "grey small", text: "Each button asks twice: press, then press Confirm. Nothing is sent to a channel from here." }));
  return panel("Your decision", body);
}

/**
 * The screening panel belongs to another work package. Mount it when the row is
 * stuck on a question, and when an answer is banked offer the retry that puts
 * the row back on the autopilot path.
 */
async function mountScreening(host, row, reason) {
  if (!UNANSWERED_QUESTION.test(String(reason || ""))) return;
  const mod = await import("./screening.js").catch(() => null);
  if (!mod || typeof mod.screeningPanel !== "function") return;
  const banked = h("div", { class: "banked" });
  const node = mod.screeningPanel({
    row,
    reason,
    onBanked: () => {
      while (banked.firstChild) banked.firstChild.remove();
      // The answer is in the file now, so the thing worth offering is the run
      // that reads it, not another trip through the morning queue.
      const retry = retryNowControl(row, () => render());
      banked.append(h("p", { text: "Answer banked. Retry now?" }), retry.button, retry.extra);
      // guarded() arms on the first press, so one programmatic press leaves the
      // button armed and focused: the person's press is the one that commits.
      retry.button.click();
    },
  });
  if (node) host.append(node);
  host.append(banked);
}

export async function viewRow(view, id) {
  view.append(h("p", { class: "empty", text: "Loading the row." }));
  // The history's reasons are run stamps until home.js's rewriter is loaded.
  await loadReasonHelper();
  const laneTable = lanes();
  const data = await fetchInto(view, `rows/${encodeURIComponent(id)}`, "Could not load this row.");
  if (!data) return view.prepend(pageHeader({ title: "Row", back: h("a", { href: "#/applications", text: "Applications" }) }));
  const row = data.row || {};
  const pkg = data.package || {};
  // One box for the whole page, so a single rule gives every top-level section
  // the same 24 px under the one before it (see .row-page in app.css).
  const page = h("div", { class: "row-page" });
  view.append(page);
  page.append(pageHeader({
    title: row.title || "Untitled role",
    back: h("a", { href: "#/applications", text: "Applications" }),
  }));
  const facts = [
    row.company, row.location,
    typeof row.score === "number" ? `score ${Math.round(row.score)}` : null,
    row.classification?.work_arrangement || row.workArrangement,
    APPLY_METHODS[row.applyMethod] || row.applyMethod,
    row.userSaved ? "saved by you" : null, statusLabel(row.status) || null,
  ].filter(Boolean);
  const line = h("p", { class: "detail-meta", text: `${facts.join(", ")}. ` });
  const pill = lanePill(row, await laneTable);
  if (pill) line.append(pill, document.createTextNode(" "));
  if (row.url) line.append(h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" }));
  page.append(line);

  page.append(statsRow(row, pkg, data.package_files));

  // Letter left at reading measure, JD right and quieter, the two cards the
  // same height with the JD scrolling inside its own card. Stacked on a phone,
  // letter first, because the letter is what the decision is about. With no
  // letter in the package there is nothing to read beside, so the JD takes the
  // full width.
  const decision = decisionFields();
  const redraft = REDRAFTABLE.has(row.status)
    ? redraftControl(row, data.redraft_requested, () => decision.reason.value, { small: true })
    : null;
  if (redraft) redraft.button.addEventListener("click", decision.reveal);
  const hasLetter = asText(pkg.cover_letter).trim() !== "";
  const editable = row.status === "manual_action_needed" || row.status === "awaiting_approval";
  const columns = h("div", { class: hasLetter ? "columns" : "columns one" });
  if (hasLetter) columns.append(letterCard(row, pkg, redraft));
  const jdText = asText(row.description || pkg.jd);
  const jd = h("section", { class: "card jd-card" }, h("div", { class: "card-head" }, h("h2", { text: "Job description" })));
  jd.append(jdText.trim()
    ? h("div", { class: "jd" }, h("pre", { text: jdText }))
    : h("p", { class: "grey", text: "No job description stored for this row. Open the advert to read it." }));
  columns.append(jd);
  page.append(columns);
  if (!hasLetter && editable) page.append(letterCard(row, pkg, redraft));

  // The order the page is read in: what it is, whether it may go, what it
  // says, the question in the way, the decision, and the history last.
  const rest = h("div", { class: "stack" });
  const done = () => { location.hash = "#/applications"; render(); };
  const screening = h("div", { class: "screening-slot" });
  // The panel mounts on exactly this condition, so the bar can leave the
  // Answer button out without waiting for the panel's module to load.
  const reason = data.reason || row.notes;
  const screeningOnPage = UNANSWERED_QUESTION.test(String(reason || ""));
  // The lane banner sits directly above the decision card, because it is the
  // answer to the question the buttons under it are about to ask.
  const banner = laneBanner(data.action || { kind: "none" }, row);
  rest.append(screening);
  if (banner) rest.append(banner);
  rest.append(actionBar(data, row, done, { screeningOnPage, decision }), historyBlock(row.history));
  page.append(rest);
  await mountScreening(screening, row, reason);
  try {
    if (sessionStorage.getItem(FOCUS_KEY) === row.id) {
      sessionStorage.removeItem(FOCUS_KEY);
      screening.scrollIntoView({ block: "center" });
      const focusable = screening.querySelector("input, textarea, button, select");
      if (focusable) focusable.focus();
    }
  } catch { /* storage is off; the panel is still on the page */ }
}
