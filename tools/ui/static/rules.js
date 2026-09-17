/*
 * rules.js - the editorial rules every cover letter is checked against, and the
 * one place the person promotes a recurring critic finding into a standing rule.
 *
 * AGENTS.md section 5: recurring findings become rules, and that promotion is
 * an attended decision. So this screen writes, but only here, only on a second
 * deliberate press, and only into `standing_rules` in the profile's own
 * letter-critic-rules.yaml. The `never_named` patterns and editorial-bans.yaml
 * are shown and never edited: they are regexes that stop a client being named,
 * and a regex typed into a browser is a way to quietly stop blocking something.
 */

import { api, clear, errorBox, fetchInto, guarded, h, pageHeader, panel, render, toast } from "./app.js";

/** The noun the digest's verb class reads as. `other` names no class at all. */
const VERB_NOUNS = {
  inflate: "inflation",
  conflate: "conflation",
  misattribut: "misattribution",
  invent: "invention",
  omit: "omission",
  other: "",
};

/**
 * A theme key in words. The digest groups on `<subject>:<verb class>`, which is
 * a machine key: `standing-rule-4:other` is a heading nobody reads twice.
 */
export function themeTitle(key) {
  const raw = String(key || "").trim();
  if (!raw) return "Unnamed theme";
  const at = raw.lastIndexOf(":");
  const subject = at < 0 ? raw : raw.slice(0, at);
  const verb = at < 0 ? "other" : raw.slice(at + 1);
  const numbered = /^standing-rule-(\d+)$/.exec(subject);
  const who = numbered
    ? `Standing rule ${numbered[1]}`
    : subject.charAt(0).toUpperCase() + subject.slice(1);
  const noun = VERB_NOUNS[verb] === undefined ? verb : VERB_NOUNS[verb];
  return noun ? `${who}: ${noun}` : who;
}

/**
 * The digest proposes a rule in the YAML shape the file wants (`- 'text'`), so
 * the browser posts the sentence and the server does the quoting.
 */
export function ruleTextOf(theme) {
  const raw = String((theme && theme.proposed_rule) || "").trim().replace(/^-\s*/, "");
  const quoted = /^'([\s\S]*)'$/.exec(raw);
  return (quoted ? quoted[1].replace(/''/g, "'") : raw).trim();
}

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/** One recurring theme, with the rule it proposes and the press that lands it. */
function themeRow(theme) {
  const row = h("article", { class: "theme" });
  row.append(h("p", { class: "theme-head" },
    h("span", { class: "theme-count", text: String(theme.count ?? 0) }),
    h("span", { class: "theme-title", text: themeTitle(theme.key) })));
  if (theme.sample) row.append(h("p", { class: "sample", text: theme.sample }));

  const text = ruleTextOf(theme);
  if (!text) return row;
  const note = h("p", { class: "grey small" });
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
  row.append(h("div", { class: "proposed" }, h("p", { text }), promote), note);
  return row;
}

/** Card one: what the critic keeps saying, over the last 14 days. */
function themesCard(digest) {
  const body = h("div", {});
  const themes = (digest && digest.themes) || [];
  body.append(h("p", { class: "grey small",
    text: `Last 14 days. ${digest.verdicts ?? 0} verdicts, ${digest.blocked ?? 0} blocked.` }));
  if (!themes.length) {
    body.append(h("p", { class: "empty", text: "No findings in this window. Nothing to promote." }));
    return panel("Recurring critic themes", body);
  }
  const recurring = themes.filter((theme) => (theme.count ?? 0) >= 2);
  const singles = themes.filter((theme) => (theme.count ?? 0) < 2);
  if (recurring.length) for (const theme of recurring) body.append(themeRow(theme));
  else body.append(h("p", { class: "empty", text: "Nothing has been said twice. A single finding is a letter to fix, not a rule to write." }));

  if (singles.length) {
    const hidden = h("div", { class: "singles", hidden: true });
    for (const theme of singles) hidden.append(themeRow(theme));
    const toggle = h("button", { type: "button", class: "btn",
      text: `Show ${plural(singles.length, "single finding")}`, "aria-expanded": "false" });
    toggle.addEventListener("click", () => {
      const open = hidden.hidden;
      hidden.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Hide the single findings" : `Show ${plural(singles.length, "single finding")}`;
    });
    body.append(toggle, hidden);
  }
  return panel("Recurring critic themes", body);
}

