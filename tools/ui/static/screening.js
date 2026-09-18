/*
 * screening.js - the card that unsticks a row parked on a question.
 *
 * A portal asked something the profile has no answer for, so the run stopped
 * and wrote the question into screening-answers.yaml. That is the whole of the
 * block: one sentence the person can answer in ten seconds, sitting in a YAML
 * file they would otherwise have to open in an editor.
 *
 * The card is the question. Everything that is not this row's question (the
 * years-with-a-skill form, and every answer already banked) sits in one
 * "Answer bank" disclosure at the bottom of it, because two unrelated forms at
 * the same weight read as one confusing form
 * (docs/ui-redesign-2026-09-18.md, section 6, Row page).
 *
 * `screeningCard({ row, reason, send, onBanked })` resolves to a card, or to
 * null when nothing on this row is unanswered: the card is only ever on the
 * page when there is a question on it. Banking an answer writes it into the
 * person's own file and calls `onBanked`; nothing here submits, retries or
 * contacts anything (AGENTS.md section 2). The one control that can send is
 * `send`, built by the row page, and it arrives disabled.
 */

import { api, h, toast } from "./app.js";

/** One labelled control, the shape every form in this UI uses: the label 4 px
 * above the field, the help 4 px under it (section 7, Form fields). */
function field(text, control, help) {
  const box = h("label", { class: "field" }, h("span", { class: "field-label", text }), control);
  if (help) box.append(h("span", { class: "field-help", text: help }));
  return box;
}

/** The question a parked row's reason line is quoting, if it is quoting one. */
export function questionInReason(reason) {
  const text = String(reason || "");
  const quoted = /(?:unknown |unanswered )?screening question:\s*"([^"]+)"/i.exec(text)
    || /unanswered question:\s*(.+?)(?:\s*\(|$)/i.exec(text);
  return quoted ? quoted[1].trim() : "";
}

/** The same canonical form the submission worker matches on, in miniature. */
export function normalise(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/[\s*]*(?:\(\s*required\s*\)|\brequired\b|\*)\s*$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/[\s.,;:!?*"'’]+$/g, "").trim();
}

/** A dropdown's option labels, as the worker recorded them: "$30k | $35k | ...". */
function optionsOf(entry) {
  if (!entry || !entry.context) return [];
  return String(entry.context).split("|").map((o) => o.trim()).filter(Boolean);
}

/** The input this question deserves, plus the help that says what to type. */
function fieldFor(entry, id) {
  const options = entry.kind === "option" ? optionsOf(entry) : [];
  if (options.length) {
    const select = h("select", { id });
    for (const option of options) select.append(h("option", { value: option, text: option }));
    return { control: select, help: "The portal offered these and nothing else." };
  }
  if (entry.kind === "numeric") {
    return { control: h("input", { type: "number", min: "0", step: "1", id, placeholder: "e.g. 4" }), help: "Years." };
  }
  return { control: h("input", { type: "text", id, placeholder: "e.g. Yes, full working rights" }), help: "" };
}

/** Enter submits a single-field form (section 7, Form fields). */
function submitsOnEnter(control, run) {
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    run();
  });
}

/**
 * One unanswered question, with the two controls that clear it: bank the
 * answer, or say it was never a question (a heading the scraper read as one).
 */
function askBlock(entry, index, actions) {
  const block = h("div", { class: "screening-ask" });
  block.append(h("p", { class: "screening-question", text: entry.question }));
  if (entry.company || entry.title) {
    block.append(h("p", { class: "field-help", text: [entry.title, entry.company].filter(Boolean).join(" at ") }));
  }
  const id = `screening-answer-${index}`;
  const { control, help } = fieldFor(entry, id);
  const note = h("p", { class: "field-error", hidden: true });
  const bank = h("button", { type: "button", class: "btn btn-primary", text: "Bank answer" });
  const drop = h("button", { type: "button", class: "btn", text: "Not a real question" });

  const say = (text) => { note.hidden = !text; note.textContent = text || ""; };
  const post = async (path, body, button, banked) => {
    say("");
    button.disabled = true;
    try {
      await api(path, { method: "POST", body });
      toast(banked ? "Answer banked" : "Question removed");
      actions.done(banked);
    } catch (error) {
      button.disabled = false;
      say(error.message);
    }
  };
  const bankIt = () => {
    const answer = String(control.value || "").trim();
    if (!answer) return say("Type an answer first.");
    post("screening/answer", { question: entry.question, answer, kind: entry.kind }, bank, true);
  };
  bank.addEventListener("click", bankIt);
  submitsOnEnter(control, bankIt);
  drop.addEventListener("click", () => post("screening/remove", { question: entry.question }, drop, false));

  block.append(field("Your answer", control, help), h("div", { class: "action-buttons" }, bank, drop), note);
  return block;
}

