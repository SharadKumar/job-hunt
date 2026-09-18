/*
 * resumes.js - the CV screen: the rendered baselines, and the evidence
 * questions the keyword ledger is still holding about them.
 *
 * Two tabs, because they are two halves of one thing. A baseline is what the
 * pipeline produced; an evidence question is the ledger asking whether a term
 * the market wants is actually true of this person. Answering one changes what
 * the next render may say, so they belong on the same screen.
 *
 * Baselines use the same selection pattern as Pipeline, with one extra level:
 * the positioning list, the selected baseline, and its quality evidence. This
 * keeps comparison, action and assurance visible without repeating six large
 * cards down the page.
 *
 * AGENTS.md section 5: a production CV comes from resume-writer and the content
 * review comes from resume-critic, so there is no render button here. There is
 * an approve button, and it does exactly what `npm run resume:approve` does,
 * because it runs that tool: the critic gate is the tool's, and a refusal is
 * shown in the tool's own words rather than narrated into a pass.
 */

import {
  api, ApiError, askForToken, clear, confirmButton, fetchInto, h, isUnauthorised, pageHeader, placeholderRows,
  readToken, render, toast, when, whenFull,
} from "./app.js";
import { viewKeywords } from "./keywords.js";

const TABS = [
  { key: "baselines", label: "Baselines", hash: "#/resumes" },
  { key: "evidence", label: "Evidence questions", hash: "#/resumes/evidence" },
];

/**
 * The one sentence about the approval gate. AGENTS.md section 5 and the brief,
 * section 6: it belongs in the empty state and on the approve confirmation,
 * and nowhere else. A grey paragraph under every card said it to people who
 * were not approving anything.
 */
const APPROVE_GATE = "Approving runs resume:approve, which refuses without a current critic verdict.";

