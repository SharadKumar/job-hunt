/* Guardrails workspace: rules, themes, references and the decision layer. */
import {
  api, clear, confirmButton, errorBox, fetchInto, guarded, h, pageHeader, parseHash, placeholderRows, render, toast,
} from "./app.js";
import { beforeAfterTable } from "./decision-comparison.js";
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
  return ["themes", "reference", "decision"].includes(which) ? which : "rules";
}
function tabStrip(active, counts = {}) {
  const tabs = h("nav", { class: "tabs guard-tabs", "aria-label": "Guardrail views" });
  for (const tab of [
    { key: "rules", label: "Rules", href: "#/guardrails" },
    { key: "themes", label: "Themes", href: "#/guardrails/themes" },
    { key: "reference", label: "Reference", href: "#/guardrails/reference" },
    { key: "decision", label: "Decision layer", href: "#/guardrails/decision" },
  ]) {
    const link = h("a", { href: tab.href, text: tab.label });
    if (Number.isFinite(counts[tab.key])) link.append(h("span", { class: "tally", text: String(counts[tab.key]) }));
    if (tab.key === active) link.setAttribute("aria-current", "page");
    tabs.append(link);
  }
  return tabs;
}

function decisionOverview(health, queue) {
  const jev = health.jev || {};
  const benchmark = jev.benchmark || {};
  const comparison = jev.comparison || {};
  const correction = jev.correction || {};
  const coverage = benchmark.coverage || {};
  const quality = benchmark.operational_quality || {};
  const delegatedQuality = benchmark.delegated_quality || {};
  const delegatedAdjudication = delegatedQuality.adjudication || {};
  const runtime = benchmark.runtime || {};
  const agentBaseline = comparison.forward_agent_comparator || {};
  const jevBaseline = comparison.jev_live_comparator || {};
  const classifierComparison = comparison.classifier_comparison || {};
  const targets = comparison.targets || {};
  const costReduction = Number(targets.classification_cost_reduction?.value);
  const runtimeRatio = Number(targets.runtime_guardrail?.value);
  const panel = selectedShell("Decision layer", `${jev.model || "Jev"}: live bounded classification`);
  const body = h("div", { class: "guard-selected-body" });
  const versionText = jev.model_version_observable
    ? `Resolved model ${jev.resolved_model_version}`
    : "Vercel currently exposes only the Jev route alias, so the underlying model version is not observable";
  const advisoryText = Array.isArray(jev.degradation_advisories) && jev.degradation_advisories.length
    ? ` ${jev.degradation_advisories.length} scoped advisory${jev.degradation_advisories.length === 1 ? "" : "ies"} recorded.`
    : "";
  body.append(
    h("p", { class: "guard-selected-lede", text: jev.degradation_reason || `${jev.state === "healthy" ? "Gateway healthy" : "Gateway not healthy"}; pipeline state application ${jev.classification_state_application_enabled ? "live" : "disabled"}; Jev unattended send authority disabled by design.${advisoryText} Mechanical facts, scoring and final send gates remain deterministic.` }),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Measured cohort" }),
      h("p", { text: `${benchmark.cohort?.measured ?? 0} rows: ${coverage.automatic ?? 0} automatic, ${coverage.uncertain ?? 0} uncertain, ${plural(quality.consequential_errors?.length ?? 0, "consequential error")}.` })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Before and after" }),
      h("p", { text: "Coverage compares the same frozen 115-role cohort. Safety indicators use the corrected production rule. Earlier calibration and error figures used a different basis, so the UI does not present them as like-for-like improvements." }),
      beforeAfterTable(correction, benchmark)),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Historical operational sample" }),
      h("p", { text: `Operational-proxy ECE ${quality.calibration_ece ?? "not measured"}; estimated cohort cost $${Number(runtime.estimated_cost_usd ?? 0).toFixed(4)}. This remains monitoring evidence, not send authority.` })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Measured benefit" }),
      h("p", { text: agentBaseline.measured
        ? `Normalised per role: ${Number.isFinite(costReduction) ? `${(costReduction * 100).toFixed(2)}% lower cost` : "cost reduction not measured"}; ${Number.isFinite(runtimeRatio) && runtimeRatio > 0 ? `${(1 / runtimeRatio).toFixed(1)}x faster` : "runtime comparison not measured"}. The agent comparator measured ${agentBaseline.measured} historical rows and the current Jev cohort measured ${jevBaseline.measured}.`
        : "The forward agent comparator has not been recorded." })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Classifier agreement" }),
      h("p", { text: classifierComparison.comparable_decisions
        ? `${classifierComparison.comparable_decisions} compared: ${(Number(classifierComparison.discipline_agreement) * 100).toFixed(1)}% discipline agreement and ${(Number(classifierComparison.matched_resume_agreement) * 100).toFixed(1)}% resume agreement. Delegated review, not either classifier, resolves disagreements.`
        : "No like-for-like classifier comparison is available." })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Historical label coverage" }),
      h("p", { text: queue
        ? `${queue.counts.frozen_primary_complete} of ${queue.counts.frozen_primary_required} frozen-cohort labels recorded; ${queue.counts.shadow_review_complete} of ${queue.counts.shadow_review_required} historical disagreements reviewed; ${queue.counts.independent_human_complete ?? 0} independently human-verified. No action is required. Labels remain available for regression monitoring and are bound to the exact role content and Jev decision.`
        : "The attended calibration queue could not be loaded." })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Delegated quality diagnostic" }),
      h("p", { text: delegatedAdjudication.complete_count != null
        ? `${delegatedAdjudication.complete_count} of ${delegatedAdjudication.required} frozen roles decided. Resume agreement ${delegatedQuality.matched_resume_exact_agreement == null ? "not measured" : `${(Number(delegatedQuality.matched_resume_exact_agreement) * 100).toFixed(1)}%`}; calibration ECE ${delegatedQuality.calibration_ece == null ? "not measured" : `${(Number(delegatedQuality.calibration_ece) * 100).toFixed(2)}%`}; monotonic ${delegatedQuality.calibration_monotonic == null ? "not measured" : delegatedQuality.calibration_monotonic ? "yes" : "no"}.`
        : "Delegated quality has not been measured." })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Production boundary" }),
      h("p", { text: "Jev may classify and prioritise roles. An uncertain decision cannot enter or remain in an active queue. A narrow agent-verification parachute checks high-scoring adjacent or platform-gap near misses, not every rejection. Jev can never authorise an unattended send; a supported agent verification is required for that path." })),
    h("section", { class: "guard-detail-section" }, h("p", { class: "eyebrow", text: "Gateway route identity" }),
      h("code", { class: "pattern", text: jev.gateway_route_fingerprint || "No Gateway route identity pinned." }),
      h("p", { text: `${versionText}. This route identity does not prove an underlying model version.` })),
  );
  panel.append(body);
  return panel;
}

