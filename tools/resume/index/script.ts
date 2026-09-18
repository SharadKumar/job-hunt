/**
 * resume-index behaviour: the vanilla browser script inlined into the page.
 *
 * It reads the JSON model in `#binder-model`, switches between positionings,
 * remembers the last one read per profile in localStorage, and keeps the hash
 * in step. No build step and no framework: it ships as a string.
 */

export const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("binder-model").textContent);
  var ids = data.resumes.map(function (r) { return r.id; });
  if (!ids.length) return;
  var byId = {};
  data.resumes.forEach(function (r) { byId[r.id] = r; });

  var profileKey = data.profileId || "default";
  var storeKey = "resume-binder:last:" + profileKey;
  var paneKey = "resume-binder:pane:" + profileKey;
  var termsKey = "resume-binder:terms:" + profileKey;

  function put(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // Every brief carries the same three tabs, so the one the reader chose stays
  // chosen as they move between positionings.
  function showPane(set, want) {
    var tabs = set.querySelectorAll(".pane-tab");
    var found = false;
    Array.prototype.forEach.call(tabs, function (t) {
      if (t.getAttribute("data-pane") === want) found = true;
    });
    if (!found) return;
    Array.prototype.forEach.call(tabs, function (t) {
      t.setAttribute("aria-selected", t.getAttribute("data-pane") === want ? "true" : "false");
    });
    Array.prototype.forEach.call(set.querySelectorAll(".pane"), function (p) {
      p.hidden = p.getAttribute("data-pane") !== want;
    });
  }

  function showTermsView(set, want) {
    Array.prototype.forEach.call(set.querySelectorAll(".view-button"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-terms-view") === want ? "true" : "false");
    });
    Array.prototype.forEach.call(set.querySelectorAll(".terms-view"), function (v) {
      v.hidden = v.getAttribute("data-terms-view") !== want;
    });
  }

  function applyRemembered() {
    var pane = get(paneKey);
    var view = get(termsKey);
    if (pane) {
      Array.prototype.forEach.call(document.querySelectorAll(".pane-set"), function (set) { showPane(set, pane); });
    }
    if (view) {
      Array.prototype.forEach.call(document.querySelectorAll(".terms-set"), function (set) { showTermsView(set, view); });
    }
  }

  // Checks pane tabs: one click flips between the marks, the review and the terms.
  document.addEventListener("click", function (event) {
    var tab = event.target.closest && event.target.closest(".pane-tab");
    if (!tab) return;
    var want = tab.getAttribute("data-pane");
    Array.prototype.forEach.call(document.querySelectorAll(".pane-set"), function (set) { showPane(set, want); });
    put(paneKey, want);
  });
  // The Terms toggle: the same terms, read by cloud or as two flat lists.
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest(".view-button");
    if (!button) return;
    var want = button.getAttribute("data-terms-view");
    Array.prototype.forEach.call(document.querySelectorAll(".terms-set"), function (set) { showTermsView(set, want); });
    put(termsKey, want);
  });
  // Disclosures: a cloud's terms, or the terms the source never had.
  document.addEventListener("click", function (event) {
    var row = event.target.closest && event.target.closest(".cloud-row, .disclose");
    if (!row) return;
    var open = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", open ? "false" : "true");
    var panel = document.getElementById(row.getAttribute("aria-controls"));
    if (panel) panel.hidden = open;
  });

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var spread = document.querySelector(".spread");
  var binderView = document.querySelector(".binder-view");
  var state = { view: "positioning", id: data.selected };

  function remember(id) {
    try { localStorage.setItem(storeKey, id); } catch (e) { /* private mode */ }
  }
  function recall() {
    try { return localStorage.getItem(storeKey); } catch (e) { return null; }
  }

  function parseHash() {
    var raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (raw === "binder") return { view: "binder", id: state.id };
    if (raw && byId[raw]) return { view: "positioning", id: raw };
    return null;
  }

  function hashFor(next) {
    return next.view === "binder" ? "#binder" : "#" + encodeURIComponent(next.id);
  }

  function render() {
    var showBinder = state.view === "binder";
    if (spread) spread.hidden = showBinder;
    if (binderView) binderView.hidden = !showBinder;

    tabs.forEach(function (tab) {
      var mine = showBinder ? tab.hasAttribute("data-view") : tab.getAttribute("data-resume") === state.id;
      tab.setAttribute("aria-selected", mine ? "true" : "false");
      tab.setAttribute("tabindex", mine ? "0" : "-1");
    });

    document.querySelectorAll(".brief, .pdf-page").forEach(function (pane) {
      pane.hidden = showBinder || pane.getAttribute("data-resume") !== state.id;
    });

    if (!showBinder) {
      // Only the open positioning loads its PDF: the rest wait their turn.
      var frame = document.querySelector('.pdf-page[data-resume="' + cssEscape(state.id) + '"] iframe');
      if (frame && !frame.getAttribute("src")) frame.setAttribute("src", frame.getAttribute("data-src"));
      remember(state.id);
    }
    document.title = showBinder
      ? data.profileName + ", binder"
      : byId[state.id].label + ", " + data.profileName;
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value;
  }

  function go(next, push) {
    state = { view: next.view || "positioning", id: byId[next.id] ? next.id : state.id };
    if (push !== false && location.hash !== hashFor(state)) history.pushState(state, "", hashFor(state));
    render();
  }

  function focusSelected() {
    var current = tabs.filter(function (t) { return t.getAttribute("aria-selected") === "true"; })[0];
    if (current) current.focus();
  }

  // Print goes through the open viewer's own window: the server serves the PDF
  // from this origin, so the frame is reachable. If it is not loaded, or the
  // browser refuses, open the PDF in a tab with its toolbar and print there.
  function printResume(id) {
    var frame = document.querySelector('.pdf-page[data-resume="' + cssEscape(id) + '"] iframe');
    try {
      if (frame && frame.getAttribute("src") && frame.contentWindow) {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        return;
      }
    } catch (e) { /* not loaded, or blocked: fall through to a real window */ }
    var entry = byId[id];
    if (!entry || !entry.pdf) return;
    var win = window.open(entry.pdf + "#toolbar=1", "_blank");
    if (!win) return;
    win.addEventListener("load", function () {
      try { win.print(); } catch (e) { /* the tab is open; the reader can print */ }
    });
  }

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-print]") : null;
    if (!button) return;
    event.preventDefault();
    printResume(button.getAttribute("data-target"));
  });

  document.addEventListener("click", function (event) {
    var node = event.target && event.target.closest ? event.target.closest(".tab, .sheet") : null;
    if (!node) return;
    if (node.hasAttribute("data-view")) { go({ view: "binder" }, true); return; }
    go({ view: "positioning", id: node.getAttribute("data-resume") }, true);
  });

  // Focus never enters the iframe, so the tab column can own the arrow keys.
  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    var tag = (event.target && event.target.tagName ? event.target.tagName : "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    var order = ["binder"].concat(ids);
    var index = order.indexOf(state.view === "binder" ? "binder" : state.id);
    var next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= order.length) return;
    event.preventDefault();
    go(next === 0 ? { view: "binder" } : { view: "positioning", id: order[next] }, true);
    focusSelected();
  });

  window.addEventListener("popstate", function () {
    var parsed = parseHash();
    state = parsed || { view: "positioning", id: data.selected };
    render();
  });

  var initial = parseHash();
  if (!initial) {
    var last = recall();
    if (last && byId[last]) initial = { view: "positioning", id: last };
  }
  if (initial) { state = initial; }
  applyRemembered();
  render();
})();
`;
