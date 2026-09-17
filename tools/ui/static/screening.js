/*
 * screening.js - the card that unsticks a row parked on a question.
 *
 * A portal asked something the profile has no answer for, so the run stopped
 * and wrote the question into screening-answers.yaml. That is the whole of the
 * block: one sentence the person can answer in ten seconds, sitting in a YAML
 * file they would otherwise have to open in an editor.
 *
 * `screeningPanel({ row, reason, onBanked })` is a card another screen mounts
 * on a row, and it also stands on its own: with no row it simply shows every
 * unanswered question. Banking an answer writes it into the person's own file
 * and calls `onBanked` so the host can offer the retry; nothing here submits,
 * retries or contacts anything (AGENTS.md section 2).
 */

import { api, clear, fetchInto, h, panel, toast } from "./app.js";

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

/** The input this question deserves, plus how to read it back. */
function fieldFor(entry) {
  const options = entry.kind === "option" ? optionsOf(entry) : [];
  if (options.length) {
    const select = h("select", { class: "screening-input", "aria-label": "Answer" });
    for (const option of options) select.append(h("option", { value: option, text: option }));
    return select;
  }
  if (entry.kind === "numeric") {
    return h("input", { class: "screening-input", type: "number", min: "0", step: "1",
      placeholder: "Years, or a sentence", "aria-label": "Answer" });
  }
  return h("input", { class: "screening-input", type: "text", placeholder: "Your answer", "aria-label": "Answer" });
}

/** One unanswered question, with the control that banks it. */
function askBlock(entry, actions) {
  const block = h("div", { class: "screening-ask" });
  block.append(h("p", { class: "screening-question", text: entry.question }));
  if (entry.company || entry.title) {
    block.append(h("p", { class: "grey small", text: [entry.title, entry.company].filter(Boolean).join(" at ") }));
  }
  const field = fieldFor(entry);
  const note = h("p", { class: "grey small" });
  const bank = h("button", { type: "button", class: "btn primary", text: "Bank answer" });
  const drop = h("button", { type: "button", class: "btn", text: "Not a real question" });

  bank.addEventListener("click", async () => {
    const answer = String(field.value || "").trim();
    if (!answer) { note.textContent = "Type an answer first."; return; }
    bank.disabled = true;
    clear(note);
    try {
      await api("screening/answer", { method: "POST", body: { question: entry.question, answer, kind: entry.kind } });
      toast("Answer banked. The next run will use it.");
      actions.done();
    } catch (error) {
      bank.disabled = false;
      note.textContent = error.message;
    }
  });
  drop.addEventListener("click", async () => {
    drop.disabled = true;
    clear(note);
    try {
      await api("screening/remove", { method: "POST", body: { question: entry.question } });
      toast("Question removed.");
      actions.done();
    } catch (error) {
      drop.disabled = false;
      note.textContent = error.message;
    }
  });

  block.append(h("div", { class: "screening-fields" }, field, h("div", { class: "action-buttons" }, bank, drop)), note);
  return block;
}

/** "I have N years with X", the one answer shape that resolves a whole family. */
function yearsForm(actions) {
  const skill = h("input", { class: "screening-input", type: "text", placeholder: "Skill, for example azure", "aria-label": "Skill" });
  const years = h("input", { class: "screening-input short", type: "number", min: "0", step: "1", placeholder: "Years", "aria-label": "Years" });
  const note = h("p", { class: "grey small" });
  const save = h("button", { type: "button", class: "btn primary", text: "Save years" });
  save.addEventListener("click", async () => {
    const name = String(skill.value || "").trim();
    const count = Number(years.value);
    if (!name || !Number.isFinite(count)) { note.textContent = "A skill and a number of years, please."; return; }
    save.disabled = true;
    clear(note);
    try {
      await api("screening/skill-years", { method: "POST", body: { skill: name, years: count } });
      toast(`${name}: ${count} years saved.`);
      actions.done();
    } catch (error) {
      save.disabled = false;
      note.textContent = error.message;
    }
  });
  const box = h("div", { class: "screening-years" });
  box.append(h("p", { class: "grey small", text: "A years question answers itself once the years are on file: \"how many years with X\" is filled from this map, never guessed." }));
  box.append(h("div", { class: "screening-fields" }, skill, years, h("div", { class: "action-buttons" }, save)), note);
  return box;
}

/** Everything already answered, folded away. */
function banked(data) {
  const answered = (data.unknown || []).filter((entry) => entry.answer);
  const skills = Object.entries(data.skills_years || {});
  const box = h("details", { class: "screening-banked" });
  box.append(h("summary", { text: `${answered.length} banked ${answered.length === 1 ? "answer" : "answers"}`
    + (skills.length ? `, ${skills.length} ${skills.length === 1 ? "skill" : "skills"} on file` : "") }));
  for (const entry of answered) {
    box.append(h("p", { class: "screening-banked-row" },
      h("span", { class: "screening-question small", text: entry.question }),
      h("span", { class: "grey small", text: entry.answer })));
  }
  for (const [name, years] of skills) {
    box.append(h("p", { class: "screening-banked-row" }, h("span", { class: "small", text: `${name}: ${years} years` })));
  }
  if (!answered.length && !skills.length) {
    box.append(h("p", { class: "grey small", text: "Nothing banked yet." }));
  }
  return box;
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
  const mine = all.filter((entry) => entry.opportunity_id === row.id || (quoted && entry.normalised === quoted));
  return mine;
}

export function screeningPanel({ row, reason, onBanked } = {}) {
  const body = h("div", { class: "screening" });
  const card = panel("Screening answers", body);

  const load = async () => {
    body.append(h("p", { class: "empty", text: "Loading the questions." }));
    const data = await fetchInto(body, "screening", "Could not load the screening answers.");
    if (!data) return;
    const actions = { done: () => { if (typeof onBanked === "function") onBanked(); load(); } };
    const asked = askedOf(data, row, reason);
    if (!asked.length) {
      body.append(h("p", { class: "grey", text: row
        ? "No unanswered question is parked against this row."
        : "Every question a portal has asked has an answer on file." }));
    }
    for (const entry of asked) body.append(askBlock(entry, actions));
    body.append(yearsForm(actions), banked(data));
  };

  clear(body);
  load();
  return card;
}