/** One standing rule, with the inline editor behind Edit and a guarded Remove. */
function standingRow(text, index) {
  const row = h("li", { class: "rule-row" });
  const label = h("p", { class: "rule-text" },
    h("span", { class: "rule-number", text: `${index + 1}` }),
    h("span", { text }));
  const note = h("p", { class: "grey small" });
  const buttons = h("div", { class: "action-buttons" });
  const edit = h("button", { type: "button", class: "btn", text: "Edit" });
  const remove = h("button", { type: "button", class: "btn danger", text: "Remove" });

  const editor = h("div", { class: "rule-editor", hidden: true });
  const area = h("textarea", { rows: "4", "aria-label": `Standing rule ${index + 1}` });
  area.value = text;
  const save = h("button", { type: "button", class: "btn primary", text: "Save" });
  const cancel = h("button", { type: "button", class: "btn", text: "Cancel" });
  editor.append(area, h("div", { class: "action-buttons" }, save, cancel));

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
  guarded(remove, "Remove", async () => {
    remove.disabled = true;
    clear(note);
    try {
      await api(`rules/standing/${index}/remove`, { method: "POST", body: {} });
      toast("Rule removed.");
      render();
    } catch (error) {
      remove.disabled = false;
      note.textContent = error.message;
    }
  }, "Remove");

  buttons.append(edit, remove);
  row.append(label, editor, buttons, note);
  return row;
}

/** Card two: the rules in force, each one editable in place. */
function standingCard(rules) {
  const body = h("div", {});
  const list = (rules && rules.standing_rules) || [];
  if (!rules.exists) {
    body.append(h("p", { class: "empty",
      text: `No rules file at ${rules.path}. Run the setup skill before editing the rules.` }));
    return panel("Standing rules", body);
  }
  body.append(h("p", { class: "grey small",
    text: `${plural(list.length, "rule")} in ${rules.path}. Each breach is a letter-critic fail.` }));
  if (!list.length) {
    body.append(h("p", { class: "empty", text: "No standing rules yet. Promote a recurring theme above, or write one by hand." }));
    return panel("Standing rules", body);
  }
  const ul = h("ol", { class: "rules" });
  list.forEach((text, index) => ul.append(standingRow(text, index)));
  body.append(ul);
  return panel("Standing rules", body);
}

/** Card three: the deterministic pre-checks, read only, and the CV bans with them. */
function neverNamedCard(rules) {
  const body = h("div", {});
  const patterns = rules.never_named || [];
  body.append(h("p", { class: "grey small",
    text: "A match on any line of a letter is a fail before the critic reads a word. Edit these in the file, not here." }));
  if (!patterns.length) {
    body.append(h("p", { class: "empty", text: "No never-named patterns. Nothing is blocked by name." }));
  } else {
    const ul = h("ul", { class: "patterns" });
    for (const entry of patterns) {
      ul.append(h("li", {},
        h("code", { class: "pattern", text: entry.pattern }),
        entry.issue ? h("p", { class: "grey small", text: entry.issue }) : null,
        entry.fix ? h("p", { class: "fix small", text: entry.fix }) : null));
    }
    body.append(ul);
  }

  const bans = rules.editorial_bans || { rules: [] };
  body.append(h("h3", { text: "Editorial bans" }));
  body.append(h("p", { class: "grey small",
    text: `The mechanical subset of the CV editorial rules, from ${bans.path}. A fail here stops a render.` }));
  const banned = bans.rules || [];
  if (!banned.length) {
    body.append(h("p", { class: "empty", text: "No editorial bans. Every CV rule is prose the writer has to read." }));
    return panel("Never named", body);
  }
  const ul = h("ul", { class: "patterns" });
  for (const ban of banned) {
    const meta = [ban.scope, ban.severity].filter(Boolean).join(", ");
    ul.append(h("li", {},
      h("p", { class: "ban-head" }, h("code", { class: "pattern", text: ban.id }),
        meta ? h("span", { class: "grey small", text: meta }) : null),
      ban.note ? h("p", { class: "grey small", text: ban.note }) : null,
      ban.title_must_equal ? h("p", { class: "fix small", text: `Title must read "${ban.title_must_equal}".` }) : null,
      ban.forbidden && ban.forbidden.length
        ? h("p", { class: "small", text: `Forbidden: ${ban.forbidden.join(", ")}` })
        : null));
  }
  body.append(ul);
  return panel("Never named", body);
}

export async function viewRules(view) {
  const count = h("p", { class: "page-count", text: "Loading the rules." });
  view.append(pageHeader({ title: "Rules", lede: count }));
  const host = h("div", { class: "cards" });
  host.append(h("p", { class: "empty", text: "Loading the rules." }));
  view.append(host);

  const rules = await fetchInto(host, "rules", "Could not load the editorial rules.");
  if (!rules) { count.textContent = ""; return; }
  let digest = { themes: [], verdicts: 0, blocked: 0 };
  try {
    digest = await api("critic/digest?since=14d");
  } catch (error) {
    // The rules are the point of this screen; a digest that will not build is
    // one card's worth of bad news, not a blank page.
    host.append(errorBox(error, "Could not load the critic digest.", null));
  }

  const rulesCount = (rules.standing_rules || []).length;
  const themeCount = (digest.themes || []).filter((theme) => (theme.count ?? 0) >= 2).length;
  count.textContent = `${plural(rulesCount, "standing rule")}, ${plural(themeCount, "recurring theme")} in the last 14 days.`;

  host.append(themesCard(digest), standingCard(rules), neverNamedCard(rules));
}
