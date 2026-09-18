/*
 * row-letter.js - the cover letter on a row, the critic's findings under it,
 * and the gates strip that counts every verdict on the package it belongs to.
 *
 * The letter is what the decision is about, so the two controls that change it
 * sit on the card's own title row rather than at the bottom of the page: Edit
 * letter, which rewrites it here, and Redraft letter, which asks the next run
 * to write it again with the critic's findings in front of it. While the
 * letter is being edited the same spot carries Save letter and Cancel.
 *
 * The findings sit under the letter, not beside it: the gates strip at the top
 * of the page links a fail or a warn chip down to them, and a column of boxes
 * next to a letter set at a reading measure left the page in two minds about
 * where to look (docs/ui-redesign-2026-09-18.md, section 7, Gates strip).
 *
 * Saving writes cover-letter.md back into the package and returns the
 * deterministic pre-checks only. The model critic is not run from a browser: it
 * gates an unattended send and it is keyed to the letter's sha, so it runs when
 * the row is sent, against the bytes that would go out (AGENTS.md 3.7).
 *
 * The gates strip lives here for the same reason: every chip in it is quoted
 * off a file this module already reads, and the letter-critic chip scrolls to
 * the findings this module draws. AGENTS.md section 8: a gate with no record
 * says "not run", and nothing is ever inferred from the row's status.
 */

import { api, asText, h, paragraphs, toast } from "./app.js";

/** Where the gates strip scrolls to when a letter-critic chip is pressed. */
export const FINDINGS_ID = "letter-findings";

/** Take the person to the findings the chip they pressed is counting. */
function scrollToFindings() {
  const box = document.getElementById(FINDINGS_ID);
  if (!box) return;
  box.scrollIntoView({ block: "start" });
  box.focus({ preventScroll: true });
}

/** The statuses whose letter the person may still rewrite here. The server
 * refuses the rest (rows-ext-api.ts, LETTER_EDITABLE). */
const EDITABLE = new Set(["manual_action_needed", "awaiting_approval"]);

export const letterEditable = (status) => EDITABLE.has(String(status || ""));

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
 * One finding under the letter: the sentence the critic pinned, what is wrong
 * with it, and what to do about it. The three field names are the critic's own
 * (`quote`, `issue`, `fix`); the older names are read too so a finding written
 * by an earlier run is not shown as an empty box.
 */
export function fixCard(finding) {
  const fail = String(finding.severity || "").toLowerCase() === "fail";
  const card = h("li", { class: fail ? "fix bad" : "fix" });
  const quote = finding.quote ?? finding.sentence ?? "";
  const issue = finding.issue ?? finding.message ?? finding.detail ?? "";
  const fix = finding.fix ?? finding.suggestion ?? finding.remedy ?? "";
  card.append(h("p", { class: "fix-sev", text: fail ? "Fail" : "Warn" }));
  if (quote) card.append(h("p", { class: "fix-quote", text: `"${quote}"` }));
  if (issue) card.append(h("p", { class: "fix-issue", text: issue }));
  if (fix) card.append(h("p", { class: "fix-do", text: `Fix: ${fix}` }));
  if (!issue && !fix) card.append(h("p", { class: "fix-issue grey", text: "The critic pinned this sentence without saying why." }));
  return card;
}

/** The findings, under the letter, with the anchor the gates strip scrolls to. */
function findingsBlock(findings, verdict) {
  const box = h("div", { class: "letter-findings", id: FINDINGS_ID, tabindex: "-1" });
  const fails = findings.filter((f) => String(f.severity || "").toLowerCase() === "fail").length;
  const warns = findings.length - fails;
  const counted = [fails ? `${fails} fail` : "", warns ? `${warns} warn` : ""].filter(Boolean).join(", ");
  box.append(h("p", { class: "letter-findings-head",
    text: `The letter critic recorded ${verdict || "a verdict"}: ${counted || "no findings"}.` }));
  const list = h("ul", { class: "findings" });
  for (const finding of findings) list.append(fixCard(finding));
  box.append(list);
  return box;
}

/**
 * The letter card. `redraft` is the control built by the row detail, so the
 * button sits on this card's title row while the request it posts stays with
 * the rest of the row's actions.
 */