function selectField(id, label, values, selected, help, disabled) {
  const select = h("select", { id, disabled });
  select.append(h("option", { value: "", text: "Choose a label" }));
  for (const entry of values) {
    const value = typeof entry === "string" ? entry : entry.value;
    const text = typeof entry === "string" ? entry : entry.text;
    select.append(h("option", { value, selected: selected === value, text }));
  }
  const field = h("label", { class: "field jev-label-field", for: id },
    h("span", { class: "field-label", text: label }), select);
  if (help) field.append(h("span", { class: "field-help", text: help }));
  return { field, select };
}

function probabilityText(values) {
  if (!values) return "No distribution recorded.";
  return Object.entries(values)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([key, value]) => `${key}: ${(Number(value) * 100).toFixed(1)}%`)
    .join("; ");
}

function decisionDetail(item, queue) {
  const actions = h("div", { class: "guard-head-actions" });
  const panel = selectedShell(`Priority ${item.priority}`, item.title, actions);
  const body = h("div", { class: "guard-selected-body" });
  const note = h("p", { class: "rule-note" });
  const saved = item.human_label || {};
  const delegatedDecision = item.delegated_decision === true;
  const discipline = selectField(`jev-discipline-${item.id}`, "Discipline fit", [
    { value: "core", text: "Core" },
    { value: "platform_gap", text: "Platform gap" },
    { value: "adjacent", text: "Adjacent" },
    { value: "outside", text: "Outside" },
    { value: "insufficient_evidence", text: "Insufficient evidence" },
  ], saved.discipline_fit || "", item.required.discipline_fit ? "Required for the frozen calibration cohort." : "Optional monitoring review.", item.stale);
  const resumeOptions = [
    ...(queue.active_resumes || []).map((resume) => ({ value: resume.id, text: resume.label || resume.id })),
    { value: "none", text: "No credible active resume" },
    { value: "insufficient_evidence", text: "Insufficient evidence" },
  ];
  const resume = selectField(`jev-resume-${item.id}`, "Best resume positioning", resumeOptions,
    saved.matched_resume_id || "", item.required.matched_resume_id ? "Required for the frozen calibration cohort." : "Optional monitoring review.", item.stale);
  const apply = selectField(`jev-apply-${item.id}`, "Apply worthy", [
    { value: "yes", text: "Yes" },
    { value: "no", text: "No" },
    { value: "insufficient_evidence", text: "Insufficient evidence" },
  ], saved.apply_worthy || "", "Judge the role, not whether either classifier agrees.", item.stale);
  const notes = h("textarea", { id: `jev-notes-${item.id}`, rows: "4", disabled: item.stale, "aria-label": "Adjudication notes" });
  notes.value = saved.notes || "";
  const pending = queue.items.filter((candidate) => !candidate.complete && !candidate.stale);
  const pendingIndex = pending.findIndex((candidate) => candidate.id === item.id);
  const nextPending = pendingIndex >= 0
    ? pending[pendingIndex + 1] || pending.find((candidate) => candidate.id !== item.id) || null
    : null;
  const save = h("button", {
    type: "button", class: "btn btn-primary",
    text: item.complete ? "Update decision" : nextPending ? "Save and next" : "Save decision",
    disabled: item.stale,
  });
  save.addEventListener("click", async () => {
    clear(note);
    const missing = [];
    if (item.required.discipline_fit && !discipline.select.value) missing.push("discipline fit");
    if (item.required.matched_resume_id && !resume.select.value) missing.push("resume positioning");
    if (item.required.apply_worthy && !apply.select.value) missing.push("apply worthy");
    if (missing.length) { note.textContent = `Choose ${missing.join(", ")} before saving.`; return; }
    save.disabled = true;
    try {
      await api("jev/adjudications/record", { method: "POST", body: {
        role_id: item.id,
        content_hash: item.content_hash,
        jev_decision_id: item.jev?.decision_id,
        discipline_fit: discipline.select.value || null,
        matched_resume_id: resume.select.value || null,
        apply_worthy: apply.select.value || null,
        notes: notes.value.trim() || null,
      } });
      toast("Calibration label saved.");
      if (!item.complete && nextPending) window.location.hash = selectionHref("decision", nextPending.id);
      else if (!item.complete) window.location.hash = selectionHref("decision", "overview");
      else render();
    } catch (error) {
      save.disabled = false;
      note.textContent = error.message;
    }
  });
  actions.append(save);
  body.append(
    h("p", { class: "guard-selected-lede", text: `${item.company}${item.location ? `, ${item.location}` : ""}. Pipeline status ${item.pipeline_status}. ${item.sources.join(", ").replaceAll("_", " ")}.` }),
  );
  if (item.stale) body.append(h("p", { class: "field-error", text: item.stale_reason || "This review item is stale." }));
  if (delegatedDecision) body.append(h("p", { class: "guard-selected-lede", text: "I made this decision on your behalf because the evidence was clear. It is final unless you want to change it, but it does not count as independent human validation." }));
  body.append(
    h("section", { class: "guard-detail-section" },
      h("p", { class: "eyebrow", text: "Classifier comparison" }),
      h("div", { class: "jev-compare" },
        h("div", {}, h("strong", { text: "Generic agent" }),
          h("p", { text: item.generic_agent ? `Discipline ${item.generic_agent.discipline_fit}; resume ${item.generic_agent.matched_resume_id || "none"}; relevance ${item.generic_agent.profile_relevance}.` : "No comparator decision." }),
          item.generic_agent?.reason ? h("p", { class: "field-help", text: item.generic_agent.reason }) : null),
        h("div", {}, h("strong", { text: "Jev" }),
          h("p", { text: item.jev ? `Discipline ${item.jev.discipline_fit}; resume ${item.jev.matched_resume_id || "none"}; relevance ${item.jev.profile_relevance}; ${item.jev.status}.` : "No current Jev decision." }),
          h("p", { class: "field-help", text: item.jev ? probabilityText(item.jev.discipline_distribution) : "" }),
          h("p", { class: "field-help", text: item.jev ? probabilityText(item.jev.resume_distribution) : "" })))),
    h("section", { class: "guard-detail-section" },
      h("p", { class: "eyebrow", text: delegatedDecision ? "Delegated decision" : "Human label" }),
      h("div", { class: "jev-label-grid" }, discipline.field, resume.field, apply.field),
      h("label", { class: "field jev-notes-field", for: notes.id }, h("span", { class: "field-label", text: "Notes" }), notes),
      note),
    h("details", { class: "guard-detail-section jev-description" },
      h("summary", { text: "Full job description" }),
      h("pre", { text: item.description || "No job description recorded." })),
    h("p", { class: "guard-source", text: "This records calibration evidence only. It does not alter the role, score, pipeline status, application package or send authority." }),
  );
  panel.append(body);
  return panel;
}

