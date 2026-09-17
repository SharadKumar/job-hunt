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

import { ACTIONS, actionButton, contextualControl, FOCUS_KEY, plainReasonText } from "./applications.js";
import { APPLY_METHODS, api, asText, eyebrow, fetchInto, h, pageHeader, panel, paragraphs, render, statusLabel, toast, when } from "./app.js";

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

/** What the run put in the package, in the words the metadata uses. */
function resumeOf(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const resume = (meta.resume && typeof meta.resume === "object") ? meta.resume : {};
  const mode = String(resume.mode ?? resume.choice ?? (resume.docx || resume.pdf ? "rendered" : "")).toLowerCase();
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
  const sent = row.status === "submitted";
  stats.append(stat("Gates", sent ? "Gate passed" : `Gate waiting, ${statusLabel(row.status)}`, sent ? "good" : "", `${notes.join(". ")}.`));
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
    : resume.mode ? "CV recorded" : "No CV recorded";
  stats.append(stat("Package", label, resume.mode ? "" : "bad", `${packageNote}.`));
  return stats;
}

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

/** One finding beside the letter: what is wrong, and what to do about it. */
function fixCard(finding) {
  const card = h("div", { class: finding.severity === "fail" ? "fix bad" : "fix" });
  card.append(h("p", { class: "fix-sev", text: finding.severity === "fail" ? "Fail" : "Warn" }));
  if (finding.quote || finding.sentence) card.append(h("p", { class: "fix-quote", text: `"${finding.quote || finding.sentence}"` }));
  if (finding.issue || finding.message) card.append(h("p", { class: "fix-issue", text: finding.issue || finding.message }));
  if (finding.fix) card.append(h("p", { class: "fix-do grey small", text: finding.fix }));
  return card;
}

function findingsColumn(findings) {
  const column = h("div", { class: "fixes" });
  column.append(eyebrow("What the critic pinned"));
  for (const finding of findings) column.append(fixCard(finding));
  return column;
}

/**
 * The letter card. On a blocked or to-approve row it can be edited in place:
 * Save writes cover-letter.md back into the package and returns the
 * deterministic pre-check findings. The model critic is not run from here.
 */
