/*
 * resumes.js - the Resumes screen, one module so app.js stays readable.
 *
 * It shows what the CV pipeline has already decided and nothing else. AGENTS.md
 * section 5: a production CV comes from resume-writer, the content review comes
 * from resume-critic, and an approval comes from `npm run resume:approve` with
 * the person present. So there is no render button here and no approve button
 * here, only the state of each positioning and a way to open the files.
 *
 * app.js passes its own DOM helpers in rather than this module importing them,
 * which keeps the two files free of a circular import.
 */

/** A page counts as low fill when the server says so; the caption says why. */
function pageThumb(page, h) {
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

function gateChip(gate, h) {
  const tone = toneFor(gate.verdict);
  return h("span", { class: tone ? `chip ${tone}` : "chip", title: gate.reason || gate.verdict },
    h("span", { class: "dot" }), h("span", { text: gate.name.replace(/_/g, " ") }));
}

/** "Critic pass, 0 findings, round 2" or "Critic blocked, 3 findings". */
function criticLine(critic) {
  if (!critic || !critic.verdict) return "Critic has not reviewed this render yet.";
  const verdict = critic.verdict === "block" ? "blocked" : critic.verdict;
  const count = critic.findings_count ?? 0;
  const parts = [`Critic ${verdict}`, `${count} ${count === 1 ? "finding" : "findings"}`];
  if (critic.round) parts.push(`round ${critic.round}`);
  return `${parts.join(", ")}.`;
}

function coverageBar(label, counts, h) {
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
  const stale = list.filter((c) => c.stale).length;
  return `${list.length} ${list.length === 1 ? "cloud" : "clouds"}, ${stale} stale.`;
}

function fileButton(label, href, h) {
  if (!href) return h("span", { class: "btn disabled", text: label, "aria-disabled": "true" });
  return h("a", { class: "btn", href, target: "_blank", rel: "noopener", text: label });
}

/**
 * One positioning, as a card that fits beside another at 1280: a title row with
 * the stamp hard right, the positioning under it, then the pages on the left of
 * the body and everything the gates say on the right, and the files in a row.
 */
function resumeCard(item, h) {
  const card = h("article", { class: "card resume" });

  const stamp = item.stamp || { kind: "missing", text: "No render" };
  card.append(h("h2", {},
    h("span", { text: item.label || item.id }),
    h("span", { class: "grey small", text: item.id }),
    h("span", { class: `stamp ${stamp.kind}`, text: stamp.text })));
  if (item.positioning) card.append(h("p", { class: "resume-positioning grey small", text: item.positioning }));

  const body = h("div", { class: "resume-body" });

  const pages = item.pages || [];
  const left = h("div", { class: "pages" });
  // Four pages is every CV this pipeline renders; a fifth would only make the
  // card taller than the one beside it.
  if (pages.length) for (const page of pages.slice(0, 4)) left.append(pageThumb(page, h));
  else left.append(h("p", { class: "grey small", text: "No rendered pages on disk." }));
  body.append(left);

  const right = h("div", { class: "resume-facts" });
  const gates = item.gates || [];
  if (gates.length) {
    const row = h("div", { class: "chips" });
    for (const gate of gates) row.append(gateChip(gate, h));
    right.append(row);
  }
  const criticTone = toneFor(item.critic && item.critic.verdict);
  right.append(h("p", { class: criticTone ? `critic-line ${criticTone}` : "critic-line grey", text: criticLine(item.critic) }));

  const keywords = item.keywords || {};
  right.append(h("div", { class: "covers" },
    coverageBar("must-have", keywords.must_have, h),
    coverageBar("renderable", keywords.renderable, h)));
  right.append(h("p", { class: "grey small", text: cloudLine(item.clouds) }));
  if (item.last_render_at) {
    right.append(h("p", { class: "grey small", text: `rendered ${String(item.last_render_at).slice(0, 10)}` }));
  }
  body.append(right);
  card.append(body);

  const files = item.files || {};
  card.append(h("div", { class: "action-buttons resume-files" },
    fileButton("Open PDF", files.pdf, h),
    fileButton("Open DOCX", files.docx, h),
    fileButton("Markdown", files.md, h)));
  return card;
}

/**
 * Draw the screen. `ui` carries app.js's helpers: `h` builds nodes, `fetchInto`
 * loads into a host and paints its own error, and `panel` is unused here but
 * kept in the shape so the screen can grow a panel without a new argument.
 */
export async function viewResumes(view, ui) {
  const { h, fetchInto, pageHeader } = ui;
  const count = h("p", { class: "page-count", text: "Loading the positionings." });
  view.append(pageHeader({ title: "Resumes", lede: count }));
  const host = h("div", { class: "cards resume-grid" });
  host.append(h("p", { class: "empty", text: "Loading the positionings." }));
  view.append(host);
  const data = await fetchInto(host, "resumes", "Could not load the resumes.");
  if (!data) return;
  const items = data.resumes || [];
  const approved = items.filter((item) => item.stamp && item.stamp.kind === "approved").length;
  count.textContent = `${items.length} ${items.length === 1 ? "positioning" : "positionings"}, ${approved} approved`;
  if (!items.length) {
    host.append(h("p", { class: "empty", text: "No positionings yet. Run /onboarding, then /resume-review." }));
    return;
  }
  for (const item of items) host.append(resumeCard(item, h));
  // AGENTS.md section 5 again, said on the screen itself so nobody goes looking
  // for a button that must never be here.
  host.append(h("p", { class: "grey small",
    text: "Rendering and approval run through /resume-review with the person present." }));
}
