/*
 * today.js - today's journal entry, as the run wrote it.
 *
 * AGENTS.md section 3.9: the journal is where an unattended run says what it
 * did, including the full text of anything it sent. This screen only reads it.
 */

import { fetchInto, h, panel, richMarkdown } from "./app.js";

export async function viewToday(view) {
  view.append(h("h1", { text: "Today" }));
  const host = h("div", {});
  host.append(h("p", { class: "empty", text: "Loading the journal." }));
  view.append(host);
  const data = await fetchInto(host, "journal/today", "Could not load today's summary.");
  if (!data) return;
  const markdown = String(data.markdown || "").trim();
  if (!markdown) {
    host.append(h("p", { class: "empty", text: "No entry for today yet. The morning run writes one when it finishes." }));
    return;
  }
  if (data.date) view.insertBefore(h("p", { class: "page-count", text: data.date }), host);
  host.append(panel("Journal", h("div", { class: "prose" }, richMarkdown(markdown))));
}
