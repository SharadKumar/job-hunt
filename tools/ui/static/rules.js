/*
 * rules.js - the Guardrails workspace (#/guardrails/<tab>).
 *
 * Guardrails follows the same three-level flow as Resumes and Schedules:
 * persistent app navigation, a compact browser, and one selected item. The
 * title-row tabs separate rules in force, critic themes and read-only machine
 * checks, so the page never becomes one long policy document.
 *
 * A standing rule may be edited or removed here, and a recurring theme may be
 * promoted on a second deliberate press. Never-named patterns and editorial
 * bans remain read only.
 */

import {
  api, clear, confirmButton, errorBox, fetchInto, guarded, h, pageHeader, parseHash, placeholderRows, render, toast,
} from "./app.js";

const VERB_NOUNS = {
  inflate: "inflation",
  conflate: "conflation",
  misattribut: "misattribution",
  invent: "invention",
  omit: "omission",
  other: "",
};

export function themeTitle(key) {
  const raw = String(key || "").trim();
  if (!raw) return "Unnamed theme";
  const at = raw.lastIndexOf(":");
  const subject = at < 0 ? raw : raw.slice(0, at);
  const verb = at < 0 ? "other" : raw.slice(at + 1);
  const numbered = /^standing-rule-(\d+)$/.exec(subject);
  const who = numbered ? `Standing rule ${numbered[1]}` : subject.charAt(0).toUpperCase() + subject.slice(1);
  const noun = VERB_NOUNS[verb] === undefined ? verb : VERB_NOUNS[verb];
  return noun ? `${who}: ${noun}` : who;
}

export function ruleTextOf(theme) {
  const raw = String((theme && theme.proposed_rule) || "").trim().replace(/^-\s*/, "");
  const quoted = /^'([\s\S]*)'$/.exec(raw);
  return (quoted ? quoted[1].replace(/''/g, "'") : raw).trim();
}

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

function activeTab(which) {
  return ["themes", "reference"].includes(which) ? which : "rules";
}

function tabStrip(active) {
  const tabs = h("nav", { class: "tabs guard-tabs", "aria-label": "Guardrail views" });
  for (const tab of [
    { key: "rules", label: "Rules", href: "#/guardrails" },
    { key: "themes", label: "Themes", href: "#/guardrails/themes" },
    { key: "reference", label: "Reference", href: "#/guardrails/reference" },
  ]) {
    const link = h("a", { href: tab.href, text: tab.label });
    if (tab.key === active) link.setAttribute("aria-current", "page");
    tabs.append(link);
  }
  return tabs;
}

function selectionHref(active, key) {
  const q = new URLSearchParams(parseHash().query);
  q.set("selected", key);
  const base = active === "rules" ? "#/guardrails" : `#/guardrails/${active}`;
  return `${base}?${q}`;
}

function browserShell(title, count, items) {
  const browser = h("aside", { class: "guard-browser", "aria-label": title },
    h("header", { class: "guard-browser-head" },
      h("div", {}, h("p", { class: "eyebrow", text: "Guardrails" }), h("h2", { text: title })),
      h("span", { class: "guard-browser-count", text: String(count) })),
    h("nav", { class: "guard-browser-list" }));
  const list = browser.querySelector(".guard-browser-list");
  for (const item of items) list.append(item);
  return browser;
}

function browserItem({ active, key, selected, eyebrow, title, preview, count }) {
  const link = h("a", {
    class: selected ? "guard-browser-item selected" : "guard-browser-item",
    href: selectionHref(active, key),
    "aria-current": selected ? "true" : null,
  });
  link.append(h("span", { class: "guard-browser-copy" },
    h("span", { class: "guard-browser-kicker", text: eyebrow }),
    h("strong", { text: title }),
    preview ? h("span", { class: "guard-browser-preview", text: preview }) : null));
  if (count !== undefined) link.append(h("span", { class: "guard-browser-number", text: String(count) }));
  return link;
}

function selectedShell(eyebrow, title, aside) {
  const panel = h("section", { class: "guard-selected", "aria-label": "Selected guardrail" });
  panel.append(h("header", { class: "guard-selected-head" },
    h("div", {}, h("p", { class: "eyebrow", text: eyebrow }), h("h2", { text: title })), aside || null));
  return panel;
}