export function letterCard(row, pkg, redraft) {
  const editable = letterEditable(row.status);
  const critic = pkg.letter_critic;
  const verdict = critic ? String(critic.verdict || "").toLowerCase() : "";
  const findings = critic && Array.isArray(critic.findings) ? critic.findings.filter(Boolean) : [];
  let text = asText(pkg.cover_letter);
  // Once the letter has been edited the stored verdict is about bytes that no
  // longer exist, so the quotes stop being highlighted and the card says why.
  let stale = false;
  const body = h("div", { class: "letter-body" });
  const notes = h("div", { class: "letter-notes" });
  const controls = h("div", { class: "card-head-actions" });

  const paint = () => {
    while (body.firstChild) body.firstChild.remove();
    // A critic that passed can still have left warnings, and they are the most
    // useful thing on the page for the next draft, so they are shown either way.
    const pinned = findings.length > 0 && !stale;
    body.append(h("div", { class: "letter" }, text.trim()
      ? markedLetter(text, pinned ? quotesFrom(critic) : [])
      : h("p", { class: "grey", text: "No cover letter in this package. The next run drafts one." })));
    if (stale) {
      body.append(h("p", { class: "field-help",
        text: "The stored critic verdict was written against the letter before this edit. It runs again when the row is sent." }));
    }
    if (pinned) body.append(findingsBlock(findings, verdict));
  };

  const edit = h("button", { type: "button", class: "btn", text: "Edit letter",
    title: "Rewrite the letter in this package yourself" });
  /** The title row carries the letter's controls, and swaps them while editing. */
  const resting = () => {
    while (controls.firstChild) controls.firstChild.remove();
    if (editable) controls.append(edit);
    if (redraft) controls.append(redraft.button);
  };

  const closeEditor = () => { paint(); resting(); edit.focus(); };

  edit.addEventListener("click", () => {
    while (body.firstChild) body.firstChild.remove();
    const area = h("textarea", { class: "letter-edit", id: "letter-edit", "aria-label": "Cover letter" });
    area.value = text;
    const ask = h("p", { class: "letter-ask", hidden: true });
    const save = h("button", { type: "button", class: "btn btn-primary", text: "Save letter" });
    const cancel = h("button", { type: "button", class: "btn", text: "Cancel" });
    const changed = () => area.value !== text;

    /** Escape closes the editor, and asks once when there is something to lose
     * (docs/ui-redesign-2026-09-18.md, section 7, Keyboard and focus). */
    const askOnce = () => {
      if (!changed()) return closeEditor();
      if (!ask.hidden) return;
      const discard = h("button", { type: "button", class: "btn btn-danger", text: "Discard the edits" });
      const keep = h("button", { type: "button", class: "btn", text: "Keep editing" });
      discard.addEventListener("click", () => closeEditor());
      keep.addEventListener("click", () => { ask.hidden = true; area.focus(); });
      while (ask.firstChild) ask.firstChild.remove();
      ask.append(h("span", { text: "This letter has unsaved edits." }), discard, keep);
      ask.hidden = false;
      discard.focus();
    };

    area.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      askOnce();
    });
    cancel.addEventListener("click", () => askOnce());

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
        notes.append(h("p", { class: "field-help", text: result.findings.length
          ? `${result.findings.length} pre-check finding${result.findings.length === 1 ? "" : "s"} on the saved letter. The full critic runs when the row is sent.`
          : "The pre-checks found nothing. The full critic runs when the row is sent, against the letter that would go out." }));
        if (result.findings.length) {
          const list = h("ul", { class: "findings" });
          for (const finding of result.findings) list.append(fixCard(finding));
          notes.append(list);
        }
      } catch (error) {
        save.disabled = false;
        notes.append(h("p", { class: "field-error", text: error.message }));
      }
    });

    while (controls.firstChild) controls.firstChild.remove();
    controls.append(save, cancel);
    body.append(area, ask);
    area.focus();
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

// ---------------------------------------------------------------------------
// The gates strip: every verdict on this package, quoted off a file
// ---------------------------------------------------------------------------

/** A gate value written a dozen ways across the archive, read one way here. */
function verdictWord(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === true) return "pass";
  if (raw === false) return "fail";
  const text = String(typeof raw === "object" ? raw.verdict ?? raw.status ?? "" : raw).trim().toLowerCase();
  if (!text) return null;
  return text.split(/[\s(,]/)[0] || null;
}

