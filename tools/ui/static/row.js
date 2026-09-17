/*
 * row.js - one application, read end to end.
 *
 * The first line of numbers says whether the letter may go out: the score, the
 * critic verdict, the gate. Then the letter beside the job description, the
 * critic findings, the history, and the five decisions. AGENTS.md section 8: a
 * verdict that was never run is shown as missing, never read as a pass.
 */

import { ACTIONS, actionButton } from "./applications.js";
import { APPLY_METHODS, asText, eyebrow, fetchInto, h, panel, paragraphs, render, statusLabel, when } from "./app.js";

/** One small card in the stats row: a label, a verdict, and a quiet note. */
function stat(label, value, tone, note) {
  const card = h("div", { class: tone ? `card stat ${tone}` : "card stat" });
  card.append(eyebrow(label), h("p", { class: "value", text: value }));
  if (note) card.append(h("p", { class: "note", text: note }));
  return card;
}

/** The stats row: the machine verdicts that decide whether a letter may go out.
 * A missing verdict says so; it is never read as a pass (AGENTS.md section 8). */
export function statsRow(row, pkg) {
  const stats = h("div", { class: "stats", "aria-label": "Gates" });
  stats.append(typeof row.score === "number" ? stat("Score", String(Math.round(row.score)), "good") : stat("Score", "Not scored", ""));
  const critic = pkg.letter_critic;
  if (!critic) stats.append(stat("Critic", "Critic not run", "", "No letter has been critiqued on this row."));
  else {
    const findings = Array.isArray(critic.findings) ? critic.findings : [];
    const count = (severity) => findings.filter((f) => f && f.severity === severity).length;
    stats.append(String(critic.verdict || "").toLowerCase() !== "pass"
      ? stat("Critic", `Critic blocked, ${count("fail")} fail`, "bad")
      : stat("Critic", `Critic pass, ${count("warn")} warn`, "good"));
  }
  const quality = (pkg.metadata && typeof pkg.metadata === "object" && pkg.metadata.quality) || {};
  const notes = [];
  for (const [label, keys] of [["Slop", ["slop", "slopKiller", "slop_killer"]], ["Voice", ["voice", "voiceCheck", "voice_check"]]]) {
    const raw = keys.map((k) => quality[k]).find((v) => v !== undefined && v !== null);
    if (raw === undefined) notes.push(`${label} not recorded`);
    else notes.push(`${label} ${raw === true || String(raw).toLowerCase() === "pass" ? "pass" : "fail"}`);
  }
  const sent = row.status === "submitted";
  stats.append(stat("Gate", sent ? "Gate passed" : `Gate waiting, ${statusLabel(row.status)}`, sent ? "good" : "", notes.join(". ") + "."));
  return stats;
}

function findingsBlock(critic) {
  const findings = critic && Array.isArray(critic.findings) ? critic.findings : [];
  if (!findings.length) return null;
  const ul = h("ul", { class: "findings" });
  for (const finding of findings) {
    const text = typeof finding === "string" ? finding : [
      finding.severity === "fail" ? "Fail" : finding.severity === "warn" ? "Warn" : finding.severity,
      finding.issue || finding.message, finding.fix,
    ].filter(Boolean).map((part) => String(part).trim().replace(/\.+$/, "")).join(". ") + ".";
    ul.append(h("li", { text: text || asText(finding) }));
  }
  return panel("Critic findings", ul);
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
    else if (item.reason) li.append(h("div", { class: "grey small", text: item.reason }));
    ul.append(li);
  }
  return panel("History", ul);
}

function actionBar(row, onDone) {
  const buttons = h("div", { class: "action-buttons" });
  const reason = h("input", { type: "text", "aria-label": "Reason, optional", placeholder: "Reason, optional" });
  const edits = h("textarea", { "aria-label": "Edits, optional", placeholder: "Edits to the letter or package, optional" });
  const fields = () => ({
    ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
    ...(edits.value.trim() ? { edits: edits.value.trim() } : {}),
  });
  for (const action of ACTIONS) buttons.append(actionButton(row, action, fields, onDone));
  return panel("Your decision", h("div", {}, buttons, h("div", { class: "action-fields" }, reason, edits),
    h("p", { class: "grey small", text: "Each button asks twice: press, then press Confirm. Nothing is sent to a channel from here." })));
}

export async function viewRow(view, id) {
  view.append(h("p", { class: "empty", text: "Loading the row." }));
  const data = await fetchInto(view, `rows/${encodeURIComponent(id)}`, "Could not load this row.");
  if (!data) return view.prepend(h("p", { class: "backlink" }, h("a", { href: "#/applications", text: "Applications" })));
  const row = data.row || {};
  const pkg = data.package || {};
  view.append(h("p", { class: "backlink" }, h("a", { href: "#/applications", text: "Applications" })),
    h("h1", { text: row.title || "Untitled role" }));
  const facts = [
    row.company, row.location, row.classification?.work_arrangement || row.workArrangement,
    APPLY_METHODS[row.applyMethod] || row.applyMethod,
    row.userSaved ? "saved by you" : null, statusLabel(row.status) || null,
  ].filter(Boolean);
  const line = h("p", { class: "detail-meta", text: `${facts.join(", ")}. ` });
  if (row.url) line.append(h("a", { href: row.url, rel: "noreferrer noopener", target: "_blank", text: "Open the advert" }));
  view.append(line);
  const reasonLine = data.reason || row.reason;
  if (reasonLine) view.append(h("p", { class: "detail-reason", text: reasonLine }));

  view.append(statsRow(row, pkg));

  // Letter left at reading measure, JD right and quieter. Stacked on a phone,
  // letter first, because the letter is what the decision is about.
  const columns = h("div", { class: "columns" });
  const letterText = asText(pkg.cover_letter);
  columns.append(panel("Cover letter", letterText.trim()
    ? h("div", { class: "letter" }, paragraphs(letterText))
    : h("p", { class: "grey", text: "No cover letter in this package. Retry to have the harness draft one." })));
  const jdText = asText(row.description || pkg.jd);
  columns.append(panel("Job description", jdText.trim()
    ? h("div", { class: "jd" }, h("pre", { text: jdText }))
    : h("p", { class: "grey", text: "No job description stored for this row. Open the advert to read it." })));
  view.append(columns);

  const rest = h("div", { class: "stack" });
  const findings = findingsBlock(pkg.letter_critic);
  if (findings) rest.append(findings);
  rest.append(historyBlock(row.history), actionBar(row, () => { location.hash = "#/applications"; render(); }));
  view.append(rest);
}
