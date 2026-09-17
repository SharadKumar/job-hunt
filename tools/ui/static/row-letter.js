/*
 * row-letter.js - the cover letter on a row, and the critic's findings beside
 * it.
 *
 * The letter is the thing the decision is about, so the two controls that
 * change it sit on the card's own title row rather than at the bottom of the
 * page: Edit letter, which rewrites it here, and Redraft letter, which asks the
 * next run to write it again with the critic's findings in front of it. While
 * the letter is being edited the same spot carries Save letter and Cancel.
 *
 * Saving writes cover-letter.md back into the package and returns the
 * deterministic pre-checks only. The model critic is not run from a browser: it
 * gates an unattended send and it is keyed to the letter's sha, so it runs when
 * the row is retried, against the bytes that would go out (AGENTS.md 3.7).
 */

import { api, asText, eyebrow, h, paragraphs, toast } from "./app.js";

/** The quoted sentences the critic pinned, so they can be found in the letter. */
function quotesFrom(critic) {
  const findings = critic && Array.isArray(critic.findings) ? critic.findings : [];
  return findings
    .map((f) => String((f && (f.quote ?? f.sentence)) || "").trim())
    .filter((q) => q.length >= 8);
}

/** One line of the letter, with any quoted stretch wrapped in a mark. */
function markLine(line, quotes) {
  const lower = line.toLowerCase();
  let best = null;
  for (const quote of quotes) {
    const needle = quote.toLowerCase().replace(/[.…]+$/, "");
    if (needle.length < 8) continue;
    const at = lower.indexOf(needle);
    if (at > -1 && (!best || at < best.at)) best = { at, len: needle.length };
  }
  if (!best) return [document.createTextNode(line)];
  const head = line.slice(0, best.at);
  const hit = line.slice(best.at, best.at + best.len);
  const tail = line.slice(best.at + best.len);
  return [...(head ? [document.createTextNode(head)] : []), h("mark", { text: hit }), ...markLine(tail, quotes)];
}

/** The letter as paragraphs, with the critic's quotes highlighted in place. */
function markedLetter(text, quotes) {
  if (!quotes.length) return paragraphs(text);
  const out = [];
  for (const block of String(text).replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const p = h("p", {});
    lines.forEach((line, i) => {
      if (i) p.append(h("br", {}));
      for (const node of markLine(line.trim(), quotes)) p.append(node);
    });
    out.push(p);
  }
  return out.length ? out : [h("p", { class: "grey", text: "(empty)" })];
}

/**
 * One finding beside the letter: the sentence the critic pinned, what is wrong
 * with it, and what to do about it. The three field names are the critic's own
 * (`quote`, `issue`, `fix`); the older names are read too so a finding written
 * by an earlier run is not shown as an empty box.
 */
export function fixCard(finding) {
  const card = h("div", { class: finding.severity === "fail" ? "fix bad" : "fix" });
  const quote = finding.quote ?? finding.sentence ?? "";
  const issue = finding.issue ?? finding.message ?? finding.detail ?? "";
  const fix = finding.fix ?? finding.suggestion ?? finding.remedy ?? "";
  card.append(h("p", { class: "fix-sev", text: finding.severity === "fail" ? "Fail" : "Warn" }));
  if (quote) card.append(h("p", { class: "fix-quote", text: `"${quote}"` }));
  if (issue) card.append(h("p", { class: "fix-issue", text: issue }));
  if (fix) card.append(h("p", { class: "fix-do grey small", text: `Fix: ${fix}` }));
  if (!issue && !fix) card.append(h("p", { class: "fix-issue grey", text: "The critic pinned this sentence without saying why." }));
  return card;
}

function findingsColumn(findings) {
  const column = h("div", { class: "fixes" });
  column.append(eyebrow("What the critic pinned"));
  for (const finding of findings) column.append(fixCard(finding));
  return column;
}

/**
 * The letter card. `redraft` is the control built by the row detail, so the
 * button sits on this card's title row while the request it posts stays with
 * the rest of the row's actions.
 */
export function letterCard(row, pkg, redraft) {
  const editable = row.status === "manual_action_needed" || row.status === "awaiting_approval";
  const critic = pkg.letter_critic;
  const findings = critic && Array.isArray(critic.findings) ? critic.findings.filter(Boolean) : [];
  // A critic that passed can still have left warnings, and they are the most
  // useful thing on the page for the next draft, so they are shown either way.
  let text = asText(pkg.cover_letter);
  // Once the letter has been edited the stored verdict is about bytes that no
  // longer exist, so the quotes stop being highlighted and the card says why.
  let stale = false;
  const body = h("div", { class: "letter-body" });
  const notes = h("div", { class: "letter-notes" });
  const controls = h("div", { class: "card-head-actions" });

  const paint = () => {
    while (body.firstChild) body.firstChild.remove();
    const pinned = findings.length > 0 && !stale;
    const letter = h("div", { class: "letter" }, text.trim()
      ? markedLetter(text, pinned ? quotesFrom(critic) : [])
      : h("p", { class: "grey", text: "No cover letter in this package. Retry to have the harness draft one." }));
    if (pinned) body.append(h("div", { class: "letter-fix" }, letter, findingsColumn(findings)));
    else body.append(letter);
  };

  const edit = h("button", { type: "button", class: "btn sm", text: "Edit letter",
    title: "Rewrite the letter in this package yourself" });
  /** The title row carries the letter's controls, and swaps them while editing. */
  const resting = () => {
    while (controls.firstChild) controls.firstChild.remove();
    if (editable) controls.append(edit);
    if (redraft) controls.append(redraft.button);
  };

  edit.addEventListener("click", () => {
    while (body.firstChild) body.firstChild.remove();
    const area = h("textarea", { class: "letter-edit", "aria-label": "Cover letter" });
    area.value = text;
    const save = h("button", { type: "button", class: "btn primary sm", text: "Save letter" });
    const cancel = h("button", { type: "button", class: "btn sm", text: "Cancel" });
    cancel.addEventListener("click", () => { paint(); resting(); });
    save.addEventListener("click", async () => {
      save.disabled = true;
      while (notes.firstChild) notes.firstChild.remove();
      try {
        const result = await api(`rows/${encodeURIComponent(row.id)}/letter`, { method: "POST", body: { text: area.value } });
        text = area.value;
        stale = true;
        paint();
        resting();
        toast(`Letter saved, ${result.words} words.`);
        notes.append(h("p", { class: "grey small", text: result.findings.length
          ? `${result.findings.length} pre-check finding${result.findings.length === 1 ? "" : "s"} on the saved letter. The full critic runs when you retry.`
          : "The pre-checks found nothing. The full critic runs when you retry, against the letter that would go out." }));
        for (const finding of result.findings) notes.append(fixCard(finding));
      } catch (error) {
        save.disabled = false;
        notes.append(h("p", { class: "error", text: error.message }));
      }
    });
    while (controls.firstChild) controls.firstChild.remove();
    controls.append(save, cancel);
    body.append(area);
  });

  paint();
  resting();
  const card = h("section", { class: "card letter-card" },
    h("div", { class: "card-head" }, h("h2", { text: "Cover letter" }), controls));
  // A redraft already asked for is a caption under the title, not a block.
  if (redraft) card.append(redraft.extra);
  card.append(body, notes);
  return card;
}