function standingDetail(text, index, rules) {
  const note = h("p", { class: "rule-note" });
  const actions = h("div", { class: "guard-head-actions" });
  const panel = selectedShell("Rule in force", `Standing rule ${index + 1}`, actions);
  const body = h("div", { class: "guard-selected-body" });
  const label = h("p", { class: "guard-rule-text", text });
  const editor = h("div", { class: "rule-editor", hidden: true });
  const area = h("textarea", { rows: "8", "aria-label": `Standing rule ${index + 1}` });
  area.value = text;
  const save = h("button", { type: "button", class: "btn btn-primary", text: "Save" });
  const cancel = h("button", { type: "button", class: "btn", text: "Cancel" });
  editor.append(area, h("div", { class: "action-buttons" }, save, cancel));

  const edit = h("button", { type: "button", class: "btn", text: "Edit" });
  const removal = confirmButton("Remove", "Confirm remove", async () => {
    removal.button.disabled = true;
    clear(note);
    try {
      await api(`rules/standing/${index}/remove`, { method: "POST", body: {} });
      toast("Rule removed.");
      render();
    } catch (error) {
      removal.button.disabled = false;
      note.textContent = error.message;
    }
  }, { class: "btn btn-danger" });
  actions.append(edit, removal);

  const open = (yes) => {
    editor.hidden = !yes;
    label.hidden = yes;
    edit.hidden = yes;
    if (yes) area.focus();
  };
  edit.addEventListener("click", () => { area.value = text; clear(note); open(true); });
  cancel.addEventListener("click", () => { clear(note); open(false); });
  save.addEventListener("click", async () => {
    const next = area.value.replace(/\s+/g, " ").trim();
    clear(note);
    if (!next) { note.textContent = "A standing rule has to say something."; return; }
    save.disabled = true;
    try {
      await api(`rules/standing/${index}`, { method: "POST", body: { text: next } });
      toast("Rule saved.");
      render();
    } catch (error) {
      save.disabled = false;
      note.textContent = error.message;
    }
  });

  body.append(
    h("p", { class: "guard-selected-lede", text: "Every letter is checked against this wording. A breach is a letter-critic fail." }),
    label, editor, note, h("p", { class: "guard-source", text: `Held in ${rules.path}.` }),
  );
  panel.append(body);
  return panel;
}

function rulesWorkspace(rules, selectedKey) {
  const list = rules.standing_rules || [];
  if (!rules.exists || !list.length) {
    const message = !rules.exists
      ? `No rules file at ${rules.path}. Run the setup skill before editing the rules.`
      : "No standing rules yet. Promote a recurring theme, or write one into the rules file by hand.";
    return h("div", { class: "guard-workbench" }, browserShell("Standing rules", 0, []),
      h("section", { class: "guard-selected" }, h("p", { class: "empty", text: message })));
  }
  const asked = /^rule-(\d+)$/.exec(selectedKey || "");
  const index = asked && Number(asked[1]) < list.length ? Number(asked[1]) : 0;
  const items = list.map((text, at) => browserItem({
    active: "rules", key: `rule-${at}`, selected: at === index,
    eyebrow: `Rule ${at + 1}`, title: text, preview: "In force",
  }));
  return h("div", { class: "guard-workbench" }, browserShell("Standing rules", list.length, items), standingDetail(list[index], index, rules));
}

