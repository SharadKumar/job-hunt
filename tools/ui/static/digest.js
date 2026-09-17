/*
 * digest.js - what the letter critic keeps saying, over the last 14 days.
 *
 * AGENTS.md section 5: recurring findings become editorial rules, but the
 * person promotes them in an attended session. This screen copies a proposed
 * rule to the clipboard and writes nothing.
 */

import { fetchInto, h, pageHeader, toast } from "./app.js";

function copyButton(text) {
  const button = h("button", { type: "button", class: "btn", text: "Copy rule" });
  button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); toast("Rule copied."); }
    catch { toast("This browser blocked the clipboard. Select the rule and copy it.", "bad"); }
  });
  return button;
}

export async function viewDigest(view) {
  const count = h("p", { class: "page-count", text: "Loading the digest." });
  view.append(pageHeader({ title: "Digest", lede: count }));
  const host = h("div", { class: "cards" });
  host.append(h("p", { class: "empty", text: "Loading the digest." }));
  view.append(host);
  const data = await fetchInto(host, "critic/digest?since=14d", "Could not load the critic digest.");
  if (!data) return;
  const themes = data.themes || [];
  count.textContent = `Last 14 days. ${data.verdicts ?? 0} verdicts, ${data.blocked ?? 0} blocked.`;
  if (!themes.length) {
    host.append(h("p", { class: "empty", text: "No recurring themes in this window. Nothing to promote into the editorial rules." }));
    return;
  }
  for (const theme of themes) {
    const card = h("article", { class: "card" });
    card.append(h("h3", {}, h("span", { class: "digest-count", text: String(theme.count ?? 0) }),
      h("span", { text: theme.key || "unnamed theme" })));
    if (theme.sample) card.append(h("p", { class: "sample", text: theme.sample }));
    if (theme.proposed_rule) {
      card.append(h("div", { class: "proposed" }, h("div", { text: theme.proposed_rule }), copyButton(theme.proposed_rule)));
    }
    host.append(card);
  }
  host.append(h("p", { class: "grey small",
    text: "Nothing here is written to the editorial rules. Copy a rule and promote it in an attended session." }));
}
