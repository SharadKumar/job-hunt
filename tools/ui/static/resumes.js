/*
 * resumes.js - the CV screen: the rendered baselines, and the evidence
 * questions the keyword ledger is still holding about them.
 *
 * Two tabs, because they are two halves of one thing. A baseline is what the
 * pipeline produced; an evidence question is the ledger asking whether a term
 * the market wants is actually true of this person. Answering one changes what
 * the next render may say, so they belong on the same screen.
 *
 * AGENTS.md section 5: a production CV comes from resume-writer and the content
 * review comes from resume-critic, so there is no render button here. There is
 * an approve button, and it does exactly what `npm run resume:approve` does,
 * because it runs that tool: the critic gate is the tool's, it is not restated
 * here, and a refusal is shown in the tool's own words.
 */

import { api, clear, fetchInto, guarded, h, pageHeader, render, toast } from "./app.js";
import { viewKeywords } from "./keywords.js";

const TABS = [
  { key: "baselines", label: "Baselines", hash: "#/resumes" },
  { key: "evidence", label: "Evidence questions", hash: "#/resumes/evidence" },
];

function tabStrip(active) {
  const nav = h("nav", { class: "tabs", "aria-label": "Resumes" });
  for (const tab of TABS) {
    const link = h("a", { href: tab.hash, text: tab.label });
    if (tab.key === active) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
}

/** A page counts as low fill when the server says so; the caption says why. */
function pageThumb(page) {
  const img = h("img", { src: page.src, alt: "", loading: "lazy", class: "page-img" });
  const link = h("a", { class: page.low ? "page low" : "page", href: page.src, target: "_blank", rel: "noopener" }, img);
  const fill = typeof page.fill === "number" ? `fill ${Math.round(page.fill)}%` : "fill unknown";
  return h("figure", { class: "page-fig" }, link, h("figcaption", { class: page.low ? "bad" : "grey", text: fill }));
}

/** green for a pass, amber for a warn, red for a fail, grey for never run. */
function toneFor(verdict) {
  if (verdict === "pass") return "good";
  if (verdict === "warn" || verdict === "revise") return "warn";
  if (verdict === "fail" || verdict === "block") return "bad";
  return "";
}

/**
 * The gates as one sentence plus a fold.
 *
 * A row of unlabelled chips said "there are eleven gates" and nothing else: the
 * names were in a title attribute nobody hovers. The tally is what the person
 * actually wants at a glance, and the fold has the names and the verdicts.
 */
function gatesBlock(gates) {
  const box = h("div", { class: "gates" });
  if (!gates.length) {
    box.append(h("p", { class: "gates-line grey", text: "Gates: none on this render." }));
    return box;
  }
  const tally = { pass: 0, warn: 0, fail: 0 };
  for (const gate of gates) {
    const verdict = String(gate.verdict || "").toLowerCase();
    if (verdict === "pass") tally.pass += 1;
    else if (verdict === "fail" || verdict === "block") tally.fail += 1;
    else tally.warn += 1;
  }
  const tone = tally.fail ? "bad" : tally.warn ? "warn" : "good";
  const details = h("ul", { class: "gate-list", hidden: true });
  for (const gate of gates) {
    details.append(h("li", {},
      h("span", { class: "gate-name", text: String(gate.name || "gate").replace(/_/g, " ") }),
      h("span", { class: `gate-verdict ${toneFor(gate.verdict)}`, text: gate.verdict || "unknown" }),
      gate.reason ? h("span", { class: "grey small", text: gate.reason }) : null));
  }
  const toggle = h("button", { type: "button", class: "linky", text: "details", "aria-expanded": "false" });
  toggle.addEventListener("click", () => {
    const open = details.hidden;
    details.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.textContent = open ? "hide" : "details";
  });
  box.append(h("p", { class: `gates-line ${tone}` },
    h("span", { text: `Gates: ${tally.pass} pass, ${tally.warn} warn, ${tally.fail} fail` }), toggle), details);
  return box;
}

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/** "Critic pass, 0 findings, round 2" or "Critic blocked, 3 findings". */
function criticLine(critic) {
  if (!critic || !critic.verdict) return "Critic has not reviewed this render yet.";
  const verdict = critic.verdict === "block" ? "blocked" : critic.verdict;
  const parts = [`Critic ${verdict}`, plural(critic.findings_count ?? 0, "finding")];
  if (critic.round) parts.push(`round ${critic.round}`);
  return `${parts.join(", ")}.`;
}

/**
 * What the person may do about this render.
 *
 * A critic that asked for a revision is not a refusal to show: it is work, and
 * the work is the /resume-review skill, so the amber line names it. Approval
 * only appears when the critic passed and the baseline is not already approved,
 * and even then the button is armed before it posts.
 */
function criticBlock(item) {
  const critic = item.critic || {};
  const box = h("div", { class: "critic" });
  if (critic.verdict === "revise") {
    box.append(h("p", { class: "critic-line warn",
      text: `needs review: ${plural(critic.findings_count ?? 0, "finding")}` }));
    box.append(h("p", { class: "grey small", text: "run /resume-review" }));
    return box;
  }
  box.append(h("p", { class: toneFor(critic.verdict) ? `critic-line ${toneFor(critic.verdict)}` : "critic-line grey",
    text: criticLine(critic) }));
  const approved = (item.stamp || {}).kind === "approved";
  if (critic.verdict !== "pass" || approved) return box;

  const note = h("p", { class: "grey small" });
  const button = h("button", { type: "button", class: "btn primary approve", text: "Approve this render" });
  guarded(button, "Approve", async () => {
    button.disabled = true;
    clear(note);
    note.textContent = "Approving.";
    try {
      await api(`resumes/${encodeURIComponent(item.id)}/approve`, { method: "POST", body: {} });
      toast(`${item.label || item.id} approved.`);
      render();
    } catch (error) {
      button.disabled = false;
      clear(note);
      // The tool refuses in its own words (a stale or missing critic verdict is
      // the usual one); it is shown as it came back, never summarised into a
      // warning that reads like a pass.
      note.append(h("span", { class: "bad", text: error.message }));
    }
  }, "Approve this render");
  box.append(button, note);
  return box;
}

function coverageBar(label, counts) {
  const total = counts && counts.total ? counts.total : 0;
  const surfaced = counts && counts.surfaced ? counts.surfaced : 0;
  const pct = total ? Math.min(100, Math.round((surfaced / total) * 100)) : 0;
  return h("div", { class: "cover" },
    h("p", { class: "grey small", text: `${label} ${surfaced} of ${total}` }),
    h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" },
      h("span", { style: `width: ${pct}%` })));
}