function decisionWorkspace(health, queue, selectedKey) {
  if (!queue || !queue.items) return h("div", { class: "guard-workbench guard-decision-workbench" }, decisionOverview(health, null));
  const active = queue.items.filter((item) => !item.stale), pending = active.filter((item) => !item.complete);
  const selected = selectedKey === "overview"
    ? null
    : active.find((item) => item.id === selectedKey) || pending[0] || active[0] || null;
  const items = [browserItem({
    active: "decision", key: "overview", selected: !selected,
    eyebrow: "Evidence", title: "Measurement overview",
    preview: `${queue.counts.frozen_primary_required} historical labels available; ${queue.counts.frozen_primary_complete} recorded`,
  }), ...active.map((item) => browserItem({
    active: "decision", key: item.id, selected: selected?.id === item.id,
    eyebrow: item.delegated_decision ? "Delegated" : item.complete ? "Labelled" : item.stale ? "Stale" : `Priority ${item.priority}`,
    title: item.title,
    preview: `${item.company}; ${item.sources.join(", ").replaceAll("_", " ")}`,
  }))];
  return h("div", { class: "guard-workbench" },
    browserShell("Active monitoring", active.length, items),
    selected ? decisionDetail(selected, queue) : decisionOverview(health, queue));
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
    eyebrow: "In force", title: `Standing rule ${at + 1}`, preview: text,
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
  const panel = selectedShell("Recurring theme", themeTitle(theme.key), actions);
  const body = h("div", { class: "guard-selected-body" },
    h("p", { class: "guard-selected-lede", text: `${plural(theme.count ?? 0, "active blocked package")} share this finding. Historical verdicts remain in the audit archive.` }));
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
      h("section", { class: "guard-selected" }, h("p", { class: "empty", text: "No recurring findings among active blocked packages. Individual findings stay with their application package." })));
  }
  const selected = themes.find((theme) => `theme-${theme.key}` === selectedKey) || themes[0];
  const items = themes.map((theme) => browserItem({
    active: "themes", key: `theme-${theme.key}`, selected: theme === selected,
    eyebrow: "Recurring",
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
  const tabs = tabStrip(active);
  view.append(pageHeader({ title: "Guardrails", lede: count, aside: tabs }));
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

  const tabCounts = { rules: (rules.standing_rules || []).length,
    themes: digestError ? undefined : (digest.themes || []).length,
    reference: referenceEntries(rules).length,
    decision: undefined,
  };
  clear(tabs);
  for (const tab of [...tabStrip(active, tabCounts).children]) tabs.append(tab);

  const selected = (query instanceof URLSearchParams ? query : new URLSearchParams()).get("selected") || "";
  if (active === "decision") {
    const [health, queue] = await Promise.all([api("health"), api("jev/adjudications")]);
    count.textContent = queue.counts.pending
      ? `${queue.counts.pending} active monitoring review${queue.counts.pending === 1 ? "" : "s"}. Nothing here changes application state.`
      : `No active monitoring reviews. ${queue.counts.stale} superseded labels remain in the audit evidence, not in this queue.`;
    const decisionTab = tabs.querySelector('a[href="#/guardrails/decision"] .tally');
    if (decisionTab) decisionTab.textContent = String(queue.counts.pending);
    host.append(decisionWorkspace(health, queue, selected));
  } else if (active === "themes") {
    count.textContent = `${plural((digest.themes || []).length, "active recurring theme")}, ${plural(digest.blocked ?? 0, "active blocked package")}.`;
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
