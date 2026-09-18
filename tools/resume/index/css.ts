/**
 * resume-index stylesheet: the inline CSS for the binder page.
 *
 * Lives on its own so the design can be read end to end without scrolling past
 * the markup that uses it. The design plan it answers to sits at the top of
 * `render.ts`.
 */

export const CSS = `
:root {
  color-scheme: light;
  --desk: #14213D;
  --paper: #FFFFFF;
  --ink: #1A1D23;
  --muted: #6B7280;
  --rule: #E4E6EA;
  --green: #2E7D32;
  --amber: #F0A202;
  --grey: #9AA0A6;
  --red: #C0392B;
  --sans: "Avenir Next", "Avenir", "Helvetica Neue", Inter, system-ui, sans-serif;
  --shadow: 6px 6px 0 rgba(0, 0, 0, 0.32);
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

html, body { height: 100%; }

body {
  margin: 0;
  background: var(--desk);
  color: var(--ink);
  font: 400 15px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
}

button { font: inherit; color: inherit; }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}

/* ------------------------------------------------------------ the binder */

.binder {
  display: flex;
  height: 100vh;
  padding: 24px 24px 24px 18px;
  gap: 0;
}

.tabs {
  flex: 0 0 64px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding-top: 4px;
  overflow: hidden;
}

.who {
  writing-mode: vertical-rl;
  margin: 0 auto 10px;
  max-height: 180px;
  overflow: hidden;
  color: #9FA9C0;
  font-size: 13px;
}

/* A tab: label rotated down the spine, state colour on its outer edge, sitting
   a few pixels back from the open page unless it is the selected one. */
.tab {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 14px 9px;
  background: #F4F5F7;
  border: 0;
  border-left: 4px solid var(--grey);
  border-radius: 3px 0 0 3px;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transform: translateX(-5px);
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.3);
  transition: transform 120ms ease-out;
}

.tab:hover, .tab:focus-visible { transform: translateX(-1px); }
.tab:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 2px; }

.tab[aria-selected="true"] {
  transform: translateX(0);
  box-shadow: none;
  background: var(--paper);
}

.tab.state-approved { border-left-color: var(--green); }
.tab.state-stale, .tab.state-fresh { border-left-color: var(--amber); }
.tab.state-missing { border-left-color: #D6D9DE; background: #EDEFF2; color: var(--muted); }
.tab.is-inactive { color: var(--grey); border-left-color: var(--grey); background: #E9EBEE; transform: translateX(-9px); }
.tab.is-inactive:hover, .tab.is-inactive:focus-visible { transform: translateX(-5px); }
.tab.is-inactive[aria-selected="true"] { transform: translateX(0); background: #F3F4F6; }

.tab-binder { border-left-color: #6B7A9B; background: #E7EAF0; }

/* ------------------------------------------------------------ the spread */

.spread { flex: 1; display: flex; gap: 14px; min-width: 0; }

.page { background: var(--paper); box-shadow: var(--shadow); min-width: 0; }

.brief {
  flex: 0 0 34%;
  min-width: 380px;
  padding: 26px 28px 32px;
  overflow-y: auto;
  font-variant-numeric: tabular-nums;
}

.pdf-page { flex: 1; display: flex; }
.pdf-page iframe { flex: 1; width: 100%; height: 100%; border: 0; display: block; }

.empty { margin: 0; padding: 28px; color: var(--muted); font-size: 15px; }

/* ------------------------------------------------------------- the brief */

/* State at a glance: the name and the stamp on one line, the fill bars and the
   single next move directly under them. Nothing else competes up here. */
.brief-head { display: flex; flex-direction: column; gap: 12px; }
.brief-headline { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.brief-title { margin: 0; font-size: 28px; font-weight: 600; line-height: 1.2; }
.brief-next { margin: 0; font-size: 15px; }

.stamp {
  display: inline-block;
  padding: 3px 9px;
  border: 1px solid var(--grey);
  border-radius: 2px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.stamp.state-approved { color: var(--green); border-color: var(--green); }
.stamp.state-stale, .stamp.state-fresh { color: var(--amber); border-color: var(--amber); }

.brief-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--rule); }
.brief-section h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.brief-section p { margin: 0 0 8px; font-size: 15px; }
.brief-section p:last-child { margin-bottom: 0; }
.brief-note { color: var(--muted); font-size: 13px; }

/* Checks: mark and name on the left, the one-line reason on the right. */
.marks { list-style: none; margin: 0; padding: 0; }
.marks li { display: grid; grid-template-columns: 148px 1fr; gap: 10px; padding: 3px 0; align-items: baseline; }
.mark-name { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.mark-name svg { width: 13px; height: 13px; flex: 0 0 13px; }
.mark-pass svg { color: var(--green); }
.mark-warn svg { color: var(--amber); }
.mark-fail svg { color: var(--red); }
.mark-skip svg { color: var(--grey); }
.mark-why { color: var(--muted); font-size: 13px; }

/* Checks pane: Gates (the marks) and Review (the critic's words) behind two
   small tabs, so the long sentence only takes space when asked for. */
.pane-tabs { display: flex; gap: 14px; margin: -4px 0 8px; border-bottom: 1px solid var(--rule); }
.pane-tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  margin-bottom: -1px; padding: 2px 0 6px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer;
}
.pane-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.pane-tab:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.review-summary { font-size: 14px; margin: 0 0 8px; }
.review-findings { margin: 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
.review-findings li { margin: 0 0 6px; }

/* Coverage: one dot per must-have term. */
.dots { list-style: none; display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 8px; padding: 0; }
.dots li { width: 8px; height: 8px; border-radius: 50%; }
.dots.is-dense { gap: 3px; }
.dots.is-dense li { width: 5px; height: 5px; }
.dots .surfaced { background: var(--ink); }
.dots .renderable { background: var(--amber); }
.dots .absent { background: transparent; box-shadow: inset 0 0 0 1px var(--grey); }
.questions { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; }

/* Coverage by cloud: one sentence, a legend, then a bar per cloud that opens
   onto the terms behind it. A bar reads at a glance where 25 dots did not. */
.coverage-summary { margin: 0 0 8px; font-size: 14px; }
.coverage-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.coverage-legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.swatch.surfaced { background: var(--ink); }
.swatch.renderable { background: var(--amber); }
.swatch.absent { background: transparent; box-shadow: inset 0 0 0 1px var(--grey); }

.clouds { list-style: none; margin: 0 0 8px; padding: 0; }
.clouds .cloud { border-bottom: 1px solid var(--rule); }
.clouds .cloud:last-child { border-bottom: 0; }
.cloud-row {
  appearance: none; background: none; border: 0; width: 100%; padding: 6px 0; margin: 0;
  font: inherit; font-size: 13px; color: var(--ink); text-align: left; cursor: pointer;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
}
.cloud-where { flex: 0 0 100%; text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.cloud-where:empty { display: none; }
.cloud-row:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.cloud-name { flex: 0 0 auto; }
.cloud-weight { color: var(--muted); margin-left: 6px; }
.cloud-bar { flex: 1 1 auto; min-width: 60px; display: flex; height: 7px; border-radius: 1px; box-shadow: inset 0 0 0 1px var(--rule); overflow: hidden; }
.cloud-bar span { display: block; height: 100%; }
.cloud-bar .surfaced { background: var(--ink); }
.cloud-bar .renderable { background: var(--amber); }
.cloud-count { flex: 0 0 auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.cloud-terms { padding: 0 0 8px; }
.cloud-terms p { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
.cloud-terms p:last-child { margin-bottom: 0; }
.cloud-terms .term-head { color: var(--ink); }

/* Terms tab: one toggle between the per-cloud bars and the flat used /
   not-used chip lists, so the same terms can be read either way. */
.view-toggle { display: flex; gap: 6px; margin: 0 0 14px; }
.view-button {
  appearance: none; background: none; border: 1px solid var(--rule); border-radius: 3px;
  padding: 3px 9px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer;
}
.view-button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
.view-button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* Stacked, not side by side: a term reads as one line at full width, where
   two narrow columns wrapped most of them onto two. */
.chip-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
.chip-head { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.chip-count { margin-left: 4px; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.chips { list-style: none; display: flex; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border: 1px solid var(--grey); border-radius: 11px;
  font-size: 12px; line-height: 1.6; color: var(--ink);
}
.chip-used { border-color: var(--ink); }
.chip-unused { border-color: var(--amber); }
.chip-gone { border-color: var(--rule); color: var(--muted); }
.chip.is-must { font-weight: 600; }
.chip-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: 0 0 5px; }
.chip-note { color: var(--muted); font-size: 11px; }
.disclose {
  appearance: none; background: none; border: 0; margin: 14px 0 0; padding: 0;
  font: inherit; font-size: 13px; color: var(--muted); text-align: left; cursor: pointer;
}
.disclose:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.absent-panel { margin-top: 8px; }

/* Pages: a fill bar per page with its percentage beneath. */
.fills { display: flex; gap: 12px; margin: 0; }
.fill { display: flex; flex-direction: column; gap: 4px; }
.fill-bar { width: 34px; height: 6px; background: var(--rule); border-radius: 1px; overflow: hidden; }
.fill-bar span { display: block; height: 100%; background: var(--ink); }
.fill-bar span.is-low { background: var(--amber); }
.fill-pct { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

.shape-bar { display: flex; height: 6px; margin-top: 22px; border-radius: 1px; overflow: hidden; background: var(--rule); }
.shape-bar span { display: block; height: 100%; }
.shape-bar .featured { background: var(--ink); }
.shape-bar .mentioned { background: var(--grey); }
.shape-bar .dropped { background: var(--rule); }
.shape-line { margin-top: 8px; color: var(--muted); font-size: 13px; }

/* Files: an icon per artefact with its name under it, the two PDF actions
   first, then a hairline, then the working sidecars. Icons are Lucide (ISC). */
.files { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 2px; }
.files .file-icon {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 66px;
  padding: 7px 2px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
}
.files .file-icon svg { width: 18px; height: 18px; }
.files .file-caption { font-size: 11px; line-height: 1.3; color: var(--muted); text-align: center; }
.files .file-icon:hover { background: #F4F5F7; }
.files .file-icon:hover .file-caption { color: var(--ink); }
.files .file-icon:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* The print action is a link that happens to be a button, so it reads as one. */
.files .file-action { font: inherit; background: none; }
.files .file-action:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.files .file-divider { align-self: stretch; width: 1px; margin: 6px 8px; background: var(--rule); }
.files .file-icon.is-quiet { color: var(--muted); }
.brief-foot { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 12px; }
.brief-foot a { color: var(--muted); font-size: 13px; }

/* --------------------------------------------------------- binder (all) */

/* The same left gutter the open spread leaves, so sheets and heading start
   clear of the tab column instead of butting against it. */
.binder-view { flex: 1; overflow-y: auto; padding: 4px 2px 24px 32px; }
.binder-view h1 { margin: 0 0 6px; color: #FFFFFF; font-size: 18px; font-weight: 600; }
.binder-lede { margin: 0 0 20px; color: #9FA9C0; font-size: 13px; }

.sheets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; max-width: 1180px; }

.sheet {
  position: relative;
  width: 100%;
  padding: 14px 14px 14px 18px;
  background: var(--paper);
  border: 0;
  border-left: 5px solid var(--grey);
  box-shadow: var(--shadow);
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sheet:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 3px; }
.sheet.state-approved { border-left-color: var(--green); }
.sheet.state-stale, .sheet.state-fresh { border-left-color: var(--amber); }
.sheet.state-missing { border-left-color: #D6D9DE; }
.sheet.is-inactive { border-left-color: var(--grey); background: #F4F5F7; }
.sheet img { width: 100%; height: 420px; object-fit: cover; object-position: top center; border: 1px solid var(--rule); }
.sheet-blank { height: 420px; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--rule); color: var(--muted); font-size: 13px; }
.sheet-name { font-size: 15px; font-weight: 600; }
.sheet-stamp { font-size: 13px; color: var(--muted); }
.sheet-stamp.state-approved { color: var(--green); }
.sheet-stamp.state-stale, .sheet-stamp.state-fresh { color: var(--amber); }
.sheet .fills { margin: 0; gap: 8px; }
.sheet-marks { display: flex; gap: 8px; }
.sheet-marks svg { width: 13px; height: 13px; }

@media (prefers-reduced-motion: reduce) {
  .tab { transition: none; }
}

/* ----------------------------------------------------------- narrow view */

@media (max-width: 960px) {
  .binder { flex-direction: column; height: auto; padding: 12px; }
  .tabs { flex: 0 0 auto; flex-direction: row; align-items: stretch; gap: 4px; overflow-x: auto; padding: 0 0 10px; }
  .who { writing-mode: horizontal-tb; max-height: none; margin: 0 10px 0 0; align-self: center; white-space: nowrap; }
  .tab {
    writing-mode: horizontal-tb;
    flex: 0 0 auto;
    max-width: 150px;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding: 8px 10px;
    border-left: 0;
    border-bottom: 4px solid var(--grey);
    border-radius: 3px 3px 0 0;
    transform: translateY(4px);
  }
  .tab:hover, .tab:focus-visible, .tab.is-inactive:hover { transform: translateY(0); }
  .tab[aria-selected="true"], .tab.is-inactive[aria-selected="true"] { transform: translateY(0); }
  .tab.is-inactive { transform: translateY(6px); }
  .tab.state-approved { border-bottom-color: var(--green); }
  .tab.state-stale, .tab.state-fresh { border-bottom-color: var(--amber); }
  .tab.state-missing { border-bottom-color: #D6D9DE; }
  .tab.is-inactive { border-bottom-color: var(--grey); }
  .tab-binder { border-bottom-color: #6B7A9B; }
  .spread { flex-direction: column; gap: 12px; }
  .brief { flex: 0 0 auto; min-width: 0; width: 100%; }
  .marks li { grid-template-columns: 120px 1fr; }
  .pdf-page { height: 80vh; }
  .binder-view { padding-left: 2px; }
  .sheets { gap: 14px; }
  .sheet { width: 100%; }
}

@media (max-width: 900px) {
  .sheets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 600px) {
  .sheets { grid-template-columns: minmax(0, 1fr); }
}
`;