function cloudLine(clouds) {
  const list = clouds || [];
  if (!list.length) return "No keyword clouds on this positioning.";
  const stale = list.filter((cloud) => cloud.stale).length;
  return `${plural(list.length, "cloud")}, ${stale} stale.`;
}

function fileButton(label, href) {
  if (!href) return h("span", { class: "btn disabled", text: label, "aria-disabled": "true" });
  return h("a", { class: "btn", href, target: "_blank", rel: "noopener", text: label });
}

/**
 * One positioning, as a card that fits beside another at 1280: the title, then
 * the stamp on its own line with the render date, then the pages on the left of
 * the body and every verdict on the right, and the files in a row.
 */
function resumeCard(item) {
  const card = h("article", { class: "card resume" });

  const stamp = item.stamp || { kind: "missing", text: "No render" };
  // The id is only worth printing when it is not already the label.
  const label = item.label || item.id;
  card.append(h("h2", {},
    h("span", { text: label }),
    label === item.id ? null : h("span", { class: "grey small", text: item.id })));
  card.append(h("p", { class: "resume-stamp" },
    h("span", { class: `stamp ${stamp.kind}`, text: stamp.text }),
    item.last_render_at
      ? h("span", { class: "grey small", text: `rendered ${String(item.last_render_at).slice(0, 10)}` })
      : h("span", { class: "grey small", text: "never rendered" })));
  if (item.positioning) card.append(h("p", { class: "resume-positioning grey small", text: item.positioning }));

  const body = h("div", { class: "resume-body" });
  const pages = item.pages || [];
  const left = h("div", { class: "pages" });
  // Four pages is every CV this pipeline renders; a fifth would only make the
  // card taller than the one beside it.
  if (pages.length) for (const page of pages.slice(0, 4)) left.append(pageThumb(page));
  else left.append(h("p", { class: "grey small", text: "No rendered pages on disk." }));
  body.append(left);

  const right = h("div", { class: "resume-facts" });
  right.append(gatesBlock(item.gates || []));
  right.append(criticBlock(item));
  const keywords = item.keywords || {};
  right.append(h("div", { class: "covers" },
    coverageBar("must-have", keywords.must_have),
    coverageBar("renderable", keywords.renderable)));
  right.append(h("p", { class: "grey small", text: cloudLine(item.clouds) }));
  body.append(right);
  card.append(body);

  const files = item.files || {};
  card.append(h("div", { class: "action-buttons resume-files" },
    fileButton("Open PDF", files.pdf),
    fileButton("Open DOCX", files.docx),
    fileButton("Markdown", files.md)));
  return card;
}

async function baselines(view, count) {
  const host = h("div", { class: "cards resume-grid" });
  host.append(h("p", { class: "empty", text: "Loading the positionings." }));
  view.append(host);
  const data = await fetchInto(host, "resumes", "Could not load the resumes.");
  if (!data) { count.textContent = ""; return; }
  const items = data.resumes || [];
  const approved = items.filter((item) => item.stamp && item.stamp.kind === "approved").length;
  count.textContent = `${plural(items.length, "positioning")}, ${approved} approved`;
  if (!items.length) {
    host.append(h("p", { class: "empty", text: "No positionings yet. Run /onboarding, then /resume-review." }));
    return;
  }
  for (const item of items) host.append(resumeCard(item));
  // AGENTS.md section 5 again, said on the screen itself so nobody goes looking
  // for a render button that must never be here.
  host.append(h("p", { class: "grey small",
    text: "Rendering runs through /resume-review with the person present. Approving here runs the same resume:approve gate, which refuses without a current critic verdict." }));
}

/**
 * Draw the screen. `which` is the tab from the address: "" is Baselines and
 * "evidence" is the keyword questions, which keep their own module and their
 * own session, and render under this screen's header rather than a second one.
 */
export async function viewResumes(view, which) {
  const active = which === "evidence" ? "evidence" : "baselines";
  const count = h("p", { class: "page-count", text: "Loading." });
  view.append(pageHeader({ title: "Resumes", lede: count, aside: tabStrip(active) }));
  if (active === "evidence") return viewKeywords(view, { lede: count });
  return baselines(view, count);
}
