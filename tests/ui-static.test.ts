#!/usr/bin/env tsx
/**
 * ui-static.test.ts - the local Job Hunt UI is a set of static files with no
 * build step, so nothing else checks them. This test pins the properties that
 * make them safe to serve and load:
 *
 *   - index.html loads app.js and app.css and nothing from the network. A CDN
 *     reference would send the person's browsing to a third party and break the
 *     page offline.
 *   - the front end is split into one module per screen, each parses, and none
 *     of them grows past 500 lines.
 *   - no module uses a browser modal (alert / confirm / prompt). Every action
 *     confirms inline, with a second deliberate press.
 *   - the four fixed keyword answers appear verbatim (AGENTS.md section 9) and
 *     each term is recorded on its own.
 *   - every hash route the redesign specifies is present, Today is the
 *     default, and the nav is in the agreed order.
 *   - autopilot is switched from the header and the kill switch from Settings,
 *     both against the policy API (AGENTS.md section 2).
 *   - the visual contract of docs/ui-redesign-2026-09-18.md: the serif and
 *     sans pair with no web font, the fixed palette, hairline lists, flat
 *     surfaces, nothing shouted, and the three button weights.
 *   - no em dash and no en dash anywhere (AGENTS.md section 3.2).
 *
 * Run: npx tsx tests/ui-static.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../tools/repo-root.ts";

const ROOT = repoRoot();
const STATIC_DIR = path.join(ROOT, "tools/ui/static");
const HTML_PATH = path.join(STATIC_DIR, "index.html");
const CSS_PATH = path.join(STATIC_DIR, "app.css");

/** Every module of the front end. app.js is the router and the shared helpers;
 * the rest are one screen each. The list is the contract: a new screen is a new
 * module here, not another thousand lines in app.js. */
const MODULES = [
  "app.js", "shell.js", "labels.js", "markdown.js", "controls.js", "applications.js", "pipeline-rows.js", "row.js", "row-actions.js", "row-letter.js",
  "keywords.js", "home.js", "today-lists.js", "today-workbench.js", "quotes.js", "settings.js", "runs.js", "rules.js", "resumes.js",
  "screening.js",
];

/** One stylesheet per screen, beside app.css. The three wave files
 * (screens-a/b/c.css) are gone: every rule in them moved to the screen that
 * owns it, and every shared primitive moved to app.css. */
const SCREEN_SHEETS = [
  "today.css", "pipeline.css", "row.css", "resumes.css", "guardrails.css", "runs.css", "settings.css",
];

/** No module may pass this. It is the whole reason the front end is split. */
const MAX_MODULE_LINES = 500;

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function read(file: string): string {
  assert.ok(fs.existsSync(file), `missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

console.log("ui static front end");

const html = read(HTML_PATH);
const css = read(CSS_PATH);

/** Each screen stylesheet by name, plus one concatenation for the checks that
 * only care that a rule exists somewhere in the UI. */
const sheet: Record<string, string> = {};
for (const name of SCREEN_SHEETS) sheet[name] = read(path.join(STATIC_DIR, name));
const styles = [css, ...SCREEN_SHEETS.map((name) => sheet[name])].join("\n");

/** Each module by name, plus one concatenation for "somewhere in the UI" checks. */
const src: Record<string, string> = {};
for (const name of MODULES) src[name] = read(path.join(STATIC_DIR, name));
const front = MODULES.map((name) => src[name]).join("\n");

const app = src["app.js"];
const applications = src["applications.js"];
/** The Pipeline screen is two files: the screen, and the row anatomy plus the
 * controls the row page borrows from it. */
const pipelineRows = src["pipeline-rows.js"];
const todayWorkbench = src["today-workbench.js"];
const rowJs = src["row.js"];
const keywords = src["keywords.js"];
const home = src["home.js"];
const lists = src["today-lists.js"];
const settings = src["settings.js"];
const resumesJs = src["resumes.js"];
const rulesJs = src["rules.js"];
const runsJs = src["runs.js"];
const labelsJs = src["labels.js"];

test("index.html loads app.js and app.css", () => {
  assert.match(html, /<script[^>]+type="module"[^>]+src="app\.js"/, "index.html must load app.js as a module");
  assert.match(html, /<link[^>]+rel="stylesheet"[^>]+href="app\.css"/, "index.html must load app.css");
});

test("index.html pulls nothing off the network", () => {
  // Every src= and href= must be same-origin. A CDN or any absolute URL fails.
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "expected at least one src/href in index.html");
  for (const ref of refs) {
    assert.ok(
      !/^(?:https?:)?\/\//i.test(ref),
      `index.html references an external asset: ${ref}`,
    );
  }
  assert.ok(!/https?:\/\//i.test(html), "index.html must not contain an http(s) URL at all");
});

test("the modules and every stylesheet pull nothing off the network", () => {
  for (const [name, body] of [["app.css", css], ...SCREEN_SHEETS.map((n) => [n, sheet[n]] as [string, string])]) {
    assert.ok(!/@import\s+url\(/i.test(body), `${name} must not @import a remote stylesheet`);
    assert.ok(!/https?:\/\//i.test(body), `${name} must not contain an http(s) URL`);
    assert.ok(!/@font-face/i.test(body), `${name} must not load a font of its own`);
  }
  for (const name of MODULES) {
    assert.ok(!/\bimport\s+[^\n]*["']https?:/i.test(src[name]), `${name} must not import from a URL`);
    assert.ok(!/\bfrom\s+["']https?:/i.test(src[name]), `${name} must not import from a URL`);
    for (const value of [...src[name].matchAll(/src:\s*([^,\n]+)/g)].map((m) => m[1].trim())) {
      assert.ok(!/^["']https?:/i.test(value), `${name} sets an external src: ${value}`);
    }
  }
});

test("the front end is one module per screen, and each one parses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-static-test-"));
  try {
    for (const name of MODULES) {
      // node --check reads a bare .js file as a script, so drop the module
      // syntax first: whole import statements, and the export keyword.
      const stripped = src[name]
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/g, "")
        .replace(/import\s+[\w$]+\s+from\s*["'][^"']+["'];?/g, "")
        // A re-export list is module syntax too: `export { a, b };` on its own
        // is not a statement a script can run, so it goes with the imports.
        .replace(/^export\s*\{[\s\S]*?\}\s*(?:from\s*["'][^"']+["'])?\s*;/gm, "")
        .replace(/^export\s+/gm, "");
      const copy = path.join(dir, `${name}.check.js`);
      fs.writeFileSync(copy, stripped);
      try {
        execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
      } catch (error) {
        const stderr = String((error as { stderr?: Buffer }).stderr ?? error);
        assert.fail(`${name} does not parse:\n${stderr}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no module is longer than 500 lines", () => {
  for (const name of MODULES) {
    const lines = src[name].split("\n").length;
    assert.ok(lines <= MAX_MODULE_LINES, `${name} is ${lines} lines; the budget is ${MAX_MODULE_LINES}`);
  }
});

test("app.js imports every screen module", () => {
  // The exceptions are owned by a screen rather than by the router:
  // keywords.js is the Resumes screen's second tab; row-actions.js and
  // row-letter.js are the row detail's own parts, and the applications board
  // reuses one of them; screening.js is imported by the row when it needs it;
  // today-lists.js is the second half of Today, which home.js draws;
  // pipeline-rows.js is the Pipeline's row anatomy, which the Pipeline draws
  // and the row detail borrows.
  const owned = new Set([
    "app.js", "labels.js", "markdown.js", "controls.js", "keywords.js", "row-actions.js", "row-letter.js",
    "screening.js", "today-lists.js", "today-workbench.js", "pipeline-rows.js", "quotes.js", "shell.js",
  ]);
  for (const name of MODULES.filter((m) => !owned.has(m))) {
    assert.ok(app.includes(`from "./${name}"`), `app.js does not import ./${name}`);
  }
  assert.match(app, /import \{ viewResumes \} from "\.\/resumes\.js"/, "app.js must import the resumes view");
  assert.ok(rowJs.includes('from "./row-actions.js"'), "the row detail must own its retry, redraft and mark-sent controls");
  assert.ok(rowJs.includes('from "./row-letter.js"'), "and the letter card must be its own module");
  assert.match(resumesJs, /import \{ viewKeywords \} from "\.\/keywords\.js"/,
    "the Resumes screen must own the evidence questions tab");
  assert.ok(!app.includes('from "./keywords.js"'), "the router must not draw the keywords view itself");
  assert.ok(applications.includes('from "./pipeline-rows.js"'), "the Pipeline must own its row anatomy");
});

test("no module uses a browser modal", () => {
  for (const name of MODULES) {
    for (const banned of ["alert(", "confirm(", "prompt("]) {
      assert.ok(!src[name].includes(banned), `${name} must not call ${banned.slice(0, -1)}(): confirmation is inline`);
    }
  }
});

