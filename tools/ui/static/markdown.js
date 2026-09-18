/*
 * markdown.js - the little markdown the UI renders: paragraphs for a cover
 * letter, plus headings, lists and preformatted tables for a run summary.
 *
 * Text nodes only, never an HTML string, so a company name, a job description
 * or a journal entry can never become markup. Exported again from app.js,
 * which is what the screens import from.
 */

import { h } from "./app.js";

// --- Minimal markdown: paragraphs for letters, plus headings, lists and
// --- preformatted tables for the journal. Text nodes only.
export function paragraphs(source) {
  const out = [];
  for (const block of String(source).replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const p = h("p", {});
    lines.forEach((line, i) => { if (i) p.append(h("br", {})); p.append(document.createTextNode(line.trim())); });
    out.push(p);
  }
  return out.length ? out : [h("p", { class: "grey", text: "(empty)" })];
}

export function richMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null, table = null, para = [];
  const flushPara = () => { if (para.length) { out.push(...paragraphs(para.join("\n"))); para = []; } };
  const flushList = () => { if (list) { out.push(list); list = null; } };
  // A markdown table renders as preformatted text rather than as a grid.
  const flushTable = () => { if (table) { out.push(h("pre", { text: table.join("\n") })); table = null; } };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    // A table line is collected until the block ends; see flushTable.
    if (line.trim().startsWith("|")) { flushPara(); flushList(); (table = table || []).push(line); continue; }
    flushTable();
    if (heading) { // h1 is the view title, so a document heading starts at h2
      flushAll();
      out.push(h(`h${Math.min(3, heading[1].length + 1)}`, { text: heading[2].trim() }));
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      (list = list || h("ul", {})).append(h("li", { text: (bullet ? bullet[1] : numbered[1]).trim() }));
      continue;
    }
    flushList();
    if (line.trim() === "") flushPara();
    else para.push(line);
  }
  flushAll();
  return out.length ? out : [h("p", { class: "grey", text: "(empty)" })];
}

/** Package fields arrive as strings or as objects; show something either way. */
export function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

