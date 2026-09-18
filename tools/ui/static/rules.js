/*
 * rules.js - the Guardrails screen (#/guardrails): the editorial rules every
 * cover letter is checked against, what the critic keeps saying about them, and
 * the deterministic patterns that stop a client being named.
 *
 * Reading order is the order the person needs it in (the brief, section 4):
 * the rules in force first, because those are what a letter is judged against;
 * the recurring critic themes second, because those are the rules that are not
 * written yet; and the machine-readable patterns last, collapsed, because they
 * are reference and not work.
 *
 * AGENTS.md section 5: recurring findings become rules, and that promotion is
 * an attended decision. So this screen writes, but only here, only on a second
 * deliberate press, and only into `standing_rules` in the profile's own
 * letter-critic-rules.yaml. The `never_named` patterns and editorial-bans.yaml
 * are shown and never edited: they are regexes that stop a client being named,
 * and a regex typed into a browser is a way to quietly stop blocking something.
 */

import {
  api, clear, confirmButton, errorBox, fetchInto, guarded, h, pageHeader, placeholderRows, render, toast,
} from "./app.js";

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

const section = (title, body) => h("section", { class: "guard-section" }, h("h2", { text: title }), body);

// --- Standing rules ------------------------------------------------------

/**
 * One standing rule as a full-width row: the sentence at the reading measure,
 * Edit and Remove on its first line, and the editor opening in place under it.
 */
function standingRow(text, index) {
  const row = h("div", { class: "list-row rule-row" });
  const main = h("div", { class: "list-main" });
  const label = h("p", { class: "rule-text", text });
  main.append(label);
  row.append(main);

  const note = h("p", { class: "rule-note" });
  const editor = h("div", { class: "row-extra rule-editor", hidden: true });
  const area = h("textarea", { rows: "4", "aria-label": `Standing rule ${index + 1}` });
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
  row.append(h("div", { class: "list-action" }, edit, removal));

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

  row.append(editor, h("div", { class: "row-extra" }, note));
  return row;
}

function standingSection(rules) {
  const body = h("div", {});
  const list = (rules && rules.standing_rules) || [];
  if (!rules.exists) {
    body.append(h("p", { class: "empty",
      text: `No rules file at ${rules.path}. Run the setup skill before editing the rules.` }));
    return section("Standing rules", body);
  }
  if (!list.length) {
    body.append(h("p", { class: "empty",
      text: "No standing rules yet. Promote a recurring theme below, or write one into the rules file by hand." }));
    return section("Standing rules", body);
  }
  body.append(h("p", { class: "guard-lede", text: "Every letter is checked against these. A breach is a letter-critic fail." }));
  const host = h("div", { class: "list rules" });
  list.forEach((text, index) => host.append(standingRow(text, index)));
  body.append(host, h("p", { class: "grey small", text: `Held in ${rules.path}.` }));
  return section("Standing rules", body);
}

// --- Recurring critic themes ---------------------------------------------

/** One recurring theme: the name and its count, what the rule would say, the
 * finding that prompted it as a quotation, and the press that lands it. */
function themeRow(theme) {
  const row = h("div", { class: "list-row theme-row" });
  const main = h("div", { class: "list-main" });
  main.append(h("p", { class: "list-title", text: themeTitle(theme.key) }));
  const text = ruleTextOf(theme);
  if (text) main.append(h("p", { class: "list-reason", text }));
  if (theme.sample) main.append(h("blockquote", { class: "theme-sample", text: theme.sample }));
  row.append(main, h("span", { class: "list-score", text: String(theme.count ?? 0) }));

  if (!text) return row;
  const note = h("p", { class: "rule-note" });
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
  row.append(h("div", { class: "list-action" }, promote), h("div", { class: "row-extra" }, note));
  return row;
}

function themesSection(digest) {
  const body = h("div", {});
  const themes = (digest && digest.themes) || [];
  body.append(h("p", { class: "guard-lede",
    text: `Last 14 days: ${plural(digest.verdicts ?? 0, "verdict")}, ${digest.blocked ?? 0} blocked.` }));
  if (!themes.length) {
    body.append(h("p", { class: "empty", text: "No findings in this window. Nothing to promote." }));
    return section("Recurring critic themes", body);
  }
  const recurring = themes.filter((theme) => (theme.count ?? 0) >= 2);
  const singles = themes.filter((theme) => (theme.count ?? 0) < 2);
  if (recurring.length) {
    const host = h("div", { class: "list themes" });
    for (const theme of recurring) host.append(themeRow(theme));
    body.append(host);
  } else {
    body.append(h("p", { class: "empty",
      text: "Nothing has been said twice. A single finding is a letter to fix, not a rule to write." }));
  }

  if (singles.length) {
    const fold = h("details", { class: "disclosure" },
      h("summary", { text: `${plural(singles.length, "single finding")}` }));
    const host = h("div", { class: "list themes" });
    for (const theme of singles) host.append(themeRow(theme));
    fold.append(host);
    body.append(fold);
  }
  return section("Recurring critic themes", body);
}