/** "I have N years with X", the one answer shape that resolves a whole family. */
function yearsForm(actions) {
  const skill = h("input", { type: "text", id: "years-skill", placeholder: "e.g. azure" });
  const years = h("input", { type: "number", min: "0", step: "1", id: "years-count", placeholder: "e.g. 4" });
  const note = h("p", { class: "field-error", hidden: true });
  const save = h("button", { type: "button", class: "btn btn-primary", text: "Save years" });
  const run = async () => {
    const name = String(skill.value || "").trim();
    const count = Number(years.value);
    if (!name || !Number.isFinite(count) || years.value === "") {
      note.hidden = false;
      note.textContent = "A skill and a number of years.";
      return;
    }
    note.hidden = true;
    save.disabled = true;
    try {
      await api("screening/skill-years", { method: "POST", body: { skill: name, years: count } });
      toast(`${name}: ${count} years saved`);
      actions.done(false);
    } catch (error) {
      save.disabled = false;
      note.hidden = false;
      note.textContent = error.message;
    }
  };
  save.addEventListener("click", run);
  submitsOnEnter(skill, run);
  submitsOnEnter(years, run);
  const box = h("div", { class: "screening-years" });
  box.append(h("h3", { class: "screening-sub", text: "Years with a skill" }),
    h("p", { class: "field-help", text: "A years question answers itself once the years are on file: \"how many years with X\" is filled from this map, never guessed." }));
  const row = h("div", { class: "years-row" }, field("Skill", skill), field("Years", years), save);
  row.querySelectorAll(".field")[1].classList.add("short");
  box.append(row, note);
  return box;
}

/** Everything already answered, under the same fold as the years form. */
function bankedList(data) {
  const answered = (data.unknown || []).filter((entry) => entry.answer);
  const skills = Object.entries(data.skills_years || {});
  const box = h("div", { class: "screening-banked" });
  if (!answered.length && !skills.length) {
    box.append(h("p", { class: "field-help", text: "Nothing banked yet." }));
    return { node: box, count: 0 };
  }
  for (const entry of answered) {
    box.append(h("p", { class: "screening-banked-row" },
      h("span", { class: "banked-q", text: entry.question }),
      h("span", { class: "banked-a", text: entry.answer })));
  }
  for (const [name, years] of skills) {
    box.append(h("p", { class: "screening-banked-row" },
      h("span", { class: "banked-q", text: name }),
      h("span", { class: "banked-a", text: `${years} years` })));
  }
  return { node: box, count: answered.length + skills.length };
}

/**
 * The questions this row is actually stuck on: the ones parked under its id,
 * and the one its reason line quotes, which may have been parked under another
 * row that asked the same thing.
 */
function askedOf(data, row, reason) {
  const all = (data.unknown || []).filter((entry) => !entry.answer);
  if (!row) return all;
  const quoted = normalise(questionInReason(reason));
  return all.filter((entry) => entry.opportunity_id === row.id || (quoted && entry.normalised === quoted));
}

/**
 * The card, or null when this row has no unanswered question. `send` is the
 * row page's own "Send now via autopilot" control, which arrives disabled:
 * banking an answer enables it and gives it the focus, and the person's press
 * is the one that sends (AGENTS.md section 2).
 */
export async function screeningCard({ row, reason, send, onBanked } = {}) {
  let data = null;
  try { data = await api("screening"); } catch { return null; }
  const asked = askedOf(data, row, reason);
  if (!asked.length) return null;

  const card = h("section", { class: "card screening-card" });
  const body = h("div", { class: "screening" });
  card.append(h("h2", { text: asked.length === 1 ? "A question in the way" : `${asked.length} questions in the way` }), body);

  /** Redraw off the file as it now is, then hand the send control over. The
   * order matters: `onBanked` puts the focus on a button, and moving a focused
   * node in the redraw would take the focus straight back off it. */
  const repaint = async (banked) => {
    const fresh = await api("screening").catch(() => null);
    if (fresh) { data = fresh; draw(); }
    if (banked && typeof onBanked === "function") onBanked();
  };

  function draw() {
    while (body.firstChild) body.firstChild.remove();
    const actions = { done: (banked) => repaint(banked) };
    const left = askedOf(data, row, reason);
    if (!left.length) {
      body.append(h("p", { class: "screening-done", text: "Answered. Nothing else on this row is waiting on you." }));
    }
    left.forEach((entry, index) => body.append(askBlock(entry, index, actions)));
    if (send) body.append(h("div", { class: "screening-send" }, send.node, send.help, send.line));
    else body.append(h("p", { class: "field-help", text: "Nothing is sent to a channel from here." }));
    const bank = bankedList(data);
    const fold = h("details", { class: "disclosure screening-bank" });
    fold.append(h("summary", { text: `Answer bank, ${bank.count} ${bank.count === 1 ? "answer" : "answers"}` }),
      yearsForm(actions), bank.node);
    body.append(fold);
  }

  draw();
  return card;
}