function themeDetail(theme, digest) {
  const text = ruleTextOf(theme);
  const note = h("p", { class: "rule-note" });
  const actions = h("div", { class: "guard-head-actions" });
  if (text) {
    const promote = h("button", { type: "button", class: "btn", text: "Promote to standing rule" });
    guarded(promote, "Promote", async () => {
      promote.disabled = true;
      clear(note);
      try {
        await api("rules/standing", { method: "POST", body: { text, source_theme: theme.key } });
        toast("Promoted. The critic applies it to the next letter.");
        render();
      } catch (error) {
        promote.disabled = false;
        note.textContent = error.message;
      }
    }, "Promote to standing rule");
    actions.append(promote);
  }
  const panel = selectedShell((theme.count ?? 0) >= 2 ? "Recurring theme" : "Single finding", themeTitle(theme.key), actions);
  const body = h("div", { class: "guard-selected-body" },
    h("p", { class: "guard-selected-lede", text: `${plural(theme.count ?? 0, "finding")} in ${plural(digest.verdicts ?? 0, "verdict")} over the last 14 days.` }));
  if (text) body.append(h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Proposed rule" }), h("p", { class: "guard-rule-text", text })));
  if (theme.sample) body.append(h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Example finding" }), h("blockquote", { class: "theme-sample", text: theme.sample })));
  body.append(note);
  panel.append(body);
  return panel;
}

function themesWorkspace(digest, selectedKey) {
  const themes = digest.themes || [];
  if (!themes.length) {
    return h("div", { class: "guard-workbench" }, browserShell("Critic themes", 0, []),
      h("section", { class: "guard-selected" }, h("p", { class: "empty", text: "No findings in this window. Nothing to promote." })));
  }
  const selected = themes.find((theme) => `theme-${theme.key}` === selectedKey) || themes[0];
  const items = themes.map((theme) => browserItem({
    active: "themes", key: `theme-${theme.key}`, selected: theme === selected,
    eyebrow: (theme.count ?? 0) >= 2 ? "Recurring" : "Single finding",
    title: themeTitle(theme.key), preview: ruleTextOf(theme), count: theme.count ?? 0,
  }));
  return h("div", { class: "guard-workbench" }, browserShell("Critic themes", themes.length, items), themeDetail(selected, digest));
}

function referenceEntries(rules) {
  const patterns = (rules.never_named || []).map((entry, index) => ({
    key: `pattern-${index}`, kind: "Never named", title: entry.issue || `Pattern ${index + 1}`,
    machinery: entry.pattern, fix: entry.fix || "No fix is recorded.", path: rules.path,
  }));
  const bans = rules.editorial_bans || { rules: [], path: "" };
  const banned = (bans.rules || []).map((ban, index) => ({
    key: `ban-${index}`, kind: "Editorial ban", title: ban.note || ban.id,
    machinery: [
      ban.forbidden && ban.forbidden.length ? ban.forbidden.join(", ") : "",
      ban.title_must_equal ? `title must read "${ban.title_must_equal}"` : "",
    ].filter(Boolean).join("; "),
    fix: `${ban.id}, severity ${ban.severity}${ban.scope ? `, applies to ${ban.scope}` : ""}.`, path: bans.path,
  }));
  return [...patterns, ...banned];
}

function referenceDetail(entry) {
  const panel = selectedShell(entry.kind, entry.title);
  panel.append(h("div", { class: "guard-selected-body" },
    h("p", { class: "guard-selected-lede", text: "This check is read only here. It fails mechanically before the critic reads the document." }),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Pattern or condition" }), h("code", { class: "pattern", text: entry.machinery || "No machine condition recorded." })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Required correction" }), h("p", { class: "ref-fix", text: entry.fix })),
    h("p", { class: "guard-source", text: `Edit this in ${entry.path}, not here.` })));
  return panel;
}

function referenceWorkspace(rules, selectedKey) {
  const entries = referenceEntries(rules);
  if (!entries.length) {
    return h("div", { class: "guard-workbench" }, browserShell("Reference checks", 0, []),
      h("section", { class: "guard-selected" }, h("p", { class: "empty", text: "No never-named patterns or editorial bans are in force." })));
  }
  const selected = entries.find((entry) => entry.key === selectedKey) || entries[0];
  const items = entries.map((entry) => browserItem({
    active: "reference", key: entry.key, selected: entry === selected,
    eyebrow: entry.kind, title: entry.title, preview: entry.fix,
  }));
  return h("div", { class: "guard-workbench" }, browserShell("Reference checks", entries.length, items), referenceDetail(selected));
}

export async function viewRules(view, which, query) {
  const active = activeTab(which);
  const count = h("p", { class: "page-count" });
  view.append(pageHeader({ title: "Guardrails", lede: count, aside: tabStrip(active) }));
  const host = h("div", { class: "guard-stage" });
  host.append(placeholderRows(3));
  view.append(host);

  const rules = await fetchInto(host, "rules", "Could not load the editorial rules.");
  if (!rules) { count.textContent = ""; return; }
  let digest = { themes: [], verdicts: 0, blocked: 0 };
  let digestError = null;
  try {
    digest = await api("critic/digest?since=14d");
  } catch (error) {
    digestError = error;
  }

  const selected = (query instanceof URLSearchParams ? query : new URLSearchParams()).get("selected") || "";
  if (active === "themes") {
    count.textContent = `${plural((digest.themes || []).length, "theme")}, ${digest.blocked ?? 0} blocked verdicts in the last 14 days.`;
    if (digestError) host.append(errorBox(digestError, "Could not load the critic digest.", null));
    else host.append(themesWorkspace(digest, selected));
  } else if (active === "reference") {
    const entries = referenceEntries(rules);
    count.textContent = `${plural(entries.length, "machine check")}, read only here.`;
    host.append(referenceWorkspace(rules, selected));
  } else {
    const rulesCount = (rules.standing_rules || []).length;
    count.textContent = `${plural(rulesCount, "standing rule")} in force.`;
    host.append(rulesWorkspace(rules, selected));
  }
}