function tabStrip(active) {
  const nav = h("nav", { class: "tabs", "aria-label": "Resumes" });
  for (const tab of TABS) {
    const link = h("a", { href: tab.hash, text: tab.label });
    if (tab.key === active) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
}

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

// --- Tokened artefacts ---------------------------------------------------

/*
 * The token strategy, one way for all four kinds of artefact (PDF, DOCX,
 * Markdown and a page image): the browser fetches the file route with the same
 * bearer header every other API call carries, and opens the bytes as an object
 * url. The token is never put in a query string, where it would land in the
 * server log and in the address bar, and an `<img src>` or a bare `href` is
 * never used, because neither can carry a header and both 401 the moment
 * HARNESS_UI_TOKEN is set.
 *
 * The tab is opened synchronously inside the click, before the await, so a
 * popup blocker sees a user gesture and lets it through; the fetched url is
 * put into it afterwards. It is opened without `noopener`, because that
 * feature makes `window.open` return null and the artefact would then replace
 * the app in the tab the person was reading.
 */
const opened = new Map();

async function artefactUrl(url) {
  const held = opened.get(url);
  if (held) return held;
  const headers = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new ApiError(0, "Could not reach the harness. Is the UI server still running?");
  }
  if (!response.ok) {
    let detail = `the server refused the file (${response.status})`;
    try { detail = (JSON.parse(await response.text()) || {}).error || detail; } catch { /* not JSON */ }
    throw new ApiError(response.status, detail);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  opened.set(url, objectUrl);
  return objectUrl;
}

/** Wire any element so a press opens the artefact behind `url` in a new tab. */
function opensFile(node, url, note) {
  node.addEventListener("click", async (event) => {
    event.preventDefault();
    const tab = window.open("", "_blank");
    try {
      const objectUrl = await artefactUrl(url);
      if (tab) tab.location = objectUrl;
      else window.location.assign(objectUrl);
    } catch (error) {
      if (tab) tab.close();
      if (isUnauthorised(error)) { askForToken(); return; }
      if (note) note.textContent = error.message;
      else toast(error.message, "bad");
    }
  });
  return node;
}

/** Quiet file access below the inline preview. */
function fileLink(label, url, note) {
  if (!url) return h("span", { class: "resume-file-link disabled", text: label, "aria-disabled": "true" });
  return opensFile(h("a", {
    class: "resume-file-link",
    href: url,
    rel: "noopener",
    target: "_blank",
  }, label), url, note);
}

// --- Page fill -----------------------------------------------------------

/**
 * The page fills as one horizontal row of short bars: the percentage in ink
 * above each bar, the page number under it, and a page under the render's own
 * floor labelled in `--warn`.
 *
 * Never red. A page at 88 percent against a 90 percent floor is a page worth
 * looking at, not a failed render, and the tall red bars this replaced read as
 * the second thing (the brief, section 6, Resumes cards).
 */
function pageFill(page, href, selected) {
  const pct = typeof page.fill === "number" ? Math.max(0, Math.min(100, Math.round(page.fill))) : null;
  const floor = typeof page.threshold === "number" ? Math.round(page.threshold) : null;
  const figure = h("figure", { class: page.low ? "fill low" : "fill" });
  figure.append(h("p", { class: "fill-pct", text: pct === null ? "not measured" : `${pct}%` }));
  figure.append(h("div", {
    class: "bar",
    role: "img",
    "aria-label": pct === null ? `Page ${page.page}, fill not measured` : `Page ${page.page}, ${pct} percent filled`,
  }, h("span", { style: `width: ${pct === null ? 0 : pct}%` })));
  const caption = h("figcaption", {});
  caption.append(h("a", { class: selected ? "fill-page selected" : "fill-page", href, text: `Page ${page.page}` }));
  if (page.low && floor !== null) caption.append(h("span", { class: "fill-low", text: `under ${floor}%` }));
  figure.append(caption);
  return figure;
}

// --- Gates, critic, keywords ---------------------------------------------

const verdictOf = (gate) => String(gate.verdict || "").toLowerCase();
const isFail = (gate) => verdictOf(gate) === "fail" || verdictOf(gate) === "block";
const isPass = (gate) => verdictOf(gate) === "pass";

/** The pill class a recorded verdict takes. A verdict is quoted, never invented. */
function gatePill(gate) {
  const verdict = verdictOf(gate) || "not run";
  const tone = isPass(gate) ? "pill-pass" : isFail(gate) ? "pill-fail" : verdict === "not run" ? "pill-none" : "pill-warn";
  return h("span", { class: `pill ${tone}`, text: verdict });
}

/**
 * "Gates: 6 pass, 2 warn", with everything that is not a pass folded under it.
 * The clause for a count of zero is dropped rather than printed: "0 fail" is a
 * number nobody needed.
 */
function gatesBlock(gates) {
  const box = h("div", { class: "gates" });
  if (!gates.length) {
    box.append(h("p", { class: "verdict-line", text: "Gates: none recorded on this render." }));
    return box;
  }
  const pass = gates.filter(isPass);
  const fail = gates.filter(isFail);
  const warn = gates.filter((gate) => !isPass(gate) && !isFail(gate));
  const parts = [`${pass.length} pass`];
  if (warn.length) parts.push(`${warn.length} warn`);
  if (fail.length) parts.push(`${fail.length} fail`);
  box.append(h("p", { class: "verdict-line", text: `Gates: ${parts.join(", ")}` }));

  const open = [...fail, ...warn];
  if (!open.length) return box;
  const said = [fail.length ? plural(fail.length, "failure") : "", warn.length ? plural(warn.length, "warning") : ""]
    .filter(Boolean).join(" and ");
  const fold = h("details", { class: "disclosure" }, h("summary", { text: said }));
  const list = h("ul", { class: "verdict-list" });
  for (const gate of open) {
    list.append(h("li", {},
      h("span", { class: "verdict-name", text: String(gate.name || "gate").replace(/_/g, " ") }),
      gatePill(gate),
      gate.reason ? h("p", { class: "verdict-why", text: gate.reason }) : null));
  }
  fold.append(list);
  box.append(fold);
  return box;
}

/**
 * The critic line. A count of open findings is the useful reading, and the
 * count is the summary of the fold that holds them, so the number the person
 * reads is the thing they open.
 */
function criticBlock(critic) {
  const box = h("div", { class: "critic" });
  const verdict = critic && critic.verdict ? String(critic.verdict) : "";
  if (!verdict) {
    box.append(h("p", { class: "verdict-line", text: "Critic has not reviewed this render." }));
    return box;
  }
  const said = verdict === "block" ? "blocked" : verdict;
  const round = critic.round ? `, round ${critic.round}` : "";
  const findings = Array.isArray(critic.findings) ? critic.findings : [];
  const total = typeof critic.findings_count === "number" ? critic.findings_count : findings.length;
  box.append(h("p", { class: "verdict-line", text: `Critic ${said}${round}` }));
  if (!total) {
    box.append(h("p", { class: "verdict-why", text: "Nothing left to review." }));
    return box;
  }
  const fold = h("details", { class: "disclosure" },
    h("summary", { text: `${plural(total, "finding")} to review` }));
  if (findings.length) {
    const list = h("ul", { class: "verdict-list" });
    for (const finding of findings) list.append(h("li", {}, h("p", { class: "verdict-why", text: finding })));
    fold.append(list);
  } else {
    fold.append(h("p", { class: "verdict-why", text: "The critic file records the count but not the findings." }));
  }
  box.append(fold);
  return box;
}

/** One coverage bar: the label, the bar and the fraction all on one line. */
function coverageBar(label, counts) {
  const total = counts && counts.total ? counts.total : 0;
  const surfaced = counts && counts.surfaced ? counts.surfaced : 0;
  const pct = total ? Math.min(100, Math.round((surfaced / total) * 100)) : 0;
  return h("p", { class: "cover" },
    h("span", { class: "cover-label", text: label }),
    h("span", {
      class: "bar", role: "progressbar", "aria-label": label,
      "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100",
    }, h("span", { style: `width: ${pct}%` })),
    h("span", { class: "cover-count", text: `${surfaced} of ${total}` }));
}

/** "Keyword clouds: 12 current", and the stale count only when there is one. */
function cloudLine(clouds) {
  const list = clouds || [];
  if (!list.length) return "Keyword clouds: none on this positioning.";
  const stale = list.filter((cloud) => cloud.stale).length;
  return `Keyword clouds: ${list.length} current${stale ? `, ${stale} stale` : ""}`;
}

// --- Three-level baseline workbench -------------------------------------

/** The stamp, with its date said the way every other date in the UI is said. */
function stampFor(item) {
  const stamp = item.stamp || { kind: "missing", text: "No render" };
  if (stamp.kind === "approved" && item.approved_at) {
    return h("span", { class: "stamp approved", title: whenFull(item.approved_at), text: `Approved ${when(item.approved_at)}` });
  }
  return h("span", { class: `stamp ${stamp.kind}`, text: stamp.text });
}

/**
 * Approve, behind the server's own gate. One arming press, then the post; the
 * sentence about the critic verdict appears on the armed state, which is the
 * moment it is worth reading.
 */
function approveControl(item) {
  const note = h("p", { class: "approve-note" });
  const box = confirmButton("Approve", "Confirm approve", async () => {
    const button = box.button;
    button.disabled = true;
    note.textContent = "Approving.";
    try {
      await api(`resumes/${encodeURIComponent(item.id)}/approve`, { method: "POST", body: {} });
      toast(`${item.label || item.id} approved.`);
      render();
    } catch (error) {
      button.disabled = false;
      clear(note);
      // The tool refuses in its own words. AGENTS.md section 3.8: a red exit
      // is never narrated into a green line.
      note.append(h("span", { class: "approve-refusal", text: error.message }));
    }
  }, { class: "btn btn-primary" });
  box.button.addEventListener("click", () => {
    note.textContent = box.button.classList.contains("armed") ? APPROVE_GATE : "";
  });
  return h("div", { class: "approve" }, box, note);
}

function selectionHref(query, id) {
  const q = new URLSearchParams(query);
  q.set("selected", id);
  q.delete("page");
  return `#/resumes?${q.toString()}`;
}

function inspectorHref(query, id, panel, page) {
  const q = new URLSearchParams(query);
  q.set("selected", id);
  if (panel === "quality") q.set("panel", "quality");
  else q.delete("panel");
  if (page) q.set("page", String(page));
  else q.delete("page");
  return `#/resumes?${q.toString()}`;
}

function openQualityCount(item) {
  return (item.gates || []).filter((gate) => !isPass(gate)).length;
}

function resumeBrowserItem(item, selected, query) {
  const label = item.label || item.id;
  const link = h("a", {
    class: `resume-browser-item${selected ? " selected" : ""}`,
    href: selectionHref(query, item.id),
  });
  if (selected) link.setAttribute("aria-current", "true");
  const findings = (item.critic || {}).findings_count || 0;
  link.append(
    h("div", { class: "resume-browser-title" }, h("strong", { text: label }), stampFor(item)),
    h("p", { class: "resume-browser-positioning", text: item.positioning || "No positioning recorded" }),
    h("p", { class: "resume-browser-quality", text: `${plural(openQualityCount(item), "open gate")}, ${plural(findings, "critic finding")}` }),
  );
  return link;
}

function resumeOverview(item, query) {
  const panel = h("section", { class: "resume-overview", "aria-label": "Selected resume" });
  const label = item.label || item.id;
  const head = h("header", { class: "resume-overview-head" });
  const title = h("div", {}, h("p", { class: "eyebrow", text: "Selected baseline" }), h("h2", { text: label }));
  const actions = h("div", { class: "resume-head-actions" }, stampFor(item));
  const approved = (item.stamp || {}).kind === "approved";
  const criticPassed = ((item.critic || {}).verdict || "") === "pass";
  if (criticPassed && !approved) actions.append(approveControl(item));
  head.append(title, actions);
  panel.append(head);

  const meta = [
    item.positioning || "",
    item.last_render_at ? `rendered ${when(item.last_render_at)}` : "never rendered",
  ].filter(Boolean).join(", ");
  panel.append(h("p", { class: "resume-meta", title: whenFull(item.last_render_at), text: meta }));

  const pages = item.pages || [];
  panel.append(h("div", { class: "resume-section-head" },
    h("p", { class: "eyebrow", text: "Page fill" }),
    h("p", { class: "resume-section-note", text: `${plural(pages.length, "rendered page")}` })));
  if (pages.length) {
    const fills = h("div", { class: "fills" });
    const shown = Number(query.get("page")) || pages[0].page;
    for (const page of pages.slice(0, 4)) fills.append(pageFill(
      page, inspectorHref(query, item.id, "preview", page.page), page.page === shown,
    ));
    panel.append(fills);
  } else {
    panel.append(h("p", { class: "verdict-why", text: "No rendered pages on disk." }));
  }

  const keywords = item.keywords || {};
  panel.append(h("div", { class: "resume-section-head" }, h("p", { class: "eyebrow", text: "Market coverage" })));
  panel.append(h("div", { class: "covers" },
    coverageBar("Must have", keywords.must_have),
    coverageBar("Renderable", keywords.renderable)));

  return panel;
}

function cloudsBlock(clouds) {
  const list = clouds || [];
  const box = h("section", { class: "resume-quality-section" },
    h("p", { class: "eyebrow", text: "Keyword clouds" }),
    h("p", { class: "verdict-line", text: cloudLine(list) }));
  if (!list.length) return box;
  const rows = h("ul", { class: "cloud-list" });
  for (const cloud of list) rows.append(h("li", {},
    h("span", { text: cloud.label || cloud.id }),
    h("span", { class: cloud.stale ? "cloud-age stale" : "cloud-age", text: cloud.stale ? "stale" : `weight ${cloud.weight || 0}` })));
  box.append(rows);
  return box;
}

function resumeQuality(item) {
  const panel = h("div", { class: "resume-quality", "aria-label": "Resume quality" });
  panel.append(
    h("header", { class: "resume-quality-head" },
      h("p", { class: "eyebrow", text: "Quality evidence" }),
      h("h2", { text: "Gates and review" }),
      h("p", { text: "Recorded evidence for this exact render." })),
    h("section", { class: "resume-quality-section" }, h("p", { class: "eyebrow", text: "Deterministic gates" }), gatesBlock(item.gates || [])),
    h("section", { class: "resume-quality-section" }, h("p", { class: "eyebrow", text: "Independent critic" }), criticBlock(item.critic || {})),
    cloudsBlock(item.clouds),
  );
  return panel;
}

async function resumePreview(item, query) {
  const pages = item.pages || [];
  const wanted = Number(query.get("page"));
  const page = pages.find((entry) => entry.page === wanted) || pages[0];
  const panel = h("section", { class: "resume-preview", "aria-label": "Resume preview" });
  if (!page) {
    panel.append(h("p", { class: "empty", text: "No rendered pages are available for this baseline." }));
    return panel;
  }
  const tabs = h("nav", { class: "tabs resume-page-tabs", "aria-label": "Rendered pages" });
  for (const entry of pages) {
    const link = h("a", { href: inspectorHref(query, item.id, "preview", entry.page), text: `Page ${entry.page}` });
    if (entry.page === page.page) link.setAttribute("aria-current", "page");
    tabs.append(link);
  }
  const note = h("p", { class: "file-note", text: "Loading rendered page." });
  const image = h("img", { class: "resume-preview-image", alt: `${item.label || item.id}, page ${page.page}` });
  try {
    image.src = await artefactUrl(page.src);
    note.textContent = "";
  } catch (error) {
    if (isUnauthorised(error)) askForToken();
    note.textContent = error.message;
  }
  const files = item.files || {};
  panel.append(tabs, h("div", { class: "resume-page" }, image),
    h("nav", { class: "resume-files", "aria-label": "Resume files" },
      fileLink("PDF", files.pdf, note), fileLink("DOCX", files.docx, note), fileLink("Markdown", files.md, note)), note);
  return panel;
}

async function resumeInspector(item, query) {
  const active = query.get("panel") === "quality" ? "quality" : "preview";
  const panel = h("aside", { class: "resume-inspector", "aria-label": "Resume inspector" });
  const tabs = h("nav", { class: "tabs resume-inspector-tabs", "aria-label": "Resume inspector tabs" });
  for (const tab of [{ key: "preview", label: "Resume" }, { key: "quality", label: "Quality" }]) {
    const link = h("a", { href: inspectorHref(query, item.id, tab.key), text: tab.label });
    if (tab.key === active) link.setAttribute("aria-current", "page");
    tabs.append(link);
  }
  panel.append(tabs, active === "quality" ? resumeQuality(item) : await resumePreview(item, query));
  return panel;
}

async function baselines(view, count, query) {
  const host = h("div", {});
  host.append(placeholderRows(3));
  view.append(host);
  const data = await fetchInto(host, "resumes", "Could not load the resumes.");
  if (!data) { count.textContent = ""; return; }
  const items = data.resumes || [];
  const approved = items.filter((item) => item.stamp && item.stamp.kind === "approved").length;
  count.textContent = `${plural(items.length, "positioning")}, ${approved} approved`;
  if (!items.length) {
    host.append(h("p", { class: "empty", text: `No positionings yet. Run /onboarding, then /resume-review. ${APPROVE_GATE}` }));
    return;
  }
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const selected = items.find((item) => item.id === params.get("selected")) || items[0];
  const browser = h("section", { class: "resume-browser", "aria-label": "Resume positionings" },
    h("header", { class: "resume-browser-head" }, h("p", { class: "eyebrow", text: "Positionings" }), h("h2", { text: "Baselines" })),
    h("nav", { class: "resume-browser-list" }));
  const list = browser.querySelector(".resume-browser-list");
  for (const item of items) list.append(resumeBrowserItem(item, item.id === selected.id, params));
  host.append(h("div", { class: "resume-workbench" }, browser, resumeOverview(selected, params), await resumeInspector(selected, params)));
}

/**
 * Draw the screen. `which` is the tab from the address: "" is Baselines and
 * "evidence" is the keyword questions, which keep their own module and render
 * under this screen's header rather than a second one.
 */
export async function viewResumes(view, which, query) {
  const active = which === "evidence" ? "evidence" : "baselines";
  const count = h("p", { class: "page-count" });
  view.append(pageHeader({ title: "Resumes", lede: count, aside: tabStrip(active) }));
  if (active === "evidence") return viewKeywords(view, { lede: count });
  return baselines(view, count, query);
}