// --- The reference section -----------------------------------------------

/** One never-named entry: what it is for, then the pattern, then the fix. */
function patternRow(entry) {
  return h("li", {},
    entry.issue ? h("p", { class: "ref-what", text: entry.issue }) : h("p", { class: "ref-what", text: "No description in the file." }),
    h("p", { class: "ref-pattern" }, h("code", { class: "pattern", text: entry.pattern })),
    entry.fix ? h("p", { class: "ref-fix", text: entry.fix }) : null);
}

/** One editorial ban, described the same way: words first, machinery after. */
function banRow(ban) {
  const what = [ban.note, ban.scope ? `Applies to ${ban.scope}.` : ""].filter(Boolean).join(" ");
  const machinery = [
    ban.forbidden && ban.forbidden.length ? ban.forbidden.join(", ") : "",
    ban.title_must_equal ? `title must read "${ban.title_must_equal}"` : "",
  ].filter(Boolean).join("; ");
  return h("li", {},
    h("p", { class: "ref-what", text: what || ban.id }),
    machinery ? h("p", { class: "ref-pattern" }, h("code", { class: "pattern", text: machinery })) : null,
    h("p", { class: "ref-fix", text: `${ban.id}, severity ${ban.severity}.` }));
}

/**
 * The machine-readable half, collapsed. Nothing in here is editable and
 * nothing in here is coloured: a fix line that looks like a link but is not is
 * the thing the brief, section 6, is fixing.
 */
function referenceSection(rules) {
  const body = h("div", {});
  const patterns = rules.never_named || [];
  const bans = rules.editorial_bans || { rules: [], path: "" };
  const banned = bans.rules || [];

  const fold = h("details", { class: "disclosure" },
    h("summary", { text: `Patterns and bans, ${patterns.length + banned.length} in force` }));
  fold.append(h("p", { class: "guard-lede",
    text: "A match on any line of a letter is a fail before the critic reads a word." }));
  if (patterns.length) {
    const list = h("ul", { class: "patterns" });
    for (const entry of patterns) list.append(patternRow(entry));
    fold.append(list);
  } else {
    fold.append(h("p", { class: "grey small", text: "No never-named patterns. Nothing is blocked by name." }));
  }
  fold.append(h("p", { class: "grey small", text: `Edit these in ${rules.path}, not here.` }));

  fold.append(h("h3", { text: "Editorial bans" }));
  fold.append(h("p", { class: "guard-lede", text: "The mechanical subset of the CV editorial rules. A fail here stops a render." }));
  if (banned.length) {
    const list = h("ul", { class: "patterns" });
    for (const ban of banned) list.append(banRow(ban));
    fold.append(list);
  } else {
    fold.append(h("p", { class: "grey small", text: "No editorial bans. Every CV rule is prose the writer has to read." }));
  }
  fold.append(h("p", { class: "grey small", text: `Edit these in ${bans.path}, not here.` }));

  body.append(fold);
  return section("Never named", body);
}

export async function viewRules(view) {
  const count = h("p", { class: "page-count" });
  view.append(pageHeader({ title: "Guardrails", lede: count }));
  const host = h("div", { class: "guardrails" });
  host.append(placeholderRows(3));
  view.append(host);

  const rules = await fetchInto(host, "rules", "Could not load the editorial rules.");
  if (!rules) { count.textContent = ""; return; }
  let digest = { themes: [], verdicts: 0, blocked: 0 };
  try {
    digest = await api("critic/digest?since=14d");
  } catch (error) {
    // The rules are the point of this screen; a digest that will not build is
    // one section's worth of bad news, not a blank page.
    host.append(errorBox(error, "Could not load the critic digest.", null));
  }

  const rulesCount = (rules.standing_rules || []).length;
  const themeCount = (digest.themes || []).filter((theme) => (theme.count ?? 0) >= 2).length;
  count.textContent = `${plural(rulesCount, "standing rule")}, ${plural(themeCount, "recurring theme")} in the last 14 days.`;

  host.append(standingSection(rules), themesSection(digest), referenceSection(rules));
}