function letterCard(row, pkg) {
  const editable = row.status === "manual_action_needed" || row.status === "awaiting_approval";
  const critic = pkg.letter_critic;
  const findings = critic && Array.isArray(critic.findings) ? critic.findings.filter(Boolean) : [];
  const blocked = Boolean(critic) && String(critic.verdict || "").toLowerCase() !== "pass";
  let text = asText(pkg.cover_letter);
  // Once the letter has been edited the stored verdict is about bytes that no
  // longer exist, so the quotes stop being highlighted and the card says why.
  let stale = false;
  const body = h("div", { class: "letter-body" });
  const notes = h("div", { class: "letter-notes" });

  const paint = () => {
    while (body.firstChild) body.firstChild.remove();
    const pinned = blocked && !stale;
    const letter = h("div", { class: "letter" }, text.trim()
      ? markedLetter(text, pinned ? quotesFrom(critic) : [])
      : h("p", { class: "grey", text: "No cover letter in this package. Retry to have the harness draft one." }));
    if (pinned && findings.length) body.append(h("div", { class: "letter-fix" }, letter, findingsColumn(findings)));
    else body.append(letter);
  };

  const edit = h("button", { type: "button", class: "btn sm", text: "Edit letter" });
  edit.addEventListener("click", () => {
    while (body.firstChild) body.firstChild.remove();
    const area = h("textarea", { class: "letter-edit", "aria-label": "Cover letter" });
    area.value = text;
    const save = h("button", { type: "button", class: "btn primary sm", text: "Save letter" });
    const cancel = h("button", { type: "button", class: "btn sm", text: "Cancel" });
    cancel.addEventListener("click", () => { paint(); edit.hidden = false; });
    save.addEventListener("click", async () => {
      save.disabled = true;
      while (notes.firstChild) notes.firstChild.remove();
      try {
        const result = await api(`rows/${encodeURIComponent(row.id)}/letter`, { method: "POST", body: { text: area.value } });
        text = area.value;
        stale = true;
        paint();
        edit.hidden = false;
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
    body.append(area, h("div", { class: "letter-actions" }, save, cancel));
    edit.hidden = true;
  });

  paint();
  const card = panel("Cover letter", h("div", {}, body, notes));
  if (editable) card.append(h("div", { class: "letter-actions" }, edit));
  return card;
}

function historyBlock(history) {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) return panel("History", h("p", { class: "grey", text: "No transitions recorded on this row yet." }));
  const ul = h("ul", { class: "history" });
  for (const item of [...entries].reverse()) {
    const li = h("li", {});
    const from = item.from ? statusLabel(item.from) : "new";
    li.append(h("span", { class: "at", text: `${when(item.at)}  ` }), `${from} to ${statusLabel(item.to) || "unknown"}`);
    // A field_update entry is an enrichment pass, not a decision: say which
    // fields moved and keep the raw machinery off the page.
    const fields = /^field_update:\s*([^([]*)/.exec(item.reason || "");
    if (fields) li.append(h("div", { class: "grey small", text: `updated ${fields[1].trim() || "some fields"}` }));
    else if (item.reason) {
      const full = plainReasonText(item.reason);
      const match = /^[^.!?]*[.!?]/.exec(full);
      const first = match ? match[0] : full;
      const note = h("div", { class: "grey small", text: first });
      if (first.length < full.length) {
        const more = h("button", { type: "button", class: "linkish", text: "more" });
        more.addEventListener("click", () => { note.textContent = full; more.remove(); });
        note.append(" ", more);
      }
      li.append(note);
    }
    ul.append(li);
  }
  return panel("History", ul);
}

/**
 * The decision bar. The contextual action comes first and is the primary;
 * Approve is the black button only on a row that is actually waiting on a yes.
 */
function actionBar(data, row, onDone) {
  const buttons = h("div", { class: "action-buttons" });
  const reason = h("input", { type: "text", "aria-label": "Reason, optional", placeholder: "Reason, optional" });
  const edits = h("textarea", { "aria-label": "Edits, optional", placeholder: "Edits to the letter or package, optional" });
  const fields = () => ({
    ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
    ...(edits.value.trim() ? { edits: edits.value.trim() } : {}),
  });
  const act = data.action || { kind: "none" };
  const contextual = contextualControl({ ...row, action: { ...act, primary: true } }, onDone, { small: false });
  if (contextual) buttons.append(contextual);
  for (const action of ACTIONS) {
    if (act.post && action.key === act.post) continue;
    const primary = action.key === "approve" ? row.status === "awaiting_approval" && act.kind !== "approve" : false;
    buttons.append(actionButton(row, { ...action, primary }, fields, onDone));
  }
  return panel("Your decision", h("div", {}, buttons, h("div", { class: "action-fields" }, reason, edits),
    h("p", { class: "grey small", text: "Each button asks twice: press, then press Confirm. Nothing is sent to a channel from here." })));
}

/**
 * The screening panel belongs to another work package. Mount it when the row is
 * stuck on a question, and when an answer is banked offer the retry that puts
 * the row back on the autopilot path.
 */
async function mountScreening(host, row, reason, onDone) {
  if (!UNANSWERED_QUESTION.test(String(reason || ""))) return;
  const mod = await import("./screening.js").catch(() => null);
  if (!mod || typeof mod.screeningPanel !== "function") return;
  const banked = h("div", { class: "banked" });
  const node = mod.screeningPanel({
    row,
    reason,
    onBanked: () => {
      while (banked.firstChild) banked.firstChild.remove();
      const retry = actionButton(row, { key: "retry", label: "Retry", primary: true }, null, onDone);
      banked.append(h("p", { text: "Answer banked. Retry now?" }), retry);
      // guarded() arms on the first press, so one programmatic press leaves the
      // button armed and focused: the person's press is the one that commits.
      retry.click();
    },
  });
  if (node) host.append(node);
  host.append(banked);
}

export async function viewRow(view, id) {
  view.append(h("p", { class: "empty", text: "Loading the row." }));
  const data = await fetchInto(view, `rows/${encodeURIComponent(id)}`, "Could not load this row.");
  if (!data) return view.prepend(pageHeader({ title: "Row", back: h("a", { href: "#/applications", text: "Applications" }) }));
  const row = data.row || {};
  const pkg = data.package || {};
  view.append(pageHeader({
    title: row.title || "Untitled role",
    back: h("a", { href: "#/applications", text: "Applications" }),
  }));
  const facts = [
    row.company, row.location,
    typeof row.score === "number" ? `Score ${Math.round(row.score)}` : null,
    row.classification?.work_arrangement || row.workArrangement,
    APPLY_METHODS[row.applyMethod] || row.applyMethod,
    row.userSaved ? "saved by you" : null, statusLabel(row.status) || null,
  ].filter(Boolean);
  const line = h("p", { class: "detail-meta", text: `${facts.join(", ")}. ` });
  if (row.url) line.append(h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" }));
  view.append(line);

  view.append(statsRow(row, pkg, data.package_files));

  // Letter left at reading measure, JD right and quieter. Stacked on a phone,
  // letter first, because the letter is what the decision is about. With no
  // letter in the package there is nothing to read beside, so the JD takes the
  // full width.
  const hasLetter = asText(pkg.cover_letter).trim() !== "";
  const columns = h("div", { class: hasLetter ? "columns" : "columns one" });
  if (hasLetter) columns.append(letterCard(row, pkg));
  const jdText = asText(row.description || pkg.jd);
  columns.append(panel("Job description", jdText.trim()
    ? h("div", { class: "jd" }, h("pre", { text: jdText }))
    : h("p", { class: "grey", text: "No job description stored for this row. Open the advert to read it." })));
  view.append(columns);
  if (!hasLetter && (row.status === "manual_action_needed" || row.status === "awaiting_approval")) {
    view.append(letterCard(row, pkg));
  }

  const rest = h("div", { class: "stack" });
  const done = () => { location.hash = "#/applications"; render(); };
  const screening = h("div", { class: "screening-slot" });
  rest.append(historyBlock(row.history), screening, actionBar(data, row, done));
  view.append(rest);
  await mountScreening(screening, row, data.reason || row.notes, done);
  try {
    if (sessionStorage.getItem(FOCUS_KEY) === row.id) {
      sessionStorage.removeItem(FOCUS_KEY);
      screening.scrollIntoView({ block: "center" });
      const focusable = screening.querySelector("input, textarea, button, select");
      if (focusable) focusable.focus();
    }
  } catch { /* storage is off; the panel is still on the page */ }
}