test("the front end confirms inline, with a second press, and never in a dialog", () => {
  const controls = src["controls.js"];
  assert.match(controls, /Confirm \$\{label\.toLowerCase\(\)\}/, "controls.js must label the armed state");
  assert.match(controls, /export function guarded\s*\(/, "controls.js must own the inline confirm wiring");
  assert.match(controls, /export function confirmButton\(label, confirmLabel, onConfirm, options\)/,
    "and offer one button that confirms itself");
  assert.ok(app.includes("confirmButton"), "app.js must export it again for the screens");
  assert.match(controls, /const ARM_WINDOW_MS = 8000;/, "the armed state must expire after eight seconds");
  assert.match(controls, /text: "Cancel", onClick: \(\) => disarm\(\)/, "a Cancel must appear beside the armed button");
  assert.match(controls, /event\.key === "Escape"\) disarm\(\)/, "and Escape must back out of it");
  assert.match(controls, /export function busy\(button, label\)/, "a button that is working must say so");
  assert.match(controls, /setAttribute\("aria-busy", "true"\)/, "out loud, in aria-busy");
  assert.match(controls, /button\.style\.minWidth = `\$\{Math\.ceil\(width\)\}px`/,
    "with its width locked so the row does not jump");
  assert.match(pipelineRows, /guarded\s*\(/, "a row decision must go through the inline confirm helper");
});

test("a screen shows the shape of what is coming, and says a load failure in place", () => {
  const controls = src["controls.js"];
  assert.match(controls, /export function placeholderRows\(count\)/, "controls.js must own the placeholder rows");
  assert.match(css, /\.placeholder \{[^}]*opacity: 0\.4;/, "and they must sit at 40 per cent");
  const code = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/Loading\./.test(code(controls)), "there is no loading sentence and no spinner");
  assert.ok(!/>Loading\.</.test(html), "and the shell stands placeholder rows rather than saying it");
  assert.match(html, /<div class="placeholder" aria-hidden="true">/, "which is what the shell renders first");
  assert.match(controls, /export function loadError\(what, error, retry\)/, "a failed load must be said in place");
  assert.match(controls, /Could not load \$\{what\}/, "naming what would not load");
  assert.match(css, /\.load-error \{/, "in its own hairline box at the top of the list");
  assert.match(controls, /export const TOKEN_PROMPT = "This server needs the API token\.";/,
    "a 401 must have one sentence");
  assert.match(controls, /export function askForToken\(\)/, "and one route: Settings");
  assert.match(controls, /location\.hash = "#\/settings"/, "which is where it sends the person");
  assert.match(settings, /field\.focus\(\)/, "with the token field focused when they land");
});

test("no module builds markup from a string", () => {
  for (const name of MODULES) {
    assert.ok(!/\.innerHTML\s*=/.test(src[name]), `${name} must not assign innerHTML`);
    assert.ok(!/\bdocument\.write\b/.test(src[name]), `${name} must not use document.write`);
  }
});

test("the four fixed keyword answers appear verbatim", () => {
  // AGENTS.md section 9: these four and no others, recommended first.
  const options = [
    "Confirm and update source",
    "Not applicable",
    "Bring in as familiarity",
    "Unsure / keep pending",
  ];
  for (const option of options) {
    assert.ok(keywords.includes(option), `keywords.js is missing the fixed answer: ${option}`);
  }
  const first = keywords.indexOf(options[0]);
  for (const option of options.slice(1)) {
    assert.ok(first < keywords.indexOf(option), `"${options[0]}" must be offered first, before "${option}"`);
  }
  assert.match(keywords, /\(Recommended\)/, "the recommended answer must be marked");
});

test("a keyword term is recorded on its own, in one press", () => {
  // The bundle of four cards, the segmented control and the separate Record
  // and Skip buttons are gone (the brief, section 4, Resumes): the ledger is a
  // list, and each of the four fixed answers is the press that records it.
  assert.match(keywords, /body: \{ answers: \{ \[term\]: value \} \}/, "an answer must post one term at a time");
  assert.match(keywords, /handlers\.onAnswer\(item\.term, option\.value\)/, "pressing an answer must record that answer");
  for (const gone of ["KEYWORD_BUNDLE", "Record and next", "Skip these", 'text: "Record"', 'text: "Skip"']) {
    assert.ok(!keywords.includes(gone), `the bundle control must be gone: ${gone}`);
  }
});

test("a pending term is a list row with the four answers under it", () => {
  assert.match(keywords, /class: "list-row term-row"/, "a term must be the shared list row");
  assert.match(keywords, /class: "list-main"/, "with the term and its context in the main cell");
  assert.match(keywords, /class: "list-title term-name"/, "the term is the row title");
  assert.match(keywords, /class: "list-meta", text: context/, "where it came from is the meta line");
  assert.match(keywords, /class: "row-extra answers"/, "the four answers run the width of the row");
  assert.match(keywords, /class: "btn",\s*\n?\s*text: option\.value === advised/,
    "each answer is a secondary button carrying its verbatim label");
  const resumesCss = sheet["resumes.css"];
  assert.match(resumesCss, /\.answers \{[\s\S]*?display: flex;/, "the answers sit on one line and wrap as a group");
  assert.ok(!/\.options\.segmented/.test(resumesCss), "the segmented control must be gone");
  assert.ok(!/-webkit-line-clamp/.test(resumesCss), "and so must the clamped context: truncation is banned");
});

test("a term says what kind of thing it is, and whether a plan is waiting on it", () => {
  assert.match(keywords, /const CATEGORIES = \["tool", "method", "certification", "concept"\]/,
    "the list must name the four categories it will print");
  assert.match(keywords, /categoryOf\s*=\s*\(item\)/, "the category must come off the term, or be omitted");
  assert.match(keywords, /mustHave\s*=\s*\(item\)/, "a must-have term must be marked");
  assert.match(keywords, /class: "pill", text: "Must have"/, "and it is marked with the shared pill, in words");
  assert.match(keywords, /item\.count === 1 \? "seen once" : `seen \$\{item\.count\} times`/,
    "how often it came up is said in words, not as a bare number");
});

test("the recommended answer is the one the ledger recommends", () => {
  // The tag used to be baked into the first label, so every term recommended
  // "Confirm and update source", including the ones that are not skills.
  assert.match(keywords, /const RECOMMENDED = " \(Recommended\)";/, "the tag must be its own string");
  assert.ok(!/label: "Confirm and update source \(Recommended\)"/.test(keywords),
    "the tag must not be baked into the first answer");
  assert.match(keywords, /recommendedAnswer = \(item\)/, "the tag must follow item.recommendation.answer");
  assert.match(keywords, /item\.recommendation && item\.recommendation\.answer/, "and read it off the term");
  assert.match(keywords, /option\.value === advised \? `\$\{option\.label\}\$\{RECOMMENDED\}` : option\.label/,
    "the tag must sit on the recommended answer and nowhere else");
  assert.match(keywords, /item\.recommendation\.note/, "the ledger's note must be shown under the term");
  assert.match(keywords, /class: "list-reason", text: advice/, "and it must be the row's reason line");
  assert.ok(!/checked: true/.test(keywords), "no answer may be pre-selected");
});

test("a term says who asked and what might evidence it, in words", () => {
  assert.match(keywords, /`Asked by \$\{said\.join\("; "\)\}`/, "the context must name the adverts that asked");
  assert.match(keywords, /rows\.slice\(0, 2\)/, "and it must name at most two of them");
  assert.match(keywords, /\[row\.title, row\.company\]\.filter\(Boolean\)\.join\(" at "\)/,
    "an advert is a title at a company, never an opportunity id");
  assert.ok(!/item\.context,/.test(keywords), "the raw opportunity id must not reach the page");
  assert.match(keywords, /function evidenceRoles\(hint\)/, "the evidence hint must be read for its role names");
  assert.match(keywords, /roles \? `Evidence: \$\{roles\}` : ""/, "and shown as Evidence, not as a file and a line number");
  assert.ok(!/item\.evidence_hint,/.test(keywords), "cv-source.md:25,118 must never be printed as it stands");
  assert.match(keywords, /pending === 1 \? "1 term pending" : `\$\{pending\} terms pending`/,
    "the lede must be the pending count and nothing else");
});

test("the keyword view can drain a list of hundreds", () => {
  assert.ok(keywords.includes("keywords/pending?all=1"), "the list must fetch every pending term, not the first page");
  assert.match(keywords, /"aria-label": "Search the pending terms"/, "the list must carry a search field");
  assert.match(keywords, /class: "field-label", for: "term-search", text: "Search"/,
    "and the field must carry a label above it, not only a placeholder");
  assert.match(keywords, /Decided \$\{decided\.size\}, skipped \$\{skipped\.size\}, \$\{live\.length\} to go/,
    "the view must show the progress line as one muted sentence");
  assert.match(keywords, /class: "progress-line"/, "and that line is muted, not a bar");
  assert.match(keywords, /PAGE_SIZE\s*=\s*40/, "the list must cap what it draws before offering Show all");
  assert.match(keywords, /text: `Showing \$\{shown\.length\} of \$\{matching\.length\}`/,
    "a capped list must say how much of it is on screen");
  assert.match(keywords, /text: "Show all"/, "and offer the rest");
  assert.match(keywords, /Nothing pending\. Every term the hunt mined has an answer\./,
    "the empty state must say what would put something here");
  assert.match(keywords, /sessionStorage\.getItem\(KEYWORD_SESSION\)/, "the pass must survive a refresh");
  assert.match(keywords, /sessionStorage\.setItem\(KEYWORD_SESSION/, "and be written to sessionStorage");
});

test("every address the UI answers on is routed, and Today is the default", () => {
  // Nine addresses: the seven routes, the Resumes tab that carries a segment,
  // and the row detail that carries an id.
  for (const route of ["today", "pipeline", "row", "resumes", "guardrails", "runs", "settings"]) {
    assert.ok(app.includes(`"${route}"`), `app.js does not name the route: ${route}`);
  }
  assert.match(app, /ROUTES = \["today", "pipeline", "row", "resumes", "guardrails", "runs", "settings"\]/,
    "the route list is the contract and must read in nav order");
  assert.ok(resumesJs.includes('hash: "#/resumes/evidence"'), "the evidence questions must have their own address");
  assert.ok(pipelineRows.includes("#/row/"), "a pipeline row must link to #/row/<id>");
  for (const hash of ["#/today", "#/pipeline", "#/resumes", "#/guardrails", "#/runs", "#/settings"]) {
    assert.ok(html.includes(hash), `index.html has no nav link for ${hash}`);
  }
  assert.match(app, /location\.hash \|\| "#\/today"/, "an empty hash must resolve to Today");
  assert.match(app, /if \(!location\.hash\) location\.hash = "#\/today"/, "a first load must land on Today");
  assert.match(app, /!ROUTES\.includes\(name\) \? "today"/, "an unknown hash must fall back to Today");
});

test("the hash carries the query, and scroll resets on a move but not on a filter", () => {
  // The brief, section 3, principle 4: the URL is the state. The board's
  // segment, its chips, the minimum score and the sort all live in the hash,
  // so a deep link lands on the list the person shared.
  assert.match(app, /export function parseHash\(\)/, "app.js must own one hash parser");
  assert.match(app, /return \{ route, id, query, fragment \};/, "which returns the route, the id, the query and the fragment");
  assert.match(app, /new URLSearchParams\(search\)/, "the query must be parsed, not handed over as a string");
  assert.match(app, /export function setQuery\(patch, options\)/, "and one way to change it");
  assert.match(app, /history\.replaceState\(null, "", target\);\n  if \(!options \|\| options\.render !== false\) render\(\);/,
    "replaceState fires no hashchange, so the one re-render is the one asked for: no loop");
  assert.match(app, /if \(target === \(location\.hash \|\| ""\)\) return false;/,
    "and an address that is already current is a no-op");
  assert.match(app, /const place = `\$\{route\}\/\$\{id\}`;\n  if \(place !== lastPlace\) \{\n    window\.scrollTo\(0, 0\);/,
    "scroll resets when the screen changes and stays put when only a filter did");
  assert.match(applications, /viewApplications\(view, which, query\)|export async function viewApplications/,
    "the board must be handed the query the address carried");
});

test("the API is called on an absolute path", () => {
  // The server serves the shell for every extensionless path, so on a deep
  // address like #/row/abc a relative "api/..." resolved against the wrong
  // base and every call came back as the HTML shell.
  assert.match(app, /fetch\(`\/api\/\$\{path/, "app.js must fetch /api/... from the origin, not from the page");
  assert.ok(!/fetch\(`api\//.test(app), "no relative api/ path may survive");
});

test("every address that moved still works", () => {
  // Keywords became the Resumes screen's second tab, Digest became Rules and
  // Today became Runs. All three are in the person's history and in the Home
  // cards another package owns, so none of them may 404 into Home silently.
  assert.match(app, /export const REDIRECTS = \{/, "app.js must name the moved addresses in one table");
  for (const [from, to] of [
    ["home", "#/today"],
    ["applications", "#/pipeline"],
    ["queue", "#/pipeline"],
    ["rules", "#/guardrails"],
    ["keywords", "#/resumes/evidence"],
    ["digest", "#/guardrails"],
  ]) {
    assert.match(app, new RegExp(`${from}: "${to.replace(/\//g, "\\/")}"`), `${from} must redirect to ${to}`);
  }
  // #/today used to mean the Runs screen. It is the Today screen now, so the
  // route owns the address and there is nothing left to forward.
  assert.ok(!/^\s*today: "/m.test(app), "#/today must be a route, not a redirect");
  assert.match(app, /history\.replaceState\(null, "", target\)/, "a moved address must be rewritten in the address bar");
  assert.ok(!front.includes('"#/queue"'), "the front end must link to #/pipeline, not #/queue");
  assert.ok(!/href="#\/(keywords|digest|queue|home|applications|rules)"/.test(html),
    "the nav must not still link to a moved address");
});

test("the nav is in the agreed order, with the switch then the cog last", () => {
  const order = ["#/today", "#/pipeline", "#/resumes", "#/guardrails", "#/runs"];
  let at = -1;
  for (const hash of order) {
    const found = html.indexOf(`href="${hash}"`);
    assert.ok(found > at, `the nav link ${hash} is out of order`);
    at = found;
  }
  const slot = html.indexOf('id="autopilot-slot"');
  assert.ok(slot > at, "the autopilot switch must follow the nav links");
  assert.ok(html.indexOf('class="cog"') > slot, "the settings cog must be last");
});

test("the screen is called Pipeline, and every older name still works", () => {
  assert.match(html, /<a href="#\/pipeline" data-nav="pipeline">Pipeline<\/a>/, "the nav link must read Pipeline");
  assert.ok(!/>Queue</.test(html), "index.html must not still call the screen Queue");
  assert.ok(!/>Applications</.test(html), "nor Applications");
  assert.ok(app.includes('queue: "#/pipeline"'), "app.js must still accept the old #/queue address");
  assert.ok(app.includes('applications: "#/pipeline"'), "and the #/applications one");
  assert.match(app, /const keepsSegment = name === "queue" \|\| name === "applications" \|\| name === "home";/,
    "a segment must survive the redirect from an older board address");
});

test("the header carries an autopilot switch against the policy API", () => {
  assert.match(html, /id="autopilot-slot"/, "index.html must hold a slot for the switch");
  assert.match(app, /function autopilotSwitch\s*\(/, "app.js must draw the switch");
  assert.ok(app.includes(`"policy"`), "app.js must read GET /api/policy");
  assert.ok(app.includes("policy/autopilot"), "the switch must post to /api/policy/autopilot");
  assert.match(app, /reason: "ui toggle"/, "a policy change must carry the reason");
  assert.match(app, /guarded\(button, on \? "Turn off" : "Turn on"/, "the switch must arm before it posts");
  // The state is in words with today's cap beside it: "Autopilot" on its own
  // never answered the question the person actually has in the morning.
  assert.match(app, /export function switchLabel\(policy, summary\)/, "the switch label must be one function");
  assert.match(app, /state: `Autopilot \$\{policy\.autopilot_enabled \? "on" : "off"`?\}`/,
    "which names the lane state");
  assert.match(app, /tally: cap === null \? `, \$\{sent\} today` : `, \$\{sent\} of \$\{cap\} today`/,
    "and today's count against the cap, from the summary and the policy");
  assert.match(app, /if \(policy\.kill_switch === true\) return \{ state: "Kill switch on", tally: "" \};/,
    "with the kill switch on the switch says so instead");
  assert.match(app, /class: "switch btn off", disabled: true/, "and refuses to be pressed");
  assert.match(css, /\.switch\.on::before \{ background: var\(--pass\)/, "the on state carries the pass dot");
  assert.match(css, /\.switch\.off::before \{ background: var\(--fail\)/, "the off state the fail dot");
  assert.match(css, /\.switch\.unknown::before \{ background: var\(--muted\)/, "an unreadable policy is a muted dot");
  assert.match(css, /\.switch \.switch-tally \{ display: none; \}/, "and a phone keeps the state and drops the cap");
});

test("the nav folds behind a Menu button on a phone, and the lane stays visible", () => {
  assert.match(html, /class="menu-toggle btn" id="menu-toggle" aria-expanded="false" aria-controls="nav"/,
    "index.html must carry the Menu button, drawn before any script runs");
  assert.match(html, /<nav class="nav closed" id="nav"/, "and the nav must start closed");
  assert.match(app, /export function closeMenu\(\)/, "app.js must be able to close it");
  assert.match(app, /navBar\.classList\.toggle\("closed"\) === false/, "the button must toggle the one class");
  assert.match(app, /menuButton\.setAttribute\("aria-expanded", open \? "true" : "false"\)/, "and say so out loud");
  assert.match(app, /markNav\(route === "row" \? "pipeline" : route\);\n  closeMenu\(\);/,
    "moving screens must close it again");
  assert.match(css, /\.top \.menu-toggle \{ display: none; \}/, "above 720 px there is no Menu button");
  assert.match(css, /\.nav\.closed a\[data-nav\]:not\(\.cog\) \{ display: none; \}/,
    "under it the five links fold, and the switch and the cog do not");
});

test("a missing policy API degrades to a disabled switch", () => {
  assert.ok(app.includes("policy API unavailable"), "app.js must say when the policy API is not there");
  assert.match(app, /error\.status === 404\) policyAvailable = false/, "a 404 must mark the policy API unavailable");
  assert.match(app, /class: "switch btn unknown", disabled: true/, "the fallback switch must be disabled");
  assert.ok(home.includes("policy API"), "Home must say so too rather than guess the lane");
});

test("the cog is a bare icon and the header gaps are on the scale", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const cog = /\.nav \.cog \{([^}]*)\}/.exec(rules);
  assert.ok(cog, "app.css must style the cog");
  assert.ok(!/border:\s*1px/.test(cog![1]), "the cog must carry no border: the switch is the only bordered control up here");
  assert.match(cog![1], /border: 0;/, "the cog's border must be explicitly removed");
  assert.match(cog![1], /background: none;/, "and it must have no fill");
  assert.match(cog![1], /color: var\(--muted\);/, "the cog icon is muted at rest");
  assert.match(cog![1], /width: 36px;\s*height: 36px;/, "the cog keeps a 36 px hit area");
  assert.match(rules, /\.nav \.cog:hover \{ color: var\(--ink\)/, "hover takes the cog to ink");
  assert.match(rules, /\.nav \.cog:focus-visible \{ color: var\(--ink\)/, "so does keyboard focus");
  assert.match(rules, /\.nav \{[^}]*gap: 24px;/, "the nav spaces its links 24 px apart");
  assert.match(rules, /\.switch-slot \{ align-self: center;/, "the switch is centred like the links");
});

test("the kill switch lives on Settings, armed and in red", () => {
  assert.ok(!app.includes("kill-switch"), "the kill switch must not be in the header");
  assert.ok(settings.includes("policy/kill-switch"), "settings.js must post to /api/policy/kill-switch");
  assert.match(settings, /panel\("Safety"/, "the kill switch must sit in a Safety card");
  assert.match(settings, /guarded\(button, on \? "Turn off" : "Turn on"/, "the kill switch must arm before it posts");
  assert.match(settings, /class: "btn btn-danger kill"/, "the kill switch must be the destructive control");
  assert.match(settings, /text: `The kill switch is \$\{on \? "on" : "off"\}\.`/,
    "the card must open with the state in words");
  assert.match(settings, /const resting = on \? "Turn kill switch off" : "Turn kill switch on";/,
    "and the button must name the outcome exactly");
  assert.ok(
    settings.includes("The kill switch halts every unattended send."),
    "the Safety card must explain what the kill switch does",
  );
  // Section 6, Settings: the red left border goes. The card is a plain card
  // and the destructive button is what says this one is dangerous.
  assert.ok(!/\.safety \{[^}]*border-left/.test(css), "the Safety card must not wear a red border any more");
});

test("the counts sentence under the header is gone", () => {
  assert.ok(!/id="standing"/.test(html), "index.html must not still carry the standing counts line");
  assert.ok(!/class="standing"/.test(html), "the standing counts line must be gone from the markup");
  assert.ok(!front.includes("need you, "), "no screen may print the old counts sentence");
  assert.ok(!front.includes("renderHeader"), "the counts header renderer must be gone");
  assert.ok(!/\.standing\s*\{/.test(css), "app.css must not still style the counts line");
});

test("Today is a split decision workbench with supporting context below", () => {
  assert.match(home, /export async function viewHome\(view\)/, "home.js must draw the Today view");
  assert.match(home, /body\.append\(brief\(summary, getPolicy\(\), healthValue, sentRows\.length\)\);/,
    "the brief is the first thing under the greeting");
  for (const section of ["needsYouQueue", "sentSection", "referenceSection", "resumesSection", "themesSection"]) {
    assert.ok(home.includes(`${section}(`), `Today never draws ${section}`);
    assert.ok(lists.includes(`export function ${section}(`), `today-lists.js must own ${section}`);
  }
  assert.ok(home.includes("todayWorkDetail("), "Today must keep the selected application beside its queue");
  assert.ok(src["today-workbench.js"].includes("timeline(row, action)"),
    "the selected application must keep its six stage workflow visible");
  assert.ok(src["today-workbench.js"].includes("Saving an answer does not submit it."),
    "answering and submitting must remain separate actions");
  for (const gone of ["home-grid", "home-card", "home-big", "home-row", "To approve"]) {
    assert.ok(!home.includes(gone) && !lists.includes(gone), `Today still carries the old ${gone}`);
  }
  const todayCss = sheet["today.css"];
  assert.match(todayCss, /\.today-workbench \{[\s\S]*?grid-template-columns: minmax\(320px, 384px\) minmax\(0, 1fr\);/,
    "the desktop workbench must keep a compact queue beside a flexible detail pane");
  assert.match(todayCss, /@media \(max-width: 959px\) \{[\s\S]*?\.today-workbench \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    "the workbench must stack below the desktop breakpoint");
  assert.match(todayCss, /\.today-section \{ margin-top: 32px; \}/, "sections are 32 px apart, on the scale");
});

test("every number in the brief links to the list it counts", () => {
  // Section 7, Brief: a live number is a link, a zero is plain text, a zero
  // clause is left out, and an all-zero paragraph says one sentence instead.
  assert.match(home, /function num\(value, href\) \{/, "the brief must have one way of saying a number");
  assert.match(home, /return value > 0 && href \? h\("a", \{ class: "brief-number", href, text \}\)/,
    "a number with something behind it is a link");
  assert.match(home, /: document\.createTextNode\(text\);/, "and a zero is plain text");
  assert.match(css, /\.brief a, a\.brief-number \{/, "app.css must own how a brief number is drawn");
  assert.ok(home.includes('return ["Nothing needs you."];'),
    "a morning with nothing to do says so in one sentence rather than four zeroes");
  assert.match(home, /if \(!n\) continue;/, "a zero clause is left out of the sentence");
  assert.ok(home.includes('num(n, `#/pipeline/needs#${clause.key}`)'),
    "each group number must link to its own group");
  assert.ok(home.includes('num(sentCount, "#/pipeline/sent")'), "what went out must link to the sent segment");
  assert.ok(home.includes('num(stopped, "#/pipeline/needs")'), "and what stopped must link to the needs segment");
  for (const [one, many] of [["needs an answer", "need an answer"], ["is a portal you open", "are portals you open"],
    ["letter waits on a redraft", "letters wait on a redraft"], ["needs a decision", "need a decision"]]) {
    assert.ok(home.includes(one) && home.includes(many), `the brief has no singular and plural for: ${many}`);
  }
});

test("the brief says the lane in force and when the machine next wakes", () => {
  assert.match(home, /pageHeader\(\{ title: greetingFor\(now, ""\) \}\)/, "Today must draw the greeting as its title");
  assert.ok(!home.includes("lede: standing()"), "the lane sentence must not be a lede as well");
  assert.ok(home.includes('`Autopilot is ${policy.autopilot_enabled ? "on" : "off"}, `'),
    "the brief must name the autopilot state");
  assert.ok(home.includes('"The kill switch is on, so nothing sends unattended."'),
    "and say so plainly when the kill switch is the answer");
  assert.ok(home.includes("` of ${policy.max_per_day} today.`"), "with today's cap against what has gone out");
  assert.ok(home.includes("` Next run ${next}.`"), "and when the next run is");
  assert.ok(home.includes('"The policy API is not answering, so the lane in force cannot be read."'),
    "a policy API that is not there must not be read as a lane");
});

test("Needs you is grouped the way the server grouped it", () => {
  // The group is read off the action the server already derived, so the
  // heading and the number in the brief above it cannot disagree.
  const table = /const GROUP_OF_KIND = \{([\s\S]*?)\};/.exec(lists);
  assert.ok(table, "today-lists.js must mirror needsYouGroup");
  for (const [kind, group] of [["answer", "answer_question"], ["decide", "decide"], ["gate_refused", "decide"],
    ["portal", "open_portal"], ["mark_sent", "open_portal"], ["retry", "waiting_redraft"]]) {
    assert.ok(table![1].includes(`${kind}: "${group}"`), `the mirror is missing ${kind} to ${group}`);
  }
  const server = read(path.join(ROOT, "tools/ui/rows-ext-api.ts"));
  const owned = /const NEEDS_YOU_GROUPS: Partial<Record<RowAction\["kind"\], NeedsYouGroup>> = \{([\s\S]*?)\};/.exec(server);
  assert.ok(owned, "rows-ext-api.ts must still own the classification");
  for (const kind of ["answer", "decide", "gate_refused", "portal", "mark_sent", "retry"]) {
    assert.ok(owned![1].includes(`${kind}:`), `the server no longer classifies ${kind}; the mirror is stale`);
  }
  assert.ok(lists.includes('{ key: "answer_question", title: "Answer a question" }'), "the first group is the questions");
  const order = [...lists.matchAll(/\{ key: "(\w+)", title: "[^"]+" \}/g)].map((m) => m[1]);
  assert.deepEqual(order, ["answer_question", "decide", "open_portal", "waiting_redraft"],
    "the groups are out of the order section 4 fixes");
  assert.match(lists, /const GROUP_CAP = 8;/, "a group lists at most eight rows");
  assert.ok(lists.includes("`Show all ${found.length}`"), "and links to the whole list when it is capped");
  assert.ok(lists.includes("`#/pipeline/needs#${group.key}`"), "which opens that group on the Pipeline screen");
});

test("a Needs you row names its one action by what will happen", () => {
  assert.ok(lists.includes('const OPENS_ROW = { answer: "Answer and retry", decide: "Decide", gate_refused: "Decide" };'),
    "each kind of work must be named, in the words section 7 fixes");
  assert.ok(lists.includes('text: "Open portal",'), "a portal row opens the advert, which is the action itself");
  assert.ok(lists.includes('rel: "noreferrer noopener"'), "and it leaves no referrer behind it");
  // The redraft group is the run's work, so it has no button at all: `retry`
  // classifies into a group but never earns a label.
  assert.ok(!/OPENS_ROW = \{[^}]*retry:/.test(lists), "a row waiting on a redraft must carry no button");
  assert.match(lists, /class: "list-row"/, "a row is the shared list row from app.css");
  assert.match(lists, /scoreCell\(row\.score\)/, "with the shared score cell");
  assert.match(lists, /class: "list-reason", text: reason/, "and the reason in full, never truncated");
  assert.ok(!lists.includes("slice(0, 5)"), "nothing on Today truncates a list to five with no way to the rest");
});

test("Sent overnight is what went out since the last run started", () => {
  assert.match(lists, /export function overnightFrom\(health, runs\)/, "Today must know when overnight began");
  assert.ok(lists.includes("health.last_run ? health.last_run.started_at : null"),
    "which is the instant the last run's log opened");
  assert.match(lists, /export function sentSince\(rows, since\)/, "and filter the sent rows by it");
  assert.ok(lists.includes("const today = localDay();"), "with the person's own calendar day as the fallback");
  assert.match(lists, /const sentAt = \(row\) => row\.submittedAt \|\| row\.submitted_at \|\| row\.updated_at;/,
    "a row is sent when it was submitted, not when it was last touched");
  assert.ok(home.includes("sentSince(sent.value.rows || [], overnightFrom(healthValue, runRows))"),
    "the view must pass the run's start to the filter");
  assert.ok(home.includes("brief(summary, getPolicy(), healthValue, sentRows.length)"),
    "and the brief must count the same list the section lists, so the two cannot disagree");
  assert.match(labelsJs, /new Intl\.DateTimeFormat\("en-CA"\)\.format\(d\)/,
    "the day must be computed with Intl in the browser's own timezone");
});

test("the reference lines at the bottom are one row each", () => {
  for (const key of ["Replies", "Evidence questions", "Last run", "Channels"]) {
    assert.ok(lists.includes(`"${key}"`), `Today never says: ${key}`);
  }
  for (const href of ["#/pipeline/replies", "#/resumes/evidence", "#/settings", "#/guardrails", "#/resumes"]) {
    assert.ok(lists.includes(href), `a reference line does not link to ${href}`);
  }
  assert.ok(lists.includes('pair(`#/runs/${date}`, "Last run"'), "the last run line opens that run's page");
  assert.ok(lists.includes('"finished cleanly"') && lists.includes("`failed, exit ${exit}`"),
    "and says how it ended in words");
  const todayCss = sheet["today.css"];
  assert.match(todayCss, /\.today-pair \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/,
    "a reference line is a name and a value in two columns, so the values line up");
  assert.match(todayCss, /a\.today-pair:hover \{ background: var\(--wash\); text-decoration: none; \}/,
    "a whole row that is a link may tint on hover");
});

test("Home keeps its quote of the day", () => {
  assert.ok(fs.existsSync(path.join(STATIC_DIR, "quotes.js")), "quotes.js must exist");
  assert.match(home, /import \{ quoteFor \} from "\.\/quotes\.js"/, "home.js picks one");
  assert.match(sheet["today.css"], /\.quote \{/, "and today.css sets it");
});

test("Home greets the person by the hour, and says the same thing all hour", () => {
  assert.match(home, /export function greetingFor\(date, name\)/, "home.js must export the greeting for the test");
  for (const pool of ["morning", "afternoon", "evening", "night"]) {
    const found = new RegExp(`${pool}: \\[([^\\]]*)\\]`).exec(home);
    assert.ok(found, `the greeting has no ${pool} pool`);
    const lines = found![1].split('", "').length;
    assert.ok(lines >= 3, `the ${pool} pool has ${lines} lines; three is the minimum`);
    assert.ok(found![1].includes("{name}"), `the ${pool} pool must greet by name`);
  }
  for (const flavour of ["New week, {name}", "Happy Friday, {name}", "Weekend check-in, {name}"]) {
    assert.ok(home.includes(flavour), `the weekday flavour is missing: ${flavour}`);
  }
  assert.match(home, /hash % 3 === 0 \? flavour/, "the weekday line must take the pick one time in three");
  // Pure: the same date and hour must give the same line, so nothing in it may
  // read the clock or roll a die of its own.
  const fn = /export function greetingFor[\s\S]*?\n\}/.exec(home);
  assert.ok(fn, "greetingFor must be one function");
  for (const impure of ["Math.random", "Date.now", "new Date()"]) {
    assert.ok(!fn![0].includes(impure), `greetingFor must be pure: it uses ${impure}`);
  }
  assert.match(home, /at\.getFullYear\(\)\}-\$\{at\.getMonth\(\)\}-\$\{at\.getDate\(\)\}:\$\{hour\}/,
    "the pick must hash the date and the hour, so it holds for the hour");
  assert.match(home, /line\.replace\(\/,\?\\s\*\\\{name\\\}\/, ""\)/, "with no name on file the line must still read");
  assert.match(home, /setAttribute\("aria-label", text\.replace\(\/\\\?\/g, ""\)\)/,
    "a rhetorical question mark must not be read out");
  assert.match(css, /h1 \{\s*margin: 0;\s*font-family: var\(--serif\);\s*font-size: 27px;\s*font-weight: 400;/,
    "the greeting is the 27 px serif page title");
  assert.ok(home.includes("profile.name"), "the name must come from the profile the resumes API carries");
});

test("a run summary is rendered as markdown, not printed as source", () => {
  assert.match(src["markdown.js"], /export function richMarkdown\s*\(/, "markdown.js must own the shared renderer");
  assert.ok(app.includes("richMarkdown"), "and app.js must export it again for the screens");
  assert.ok(runsJs.includes("richMarkdown"), "Runs must render the raw summary through it");
  assert.ok(!/h\("pre", \{ class: "home-journal"/.test(home), "nothing may print a journal as raw source");
});

test("settings opens from a cog in the header, drawn in the page itself", () => {
  assert.match(html, /aria-label="Settings"/, "the header must carry a cog labelled Settings");
  assert.match(html, /<svg[^>]*width="20"/, "the cog must be an inline 20 px svg");
  assert.ok(!/<img/i.test(html), "the cog must not be an external image");
  assert.match(settings, /export function viewSettings\s*\(/, "settings.js must draw the settings view");
});

test("the About card gives the portless way first", () => {
  const order = ["npm run ui:portless", "npm run ui -- --open", "bash scripts/install-ui-launchd.sh", "Tailscale", "enabled: false"];
  let at = -1;
  for (const command of order) {
    const found = settings.indexOf(command);
    assert.ok(found > -1, `the settings About card never says: ${command}`);
    assert.ok(found > at, `the About card lists ${command} out of order`);
    at = found;
  }
  assert.ok(settings.includes("job-hunt.localhost"), "the portless way must name the host it gives");
  assert.match(settings, /This browser is using \$\{location\.origin\}/,
    "the origin must be read from the browser, not hard-coded");
});

test("every API endpoint in the contract is called", () => {
  for (const endpoint of [
    "summary",
    "rows?",
    "rows/",
    "keywords/pending",
    "keywords/record",
    "journal/today",
    "critic/digest",
    "policy",
    "policy/autopilot",
    "policy/kill-switch",
    "runs?limit=30",
    "runs/",
    "rules",
    "rules/standing",
  ]) {
    assert.ok(front.includes(endpoint), `the front end never calls the API endpoint: ${endpoint}`);
  }
});

test("the token is read from localStorage and sent as a bearer header", () => {
  assert.match(app, /harnessUiToken/, "app.js must use the localStorage key harnessUiToken");
  assert.match(app, /Authorization/, "app.js must set an Authorization header");
  assert.match(app, /Bearer \$\{token\}|Bearer " \+ token|Bearer \$\{/, "the token must go out as Bearer");
  assert.match(settings, /id: "token-input"/, "settings.js must draw the token field");
});

test("no em dash and no en dash in the html, the css or any module", () => {
  const files: [string, string][] = [[HTML_PATH, html], [CSS_PATH, css]];
  for (const name of MODULES) files.push([path.join(STATIC_DIR, name), src[name]]);
  for (const [file, body] of files) {
    const hit = /[\u2013\u2014]/.exec(body);
    if (hit) {
      const line = body.slice(0, hit.index).split("\n").length;
      assert.fail(`${path.relative(ROOT, file)}:${line} contains a dash character that is banned`);
    }
  }
});

test("the product is named Job Hunt, under a rocket", () => {
  assert.match(html, /<title>\u{1F680} Job Hunt<\/title>/u, "the document title must be the rocket then Job Hunt");
  assert.match(html, /class="brand"[^>]*aria-label="Job Hunt"/, "the wordmark keeps Job Hunt as its accessible name");
  assert.match(html, /<span class="rocket" aria-hidden="true">\u{1F680}<\/span> Job Hunt</u,
    "the rocket sits before the name and is hidden from a screen reader");
  assert.match(css, /\.brand \.rocket \{ font-size: 18px/, "the rocket must be 18 px so it sits on the wordmark's baseline");
  assert.match(css, /\.brand \{[^}]*font-size: 20px[^}]*font-weight: 600/, "the wordmark stays 20 px and 600");
  const icon = /<link[^>]+rel="icon"[^>]+href="([^"]+)"/.exec(html);
  assert.ok(icon, "index.html must carry a favicon link");
  assert.ok(icon![1].startsWith("data:image/svg+xml,"), "the favicon must be an inline svg data URL, not a file");
  assert.ok(icon![1].includes("%F0%9F%9A%80") || /\u{1F680}/u.test(icon![1]), "the favicon must draw the rocket");
  // The Pipeline screen no longer explains the product to the person who has
  // been using it every morning: its lede is the count of the list under it
  // (the brief, section 4). The name is in the header, on every screen.
  assert.ok(!/Job Hunt drafts and sends applications overnight\./.test(applications),
    "the Pipeline lede is the list's own count, not a sentence about the product");
  assert.ok(!/\bHarness\b/.test(html), "index.html must not still call the product Harness");
});

test("the stylesheet handles dark mode, and the two breakpoints the brief fixes", () => {
  assert.match(css, /prefers-color-scheme:\s*dark/, "app.css must define a dark scheme");
  assert.match(css, /:focus-visible/, "app.css must keep a visible focus ring for keyboard use");
  assert.match(html, /name="viewport"/, "index.html must set a viewport for phone width");
  // Section 7, Responsive: 720 for one column and 960 for the row page's
  // second column. Nothing else, so a screen cannot invent a third.
  assert.match(css, /@media \(max-width: 719px\)/, "app.css must stack everything under 720 px");
  assert.match(css, /@media \(max-width: 959px\) \{\s*\.columns \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    "and keep the row page in one column under 960 px");
  const breakpoints = new Set([...styles.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => m[1]));
  // The two breakpoints, said either way round. A screen that needs neither
  // declares neither; what it may not do is invent a third.
  const allowed = new Set(["719", "720", "959", "960"]);
  const invented = [...breakpoints].filter((width) => !allowed.has(width));
  assert.deepEqual(invented, [], `the only breakpoints are 720 and 960; found ${[...breakpoints].join(", ")}`);
  assert.match(css, /@media \(pointer: coarse\)/, "a touch screen must get a 40 px tap target");
  assert.match(css, /min-height: 40px;/, "and that is what it is");
  assert.match(sheet["today.css"], /@media \(max-width: 719px\) \{/,
    "Today stacks its two column reference lines under 720 px, and stays one column above it");
});

test("every screen draws its title through the one page header", () => {
  // Titles, ledes and top margins used to be set per screen and drifted.
  for (const name of ["home.js", "applications.js", "row.js", "resumes.js", "keywords.js", "runs.js", "rules.js", "settings.js"]) {
    assert.match(src[name], /pageHeader\(\{/, `${name} must draw its title through pageHeader`);
  }
  assert.match(app, /export function pageHeader\s*\(/, "app.js must own the page header");
  assert.ok(app.includes("pageHeader"), "app.js must hand pageHeader to the views it injects helpers into");
  assert.ok(!/class: "page-head"/.test(front), "the old one-off page head must be gone");
  for (const name of MODULES.filter((m) => m !== "app.js")) {
    assert.ok(!/h\("h1"/.test(src[name]), `${name} must not build its own h1`);
  }
  assert.match(css, /\.page-header \{[\s\S]*?margin: 32px 0 24px;/,
    "the header must carry 32 px above it and 24 px before the first card");
  assert.match(css, /\.page-header \.lede, \.page-header \.page-count \{ grid-column: 1 \/ -1; \}/,
    "the lede must run the full width under the title");
  assert.match(css, /\.lede \{\s*margin: 4px 0 0;\s*font-family: var\(--serif\);\s*font-size: 17px;\s*line-height: 1\.45;\s*color: var\(--muted\);/,
    "the lede must sit 4 px under the title and read as a serif sentence");
  assert.match(css, /\.page-aside \{ justify-self: end;/, "the aside must be right aligned on the desktop");
  assert.match(css, /\.page-aside \{ justify-self: start; order: 1;/, "on a phone the aside must drop below the lede");
  // The row detail is the only screen with a back link, and it goes above the title.
  assert.match(src["row.js"], /back: h\("a", \{ href: "#\/pipeline"/, "the row detail back link belongs to the header");
  assert.match(css, /\.page-header \.backlink \{ grid-column: 1 \/ -1; \}/, "the back link sits above the title");
  assert.match(css, /\.backlink \{ margin: 0 0 8px;/, "the back link must sit 8 px above the title");
});

test("the active nav link is underlined in the person's colour", () => {
  assert.match(css, /\.nav a \{[\s\S]*?border-bottom: 2px solid transparent;[\s\S]*?margin-bottom: -1px;/,
    "a nav link must carry a 2 px underline slot that overlaps the header rule");
  assert.match(css, /\.nav a\[aria-current="page"\] \{ font-weight: 600; border-bottom-color: var\(--you\); \}/,
    "the active link must be underlined in --you");
  assert.match(css, /\.nav a:hover \{ text-decoration: none; border-bottom-color: var\(--rule\); \}/,
    "hover must show a hairline underline rather than a text underline");
  assert.match(css, /\.nav \.cog \{\s*align-self: center;/, "the cog stays on the links' vertical centre");
  assert.match(css, /\.switch-slot \{ align-self: center;/, "so does the autopilot switch");
});

test("the type scale and the spacing scale hold across every stylesheet", () => {
  // The brief, section 3: 13, 15, 17, 21, 27, 34. 18 and 20 are the wordmark
  // and its rocket, the one pair fixed outside the scale.
  const SCALE = new Set([13, 15, 17, 21, 27, 34, 18, 20]);
  // Section 7: 4, 8, 12, 16, 24, 32, 48 and nothing else. 10 is the one
  // component metric the same section fixes off it, for a form field's sides.
  const SPACING = new Set([0, 1, 4, 8, 10, 12, 16, 24, 32, 48]);
  for (const name of ["app.css", ...SCREEN_SHEETS]) {
    const body = (name === "app.css" ? css : sheet[name]).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, value] of body.matchAll(/font-size:\s*(\d+)px/g)) {
      assert.ok(SCALE.has(Number(value)), `${name} uses a font size outside the scale: ${value}px`);
    }
    for (const [, decl] of body.matchAll(/(?:^|[\s{;])(?:margin|padding|gap|column-gap|row-gap)[a-z-]*:\s*([^;]+);/g)) {
      for (const [, value] of decl.matchAll(/(\d+)px/g)) {
        assert.ok(SPACING.has(Number(value)),
          `${name} uses a spacing value outside the scale: ${value}px in "${decl.trim()}"`);
      }
    }
  }
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rules, /\.card \{[^}]*padding: 16px/, "a card is padded 16 px everywhere");
  assert.match(rules, /\.card > h2 \{ font-size: 17px; margin: 0 0 12px; \}/,
    "a card heading is 17 px with 12 px under it");
  assert.match(rules, /\.cards \{ display: grid; gap: 24px; \}/, "cards are 24 px apart");
});

test("a button is 36 px on a page, 32 px in a list, and one padding either way", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rules, /button, \.btn \{[\s\S]*?height: 36px;\s*padding: 0 12px;\s*border-radius: 4px;/,
    "primary, secondary and destructive buttons share one height, padding and radius");
  assert.match(rules, /\.list \.btn, \.list button, \.list-action \.btn, \.list-action button, \.btn\.sm, button\.sm \{\s*height: 32px;/,
    "and a button in a list is 32 px");
  assert.match(rules, /button\[disabled\], \.btn\[disabled\] \{ opacity: 0\.5; cursor: not-allowed; \}/,
    "a disabled button keeps its label at half opacity");
  assert.ok(!/\.switch \{ border-radius/.test(rules), "the header switch takes .btn's metrics rather than its own");
});

test("the primitives every screen is built from are defined once, in app.css", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [
    ".brief", ".list", ".list-row", ".list-title", ".list-meta", ".list-score", ".list-reason", ".list-action",
    ".group-heading", ".pill", ".pill-you", ".pill-autopilot", ".pill-status",
    ".pill-pass", ".pill-fail", ".pill-warn", ".pill-none",
    ".segments", ".chips", ".chip", ".btn", ".btn-primary", ".btn-danger", ".card", ".timeline", ".disclosure",
  ]) {
    assert.ok(
      new RegExp(`(^|[,\\s])${selector.replace(".", "\\.")}\\s*[,{]`, "m").test(rules),
      `app.css does not define the shared primitive ${selector}`,
    );
  }
  // The brief's measure and the list's grid are the two the screens build on.
  assert.match(rules, /\.brief \{[\s\S]*?max-width: var\(--measure\);[\s\S]*?font-family: var\(--serif\);[\s\S]*?font-size: 17px;/,
    "the brief is the serif at the reading measure");
  assert.match(rules, /--measure: 62ch;/, "and that measure is 62ch");
  assert.match(rules, /\.list-row \{[\s\S]*?grid-template-columns: 3ch minmax\(0, 1fr\) auto;[\s\S]*?column-gap: 16px;/,
    "a list row is a leading score column, a title cell and an action rail");
  assert.match(rules, /\.list-reason \{[\s\S]*?overflow-wrap: anywhere;/, "and the reason wraps in full");
  assert.ok(!/text-overflow:\s*ellipsis/.test(rules), "nothing in the shared primitives may truncate with an ellipsis");
  assert.match(rules, /\.timeline \.current \.dot \{[^}]*background: var\(--you\)/, "the current timeline step is filled in --you");
  assert.match(rules, /\.timeline \.branch \{/, "and a hold or an exit is a labelled branch");
  assert.match(rules, /\.segments \[aria-current="page"\], \.segments \[aria-selected="true"\] \{[\s\S]*?border-bottom-color: var\(--you\);/,
    "the active segment is underlined in --you");
});

test("a score is a number in ink, and green is kept for a verdict", () => {
  // Section 6, Numbers: scores, counts and exit codes are ink with tabular
  // figures. The green score, the green count and the green exit 0 all go.
  for (const name of ["app.css", ...SCREEN_SHEETS]) {
    const body = (name === "app.css" ? css : sheet[name]).replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...body.matchAll(/\.[a-z-]*score[a-z-]*\s*\{[^}]*\}/g)].map((m) => m[0]);
    if (!rules.length) continue;
    for (const rule of rules) {
      assert.ok(!/var\(--(pass|green)\)/.test(rule), `${name} paints a score with a verdict colour: ${rule}`);
    }
    const painted = rules.filter((rule) => /color:/.test(rule));
    assert.ok(painted.length > 0, `${name} names a score cell but never says what colour it is`);
    for (const rule of painted) {
      assert.match(rule, /color: var\(--ink\)/, `${name} must set a score in ink: ${rule}`);
      assert.match(rule, /font-variant-numeric: tabular-nums/, `${name} must set a score in tabular figures: ${rule}`);
    }
  }
  assert.match(sheet["today.css"], /\.digest-count \{ color: var\(--ink\)/, "a theme count is ink, not green");
});

test("an empty state is a sentence, in the same box everywhere", () => {
  assert.match(css, /\.empty, \.error \{[\s\S]*?border: 1px dashed var\(--rule\);[\s\S]*?font-family: var\(--serif\);[\s\S]*?font-size: 17px;/,
    "empty and error states share one dashed box, set as a serif sentence");
});

test("the type is two families already on the machine, and Inter is gone", () => {
  assert.match(css, /--serif: ui-serif, "New York", "Iowan Old Style", Georgia, serif;/,
    "the voice is the system serif");
  assert.match(css, /--sans: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;/,
    "the data is the system sans");
  assert.ok(!/Inter/.test(styles), "no stylesheet may still ask for Inter");
  assert.match(css, /font-family: var\(--sans\);\s*font-variant-numeric: tabular-nums;\s*font-size: 15px;\s*line-height: 1\.4;/,
    "the body is the sans, tabular, 15 px, 1.4");
  assert.match(css, /\.brief \{[\s\S]*?line-height: 1\.45;/, "and the voice is 1.45");
});

test("the palette is the one the brief fixes, in both themes", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = rules.slice(rules.indexOf(":root {"), rules.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = rules.slice(rules.indexOf("@media (prefers-color-scheme: dark)"));
  for (const [name, lightValue, darkValue] of [
    ["paper", "#ffffff", "#0e0f11"],
    ["ink", "#141414", "#e8e6e1"],
    ["muted", "#66655f", "#9d9b94"],
    ["rule", "#dcdbd6", "#2a2c30"],
    ["wash", "#f4f3ef", "#17181b"],
    ["you", "#2337c6", "#8fa0ff"],
    ["pass", "#1a7f3c", "#4cc574"],
    ["fail", "#b3261e", "#f2685f"],
    ["warn", "#8a5a00", "#d9a03a"],
  ]) {
    assert.ok(light.includes(`--${name}: ${lightValue}`), `app.css must set --${name} to ${lightValue} in light mode`);
    assert.ok(dark.includes(`--${name}: ${darkValue}`), `app.css must set --${name} to ${darkValue} in dark mode`);
  }
  assert.match(rules, /--maxw:\s*1080px/, "the content column must be 1080 px");
  assert.match(rules, /--gutter:\s*24px/, "the gutters must be 24 px");
  // Every name the screens were written against resolves to one of the nine,
  // so a screen still to be rewritten cannot drift off the palette.
  for (const alias of ["page", "card", "hover", "grey", "line", "pill", "pill-ink", "green", "red", "amber"]) {
    assert.match(rules, new RegExp(`--${alias}: var\\(--(paper|ink|muted|rule|wash|you|pass|fail|warn)\\);`),
      `the legacy name --${alias} must resolve to a token, not to a colour of its own`);
  }
  const hexes = [...styles.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const allowed = new Set([
    "#ffffff", "#0e0f11", "#141414", "#e8e6e1", "#66655f", "#9d9b94",
    "#dcdbd6", "#2a2c30", "#f4f3ef", "#17181b", "#2337c6", "#8fa0ff",
    "#1a7f3c", "#4cc574", "#b3261e", "#f2685f", "#8a5a00", "#d9a03a", "#14233b",
  ]);
  for (const hex of hexes) {
    assert.ok(allowed.has(hex), `a stylesheet uses a colour outside the palette: ${hex}`);
  }
});

test("the six pipeline segments are named as the person names them", () => {
  // Section 4: six segments, in this order, and the default is the one the
  // person opens the screen to answer.
  const labels = ["Needs you", "Queue", "Parked", "Sent", "Replies", "Closed"];
  let at = -1;
  for (const label of labels) {
    const found = applications.indexOf(`"${label}"`);
    assert.ok(found > -1, `applications.js is missing the segment label: ${label}`);
    assert.ok(found > at, `segment "${label}" is out of order`);
    at = found;
  }
  // The labels must still map onto the pipeline statuses the API filters by,
  // and the six sets must be exactly the six the server counts in SEGMENTS.
  for (const status of [
    "manual_action_needed", "shortlisted,drafted,awaiting_approval,approved,submission_pending",
    "parked", "submitted", "responded,interview,offered,won", "rejected,withdrawn",
  ]) {
    assert.ok(applications.includes(status), `applications.js does not map a segment onto the statuses: ${status}`);
  }
  assert.match(applications, /SEGMENTS\.find\(\(s\) => s\.key === key\) \|\| SEGMENTS\[0\]/,
    "an address with no segment, or one the screen does not know, opens the first");
  assert.match(applications, /\{ key: "needs", label: "Needs you"/, "and the first is Needs you");
});

test("the pipeline keeps its whole state in the address", () => {
  // Section 3, principle 4: the segment, the chips, the floor and the sort all
  // live in the hash query, so a deep link lands on exactly the list that was
  // shared. The old filter column was module state, so a link landed on
  // whichever bucket the tab was last left on.
  assert.match(applications, /function stateFrom\(which, query\)/, "the screen reads its state off the address");
  assert.match(applications, /q\.get\("channel"\)/, "the channel chips come from the query");
  assert.match(applications, /q\.get\("min"\)/, "so does the score floor");
  assert.match(applications, /q\.get\("sort"\) === "updated"/, "and the sort");
  assert.match(applications, /setQuery\(\{ channel: next\.join\(","\) \}\)/, "a chip writes itself back to the address");
  assert.match(applications, /setQuery\(\{ min: min\.value\.trim\(\) \}\)/, "and so does the floor");
  assert.match(applications, /setQuery\(\{ sort: sort\.value === "score" \? null : sort\.value \}\)/,
    "the default sort is left out of the address rather than written into it");
  assert.match(applications, /String\(which \|\| ""\)\.split\("#"\)/,
    "a segment may carry a group anchor, because Today links at #\\/pipeline\\/needs#open_portal");
  assert.ok(!/const appState = \{/.test(applications), "no module-level filter state may survive");
});

test("the segment strip and the list header carry the same count", () => {
  // Section 2: Home, the board header and the filter column each derived their
  // own count, so one pipeline reported three figures on one screen.
  assert.match(applications, /const counts = \(summary && summary\.segments\) \|\| \{\};/,
    "the strip counts come from GET /api/summary");
  assert.match(applications, /summary\.segments && summary\.segments\[state\.segment\.key\]/,
    "and the list header counts against the same number");
  assert.match(applications, /text: `Showing \$\{shown\} of \$\{total\}`/,
    "a shortened list says which of the two numbers is which");
  assert.match(applications, /text: "Show all", onClick: \(\) => setQuery\(\{ all: "1" \}\)/,
    "and offers the rest through the address, not through module state");
  assert.match(applications, /capped: typeof data\.total === "number" && data\.total > rows\.length/,
    "the cap is the server's own total against what it sent");
  assert.match(applications, /class: "segments"/, "the strip is the shared segments primitive");
  assert.match(applications, /tab\.setAttribute\("aria-current", "page"\)/, "with the current segment marked for a screen reader");
});

test("Needs you is grouped by what the row needs, from the server's own field", () => {
  for (const group of ["answer_question", "decide", "open_portal", "waiting_redraft"]) {
    assert.ok(applications.includes(`"${group}"`), `the Needs you groups must include ${group}`);
  }
  assert.match(applications, /rows\.filter\(\(row\) => \(row\.needs_you_group \|\| "other"\) === group\.key\)/,
    "the grouping is the server's needs_you_group, never a second read of the reason text");
  assert.match(applications, /groupHeading\(group\.key, group\.label, mine\.length\)/,
    "each group is a heading with its own count and the anchor Today links at");
  assert.match(applications, /\{ key: "waiting_redraft", label: "Waiting on a redraft", quiet: true \}/,
    "a row waiting on a redraft is listed quietly");
  assert.match(applications, /section\.append\(browserRow\(state, row, selected\)\)/,
    "and every group uses the compact selection row rather than embedding actions in the list");

  // Today links at one group: #/pipeline/needs#open_portal. The screen lands
  // on that heading and gives it the focus, so it is announced rather than
  // left to be found by eye.
  assert.match(applications, /parseHash\(\)\.fragment \|\| inId \|\| q\.get\("group"\)/,
    "the group is read from the router's fragment, an older router's id, or a ?group= link");
  assert.match(applications, /target\.setAttribute\("tabindex", "-1"\)/, "the heading takes focus");
  assert.match(applications, /target\.scrollIntoView\(\{ block: "start" \}\)/, "and the list scrolls to it");
});

test("the gates strip quotes every verdict, and a gate that never ran says so", () => {
  // Section 7, Gates strip: one chip per gate, the verdict as it was recorded,
  // and "not run" where there is no record. AGENTS.md section 8: a missing
  // verdict is never read as a pass.
  const letter = src["row-letter.js"];
  assert.match(letter, /export function gatesStrip\(pkg, files\)/, "the gates strip is built in one place");
  assert.match(letter, /`\$\{name\} not run`/, "a gate with no record on file must say not run");
  assert.match(letter, /verdict \? TONES\[verdict\] \|\| "pill-warn" : "pill-none"/,
    "and it must wear the muted pill, never a pass");
  for (const gate of ["Critic", "Letter critic", "Slop", "Voice", "Term grounding"]) {
    assert.ok(letter.includes(`gateChip("${gate}"`), `the gates strip is missing the chip: ${gate}`);
  }
  // The old card invented a verdict from the row's status. A row reads
  // "submitted" because it was sent, which says nothing about what the gate found.
  for (const name of ["row.js", "row-letter.js"]) {
    assert.ok(!/status === "submitted"/.test(src[name]), `${name} must not infer a gate verdict from the status`);
  }
  assert.ok(!src["row.js"].includes("Gate waiting"), "and the waiting verdict that said it twice must be gone");
  assert.match(letter, /class: "package-line"/, "the package line sits under the chips");
  assert.match(letter, /resume\.mode === "tailored" \? "Tailored CV" : resume\.mode === "baseline" \? "Baseline CV"/,
    "and it says which CV went in");
  assert.match(sheet["row.css"], /\.gates-strip \{ display: flex; flex-wrap: wrap; gap: 8px; \}/,
    "the chips are one wrapping row 8 px apart");
  assert.match(sheet["row.css"], /\.gate-chip:hover \{/, "a chip that scrolls to its findings says so on hover");
  assert.match(letter, /export const FINDINGS_ID = "letter-findings";/,
    "the findings carry the anchor the chip scrolls to");
  assert.match(letter, /box\.scrollIntoView\(\{ block: "start" \}\)/, "and the chip scrolls to them");
});

test("the row page offers only the moves the state machine allows", () => {
  // docs/pipeline-state-machine.md is the contract. A button that always comes
  // back 409 is a lie about what the person may do, so the card is filtered
  // through the same table tools/pipeline.ts enforces.
  const actions = src["row-actions.js"];
  assert.match(actions, /const VALID_TRANSITIONS = \{/, "row-actions.js must mirror the state machine");
  assert.match(actions, /export const allows = \(status, next\) =>/, "and read it through one helper");
  assert.match(actions, /manual_action_needed: \["approved", "submitted", "rejected", "withdrawn"\]/,
    "the table must match tools/pipeline.ts");
  assert.match(actions, /export function decisionCard\(data, row, onDone\)/, "the decision card is one function");
  for (const label of ["Hold", "Reject", "Withdraw"]) {
    assert.ok(actions.includes(`label: "${label}"`), `the decision card is missing: ${label}`);
  }
  assert.ok(actions.includes('confirm: "Confirm reject"'), "Reject confirms on the button itself");
  assert.ok(actions.includes('confirm: "Confirm withdraw"'), "and so does Withdraw");
  assert.match(actions, /danger: true/, "both are the destructive secondary, never red text alone");
  for (const rung of ["Mark responded", "Interview", "Offer", "Won"]) {
    assert.ok(actions.includes(`label: "${rung}"`), `the response ladder is missing: ${rung}`);
  }
  assert.match(actions, /if \(status !== rung\.from \|\| drawn\.has\(rung\.to\) \|\| !allows\(status, rung\.to\)\) continue;/,
    "a rung is offered only from the status it is legal in");
  assert.ok(actions.includes('text: "Nothing is sent to a channel from here."'),
    "the decision card is a card where that sentence is true, so it says it");
  assert.ok(!/press, then press Confirm/.test(actions), "and the footnote about pressing twice is gone");
  assert.ok(!/eyebrow\(/.test(actions), "no all-caps eyebrow over the buttons");
});

test("the primary action is the server's, and nothing is derived from a regex", () => {
  // Section 4, Row: the one button at the top right comes from the server's
  // `action` field only. The list, this page and the tests read one derivation.
  const actions = src["row-actions.js"];
  assert.match(actions, /export function primaryControl\(data, row, onDone, hooks = \{\}\)/,
    "the primary control is built in one function");
  assert.match(actions, /const act = \(data && data\.action\) \|\| \{ kind: "none" \};/,
    "and it reads the server's action and nothing else");
  for (const kind of ["portal", "answer", "mark_sent", "unpark", "outcome"]) {
    assert.ok(actions.includes(`act.kind === "${kind}"`), `the primary control does not handle the kind: ${kind}`);
  }
  assert.match(actions, /\/\/ in_flight, gate_refused and none/,
    "an in-flight or refused row earns no button at all");
  assert.match(rowJs, /aside: primary \? primary\.node : null,/, "the primary sits on the title's baseline");
});

test("the send is the one control that can submit, and code never presses it", () => {
  // AGENTS.md section 2, and section 3 principle 6: where a button can cause a
  // submission it says so, asks once, and is never pressed by code.
  const actions = src["row-actions.js"];
  assert.match(actions, /export function sendNowControl\(row, refresh, \{ enabled = true \} = \{\}\)/,
    "row-actions.js must own the send control");
  assert.match(actions, /confirmButton\("Send now via autopilot", "Confirm send"/,
    "it must be named for what it does, and confirm once");
  assert.match(actions, /text: `This submits through \$\{sendsThrough\(row\)\}\. Send\?`/,
    "and say which channel it would go out through before it is pressed");
  assert.match(actions, /rows\/\$\{encodeURIComponent\(row\.id\)\}\/retry-now/, "it must post to the retry-now route");
  assert.match(actions, /api\(`jobs\/\$\{encodeURIComponent\(id\)\}`\)/, "and follow the job it starts");
  assert.match(actions, /const POLL_MS = 2000;/, "the job must be polled every two seconds");
  assert.match(actions, /busy\(button, "Sending via autopilot"\)/, "the button says what it is doing while it runs");
  assert.match(actions, /result\.status_after \? `The row is now \$\{statusLabel\(result\.status_after\)\}\.` : ""/,
    "the result must name the status the tool left the row in");
  assert.match(actions, /toast\(said, outcome\.job\.exit_code === 0 \? "" : "bad"\);/,
    "and the toast must say the same words, including a refusal");
  assert.match(actions, /if \(refresh\) refresh\(\);/, "the row is refetched once the job stops");
  // The old page clicked the retry for the person after an answer was banked.
  for (const name of ["row.js", "row-actions.js", "screening.js", "row-letter.js"]) {
    assert.ok(!/\.click\(\)/.test(src[name]), `${name} must not press a control from code`);
  }
  assert.match(rowJs, /send\.button\.disabled = false;\n\s*send\.button\.focus\(\);/,
    "banking an answer enables the send and focuses it, and stops there");
});

test("Redraft letter asks the next run for a new letter", () => {
  const actions = src["row-actions.js"];
  assert.match(actions, /export function redraftControl\(row, requested, getReason\)/,
    "row-actions.js must own the redraft control");
  assert.match(actions, /rows\/\$\{encodeURIComponent\(row\.id\)\}\/redraft/, "it must post to the redraft route");
  assert.ok(actions.includes("The next run rewrites the letter with the critic findings."),
    "the note must say what happens next, and when");
  assert.match(actions, /`Redraft requested \$\{stamp\}/, "an outstanding request must be shown with its date");
  assert.match(rowJs, /redraftControl\(row, data\.redraft_requested/, "the row detail must pass the stored request through");
  // Nothing is rewritten in the browser: the letter that goes out is written
  // by cover-letter-writer in the run (AGENTS.md section 5).
  assert.ok(!/redraft[\s\S]{0,120}cover-letter\.md/.test(actions), "the browser must not write the letter itself");
});

test("an external portal row can be recorded as applied", () => {
  const actions = src["row-actions.js"];
  assert.match(actions, /export function markSentControl\s*\(/, "row-actions.js must own the mark-sent control");
  assert.match(actions, /text: "Mark as applied"/, "the control must carry the label section 7 fixes");
  assert.match(actions, /rows\/\$\{encodeURIComponent\(row\.id\)\}\/mark-sent/, "it must post to the mark-sent route");
  assert.match(actions, /confirmation: reference\.value\.trim\(\)/, "the form must carry a confirmation reference");
  assert.match(actions, /note: note\.value\.trim\(\)/, "and a note");
  assert.match(actions, /confirmButton\("Mark as applied", "Confirm mark as applied"/, "the commit must confirm once");
  assert.ok(actions.includes("Nothing is submitted from here."), "the form must say what it is and is not doing");
  assert.match(front, /act\.kind === "portal" \|\| row\.applyMethod === "external"/,
    "the board must offer it on an external row even when the server does not say so");
});

test("the critic findings say what is wrong and what to do about it", () => {
  const letter = src["row-letter.js"];
  assert.match(letter, /const issue = finding\.issue \?\? finding\.message/, "a finding's issue must be read by its own name");
  assert.match(letter, /const fix = finding\.fix \?\? finding\.suggestion/, "and so must its fix");
  assert.match(letter, /class: "fix-issue", text: issue/, "the issue must reach the page");
  assert.match(letter, /text: `Fix: \$\{fix\}`/, "and the fix must be labelled as one");
  assert.match(letter, /const pinned = findings\.length > 0 && !stale/,
    "warnings on a passing letter are still worth reading");
  // The Rules screen had a `.fix` class of its own, which painted these green.
  assert.ok(!/^\.fix \{/m.test(sheet["guardrails.css"]), "the Guardrails screen must not restyle the finding card");
});

test("the job description is folded, not scrolled inside itself", () => {
  // Section 6, Row page: no inner scroll region anywhere in the app. A nested
  // scroll inside a page that already scrolls is a trap.
  const rowCss = sheet["row.css"];
  assert.match(rowCss, /\.columns \{ display: grid; gap: 24px; align-items: start; \}/,
    "each card is as tall as its own content, so the folded advert does not stretch to the letter");
  assert.match(rowCss, /\.columns > \.card \{ display: flex; flex-direction: column; min-width: 0; \}/,
    "each card must be a column so its body can take the spare height");
  assert.match(rowCss, /\.jd \{ overflow: visible; \}/, "the job description must not scroll inside itself");
  assert.ok(!/\.jd[^{]*\{[^}]*max-height/.test(rowCss), "and it must not keep a height of its own");
  assert.match(css, /\.disclosure \{/, "app.css must own the fold that shows the rest of it instead");
});

test("the letter's controls sit on its title row", () => {
  const letter = src["row-letter.js"];
  assert.match(letter, /class: "card-head" \}, h\("h2", \{ text: "Cover letter" \}\), controls/,
    "Edit and Redraft belong on the card's title row, not in a footer");
  assert.match(letter, /text: "Edit letter"/, "the letter must be editable from there");
  assert.match(letter, /text: "Save letter"/, "and saved from the same spot");
  assert.match(letter, /controls\.append\(save, cancel\)/, "which carries Save and Cancel while editing");
  assert.match(letter, /if \(redraft\) card\.append\(redraft\.extra\)/, "the redraft note is a caption under the title");
  assert.match(css, /\.card-head \{[\s\S]*?justify-content: space-between;/, "the title row must put the controls hard right");
  assert.match(css, /\.card-head-actions \{ display: flex; align-items: center; gap: 8px; \}/,
    "and the controls must sit together on one line");
  assert.match(rowJs, /redraftControl\(row, data\.redraft_requested, null\)/,
    "the redraft control is built by the row and handed to the letter card");
  // Section 7: Escape collapses an open editor without saving, and asks once
  // when there is something to lose. No browser dialog, here or anywhere.
  assert.match(letter, /if \(event\.key !== "Escape"\) return;/, "Escape must close the editor");
  assert.match(letter, /const changed = \(\) => area\.value !== text;/, "it must know whether anything changed");
  assert.match(letter, /if \(!changed\(\)\) return closeEditor\(\);/, "an unchanged editor closes without a question");
  assert.match(letter, /text: "Discard the edits"/, "and a changed one is asked about, in place");
  assert.match(letter, /max-width: var\(--measure\)/.test(sheet["row.css"]) ? /./ : /never/,
    "the letter is set at the reading measure");
  assert.match(sheet["row.css"], /\.letter \{ max-width: var\(--measure\); font-size: 15px; \}/,
    "15 px at 62ch, as section 6 fixes it");
  assert.match(sheet["row.css"], /\.letter-findings \{/, "and the findings sit under the letter, not beside it");
});

test("the row detail reads in one order, history last", () => {
  const view = /export async function viewRow\(([\s\S]*?)\n\}/.exec(rowJs);
  assert.ok(view, "row.js must draw the row in one function");
  const order = ["pageHeader(", "timeline(", "stoppedLede(", "gatesStrip(", "letterCard(", "jdCard(",
    "page.append(screeningSlot)", "decisionCard(", "historyCard(", "mountScreening("];
  let at = -1;
  for (const piece of order) {
    const found = view![1].indexOf(piece);
    assert.ok(found > at, `the row detail draws ${piece} out of order`);
    at = found;
  }
  assert.match(rowJs, /back: h\("a", \{ href: segment \? `#\/pipeline\/\$\{segment\.key\}` : "#\/pipeline"/,
    "the breadcrumb goes to the segment this row is in");
  assert.match(rowJs, /\{ key: "needs", label: "Needs you", statuses: \["manual_action_needed"\] \}/,
    "and the segments are the six the server counts");
  // The facts line is facts. The status left it for the timeline and the pill.
  assert.match(rowJs, /function factsLine\(row\)/, "the facts are one line");
  assert.match(rowJs, /text: "Open the advert"/, "with the advert last on it");
  assert.ok(!/statusLabel\(row\.status\) \|\| null,/.test(rowJs), "and no status among the facts");
});

test("the timeline is the queue as six steps, with a hold as a branch", () => {
  // Section 7, Timeline: six steps, the current one in --you, and a hold or an
  // exit as a labelled branch under the step it left.
  assert.match(rowJs, /const STEPS = \[/, "the steps are one list");
  for (const step of ["discovered", "shortlisted", "drafted", "approved", "sent", "reply"]) {
    assert.ok(rowJs.includes(`label: "${step}"`), `the timeline is missing the step: ${step}`);
  }
  assert.match(rowJs, /h\("ol", \{ class: "timeline", "aria-label": "Progress" \}\)/,
    "the timeline is an ordered list with an accessible name");
  assert.match(rowJs, /index === current \? "current" : index < current \? "done" : ""/,
    "done, current and future are the three states");
  assert.match(rowJs, /if \(branch && index === current\) li\.append\(h\("span", \{ class: "branch", text: branch \}\)\);/,
    "and a hold hangs off the step it left");
  for (const [status, said] of [["parked", "Parked"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"]]) {
    assert.ok(rowJs.includes(`${status}: "${said}"`), `a branch must name ${status} as ${said}`);
  }
  assert.ok(rowJs.includes('answer: "Stopped: question unanswered"'),
    "and a stop says what stopped it, in the person's words");
  assert.match(css, /\.timeline \.branch \{/, "app.css owns the branch");
});

test("the advert folds at twelve lines and remembers the fold", () => {
  // Section 6: no inner scroll region anywhere in the app.
  assert.match(rowJs, /const JD_LINES = 12;/, "the fold is at twelve lines");
  assert.match(rowJs, /text: "Show full description"/, "and the summary says what it opens");
  assert.match(rowJs, /class: "disclosure jd-fold"/, "the fold is the shared disclosure");
  assert.match(rowJs, /const key = `jobHuntJd:\$\{row\.id\}`;/, "the open state is remembered per row");
  assert.match(rowJs, /sessionStorage\.setItem\(key, fold\.open \? "open" : "shut"\)/, "for the session");
  const rowCss = sheet["row.css"];
  assert.ok(!/overflow-y|max-height/.test(rowCss.replace(/\/\*[\s\S]*?\*\//g, "")),
    "nothing on the row page may scroll inside itself");
});

test("every top-level section on the row page shares one 24 px gap", () => {
  // The bug this fixes: every section set its own vertical margin, and the
  // decision card, which set none, sat flush against the letter above it.
  assert.match(rowJs, /const page = h\("div", \{ class: "row-page" \}\);/,
    "the row page must draw its sections inside one box");
  const after = rowJs.slice(rowJs.indexOf('const page = h("div", { class: "row-page" });'));
  const strays = [...after.matchAll(/view\.append\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(strays, ["page"],
    `a row section goes straight on the view instead of into the box: ${strays.join(", ")}`);
  const rowRules = sheet["row.css"].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rowRules, /\.row-page > \* \+ \* \{ margin-top: 24px; \}/,
    "one rule must set the gap for every top-level section on the row page");
  assert.ok(!/\.row-gates \{[^}]*margin:/.test(rowRules),
    "the gates strip must not set its own vertical margin on top of the shared rule");
  // The pills and the facts belong to the title, so they ride inside the header
  // rather than taking 24 px of their own.
  assert.match(rowRules, /\.page-header \.row-intro \{ grid-column: 1 \/ -1; margin-top: 4px; \}/,
    "the header block carries the pills and the facts");
});

test("a row in the autopilot lane is a record, not a decision", () => {
  // AGENTS.md section 2: the lane is decided by the channel, never by who
  // asked. The row says which lane has it, as a pill, and the server decides
  // what is left to press.
  assert.match(rowJs, /function pillLine\(row, data\)/, "the row wears its pills on one line");
  assert.match(rowJs, /const lane = laneLabel\(data\.lane\);/, "the lane is the server's, said in the person's words");
  assert.match(rowJs, /data\.lane === "attended" \? "pill-you" : "pill-autopilot"/,
    "the person's lane takes --you and the run's stays quiet");
  assert.match(rowJs, /if \(data\.lane_reason\) pill\.setAttribute\("title", data\.lane_reason\);/,
    "and why it landed there is the pill's title");
  assert.match(rowJs, /text: "saved by you"/, "a job the person saved says so");
  assert.match(rowJs, /class: "pill pill-status", text: status/, "and the machine's own word is shown once, as a pill");
  // A send is offered only where tools/autopilot-submit.ts would accept one.
  assert.match(rowJs, /const SEND_FROM = new Set\(\["manual_action_needed", "approved"\]\);/,
    "the two statuses a send may start from");
  assert.match(rowJs, /const ONE_CLICK = new Set\(\["quick_apply", "easy_apply"\]\);/,
    "and the two apply methods there is an adapter for");
  assert.match(rowJs, /const canSend = \(row, lane\) => lane === "autopilot"/,
    "an attended row is never offered an unattended send");
});

test("a row the gate refused on policy is never offered a retry", () => {
  // The gate refuses for a reason no button on this page can change (AGENTS.md
  // section 2), so a retry would hand the row straight back to it. The server
  // sends no post on a refused row, and the page draws what the server sent.
  assert.match(rowJs, /const refused = act\.kind === "gate_refused";/,
    "the lede must know the refused action kind");
  assert.match(rowJs, /const note = refused \? String\(act\.note \|\| ""\)\.trim\(\) : "";/,
    "and show the server's own note, in full");
  assert.match(rowJs, /gate_refused: "Stopped: outside the autopilot lane"/,
    "the timeline branch says which lane refused it");
  assert.match(rowJs, /class: "row-why" \}, h\("span", \{ class: "row-why-label", text: "Why it stopped: " \}\)/,
    "the lede is headed in the person's words");
  assert.match(sheet["row.css"], /\.row-why \{[\s\S]*?font-family: var\(--serif\);[\s\S]*?font-size: 17px;/,
    "and set in the serif at 17 px");
  assert.match(rowJs, /function fullReason\(data, row\)/, "a capped reason is completed from the history");
  assert.match(rowJs, /if \(!shown\.endsWith\("…"\)\) return shown/, "because section 6 bans a truncated reason");
  // Nothing on the page pretends a rerun would help: the send is offered only
  // where the server would accept one, and a refused row is not one of those.
  assert.match(rowJs, /act\.kind === "retry" \|\| act\.kind === "answer"/,
    "a send is built only where the server says a retry or an answer is the move");
});

test("the lane and the machine's own status stay in the selected application context", () => {
  // The compact browser is for scanning titles and reasons. Lane and status
  // stay with the selected application's workflow, where they explain what
  // can happen next without crowding every list row.
  assert.match(todayWorkbench, /laneLabel\(data\.lane\)/,
    "the selected application names the lane from the detail API");
  assert.match(todayWorkbench, /statusLabel\(row\.status\)/,
    "and names the machine status beside it");
  assert.match(pipelineRows, /class: row\.lane === "autopilot" \? "pill pill-autopilot" : "pill pill-you"/,
    "the person's lane takes --you and the run's stays quiet");
  assert.match(pipelineRows, /class: "pill pill-status", text: statusLabel\(row\.status\)/,
    "the machine's own word is shown once, as a pill");
  assert.ok(!/text: "in flight"/.test(pipelineRows + applications),
    "no in-flight pill: a submitted row wore one, and the lane pill says it better");
  assert.match(pipelineRows, /const meta = \[row\.company, row\.location, channelLabel\(row\.channel\)\]/,
    "the channel is text in the meta line, because a channel is not a state");
  assert.match(pipelineRows, /const decides = method === "external" \|\| String\(row\.channel \|\| ""\) === "linkedin_jobs";/,
    "and the apply method is a pill only where it decides the lane");

  // needsYou, isInFlight and GATE_REFUSED were each implemented on both sides
  // of the wire. The server's fields are the only copy now.
  assert.ok(!/export const needsYou|export const isInFlight|export const GATE_REFUSED/.test(applications + pipelineRows),
    "no client copy of a derivation the server already sends");
  assert.match(pipelineRows, /act\.kind === "gate_refused"/, "a refused row is read off the server's own kind");
});

test("an action refetches the segment and the summary together, and marks the row", () => {
  // Section 7: an action refetches the list and the summary together and swaps
  // in place without scrolling, and the row it landed on is marked for three
  // seconds so the person can see which line moved.
  assert.match(applications, /await Promise\.all\(\[fetchSegment\(state\), loadSummary\(\)\]\)/,
    "the list and the counts are refetched in one go, so neither is stale beside the other");
  assert.ok(!/render\(\)/.test(applications), "and the screen is repainted in place, not redrawn from the router");
  assert.match(pipelineRows, /const ACTED_MS = 3000;/, "the mark on the row acted on lasts three seconds");
  assert.match(pipelineRows, /row\.classList\.add\("just-acted"\)/, "and is the shared just-acted class");
  assert.match(css, /\.list-row\.just-acted::before \{[\s\S]*?background: var\(--you\);/,
    "which app.css draws as a 2 px bar in the person's colour");
});

test("Today asks the server once for each thing it shows", () => {
  // The lists are the same queries the screen uses for its visible counts.
  assert.ok(home.includes('const WORKED = "manual_action_needed,shortlisted,drafted,awaiting_approval,approved,submission_pending"'),
    "the Needs you lists must be the statuses the summary counts its groups over");
  for (const call of ['api("health")', "api(`rows?status=${WORKED}`)", "api(`rows?status=submitted&limit=${SENT_LOOKBACK}`)",
    'api("resumes")', 'api("keywords/pending?limit=1")', 'api("critic/digest?since=14d")',
    'api("runs?limit=1")', 'api("journal/today")']) {
    assert.ok(home.includes(call), `Today never calls ${call}`);
  }
  assert.match(home, /const \[health, needs, sent, resumes, keywords, digest, runs, journal\] = results;/,
    "the results must be unpacked in the order they were asked for");
  assert.ok(home.includes("const baseSummary = getSummary();"), "the screen must retain the shared pipeline summary");
  assert.ok(home.includes("needs_you: groupedTotal, needs_you_groups: grouped"),
    "and the visible queue counts must be reconciled to the exact rows beside them");
  assert.ok(!home.includes('api("summary")'), "which app.js has already read, so Today must not read it again");
  assert.ok(home.includes("loadError(") && !home.includes("toast("),
    "a load that failed is said in place, never in a toast that disappears");
  assert.match(home, /placeholderRows\(3\)/, "and the list area shows the shape of what is coming");
});

test("the history reads newest first, in the person's words", () => {
  // Section 6, Row page: the person's vocabulary as the title, the machine's
  // own transition in a muted pill after it, the reason in full under it, a
  // hairline spine and no coloured dots.
  assert.match(rowJs, /const MOVES = \{/, "each move must have a word the person would use");
  for (const [status, said] of [["submitted", "Sent"], ["manual_action_needed", "Stopped"], ["parked", "Parked"]]) {
    assert.ok(rowJs.includes(`${status}: "${said}"`), `the history must read ${status} as ${said}`);
  }
  assert.match(rowJs, /for \(const item of \[\.\.\.entries\]\.reverse\(\)\)/, "newest first");
  assert.match(rowJs, /class: "pill pill-status", text: `\$\{from\} to \$\{item\.to \|\| "unknown"\}`/,
    "the machine's transition is the muted pill after it");
  assert.ok(!rowJs.includes('text: "more"'), "the trailing more link is gone");
  assert.match(rowJs, /const REASON_FOLD = 240;/, "a long reason folds rather than truncating");
  assert.match(rowJs, /text: "Show the full reason"/, "and the fold says what it holds");
  const rowCss = sheet["row.css"];
  assert.match(rowCss, /\.history \{[\s\S]*?border-left: 1px solid var\(--rule\);/, "a hairline spine, not a rail of dots");
  assert.ok(!/\.tl-dot/.test(rowCss), "and no coloured dots: a move is not a verdict");
  assert.match(rowCss, /\.hist-when \{[^}]*color: var\(--muted\)/, "the time is muted beside the move");
});

test("a decision carries one reason field, labelled Reason", () => {
  // Section 6, Row page: a field labelled "Reason", no eyebrow, no footnote,
  // and the confirm state on the button itself.
  const actions = src["row-actions.js"];
  assert.match(actions, /function reasonField\(\)/, "the field belongs to one helper");
  assert.match(actions, /h\("span", \{ class: "field-label", text: "Reason" \}\)/, "and it is labelled Reason");
  assert.ok(!actions.includes("goes into the history"), "the aside that read as a second field is gone");
  assert.ok(!actions.includes("Notes for the next run"), "and so is the second field it hid");
  assert.match(actions, /values: \(\) => \(input\.value\.trim\(\) \? \{ reason: input\.value\.trim\(\) \} : \{\}\)/,
    "an empty reason is not posted as an empty string");
  assert.match(actions, /export function sendsThrough\(row\)/, "the send must name the channel it would go through");
  assert.match(actions, /const SEND_METHOD = \{ easy_apply: "Easy Apply", quick_apply: "Quick Apply" \}/,
    "in the channel's own words for the method");
});

test("the screening card is only on the page when a question is", () => {
  const screening = src["screening.js"];
  assert.match(screening, /export async function screeningCard\(\{ row, reason, send, onBanked \} = \{\}\)/,
    "the card is one function");
  assert.match(screening, /if \(!asked\.length\) return null;/,
    "and there is no card at all when nothing on this row is unanswered");
  assert.match(screening, /function field\(text, control, help\)/, "the card must use one labelled control shape");
  assert.ok(screening.includes('field("Your answer", control, help)'), "the answer field must be labelled");
  assert.ok(screening.includes('field("Skill", skill), field("Years", years), save'),
    "skill, years and the button must sit on one row");
  assert.match(screening, /text: "Bank answer"/, "the primary banks the answer");
  assert.match(screening, /text: "Not a real question"/, "and the secondary drops a heading the scraper misread");
  assert.match(screening, /function submitsOnEnter\(control, run\)/, "Enter submits a single-field form");
  // Section 6: the years form and the bank move into one disclosure.
  assert.match(screening, /text: `Answer bank, \$\{bank\.count\} \$\{bank\.count === 1 \? "answer" : "answers"\}`/,
    "the bank is a disclosure that names its count");
  assert.match(screening, /fold\.append\(h\("summary"[\s\S]*?yearsForm\(actions\), bank\.node\)/,
    "and it holds the years form and the banked answers");
  // The sentence is only true on a card that carries no send.
  assert.match(screening, /if \(send\) body\.append\(h\("div", \{ class: "screening-send" \}/,
    "the send sits under the question when there is one");
  assert.match(screening, /else body\.append\(h\("p", \{ class: "field-help", text: "Nothing is sent to a channel from here." \}\)\);/,
    "and the sentence is said only where it is true");
  assert.match(css, /\.field \{ display: grid; gap: 4px; min-width: 0; \}/, "app.css must own the labelled field");
  assert.match(css, /\.field-label \{ font-size: 13px; font-weight: 400; color: var\(--muted\); \}/,
    "a field label is 13 px muted, 4 px above its field");
  assert.match(css, /\.field-error \{ font-size: 13px; color: var\(--fail\); \}/,
    "and an error replaces the help under it");
  assert.match(sheet["row.css"], /\.years-row \{[\s\S]*?align-items: end;/, "the years row must share one baseline");
  assert.match(sheet["row.css"], /\.screening-question \{ margin: 0; font-size: 15px; font-weight: 600; \}/,
    "the question is a 15 px 600 line");
});

test("the pipeline carries the secondary actions the server offers", () => {
  assert.match(pipelineRows, /export function alsoControls\s*\(/, "the row must render action.also");
  assert.match(pipelineRows, /act\.kind === "decide"\) return null/, "a decide row has no primary, only its also buttons");
  assert.match(pipelineRows, /spec\.href \|\| spec\.kind === "portal"/, "an also entry with a link must render as a link");
  assert.match(pipelineRows, /actionButton\(row, \{ key: spec\.post/, "and one with a post must render as a decision");
  assert.match(css, /\.row-extra \{ grid-column: 1 \/ -1; \}/, "a form a row opens must run the row's width");
  assert.match(css, /\.action-extra \{ display: grid;/, "and on the row detail it must sit under the button row");
  assert.match(todayWorkbench, /const actionable = \{ \.\.\.row, action \};/,
    "the selected workbench must join the detail API action back onto the row before rendering controls");
  assert.match(todayWorkbench, /contextualControl\(actionable, changed/,
    "so Parked, Closed and Needs you keep the action supplied beside the detail row");
});

test("Sent groups the applications that have gone quiet, in the same row style", () => {
  // Section 6: the follow-ups were a bordered inner list with their own row
  // style, their own buttons and a footnote. They are a group heading now.
  assert.match(applications, /const FOLLOW_UP_SHOWN = 8;/, "the follow-up group shows eight before it offers the rest");
  assert.match(applications, /groupHeading\("followups", `No reply after 7 days`, followups\.length, showAll\)/,
    "the heading names the thing and its count, with Show all on the same line");
  assert.match(applications, /state\.segment\.key === "sent"\s*\? \[\.\.\.\(data\.followups \|\| \[\]\), \.\.\.rows\]/,
    "a selected follow-up keeps its enriched row when the submitted row has the same id");
  assert.match(todayWorkbench, /label: "Mark responded", path: "outcome"/,
    "and the selected application's action records the reply the person already had");
  assert.ok(!/class: "nudge-card"|nudge-row/.test(applications + pipelineRows),
    "the bordered inner list and its own row style are gone");
});

test("a closed row can be reopened, with a reason, to discovered", () => {
  assert.match(todayWorkbench, /const reopen = reopenControl\(actionable, changed/,
    "the selected Closed application offers the one move a closed row has");
  assert.match(pipelineRows, /export function reopenControl\(row, done/, "which is its own control, because it asks for a reason");
  assert.match(pipelineRows, /body: \{ action: "reopen", reason: reason\.value\.trim\(\) \}/,
    "posting the server's own reopen action, the same one the row page posts");
  assert.match(todayWorkbench, /action\.kind === "reopen"/,
    "and the control is offered because the server said so, not because the segment is Closed");
  assert.match(pipelineRows, /guarded\(save, "Reopen"/, "armed like every other move");
  assert.match(pipelineRows, /h\("label", \{ class: "field-label", text: "Reason" \}\)/,
    "with the reason labelled above the field, not only in a placeholder");
});

test("there is one time format, and every screen reads it from one place", () => {
  assert.match(labelsJs, /const MONTHS = \["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"\]/,
    "labels.js must carry the three letter months, because en-AU says Sept");
  assert.match(labelsJs, /export function shortDate\s*\(/, "labels.js must own the one short date");
  assert.match(labelsJs, /export function dayStamp\s*\(/, "and the one day stamp");
  // Section 6, Global components: four formats were in use and the same
  // instant read four ways on one screen.
  assert.match(labelsJs, /export function when\(iso, now\)/, "labels.js must own the one time helper");
  assert.match(labelsJs, /if \(day\(d\) === day\(at\)\) return clockTime\(d\);/, "today is the clock");
  assert.match(labelsJs, /daysAway < 7/, "a week either side is the weekday and the clock, so a next run reads Mon 07:00");
  assert.match(labelsJs, /d\.getFullYear\(\) === at\.getFullYear\(\) \? short : `\$\{short\} \$\{d\.getFullYear\(\)\}`/,
    "this year is the day and the month, and anything older carries its year");
  assert.match(labelsJs, /export function whenFull\(iso\)/, "and the whole instant belongs in a title attribute");
  assert.ok(app.includes("when, whenFull"), "app.js must export both again for the screens");
  for (const name of MODULES) {
    assert.ok(!/month:\s*"short"/.test(src[name]), `${name} must not format a month itself: en-AU spells it Sept`);
  }
});

test("a channel, a status, a lane and a duration are said once, and the server agrees", () => {
  // The brief, section 2: channelLabel and duration were implemented two and
  // three times across the client and the server, and the copies disagreed.
  for (const helper of ["channelLabel", "statusLabel", "laneLabel", "duration"]) {
    assert.match(labelsJs, new RegExp(`export (function|const) ${helper}\\b`),
      `labels.js must own ${helper}`);
    assert.ok(app.includes(helper), `and app.js must export ${helper} again for the screens`);
    const copies = MODULES.filter((name) => name !== "labels.js" && name !== "app.js")
      .filter((name) => new RegExp(`(export )?function ${helper}\\s*\\(|(export )?const ${helper}\\s*=`).test(src[name]));
    assert.deepEqual(copies, [], `${helper} is implemented again in ${copies.join(", ")}`);
  }
  assert.match(app, /export function scoreCell\(score\)/, "app.js owns the score cell, because it builds a node");
  assert.match(app, /class: "list-score", text: value/, "which is the list's own score cell");
  // The lane, in the person's words: "You" is the lane nothing leaves without
  // them (AGENTS.md section 2).
  assert.match(labelsJs, /const LANE_LABELS = \{ autopilot: "Autopilot", attended: "You" \};/,
    "the two lanes are Autopilot and You");
  assert.match(labelsJs, /"48 s", "4 m 12 s",\n \* "1 h 46 m"/, "and there is one duration format, documented");
});

test("the pipeline is a compact application browser beside the selected workflow", () => {
  // The segment strip and compact filters lead into the selected design's
  // master-detail workbench. Rows are selection targets and actions stay in
  // the workflow pane rather than making each application a small form.
  assert.ok(!/"Filters"|"Minimum score"|filter-card|class: "job"/.test(applications),
    "the filter column and the job card are gone");
  assert.match(applications, /class: "chips"/, "the filters are the shared chips row");
  assert.match(applications, /class: "inline-field", for: "min-score"/, "with the score floor labelled inline");
  assert.match(applications, /class: "inline-field", for: "sort-rows"/, "and the sort the same way");
  assert.match(applications, /text: "Min score"/, "the label is sentence case, not an all-caps eyebrow");
  assert.match(applications, /class: `list-row pipeline-item\$\{row\.id === selected \? " selected" : ""\}`/,
    "a browser row is one selectable list row");
  assert.match(applications, /class: "pipeline-item-reason"/, "with the reason in full under the application facts");
  assert.ok(!/\.\.\.|…/.test(applications.match(/class: "pipeline-item-reason"[^)]*\)/)?.[0] ?? ""),
    "and nothing about it is truncated");
  assert.match(applications, /class: "pipeline-workbench"/, "the application browser and selected workflow share one workbench");
  assert.match(applications, /todayWorkDetail\(selected/, "the detail pane reuses the workflow context from Today");
  assert.match(sheet["pipeline.css"], /\.chip-group \{ display: flex;/, "the channel chips wrap as one group");
  assert.match(css, /\.pill \{/, "and app.css must own the pill");
});

test("the buttons carry the three weights and the confirm state", () => {
  assert.match(css, /\.primary, \.btn-primary \{[\s\S]*?background: var\(--ink\)/, "the primary button is the ink fill");
  assert.match(css, /\.danger, \.btn-danger \{ color: var\(--fail\); border-color: var\(--rule\); \}/,
    "a destructive button is the hairline secondary with fail text, never red text alone");
  assert.match(css, /\.danger:hover, \.btn-danger:hover \{ border-color: var\(--fail\)/,
    "and on hover the border takes the fail colour");
  assert.match(css, /\.armed \{[\s\S]*?background: var\(--ink\)/, "an armed action takes the primary style");
  assert.match(css, /\.armed\.danger, \.armed\.btn-danger \{[\s\S]*?background: var\(--fail\)/,
    "and an armed destructive one the fail fill");
  assert.match(css, /\.confirm \{ display: inline-flex;/, "the armed button and its Cancel sit together");
});

test("a status reaches the page in the person's vocabulary, not as a key", () => {
  assert.match(labelsJs, /export function statusLabel\s*\(/, "labels.js must have one statusLabel helper");
  // The brief, section 3, principle 5: these words and no others. The machine's
  // own word is shown once, as a pill, and this is what is said everywhere else.
  for (const [status, said] of [
    ["manual_action_needed", "Needs you"],
    ["shortlisted", "In queue"],
    ["drafted", "In queue"],
    ["awaiting_approval", "In queue"],
    ["approved", "In queue"],
    ["submission_pending", "Being sent"],
    ["submitted", "Sent"],
    ["responded", "Replied"],
    ["offered", "Offer"],
    ["parked", "Parked"],
  ]) {
    assert.ok(labelsJs.includes(`${status}: "${said}"`), `${status} must read as ${said}`);
  }
  assert.match(labelsJs, /replace\(\/_\/g, " "\)/, "an unmapped status must fall back to the key with spaces");
  assert.ok(
    !/\$\{item\.from \|\| "new"\}/.test(rowJs),
    "the history must not print a raw status key",
  );
});

test("the stylesheet keeps to the flat card house style", () => {
  // Prose in a comment must not satisfy or break the check, so read the rules only.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Section 6: no all-caps labels anywhere. A small label is sentence case,
  // 13 px, muted.
  for (const name of ["app.css", ...SCREEN_SHEETS]) {
    const body = (name === "app.css" ? css : sheet[name]).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/box-shadow/i.test(body), `${name} must not use box-shadow: surfaces are flat`);
    assert.ok(!/text-transform:\s*uppercase/i.test(body), `${name} must not shout: nothing is all caps`);
  }
  assert.match(rules, /\.eyebrow\s*\{[^}]*font-size:\s*13px[^}]*color:\s*var\(--muted\)/,
    "a small label is 13 px muted, in sentence case");
  assert.match(rules, /\.card\s*\{[^}]*border-radius:\s*6px/, "a card must have a 6 px radius");
  assert.match(rules, /button, \.btn \{[^}]*border-radius: 4px/, "a button must have a 4 px radius");
  assert.match(rules, /outline:\s*2px solid var\(--you\)/, "focus must show a 2 px outline in the person's colour");
  assert.match(rules, /prefers-reduced-motion/, "app.css must respect prefers-reduced-motion");
});

test("the Resumes screen sits between Pipeline and Guardrails", () => {
  assert.match(html, /<a href="#\/resumes" data-nav="resumes">Resumes<\/a>/, "the nav link must read Resumes");
  assert.match(html, /<a href="#\/guardrails" data-nav="guardrails">Guardrails<\/a>/, "the nav link must read Guardrails");
  assert.match(html, /<a href="#\/runs" data-nav="runs">Runs<\/a>/, "the nav link must read Runs");
  const order = ["#/pipeline", "#/resumes", "#/guardrails", "#/runs"];
  let at = -1;
  for (const hash of order) {
    const found = html.indexOf(`href="${hash}"`);
    assert.ok(found > at, `the nav link ${hash} is out of order`);
    at = found;
  }
});

test("the Resumes screen lives in its own module that app.js routes to", () => {
  assert.match(app, /route === "resumes"/, "app.js must route #/resumes to the resumes view");
  assert.match(resumesJs, /export async function viewResumes\s*\(/, "resumes.js must export the view");
  assert.ok(resumesJs.includes('"resumes"'), "resumes.js must call GET /api/resumes");
  assert.match(app, /viewResumes\(view, id, query\)/, "the selected resume must travel in the address query");
});

test("the Resumes screen renders nothing, and approves only through the tool", () => {
  // AGENTS.md section 5: rendering belongs to resume-writer and the content
  // review to resume-critic, so neither is offered here. Approval is offered,
  // and it is the real `resume:approve` behind the API, gate and all.
  // Section 6: the grey footer paragraph about resume:approve moves into the
  // empty state and the approve confirmation, and appears nowhere else.
  assert.match(resumesJs, /const APPROVE_GATE = "Approving runs resume:approve, which refuses without a current critic verdict\.";/,
    "the sentence about the gate must be named once");
  assert.equal(resumesJs.split("APPROVE_GATE").length - 1, 3,
    "and used in exactly two places: the empty state and the approve confirmation");
  assert.ok(
    resumesJs.includes("No positionings yet. Run /onboarding, then /resume-review."),
    "the empty state must point at /onboarding and /resume-review",
  );
  assert.ok(!resumesJs.includes("Rendering runs through /resume-review with the person present."),
    "the grey footer paragraph under every card must be gone");
  assert.ok(!/text:\s*"Render\b/.test(resumesJs), "resumes.js must not offer a Render button");
  // The resume is visible in the third layer. File formats are quiet links
  // below it rather than three actions competing with the preview tabs.
  assert.match(resumesJs, /fileLink\("PDF", files\.pdf, note\)/, "PDF remains available below the inline preview");
  assert.match(resumesJs, /fileLink\("DOCX", files\.docx, note\)/, "DOCX remains available");
  assert.match(resumesJs, /fileLink\("Markdown", files\.md, note\)/, "and so does Markdown");
  assert.match(resumesJs, /class: "resume-file-link"/, "file formats are links, not primary buttons");
  assert.match(resumesJs, /`Critic \$\{said\}\$\{round\}`/, "the card must carry a critic line");
  assert.ok(resumesJs.includes("positionings"), "the count line must say how many positionings there are");
  assert.ok(home.includes("stamp"), "the Home resumes card must carry the approval stamp");
});

test("a resume artefact is fetched with the token and opened as a blob", () => {
  // resumes-api.ts used to hand out a bare relative url, so with
  // HARNESS_UI_TOKEN set every PDF, DOCX and page image came back 401. The
  // file route sits behind the same bearer gate as every other /api call, so
  // the browser fetches it with the header rather than linking straight at it.
  assert.match(resumesJs, /headers\.Authorization = `Bearer \$\{token\}`/,
    "an artefact must go out with the same bearer header every API call carries");
  assert.match(resumesJs, /URL\.createObjectURL\(await response\.blob\(\)\)/, "and come back as an object url");
  assert.match(resumesJs, /const tab = window\.open\("", "_blank"\);/,
    "the tab must be opened inside the click, before the await, so a popup blocker lets it through");
  assert.ok(!/window\.open\("", "_blank", "noopener"\)/.test(resumesJs),
    "and without noopener, which returns null and would put the artefact over the app");
  assert.ok(!/token=/.test(resumesJs), "the token must never ride in a query string");
  const apiSource = fs.readFileSync(path.join(ROOT, "tools/ui/resumes-api.ts"), "utf8");
  assert.match(apiSource, /return `\/api\/resumes\/\$\{encodeURIComponent\(resumeId\)\}\/file\/\$\{encodeURIComponent\(name\)\}`;/,
    "and the url the server hands out must be absolute, not relative to whatever hash the person is on");
});

test("approving a render is armed, gated on the critic, and posts to the tool", () => {
  assert.match(resumesJs, /confirmButton\("Approve", "Confirm approve"/,
    "approval must arm once, on the button itself, and say what the second press does");
  assert.match(resumesJs, /\{ class: "btn btn-primary" \}/, "approval is the primary action on the card");
  assert.match(resumesJs, /if \(criticPassed && !approved\) actions\.append\(approveControl\(item\)\);/,
    "approval must only be offered on a passing critic and an unapproved stamp");
  assert.match(resumesJs, /api\(`resumes\/\$\{encodeURIComponent\(item\.id\)\}\/approve`/,
    "approval must post to the resume approve route");
  assert.match(resumesJs, /note\.textContent = box\.button\.classList\.contains\("armed"\) \? APPROVE_GATE : "";/,
    "the armed state is where the sentence about the critic verdict belongs");
  assert.match(resumesJs, /\$\{plural\(total, "finding"\)\} to review/,
    "open critic findings must be named as work, with their count");
  assert.match(resumesJs, /class: "disclosure" \}[\s\S]*?plural\(total, "finding"\)/,
    "and the count must be the summary of the fold that holds them");
  // A refusal is the tool's own words. Softening it into a pass is the failure
  // mode AGENTS.md section 3.8 exists to stop.
  assert.match(resumesJs, /class: "approve-refusal", text: error\.message/, "a refusal must be shown verbatim");
});

test("the gate chips are gone, replaced by a tally and a fold", () => {
  assert.match(resumesJs, /`Gates: \$\{parts\.join\(", "\)\}`/, "the gates must read as one sentence");
  assert.match(resumesJs, /const parts = \[`\$\{pass\.length\} pass`\];/, "which always names the passes");
  assert.match(resumesJs, /if \(warn\.length\) parts\.push\(`\$\{warn\.length\} warn`\);/,
    "and names a warn count only when there is one: nobody needed 0 fail");
  assert.match(resumesJs, /h\("details", \{ class: "disclosure" \}, h\("summary", \{ text: said \}\)\)/,
    "everything that is not a pass sits behind a disclosure");
  assert.match(resumesJs, /class: `pill \$\{tone\}`, text: verdict/,
    "the fold must carry the recorded verdict as a pill, in words");
  assert.ok(!/function gateChip/.test(resumesJs), "the unlabelled chip row must be gone");
  // One time format everywhere (section 6, Global components).
  assert.match(resumesJs, /text: `Approved \$\{when\(item\.approved_at\)\}`/, "the stamp date must come from when()");
  assert.match(resumesJs, /`rendered \$\{when\(item\.last_render_at\)\}`/, "and so must the render date");
  assert.ok(!/slice\(0, 10\)/.test(resumesJs), "no screen may cut an ISO stamp by hand");
});

test("the Resumes screen has two tabs and the keyword view is the second", () => {
  assert.match(resumesJs, /label: "Baselines"/, "the first tab must be Baselines");
  assert.match(resumesJs, /label: "Evidence questions"/, "the second tab must be Evidence questions");
  assert.match(resumesJs, /pageHeader\(\{ title: "Resumes", lede: count, aside: tabStrip\(active\) \}\)/,
    "the tabs must sit in the one page header, not in a header of their own");
  assert.match(resumesJs, /viewKeywords\(view, \{ lede: count \}\)/,
    "the keyword view must render under the Resumes header rather than a second one");
  assert.match(keywords, /Run \/keyword-triage first: it clears rows that are not skills/,
    "a long ledger must be sent to /keyword-triage first");
  assert.match(keywords, /TRIAGE_THRESHOLD = 40/, "the banner threshold must be 40 pending terms");
  assert.match(keywords, /banner\.hidden = pending <= TRIAGE_THRESHOLD/, "and it must only show above it");
});

test("the Guardrails screen promotes a theme, edits a rule and shows the patterns read only", () => {
  assert.match(rulesJs, /export async function viewRules\s*\(/, "rules.js must export the view");
  assert.match(rulesJs, /pageHeader\(\{ title: "Guardrails", lede: count \}\)/, "the screen is titled Guardrails");
  for (const title of ["Recurring critic themes", "Standing rules", "Never named", "Editorial bans"]) {
    assert.ok(rulesJs.includes(title), `the Guardrails screen is missing: ${title}`);
  }
  // Section 4: the rules in force come first, then what the critic keeps
  // saying, then the machine-readable reference, collapsed.
  const order = ["standingSection(rules)", "themesSection(digest)", "referenceSection(rules)"];
  let at = -1;
  for (const call of order) {
    const found = rulesJs.indexOf(`${call}`, rulesJs.indexOf("host.append(standingSection"));
    assert.ok(found > at, `the sections are out of order at ${call}`);
    at = found;
  }
  // A theme key is machinery. `standing-rule-4:other` is not a heading.
  assert.match(rulesJs, /export function themeTitle\s*\(/, "a theme key must reach the page as words");
  assert.match(rulesJs, /`Standing rule \$\{numbered\[1\]\}`/, "standing-rule-4 must read as Standing rule 4");
  assert.match(rulesJs, /inflate: "inflation"/, "a verb class must read as its noun");
  assert.match(rulesJs, /\(theme\.count \?\? 0\) >= 2/, "only a theme said twice is expanded");
  assert.match(rulesJs, /text: `\$\{plural\(singles\.length, "single finding"\)\}`/,
    "singletons sit behind a disclosure that counts them");
  assert.match(rulesJs, /text: "Promote to standing rule"/, "a theme must offer promotion");
  assert.match(rulesJs, /guarded\(promote, "Promote"/, "promotion must arm before it writes");
  assert.match(rulesJs, /api\("rules\/standing", \{ method: "POST", body: \{ text, source_theme: theme\.key \} \}\)/,
    "promotion must post the rule text and the theme it came from");
  assert.match(rulesJs, /class: "theme-sample", text: theme\.sample/, "the sample finding is a quotation, not a nested box");
  assert.match(rulesJs, /class: "list-score", text: String\(theme\.count \?\? 0\)/,
    "the count is a number in ink on the right, never a green pill");
  assert.match(rulesJs, /api\(`rules\/standing\/\$\{index\}`/, "a rule must be editable in place");
  assert.match(rulesJs, /api\(`rules\/standing\/\$\{index\}\/remove`/, "a rule must be removable");
  assert.match(rulesJs, /confirmButton\("Remove", "Confirm remove"/, "removal must confirm on itself before it writes");
  assert.match(rulesJs, /\{ class: "btn btn-danger" \}/, "removal is the destructive control");
  assert.match(rulesJs, /class: "list-row rule-row"/, "a standing rule is a full-width row");
  assert.match(sheet["guardrails.css"], /\.rules \.list-action, \.themes \.list-action \{ align-self: start;/,
    "and Edit and Remove sit on its first line, not centred against the paragraph");
  // The patterns are read only on purpose: a regex typed into a browser is a
  // way to quietly stop blocking a client's name. Description first, the
  // pattern after it, the fix muted, and nothing coloured like a link.
  assert.ok(rulesJs.includes("text: `Edit these in ${rules.path}, not here.`"),
    "the never-named fold must name the file to edit");
  assert.ok(rulesJs.includes("text: `Edit these in ${bans.path}, not here.`"),
    "and so must the editorial bans");
  assert.match(rulesJs, /class: "ref-what"[\s\S]*?class: "ref-pattern"[\s\S]*?class: "ref-fix"/,
    "a reference entry reads description, pattern, fix, in that order");
  assert.match(sheet["guardrails.css"], /\.ref-fix \{[^}]*color: var\(--muted\)/, "the fix line is muted");
  assert.ok(!/var\(--you\)/.test(sheet["guardrails.css"].replace(/focus-visible[^}]*\}/g, "")),
    "nothing on Guardrails is coloured like a link unless it is one");
  assert.ok(!/api\("rules\/never-named/.test(rulesJs), "nothing may post a never-named pattern");
});

test("the Runs screen lists runs newest first, each one a link to its page", () => {
  assert.match(runsJs, /export async function viewRuns\s*\(view, id\)/, "runs.js must route the list and one run");
  assert.ok(runsJs.includes("runs?limit=30"), "the list must ask for the last thirty runs");
  assert.match(runsJs, /newest first/, "the count line must say the order");
  assert.ok(
    runsJs.includes("No runs yet. Start one with npm run daily."),
    "the empty state must say what would put something here",
  );
  assert.ok(runsJs.includes('h("a", { class: "list-row run-row", href: `#/runs/${encodeURIComponent(run.date)}` })'),
    "a whole row is the link to that run's page, so the date, the tally and the verdict are one target");
  assert.match(css, /a\.list-row:hover, \.list-row\.is-link:hover \{ background: var\(--wash\)/,
    "and a row that is a link may tint on hover");
  assert.match(sheet["runs.css"], /\.run-row \{ color: inherit; text-decoration: none; \}/,
    "a row that is a link must not underline every line inside it");
  assert.ok(!runsJs.includes("aria-expanded"), "a run is a page now, not an accordion");
  assert.ok(runsJs.includes("duration("), "a run must say how long it took, from the one shared helper");
  assert.ok(!/function duration\s*\(/.test(runsJs), "and it must not carry a second copy of it");
  assert.ok(runsJs.includes('bits.push("no summary")'), "a run with no summary says so, quietly");
});

test("a run's exit is one verdict pill that carries the word as well as the colour", () => {
  // Section 6: "exit 0" in green and "exit 1" in red as bare text are gone.
  assert.match(runsJs, /export function verdictPill\(run\)/, "runs.js must own the one pill");
  assert.ok(runsJs.includes('h("span", { class: "pill pill-you", text: "Running" })'),
    "a run still going is its own state, in the person's colour, not a failure in red");
  assert.ok(runsJs.includes('h("span", { class: "pill pill-pass", text: "Finished" })'), "a clean exit reads Finished");
  assert.ok(runsJs.includes("`Failed, exit ${run.exit_code}`"), "a nonzero exit reads Failed and says which");
  assert.ok(runsJs.includes('run.has_log ? "No finish line" : "No log"'),
    "and a run with no exit code says which of the two reasons it has");
  assert.ok(!/run-exit/.test(runsJs) && !/run-exit/.test(sheet["runs.css"]),
    "the old bare exit text and its colours must be gone");
  assert.ok(!runsJs.includes("var(--amber)"), "and nothing on this screen paints itself outside the palette");
  assert.match(css, /\.pill-pass \{ background: transparent; border-color: var\(--pass\); color: var\(--pass\); \}/,
    "the verdict pills are the shared primitives in app.css");
  assert.match(home, /export function soFar\(seconds\)/, "home.js must still say how long a run has been going");
  assert.ok(home.includes("`${minutes} min so far`"), "a run in progress is read in minutes, not in seconds");
  assert.ok(runsJs.includes('import { soFar } from "./home.js";'), "and Runs must read it from there");
});

test("a run is a real page: sent, stopped, numbers, and the raw text folded away", () => {
  assert.ok(runsJs.includes('fetchInto(host, `runs/${encodeURIComponent(date)}`'),
    "the page must fetch its own run");
  assert.ok(runsJs.includes('back: h("a", { href: "#/runs", text: "Runs" })'), "with a breadcrumb back to the list");
  for (const section of ["sectionHead(\"Sent\"", "sectionHead(\"Stopped\"", "sectionHead(\"Numbers\""]) {
    assert.ok(runsJs.includes(section), `the run page is missing the section: ${section}`);
  }
  assert.ok(runsJs.includes('h("a", { class: "list-title", href: `#/row/${encodeURIComponent(entry.id)}`, text: title })'),
    "a row this run touched must link to the application");
  assert.ok(runsJs.includes('h("span", { class: "list-title", text: title })'),
    "and stay plain text when the run named no id, rather than linking at the wrong row");
  assert.ok(runsJs.includes('h("h3", { class: "group-heading" },'), "the stopped rows are grouped, each group headed");
  assert.ok(runsJs.includes('fold("Raw summary"') && runsJs.includes('fold("Raw log"'),
    "the run's own words stay, folded away under the structure");
  assert.ok(runsJs.includes('class: "disclosure run-fold"'), "each fold is the shared disclosure");
  assert.ok(runsJs.includes("Letters sent unattended"), "and the letters it sent are named as such (AGENTS.md 3.9)");
  assert.ok(runsJs.includes("This run is still working"), "a run in progress says what it has written so far");
  assert.ok(runsJs.includes("read from the audit log"), "and a day with no summary says where its rows came from");
  const runsCss = sheet["runs.css"];
  assert.match(runsCss, /\.run-log \{[\s\S]*?white-space: pre-wrap;/,
    "the raw log wraps: there is no inner scroll region in this UI");
  assert.ok(!/overflow: auto/.test(runsCss), "and nothing on this screen scrolls inside itself");
  assert.match(runsCss, /\.run-numbers \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/,
    "the Numbers table is a two column list, so the figures line up");
  assert.match(runsCss, /\.run-number-value \{[^}]*color: var\(--ink\)/, "a figure is ink, never a verdict colour");
});

test("Resumes uses a three-level selection workbench", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const resumesCss = sheet["resumes.css"].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rules, /\.stamp\.approved \{ color: var\(--pass\)/, "an approved stamp takes the pass colour");
  assert.match(rules, /\.stamp\.missing \{ color: var\(--fail\)/, "a missing render the fail colour");
  assert.match(resumesCss, /\.resume-workbench \{[\s\S]*?grid-template-columns: minmax\(220px, 25%\) minmax\(340px, 1fr\) minmax\(320px, 37%\);/,
    "desktop Resumes has positioning, selected baseline and quality evidence columns");
  assert.match(resumesJs, /class: "resume-browser"/, "the first level is the positioning browser");
  assert.match(resumesJs, /class: "resume-overview"/, "the second level is the selected baseline");
  assert.match(resumesJs, /class: "resume-inspector"/, "the third level is the resume inspector");
  assert.match(resumesJs, /\{ key: "preview", label: "Resume" \}, \{ key: "quality", label: "Quality" \}/,
    "the inspector switches between the rendered resume and quality evidence");
  assert.match(resumesJs, /image\.src = await artefactUrl\(page\.src\)/,
    "the selected rendered page is fetched with the authenticated artefact path and shown inline");
  assert.match(resumesJs, /q\.set\("page", String\(page\)\)/,
    "the selected rendered page is preserved in the address");
  assert.match(resumesJs, /q\.set\("selected", id\)/, "selection is preserved in the address");
  assert.match(resumesCss, /\.resume-browser-item\.selected::before[\s\S]*?background: var\(--you\);/,
    "the selected positioning carries the same person-colour rail as Pipeline");
  assert.match(resumesCss, /\.resume-overview \{ grid-row: 1;/,
    "on a phone the selected baseline comes before the long positioning list");
  assert.match(resumesCss, /\.resume-inspector \{ grid-row: 2;/,
    "and the inline resume remains the third level before that list");
  assert.match(resumesCss, /\.resume-workbench \{ grid-template-columns: minmax\(0, 1fr\);/,
    "the desktop tracks collapse to the full phone width");
  // Section 6: four tall thin bars become one horizontal row of short ones,
  // the percentage in ink, and a page under the floor is warned about.
  assert.match(resumesCss, /\.fills \{[\s\S]*?display: flex;/, "the page fills sit in one horizontal row");
  assert.match(resumesCss, /\.fill-pct \{[\s\S]*?color: var\(--ink\);/, "the percentage is in ink");
  assert.match(resumesCss, /\.fill\.low \.bar span \{ background: var\(--warn\); \}/,
    "a page under the floor is warned about, never failed");
  assert.match(resumesCss, /\.fill-low \{ color: var\(--warn\); \}/, "and its label takes the warn colour");
  assert.match(resumesJs, /pages\.slice\(0, 4\)/, "a card shows at most four page fills");
  assert.match(resumesJs, /`Page \$\{page\.page\}`/, "the page number sits under its bar");
  assert.ok(!/\.page-img/.test(resumesCss), "the tall thin thumbnails must be gone");
  // Label, bar and fraction on one line, the fraction in ink.
  assert.match(resumesCss, /\.cover \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 96px minmax\(64px, 1fr\) auto;/,
    "a coverage bar keeps its label and its fraction on the bar line");
  assert.match(resumesCss, /\.cover-count \{[^}]*color: var\(--ink\)[^}]*\}/, "and the fraction is in ink, tabular");
});

test("the wave stylesheets are gone and each selector is defined once", () => {
  for (const gone of ["screens-a.css", "screens-b.css", "screens-c.css"]) {
    assert.ok(!fs.existsSync(path.join(STATIC_DIR, gone)), `${gone} must be gone: its rules moved to the screen that owns them`);
    assert.ok(!html.includes(gone), `index.html must not still load ${gone}`);
  }
  for (const name of SCREEN_SHEETS) {
    assert.match(html, new RegExp(`<link[^>]+rel="stylesheet"[^>]+href="${name}"`), `index.html must load ${name}`);
  }
  // No selector may be declared in two files: a rule that two screens need is
  // a shared primitive and belongs in app.css.
  const seen = new Map<string, string[]>();
  for (const name of ["app.css", ...SCREEN_SHEETS]) {
    const body = (name === "app.css" ? css : sheet[name]).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, head] of body.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)) {
      for (const selector of head.split(",").map((s) => s.trim()).filter(Boolean)) {
        const at = seen.get(selector) ?? [];
        if (!at.includes(name)) at.push(name);
        seen.set(selector, at);
      }
    }
  }
  const crossFile = [...seen.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(crossFile.map(([selector]) => selector), [],
    `a selector is defined in more than one stylesheet: ${crossFile.map(([s, f]) => `${s} (${f.join(", ")})`).join("; ")}`);
});

test("no em dash and no en dash in any stylesheet", () => {
  for (const name of SCREEN_SHEETS) {
    const hit = /[\u2013\u2014]/.exec(sheet[name]);
    assert.ok(!hit, `${name} contains a dash character that is banned`);
  }
});

if (process.exitCode) {
  console.error("ui-static: FAILURES");
} else {
  console.log(`ui-static: ${passed} passed`);
}