const TONES = { pass: "pill-pass", warn: "pill-warn", fail: "pill-fail", block: "pill-fail", revise: "pill-warn" };

/** One chip: the gate, the verdict as it was recorded, and the detail. A gate
 * with no record on file says so and is never read as a pass. */
function gateChip(name, verdict, detail, onClick) {
  const tone = verdict ? TONES[verdict] || "pill-warn" : "pill-none";
  const text = verdict ? `${name} ${verdict}${detail ? `, ${detail}` : ""}` : `${name} not run`;
  if (!onClick) return h("span", { class: `pill ${tone}`, text });
  const button = h("button", { type: "button", class: `pill ${tone} gate-chip`, text });
  button.addEventListener("click", onClick);
  return button;
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
    critic: verdictWord(pick("critic", "baselineCritic") ?? meta.critic),
    slop: verdictWord(pick("slop", "coverLetterSlop", "slopKiller", "slop_killer")),
    voice: verdictWord(pick("voice", "coverLetterVoice", "voiceCheck", "voice_check")),
    grounding: verdictWord(pick("termGrounding", "term_grounding", "termGroundingCheck")),
    words: Number(letter.words ?? (meta.cover_letter && meta.cover_letter.word_count)) || null,
  };
}

/** What the run put in the package, in the words the metadata uses. */
function resumeOf(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const resume = (meta.resume && typeof meta.resume === "object") ? meta.resume : {};
  const inferred = resume.baselineApprovalCheck ? "baseline" : (resume.docx || resume.pdf ? "rendered" : "");
  const mode = String(meta.mode ?? resume.mode ?? resume.choice ?? inferred).toLowerCase();
  const file = typeof resume.docx === "string" ? resume.docx.split("/").pop()
    : typeof resume.pdf === "string" ? resume.pdf.split("/").pop() : null;
  const ref = file ?? resume.ref ?? resume.resume_id ?? resume.id ?? resume.resumeId ?? meta.resumeId ?? null;
  return { mode: mode || null, ref: ref ? String(ref) : null };
}

/**
 * The gates strip: one chip per recorded verdict, then the package line under
 * it. Every chip is quoted off a file. Nothing here is inferred from the row's
 * status: a row reads "submitted" because it was sent, which says nothing at
 * all about what the gate found on the way (AGENTS.md section 8).
 */
export function gatesStrip(pkg, files) {
  const strip = h("div", { class: "gates-strip", "aria-label": "Gates" });
  const quality = qualityOf(pkg.metadata);
  strip.append(gateChip("Critic", quality.critic, ""));

  const critic = pkg.letter_critic;
  if (!critic) strip.append(gateChip("Letter critic", null, ""));
  else {
    const findings = Array.isArray(critic.findings) ? critic.findings.filter(Boolean) : [];
    const verdict = verdictWord(critic.verdict) || "recorded";
    const fails = findings.filter((f) => String(f.severity || "").toLowerCase() === "fail").length;
    const detail = verdict === "pass"
      ? `${findings.length - fails} warn`
      : `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
    strip.append(gateChip("Letter critic", verdict, detail, findings.length ? scrollToFindings : null));
  }
  strip.append(gateChip("Slop", quality.slop, ""));
  strip.append(gateChip("Voice", quality.voice, ""));
  strip.append(gateChip("Term grounding", quality.grounding, ""));

  const resume = resumeOf(pkg.metadata);
  const names = Array.isArray(files) ? files : [];
  const words = quality.words
    || (pkg.cover_letter ? String(pkg.cover_letter).split(/\s+/).filter(Boolean).length : null);
  const label = resume.mode === "tailored" ? "Tailored CV" : resume.mode === "baseline" ? "Baseline CV"
    : resume.mode ? "CV in the package" : "No CV recorded";
  const line = h("p", { class: "package-line" });
  line.append(h("span", { text: resume.ref ? `${label}, ${resume.ref}` : label }));
  line.append(h("span", { text: `, letter ${words ? `${words} words` : "not written"}` }));
  line.append(h("span", { text: `, ${names.length} ${names.length === 1 ? "file" : "files"}` }));
  return h("div", { class: "row-gates" }, strip, line);
}
