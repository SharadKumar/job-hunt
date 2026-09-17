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
 *   - every hash route the work package specifies is present, Home is the
 *     default, and the nav is in the agreed order.
 *   - autopilot is switched from the header and the kill switch from Settings,
 *     both against the policy API (AGENTS.md section 2).
 *   - the visual contract of the board design: system sans, the fixed palette,
 *     flat cards, one uppercase label, and the three button weights.
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
  "app.js", "applications.js", "row.js", "row-actions.js", "row-letter.js",
  "keywords.js", "home.js", "settings.js", "runs.js", "rules.js", "resumes.js",
  "screening.js", "quotes.js",
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

/** Each module by name, plus one concatenation for "somewhere in the UI" checks. */
const src: Record<string, string> = {};
for (const name of MODULES) src[name] = read(path.join(STATIC_DIR, name));
const front = MODULES.map((name) => src[name]).join("\n");

const app = src["app.js"];
const applications = src["applications.js"];
const rowJs = src["row.js"];
const keywords = src["keywords.js"];
const home = src["home.js"];
const settings = src["settings.js"];
const resumesJs = src["resumes.js"];
const rulesJs = src["rules.js"];
const runsJs = src["runs.js"];

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

test("the modules and app.css pull nothing off the network", () => {
  assert.ok(!/@import\s+url\(/i.test(css), "app.css must not @import a remote stylesheet");
  assert.ok(!/https?:\/\//i.test(css), "app.css must not contain an http(s) URL");
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
  // reuses one of them; screening.js is imported by the row when it needs it.
  const owned = new Set(["app.js", "keywords.js", "row-actions.js", "row-letter.js", "screening.js", "quotes.js"]);
  for (const name of MODULES.filter((m) => !owned.has(m))) {
    assert.ok(app.includes(`from "./${name}"`), `app.js does not import ./${name}`);
  }
  assert.match(app, /import \{ viewResumes \} from "\.\/resumes\.js"/, "app.js must import the resumes view");
  assert.ok(rowJs.includes('from "./row-actions.js"'), "the row detail must own its retry, redraft and mark-sent controls");
  assert.ok(rowJs.includes('from "./row-letter.js"'), "and the letter card must be its own module");
  assert.match(resumesJs, /import \{ viewKeywords \} from "\.\/keywords\.js"/,
    "the Resumes screen must own the evidence questions tab");
  assert.ok(!app.includes('from "./keywords.js"'), "the router must not draw the keywords view itself");
});

test("no module uses a browser modal", () => {
  for (const name of MODULES) {
    for (const banned of ["alert(", "confirm(", "prompt("]) {
      assert.ok(!src[name].includes(banned), `${name} must not call ${banned.slice(0, -1)}(): confirmation is inline`);
    }
  }
});

test("the front end confirms inline, with a second press", () => {
  assert.match(app, /Confirm/, "app.js must label the armed state");
  assert.match(app, /export function guarded\s*\(/, "app.js must export the inline confirm helper");
  assert.match(applications, /guarded\s*\(/, "a row decision must go through the inline confirm helper");
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

test("keyword bundles are capped at four", () => {
  assert.match(keywords, /KEYWORD_BUNDLE\s*=\s*4/, "keywords.js must cap a keyword bundle at four terms");
});

test("a keyword term is recorded on its own, and the batch controls are gone", () => {
  for (const control of ["Record", "Skip"]) {
    assert.ok(keywords.includes(`text: "${control}"`), `the term card has no ${control} button`);
  }
  assert.match(keywords, /class: "btn primary", text: "Record"/, "Record must be the black primary button");
  assert.match(keywords, /body: \{ answers: \{ \[term\]: answer \} \}/, "Record must post one term at a time");
  assert.match(keywords, /disabled: true/, "Record must start disabled until an answer is picked");
  assert.match(keywords, /record\.disabled = !answer \|\| answer === "pending"/,
    "Record must stay disabled while the answer is unsure");
  for (const gone of ["Record and next", "Skip these", 'text: "Back"']) {
    assert.ok(!keywords.includes(gone), `the batch control must be gone: ${gone}`);
  }
});

test("a term is a decision row, not a stack of radios", () => {
  assert.match(keywords, /class: "options segmented"/, "the four answers must be a segmented control");
  assert.match(keywords, /class: "seg"/, "each answer is one segment");
  assert.match(keywords, /class: "term-row" \}, options/, "the answers and the two buttons share one row");
  assert.match(css, /\.options\.segmented \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
    "four equal segments in one row on a desktop");
  assert.match(css, /@media \(max-width: 719px\) \{[\s\S]*?\.options\.segmented \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/,
    "two by two on a phone");
  assert.match(css, /\.seg \{[\s\S]*?border: 2px solid var\(--line\);/, "a segment carries a 2 px border slot");
  assert.match(css, /\.seg\.on \{ border-color: var\(--ink\); \}/, "the chosen segment is outlined in ink");
  assert.match(keywords, /label\.classList\.toggle\("on", label\.querySelector\("input"\)\.checked\)/,
    "picking an answer must mark its segment");
  assert.match(keywords, /class: "context clamp"/, "the context is clamped to two lines");
  assert.match(css, /-webkit-line-clamp: 2;/, "and the clamp is two lines");
  assert.match(keywords, /text: "more"/, "a long context must offer to open");
  assert.match(css, /\.term-actions \{ display: flex;[^}]*\}/, "Record and Skip sit on one row");
});

test("the term list says what a term is, not that it was asked once", () => {
  assert.match(keywords, /const CATEGORIES = \["tool", "method", "certification", "concept"\]/,
    "the list must name the four categories it will print");
  assert.match(keywords, /categoryOf\s*=\s*\(item\)/, "the category must come off the term, or be omitted");
  assert.match(keywords, /mustHave\s*=\s*\(item\)/, "a must-have term must be marked");
  assert.match(keywords, /\(item\.count \?\? 0\) > 1/, "the count must only show when it is more than one");
  assert.match(keywords, /const groups = \[\["Must have", must\]\]/, "the list must lead with the must-have group");
  assert.match(keywords, /\["tool", "Tools"\], \["method", "Methods"\], \["certification", "Certifications"\], \["concept", "Concepts"\], \["", "Other"\]/,
    "and then one group per category, Other last");
  assert.match(keywords, /text: `\$\{label\} \(\$\{items\.length\}\)`/, "each group must carry its count");
  assert.match(keywords, /class: "kw-group eyebrow"/, "each group carries a small heading");
  assert.match(css, /\.must \{[\s\S]*?background: var\(--green\);/, "must-have is a green dot");
  assert.match(css, /@media \(min-width: 900px\) \{\s*\.kw-layout \{ grid-template-columns: 240px/,
    "the term list must be 240 px on a desktop");
  assert.match(css, /\.kw-list \{ position: sticky; top: 88px; \}/, "and it must stay in view while the cards scroll");
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
    "the tag must sit on the recommended segment and nowhere else");
  assert.match(keywords, /item\.recommendation\.note/, "the ledger's note must be shown under the term");
  assert.match(keywords, /class: "term-advice grey small"/, "and it must be the quiet line, not a heading");
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
  assert.match(css, /\.kw-terms \{[\s\S]*?max-height: 70vh;[\s\S]*?overflow-y: auto;/,
    "the term list must scroll inside its own box");
});

test("an unsure answer skips the term after a short window", () => {
  assert.match(keywords, /PENDING_SKIP_MS\s*=\s*400/, "the mis-click window must be 400 ms");
  assert.match(keywords, /setTimeout\(\(\) => handlers\.onSkip\(item\.term\), PENDING_SKIP_MS\)/,
    "picking unsure must skip the term after the window");
  assert.match(keywords, /clearTimeout\(pendingTimer\)/, "another answer inside the window must cancel the skip");
  assert.match(keywords, /mis-click/, "the window must be documented in the module");
});

test("the keyword view can drain a list of hundreds", () => {
  // The bug this replaced: the first four terms came back for ever, because
  // "Unsure / keep pending" left them pending. The view now holds its own pass.
  assert.ok(keywords.includes("Start again with the skipped ones"), "the keyword view has no restart control");
  assert.ok(keywords.includes("keywords/pending?all=1"), "the left list must fetch every pending term, not the first page");
  assert.match(keywords, /All terms \(\$\{terms\.length\}\)/, "the list must be headed with the term count");
  assert.match(keywords, /Search terms/, "the list must carry a search box");
  assert.match(keywords, /Decided \$\{decided\.size\}, skipped \$\{skipped\.size\}, \$\{togo\} to go/,
    "the view must show the progress line");
  assert.match(keywords, /class: "bar", role: "progressbar"/, "the view must show a progress bar");
  assert.match(keywords, /Every pending term has been seen this pass/, "the end of a pass must say so");
  assert.match(keywords, /sessionStorage\.getItem\(KEYWORD_SESSION\)/, "the pass order must survive a refresh");
  assert.match(keywords, /sessionStorage\.setItem\(KEYWORD_SESSION/, "the pass order must be written to sessionStorage");
  assert.match(keywords, /n >= 1 && n <= KEYWORD_OPTIONS\.length/, "1 to 4 must still pick an answer");
});

test("every address the UI answers on is routed, and Home is the default", () => {
  // Nine addresses: the seven routes, the Resumes tab that carries a segment,
  // and the row detail that carries an id.
  for (const route of ["home", "applications", "row", "resumes", "rules", "runs", "settings"]) {
    assert.ok(app.includes(`"${route}"`), `app.js does not name the route: ${route}`);
  }
  assert.match(app, /ROUTES = \["home", "applications", "row", "resumes", "rules", "runs", "settings"\]/,
    "the route list is the contract and must read in nav order");
  assert.ok(resumesJs.includes('hash: "#/resumes/evidence"'), "the evidence questions must have their own address");
  assert.ok(applications.includes("#/row/"), "an application card must link to #/row/<id>");
  for (const hash of ["#/home", "#/applications", "#/resumes", "#/rules", "#/runs", "#/settings"]) {
    assert.ok(html.includes(hash), `index.html has no nav link for ${hash}`);
  }
  assert.match(app, /location\.hash \|\| "#\/home"/, "an empty hash must resolve to Home");
  assert.match(app, /if \(!location\.hash\) location\.hash = "#\/home"/, "a first load must land on Home");
  assert.match(app, /!ROUTES\.includes\(name\) \? "home"/, "an unknown hash must fall back to Home");
});

test("every address that moved still works", () => {
  // Keywords became the Resumes screen's second tab, Digest became Rules and
  // Today became Runs. All three are in the person's history and in the Home
  // cards another package owns, so none of them may 404 into Home silently.
  assert.match(app, /export const REDIRECTS = \{/, "app.js must name the moved addresses in one table");
  for (const [from, to] of [
    ["queue", "#/applications"],
    ["keywords", "#/resumes/evidence"],
    ["digest", "#/rules"],
    ["today", "#/runs"],
  ]) {
    assert.match(app, new RegExp(`${from}: "${to.replace(/\//g, "\\/")}"`), `${from} must redirect to ${to}`);
  }
  assert.match(app, /history\.replaceState\(null, "", target\)/, "a moved address must be rewritten in the address bar");
  assert.ok(!front.includes('"#/queue"'), "the front end must link to #/applications, not #/queue");
  assert.ok(!/href="#\/(keywords|today|digest|queue)"/.test(html), "the nav must not still link to a moved address");
});

test("the nav is in the agreed order, with the switch then the cog last", () => {
  const order = ["#/home", "#/applications", "#/resumes", "#/rules", "#/runs"];
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

test("the screen is called Applications, and the old address still works", () => {
  assert.match(html, /<a href="#\/applications" data-nav="applications">Applications<\/a>/, "the nav link must read Applications");
  assert.ok(!/>Queue</.test(html), "index.html must not still call the screen Queue");
  assert.ok(!front.includes('"#/queue"'), "the front end must link to #/applications, not #/queue");
  assert.ok(app.includes('queue: "#/applications"'), "app.js must still accept the old #/queue address");
  assert.match(app, /name === "queue"/, "an applications tab must survive the redirect from #/queue");
});

test("the header carries an autopilot switch against the policy API", () => {
  assert.match(html, /id="autopilot-slot"/, "index.html must hold a slot for the switch");
  assert.match(app, /function autopilotSwitch\s*\(/, "app.js must draw the switch");
  assert.ok(app.includes(`"policy"`), "app.js must read GET /api/policy");
  assert.ok(app.includes("policy/autopilot"), "the switch must post to /api/policy/autopilot");
  assert.match(app, /reason: "ui toggle"/, "a policy change must carry the reason");
  assert.match(app, /guarded\(button, on \? "Turn off" : "Turn on"/, "the switch must arm before it posts");
  // The dot is the state, so the label is one word and the state lives in the
  // accessible name instead of being said twice.
  assert.match(app, /text: resting,/, "the switch must be labelled by the resting word");
  assert.match(app, /const resting = "Autopilot";/, "the switch must read just Autopilot");
  assert.match(app, /"aria-label": `Autopilot \$\{on \? "on" : "off"\}\. Press to turn \$\{on \? "off" : "on"\}\.`/,
    "the accessible name must state the state and what a press does");
  assert.ok(!/text: `Autopilot \$\{/.test(app), "the visible label must not repeat the on or off word");
  assert.match(css, /\.switch\.on::before \{ background: var\(--green\)/, "the on state must be green");
  assert.match(css, /\.switch\.off::before \{ background: var\(--red\)/, "the off state must be red");
  assert.match(css, /\.switch\.unknown::before \{ background: var\(--grey\)/, "an unreadable policy must be a grey dot");
});

test("a missing policy API degrades to a disabled switch", () => {
  assert.ok(app.includes("policy API unavailable"), "app.js must say when the policy API is not there");
  assert.match(app, /error\.status === 404\) policyAvailable = false/, "a 404 must mark the policy API unavailable");
  assert.match(app, /class: "switch unknown", disabled: true/, "the fallback switch must be disabled");
  assert.ok(home.includes("policy API"), "Home must say so too rather than guess the lane");
});

test("the cog is a bare icon and the header gaps are on the scale", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const cog = /\.nav \.cog \{([^}]*)\}/.exec(rules);
  assert.ok(cog, "app.css must style the cog");
  assert.ok(!/border:\s*1px/.test(cog![1]), "the cog must carry no border: the switch is the only bordered control up here");
  assert.match(cog![1], /border: 0;/, "the cog's border must be explicitly removed");
  assert.match(cog![1], /background: none;/, "and it must have no fill");
  assert.match(cog![1], /color: var\(--grey\);/, "the cog icon is grey at rest");
  assert.match(cog![1], /width: 36px;\s*height: 36px;/, "the cog keeps a 36 px hit area");
  assert.match(rules, /\.nav \.cog:hover \{ color: var\(--ink\)/, "hover takes the cog to ink");
  assert.match(rules, /\.nav \.cog:focus-visible \{ color: var\(--ink\)/, "so does keyboard focus");
  assert.match(rules, /\.nav \{[^}]*gap: 24px;/, "the nav spaces its links 24 px apart");
  assert.match(cog![1], /margin-left: -8px;/, "the cog pulls back to 16 px from the switch");
  assert.match(rules, /\.switch-slot \{ align-self: center;/, "the switch is centred like the links");
});

test("the kill switch lives on Settings, armed and in red", () => {
  assert.ok(!app.includes("kill-switch"), "the kill switch must not be in the header");
  assert.ok(settings.includes("policy/kill-switch"), "settings.js must post to /api/policy/kill-switch");
  assert.match(settings, /panel\("Safety"/, "the kill switch must sit in a Safety card");
  assert.match(settings, /guarded\(button, on \? "Turn off" : "Turn on"/, "the kill switch must arm before it posts");
  assert.match(settings, /class: "btn danger kill"/, "the kill switch must be the red control");
  assert.ok(
    settings.includes("The kill switch halts every unattended send."),
    "the Safety card must explain what the kill switch does",
  );
  assert.match(css, /\.safety \{ border-left: 2px solid var\(--red\)/, "the Safety card must be outlined in red");
});

test("the counts sentence under the header is gone", () => {
  assert.ok(!/id="standing"/.test(html), "index.html must not still carry the standing counts line");
  assert.ok(!/class="standing"/.test(html), "the standing counts line must be gone from the markup");
  assert.ok(!front.includes("need you, "), "no screen may print the old counts sentence");
  assert.ok(!front.includes("renderHeader"), "the counts header renderer must be gone");
  assert.ok(!/\.standing\s*\{/.test(css), "app.css must not still style the counts line");
});

test("Home is a dashboard of cards, each linking to its screen", () => {
  for (const title of [
    "Blocked", "Sent today", "To approve", "Resumes", "Evidence questions",
    "Recurring critic themes", "Latest run",
  ]) {
    assert.ok(home.includes(`"${title}"`), `Home is missing the card: ${title}`);
  }
  // Every card links at the screen that can do the work, and the three that
  // moved (keywords, digest, today) link at where they moved to.
  for (const href of [
    "#/applications/needs", "#/applications/sent", "#/applications/waiting",
    "#/resumes", "#/resumes/evidence", "#/rules", "#/runs",
  ]) {
    assert.ok(home.includes(href), `a Home card does not link to ${href}`);
  }
  for (const gone of ['"#/keywords"', '"#/digest"', '"#/today"']) {
    assert.ok(!home.includes(gone), `a Home card still links at the moved address ${gone}`);
  }
  assert.ok(home.includes("Start deciding."), "the evidence card must still prompt, as plain text now");
  assert.match(home, /\$\{rows\.length - 5\} more on the Applications screen\./,
    "the needs card must say how many more there are");

  // Every card is the link, so the "Open ..." footer links are gone and there
  // is nothing interactive left inside an anchor to click by mistake.
  for (const footer of ["Open Applications", "Open Sent", "Open Runs", "Open Rules", "Open Resumes", "Open Settings", "Open To approve", "Open the questions"]) {
    assert.ok(!home.includes(footer), `the ${footer} footer link must be gone; the card is the link`);
  }
  assert.ok(!home.includes("home-more"), "the footer link row must be gone with it");
  assert.match(home, /const section = h\("a", \{ class: "card home-card", href \}\);/,
    "a Home card must be the anchor itself");
  // Nothing nested and interactive: an anchor inside an anchor is invalid
  // markup, and a button inside one fires the navigation instead of itself.
  const cardBuilders = [...home.matchAll(/function \w+Card\([\s\S]*?\n\}/g)].map((m) => m[0]);
  assert.equal(cardBuilders.length, 8, `Home must build eight cards, found ${cardBuilders.length}`);
  for (const builder of cardBuilders) {
    assert.ok(!/h\("a",/.test(builder), `a Home card still nests a link: ${builder.slice(0, 60)}`);
    assert.ok(!/h\("button",/.test(builder), `a Home card still nests a button: ${builder.slice(0, 60)}`);
    assert.ok(!/class: "btn/.test(builder), `a Home card still carries a button: ${builder.slice(0, 60)}`);
  }
  assert.match(home, /rows\.slice\(0, 5\)/, "the needs card must show the top five rows");
  assert.match(home, /slice\(0, 3\)/, "the digest card must show the top three themes");
  assert.match(home, /slice\(0, 12\)/, "the run card must fall back to the first twelve lines of the summary");
  assert.ok(home.includes('api("runs?limit=1")'), "the latest run card must read the runs index");
  assert.match(home, /\$\{run\.sent\} sent/, "the latest run must say what went out");
  assert.match(home, /\$\{run\.blocked\} blocked/, "and what it left blocked");
  assert.match(home, /`exit \$\{run\.exit_code\}`/, "and how it exited");
  assert.match(applications, /TABS\.some\(\(t\) => t\.key === which\)/, "a Home link must open the right applications tab");
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
  assert.match(css, /h1 \{\s*margin: 0;\s*font-size: 26px;\s*font-weight: 600;/, "the greeting is the 26 px 600 page title");
  assert.ok(home.includes("profile.name"), "the name must come from the profile the resumes API carries");
});

test("a quotation sits under the greeting, attributed, and rerolled each load", () => {
  const quotes = src["quotes.js"];
  assert.match(quotes, /export const QUOTES = \[/, "the pool must be its own module's export");
  assert.match(quotes, /export function quoteFor\(rng\)/, "and the pick must take its random source as an argument");
  const entries = [...quotes.matchAll(/\{ text: "([^"]+)", by: "([^"]+)" \}/g)];
  assert.ok(entries.length >= 70, `the pool has ${entries.length} quotations; the brief fixes 70`);
  for (const [, text, by] of entries) {
    assert.ok(text.trim().length > 8, `a quotation is too short to be one: ${text}`);
    assert.ok(by.trim().length > 2, `the quotation has no attribution: ${text}`);
    assert.ok(!/[\u2014\u2013]/.test(`${text} ${by}`), `a quotation carries a banned dash: ${text}`);
  }
  // Pure: fed a number, it returns the same entry every time.
  const fn = /export function quoteFor[\s\S]*?\n\}/.exec(quotes);
  for (const impure of ["Math.random", "Date.now", "new Date("]) {
    assert.ok(!fn![0].includes(impure), `quoteFor must be pure: it uses ${impure}`);
  }
  assert.ok(home.includes("quotes.quoteFor(Math.random)"), "Home must reroll the quotation on every load");
  assert.ok(home.includes('await import("./quotes.js")'), "and load the pool when the page is drawn, not at import time");
  assert.match(home, /class: "lede quote"/, "the quotation sits where the lede goes");
  assert.match(home, /h\("p", \{ class: "lede quote" \}/, "and it is one paragraph, so quotation and attribution share a line");
  assert.match(home, /class: "quote-text", text: `"\$\{saying\.text\}"`/, "the quotation is quoted");
  assert.match(home, /\}\),\n\s*" ",\n\s*h\("span", \{ class: "quote-by", text: saying\.by \}\)/,
    "a single space separates the quotation from its attribution, with no dash and no brackets");
  assert.match(css, /\.quote \{ max-width: 72ch; font-size: 15px; \}/, "the one line wraps at the 72ch measure, at 15 px");
  assert.match(css, /\.quote-text \{ font-style: italic; \}/, "the quotation is the italic half");
  assert.match(css, /\.quote-by \{ font-size: 15px; font-weight: 400; color: var\(--grey\); \}/,
    "the attribution is 15 px regular weight grey");
});

test("the Home cards are packed, not laid out on a grid of rows", () => {
  // The bug this fixes: a two-column grid sized each row to its tallest card,
  // so a short card left a hole beside a tall one. A multi-column flow packs
  // them, provided no card is allowed to break across a column.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rules, /\.home-grid \{ column-count: 1; column-gap: var\(--gutter\); \}/,
    "the home grid must be a single column flow by default");
  assert.match(rules, /@media \(min-width: 720px\) \{\s*\.home-grid \{ column-count: 2; \}\s*\}/,
    "two columns start at 720 px, so a phone stays on one");
  assert.ok(!/\.home-grid \{[^}]*display: grid/.test(rules), "the home grid must not still be a css grid");
  assert.match(rules, /\.home-card \{[^}]*break-inside: avoid/, "a card must never split across columns");
  assert.match(rules, /\.home-card \{[^}]*-webkit-column-break-inside: avoid/, "and the webkit spelling must be there too");
  assert.match(rules, /\.home-card \{[^}]*margin-bottom: 24px/, "the gap between packed cards must be 24 px");
  assert.match(rules, /a\.home-card, a\.home-card:hover \{ text-decoration: none; color: inherit; \}/,
    "a card that is a link must keep the page's own text colour and never underline");
  assert.match(rules, /a\.home-card:hover \{ background: var\(--hover\); \}/,
    "the only hover on a card is the subtle tint");
  assert.match(rules, /--hover: #fafafa;/, "and that tint is #FAFAFA in light mode");
  assert.match(rules, /:focus-visible \{\s*outline: 2px solid var\(--ink\);/,
    "the card takes the standard focus ring, so a keyboard can see where it is");
});

test("the Home cards are in priority order", () => {
  // What is stuck first, then what waits on a decision, then the backlog,
  // then the record of what already happened.
  const call = /grid\.append\(\n([\s\S]*?)\n  \);/.exec(home);
  assert.ok(call, "home.js must append the cards in one call");
  const order = [...call![1].matchAll(/(\w+Card)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(
    order,
    ["needsCard", "waitingCard", "evidenceCard", "sentCard", "resumesCard", "digestCard", "latestRunCard"],
    "the Home cards are out of priority order",
  );
});

test("the run card renders markdown rather than printing the source", () => {
  assert.ok(
    home.includes("richMarkdown"),
    "home.js must use the shared markdown renderer from app.js",
  );
  assert.match(app, /export function richMarkdown\s*\(/, "app.js must export the shared renderer");
  assert.ok(runsJs.includes("richMarkdown"), "Runs must use the same renderer as Home");
  assert.ok(
    !/h\("pre", \{ class: "home-journal"/.test(home),
    "the run card must not print the journal as raw preformatted source",
  );
});

test("Home says which lane is in force, once, in the Harness card", () => {
  // It used to be the lede under the title as well, which said the same
  // sentence twice on one screen.
  assert.match(home, /pageHeader\(\{ title: greetingFor\(now, ""\) \}\)/, "Home must draw the greeting as its title");
  assert.ok(!home.includes("lede: standing()"), "the lane sentence must not be the lede any more");
  assert.match(home, /body\.append\(line\(standing\(\), "home-line"\)\);/,
    "the lane sentence belongs to the Harness card, as its first line");
  assert.match(home, /Autopilot \$\{policy\.autopilot_enabled \? "on" : "off"\}/, "Home must name the autopilot state");
  assert.match(home, /Kill switch \$\{policy\.kill_switch \? "on" : "off"\}/, "Home must name the kill switch state");
  assert.match(home, /of \$\{policy\.max_per_day\}/, "Home must show the daily cap against what has gone out");
  assert.match(home, /RUN_SCHEDULE\s*=\s*"The daily run is at 07:00\."/, "Home must say when the run happens");
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
    const hit = /[–—]/.exec(body);
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
  assert.ok(applications.includes("Job Hunt drafts and sends applications overnight."), "the applications lede must name Job Hunt");
  assert.ok(!/\bHarness\b/.test(html), "index.html must not still call the product Harness");
});

test("the stylesheet handles dark mode and phone width", () => {
  assert.match(css, /prefers-color-scheme:\s*dark/, "app.css must define a dark scheme");
  assert.match(css, /@media\s*\(min-width/, "app.css must have at least one responsive breakpoint");
  assert.match(css, /:focus-visible/, "app.css must keep a visible focus ring for keyboard use");
  assert.match(html, /name="viewport"/, "index.html must set a viewport for phone width");
  assert.match(css, /@media \(min-width: 720px\) \{\s*\.home-grid \{ column-count: 2; \}/,
    "Home must go to two columns on a desktop and stay single column under 720 px");
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
  assert.match(css, /\.lede \{\s*margin: 4px 0 0;\s*font-size: 17px;\s*line-height: 1\.5;\s*color: var\(--grey\);/,
    "the lede must sit 4 px under the title and read at 17 px grey");
  assert.match(css, /\.page-aside \{ justify-self: end;/, "the aside must be right aligned on the desktop");
  assert.match(css, /@media \(max-width: 719px\) \{[\s\S]*?\.page-aside \{ justify-self: start; order: 1;/,
    "on a phone the aside must drop below the lede");
  // The row detail is the only screen with a back link, and it goes above the title.
  assert.match(src["row.js"], /back: h\("a", \{ href: "#\/applications"/, "the row detail back link belongs to the header");
  assert.match(css, /\.page-header \.backlink \{ grid-column: 1 \/ -1; \}/, "the back link sits above the title");
  assert.match(css, /\.backlink \{ margin: 0 0 8px;/, "the back link must sit 8 px above the title");
});

test("the active nav link is underlined on the header rule", () => {
  assert.match(css, /\.nav a \{[\s\S]*?border-bottom: 2px solid transparent;[\s\S]*?margin-bottom: -1px;/,
    "a nav link must carry a 2 px underline slot that overlaps the header rule");
  assert.match(css, /\.nav a\[aria-current="page"\] \{ font-weight: 500; border-bottom-color: var\(--ink\); \}/,
    "the active link must be ink underlined and 500");
  assert.match(css, /\.nav a:hover \{ text-decoration: none; border-bottom-color: var\(--grey\); \}/,
    "hover must show a grey underline rather than a text underline");
  assert.match(css, /\.nav \.cog \{\s*align-self: center;/, "the cog stays on the links' vertical centre");
  assert.match(css, /\.switch-slot \{ align-self: center;/, "so does the autopilot switch");
  assert.match(css, /@media \(max-width: 639px\) \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/,
    "on a phone the nav must scroll sideways in one line instead of wrapping");
});

test("the type scale and the spacing scale hold across the stylesheet", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // 12 eyebrow, 13 meta, 15 body, 17 card title, 26 page title. 18 and 20 are
  // the wordmark and its rocket, the one pair the brief fixes outside the scale.
  const SCALE = new Set([12, 13, 15, 17, 26, 18, 20]);
  for (const [, value] of rules.matchAll(/font-size:\s*(\d+)px/g)) {
    assert.ok(SCALE.has(Number(value)), `app.css uses a font size outside the scale: ${value}px`);
  }
  const SPACING = new Set([0, 1, 4, 8, 12, 14, 16, 20, 24, 32]);
  for (const [, decl] of rules.matchAll(/(?:^|[\s{;])(?:margin|padding|gap|column-gap|row-gap)[a-z-]*:\s*([^;]+);/g)) {
    for (const [, value] of decl.matchAll(/(\d+)px/g)) {
      assert.ok(SPACING.has(Number(value)), `app.css uses a spacing value outside the scale: ${value}px in "${decl.trim()}"`);
    }
  }
  assert.match(rules, /\.card \{[^}]*padding: 20px/, "a card is padded 20 px everywhere");
  assert.match(rules, /\.cards \{ display: grid; gap: 24px; \}/, "cards are 24 px apart");
});

test("every button is the same height and the same side padding", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rules, /button, \.btn \{[\s\S]*?height: 36px;\s*padding: 0 14px;/,
    "primary, secondary and destructive buttons must share one height and one padding");
  assert.match(rules, /\.switch \{ border-radius: 8px; \}/, "the header switch must take the same metrics rather than its own");
});

test("an empty or failed panel is the same dashed box everywhere", () => {
  assert.match(css, /\.empty, \.error \{[\s\S]*?border: 1px dashed var\(--line\);/,
    "empty and error states must share one dashed box");
});

test("the type is the system sans stack the board design asks for", () => {
  // One system family, 15 px body, 1.5 line height: a job board, not a document.
  assert.match(css, /font-family:\s*Inter,\s*-apple-system,\s*BlinkMacSystemFont/, "app.css must lead the font stack with Inter and the system faces");
  assert.match(css, /"Segoe UI",\s*Roboto,\s*system-ui,\s*sans-serif/, "app.css must end the stack at system-ui and sans-serif");
  assert.match(css, /font-size:\s*15px/, "body type must be 15 px");
  assert.match(css, /line-height:\s*1\.5/, "body line height must be 1.5");
});

test("the palette is the one the brief fixes", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [name, value] of [
    ["ink", "#111827"], ["grey", "#6b7280"], ["line", "#e5e7eb"],
    ["pill", "#f3f4f6"], ["pill-ink", "#374151"], ["green", "#16a34a"], ["red", "#dc2626"],
  ]) {
    assert.ok(rules.includes(`--${name}: ${value}`), `app.css must set --${name} to ${value}`);
  }
  assert.match(rules, /--page:\s*#ffffff/, "the page must be pure white");
  assert.match(rules, /--maxw:\s*1140px/, "the content column must be 1140 px");
  assert.match(rules, /--gutter:\s*24px/, "the gutters must be 24 px");
});

test("the five application tabs are named as the person names them", () => {
  const labels = ["Blocked", "To approve", "Shortlisted", "Parked", "Sent"];
  let at = -1;
  for (const label of labels) {
    const found = applications.indexOf(`"${label}"`);
    assert.ok(found > -1, `applications.js is missing the tab label: ${label}`);
    assert.ok(found > at, `tab "${label}" is out of order`);
    at = found;
  }
  // The labels must still map onto the pipeline statuses the API filters by.
  for (const status of ["manual_action_needed", "awaiting_approval", "shortlisted", "parked", "submitted"]) {
    assert.ok(applications.includes(status), `applications.js does not map a tab onto the status: ${status}`);
  }
});

test("the row detail carries the three stat cards", () => {
  assert.match(rowJs, /export function statsRow\s*\(/, "row.js must build the stats row on the row detail");
  assert.match(css, /\.stats\s*\{/, "app.css must style the stats row");
  assert.match(css, /\.stat\.good \.value\s*\{\s*color:\s*var\(--green\)/, "a passing verdict must be green");
  assert.match(css, /\.stat\.bad \.value\s*\{\s*color:\s*var\(--red\)/, "a failed verdict must be red");
  for (const stamp of ["Critic blocked", "Critic pass", "not recorded", "Gate waiting", "Gate passed"]) {
    assert.ok(rowJs.includes(stamp), `the stats row never says: ${stamp}`);
  }
  // The gate has one verdict. "Gate waiting, blocked" read as two.
  assert.ok(!/Gate waiting, \$\{statusLabel/.test(rowJs), "the gate card must not repeat the row's status");
  // The package card names what is in the package, not that something is.
  assert.match(rowJs, /resume\.mode === "tailored" \? "Tailored CV" : resume\.mode === "baseline" \? "Baseline CV"/,
    "the package card must say which CV went in");
  assert.ok(!rowJs.includes('"CV recorded"'), "CV recorded says nothing the person can use");
  assert.match(rowJs, /`score \$\{Math\.round\(row\.score\)\}`/, "the fact line runs in lower case");
});

test("a blocked row is never offered Approve", () => {
  // Approving a blocked row marks the package approved and the next run reads
  // the same finding, blocks it again and parks it. So the button is gated on
  // the statuses where approving means something.
  assert.match(rowJs, /const APPROVABLE = new Set\(\["awaiting_approval", "shortlisted", "drafted"\]\)/,
    "row.js must name the statuses that can take an approval");
  assert.match(rowJs, /APPROVABLE\.has\(row\.status\) && act\.post !== "approve"/,
    "Approve must be gated on the row's status and not offered twice");
  assert.ok(!/key: "approve", label: "Approve", primary: true/.test(front),
    "Approve must not be an unconditional primary anywhere");
  assert.match(rowJs, /const DECISIONS = \[/, "the standing decisions must be one list");
  for (const label of ["Hold", "Reject", "Withdraw"]) {
    assert.ok(new RegExp(`label: "${label}"`).test(rowJs), `the decision bar is missing: ${label}`);
  }
  assert.ok(!applications.includes("export const ACTIONS"), "the old five-button decision list must be gone");
});

test("the decision card puts the run first, then the moves", () => {
  const bar = /function actionBar\(([\s\S]*?)\n\}/.exec(rowJs);
  assert.ok(bar, "row.js must build the decision card in one function");
  // Retry now is not a move, so it sits above the moves with its own line of
  // explanation; the moves then read contextual, also, approve, standing.
  const order = ["retryNowControl(", "Runs the critic and the gate again", '"Move this application"',
    "contextualControl(", "alsoControls(", "APPROVABLE.has(", "of DECISIONS"];
  let at = -1;
  for (const piece of order) {
    const found = bar![1].indexOf(piece);
    assert.ok(found > at, `the decision bar builds ${piece} out of order`);
    at = found;
  }
  // The screening panel is the answer, so the button that only scrolls to it
  // is noise on a page that already carries the panel.
  assert.match(rowJs, /act\.kind === "answer" && screeningOnPage/, "Answer must not be a button beside the screening panel");
  assert.match(rowJs, /const screeningOnPage = UNANSWERED_QUESTION\.test/, "and the test must be the one the panel mounts on");
});

test("Retry now runs the gate here and says what it found", () => {
  const actions = src["row-actions.js"];
  assert.match(actions, /export function retryNowControl\s*\(/, "row-actions.js must own the retry control");
  assert.match(actions, /rows\/\$\{encodeURIComponent\(row\.id\)\}\/retry-now/, "it must post to the retry-now route");
  assert.match(actions, /api\(`jobs\/\$\{encodeURIComponent\(id\)\}`\)/, "and follow the job it starts");
  assert.match(actions, /const POLL_MS = 2000;/, "the job must be polled every two seconds");
  assert.ok(actions.includes("Running the critic and the gate"), "the progress line must say what is running");
  assert.match(actions, /guarded\(button, "Retry now"/, "the retry must arm before it runs");
  assert.match(actions, /class: small \? "btn primary sm" : "btn primary", text: "Retry now"/, "Retry now is the black button");
  assert.match(actions, /error\.status === 404 \? MISSING_ROUTE : `Refused\. \$\{error\.message\}`/,
    "a 409 must show the server's own reason, and a 404 must degrade");
  assert.match(actions, /result\.status_after \? `The row is now \$\{statusLabel\(result\.status_after\)\}\.` : ""/,
    "the result must name the status the tool left the row in");
  assert.match(rowJs, /const wantsRetry = \(act\)/, "a row whose move is a retry must offer it");
  assert.ok(rowJs.includes("Answer banked. Retry now?"), "and so must a row that has just banked an answer");
});

test("Redraft letter asks the next run for a new letter", () => {
  const actions = src["row-actions.js"];
  assert.match(actions, /export function redraftControl\s*\(/, "row-actions.js must own the redraft control");
  assert.match(actions, /rows\/\$\{encodeURIComponent\(row\.id\)\}\/redraft/, "it must post to the redraft route");
  assert.match(actions, /guarded\(button, "Redraft letter"/, "the redraft must arm before it posts");
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
  assert.match(actions, /text: "I applied myself"/, "the control must be named in the person's words");
  assert.match(actions, /rows\/\$\{encodeURIComponent\(row\.id\)\}\/mark-sent/, "it must post to the mark-sent route");
  assert.match(actions, /confirmation: reference\.value\.trim\(\)/, "the form must carry a confirmation reference");
  assert.match(actions, /note: note\.value\.trim\(\)/, "and a note");
  assert.match(actions, /guarded\(save, "Mark as sent"/, "the commit must arm before it writes");
  assert.ok(actions.includes("Nothing is submitted from here."), "the form must say what it is and is not doing");
  assert.match(applications, /act\.kind === "portal" \|\| row\.applyMethod === "external"/,
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
  assert.ok(!/^\.fix \{/m.test(read(path.join(STATIC_DIR, "screens-c.css"))), "the Rules screen must not restyle the finding card");
});

test("the letter and the job description stand the same height", () => {
  assert.match(css, /\.columns \{ display: grid; gap: 24px; align-items: stretch; \}/,
    "the two cards must share one grid row");
  assert.match(css, /\.columns > \.card \{ display: flex; flex-direction: column; min-width: 0; \}/,
    "each card must be a column so its body can take the spare height");
  assert.match(css, /\.columns:not\(\.one\) > \.card > \.jd \{ flex: 1 1 0; min-height: 0; max-height: none; \}/,
    "the job description must fill what the letter leaves and scroll inside its own card");
  assert.match(css, /\.jd \{ overflow: auto; max-height: 460px; \}/,
    "stacked on a phone it must keep a box of its own rather than running the page down");
  assert.ok(!/\.jd pre \{[^}]*max-height/.test(css), "the job description must not keep a height of its own any more");
});

test("the letter's controls sit on its title row", () => {
  const letter = src["row-letter.js"];
  assert.match(letter, /class: "card-head" \}, h\("h2", \{ text: "Cover letter" \}\), controls/,
    "Edit and Redraft belong on the card's title row, not in a footer");
  assert.match(letter, /text: "Edit letter"/, "the letter must be editable from there");
  assert.match(letter, /controls\.append\(save, cancel\)/, "and the same spot must carry Save and Cancel while editing");
  assert.match(letter, /if \(redraft\) card\.append\(redraft\.extra\)/, "the redraft note is a caption under the title");
  assert.match(css, /\.card-head \{[\s\S]*?justify-content: space-between;/, "the title row must put the controls hard right");
  assert.match(css, /\.card-head-actions \{ display: flex; align-items: center; gap: 8px; \}/,
    "and the controls must sit together on one line");
  assert.match(rowJs, /redraftControl\(row, data\.redraft_requested, \(\) => decision\.reason\.value, \{ small: true \}\)/,
    "the redraft control is built by the row and handed to the letter card");
});

test("the row detail reads in one order, history last", () => {
  const view = /export async function viewRow\(([\s\S]*?)\n\}/.exec(rowJs);
  assert.ok(view, "row.js must draw the row in one function");
  const order = ["detail-meta", "statsRow(", "letterCard(", "jd-card", "screening", "actionBar(", "historyBlock("];
  let at = -1;
  for (const piece of order) {
    const found = view![1].indexOf(piece);
    assert.ok(found > at, `the row detail draws ${piece} out of order`);
    at = found;
  }
  assert.match(rowJs, /rest\.append\(actionBar\([^)]*\), historyBlock\(row\.history\)\)/,
    "the decision must come before the history, not after it");
  assert.match(rowJs, /rest\.append\(screening\);\n\s*if \(banner\) rest\.append\(banner\);/,
    "and the lane banner must sit between the question and the decision it frames");
});

test("every top-level section on the row page shares one 24 px gap", () => {
  // The bug this fixes: every section set its own vertical margin, and the
  // decision card, which set none, sat flush against the letter above it.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rowJs, /const page = h\("div", \{ class: "row-page" \}\);/,
    "the row page must draw its sections inside one box");
  const after = rowJs.slice(rowJs.indexOf('const page = h("div", { class: "row-page" });'));
  const strays = [...after.matchAll(/view\.append\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(strays, ["page"],
    `a row section goes straight on the view instead of into the box: ${strays.join(", ")}`);
  assert.match(rules, /\.row-page > \* \+ \* \{ margin-top: 24px; \}/,
    "one rule must set the gap for every top-level section on the row page");
  assert.ok(!/\.stats \{[^}]*margin:/.test(rules),
    "the stats row must not set its own vertical margin on top of the shared rule");
  assert.ok(!/\.stack \{[^}]*margin/.test(rules),
    "nor may the decision stack, or the gap above it comes back doubled");
  assert.match(rules, /\.stack \{ display: grid; gap: 24px; \}/,
    "the sections inside the stack keep the same 24 px");
});

test("a row in the autopilot lane is a record, not a decision", () => {
  // AGENTS.md section 2: the lane is decided by the channel, never by who
  // asked, so the row says which lane has it and offers only what is left.
  assert.match(rowJs, /const IN_FLIGHT = "in_flight";/, "row.js must know the in-flight action kind");
  assert.match(rowJs, /const ATTENDED_SEND = "attended_send";/, "and the attended-send kind");
  assert.match(rowJs, /text: act\.label \|\| "Autopilot handles this"/, "the green banner must say autopilot handles it");
  assert.match(rowJs, /act\.note \|\| row\.lane_reason/, "and carry the note the server sent with it");
  assert.match(rowJs, /text: "Ready to send in an attended session\."/, "the grey banner must say the session is attended");
  assert.match(rowJs, /text: "Run \/submit-approved with the person present\."/, "and name the command that does it");
  assert.match(rowJs, /class: `lane-banner lane-banner-\$\{inFlight \? "autopilot" : "attended"\}`/,
    "the two banners must be told apart by a class, not by a colour set in js");
  assert.match(css, /\.lane-banner-autopilot \{ border-color: var\(--green\); \}/, "the autopilot banner is green bordered");

  // The lane pill on the fact line.
  assert.match(rowJs, /said === "autopilot" \|\| said === "attended"/, "the pill must only draw a lane it knows");
  assert.match(rowJs, /const said = row\.lane \|\| of\("lane_of"\);/,
    "a row without its own lane must fall back to the channel's, from GET /api/lanes");
  assert.match(rowJs, /const lanes = \(\) => \(lanesRead \|\|= api\("lanes"\)\.catch\(\(\) => null\)\);/,
    "and that table must be read once a session, and never break the page when it is missing");
  assert.match(rowJs, /class: `pill lane-pill lane-pill-\$\{lane\}`, text: lane/, "the pill says the lane and nothing else");
  assert.match(rowJs, /pill\.setAttribute\("title", why\)/, "and carries lane_reason as its title");
  assert.match(css, /\.lane-pill-autopilot \{ color: var\(--green\); \}/, "autopilot is the green lane");
  assert.match(css, /\.lane-pill-attended \{ color: var\(--grey\); \}/, "attended is the grey one");

  // The decision card an in-flight row gets.
  assert.match(rowJs, /const IN_FLIGHT_DECISIONS = new Set\(\["hold", "reject"\]\);/,
    "an in-flight row takes only Hold and Reject");
  assert.match(rowJs, /eyebrow\(inFlight \? "Take it out of the run" : "Move this application"\)/,
    "and the card is captioned as taking it out of the run");
  assert.match(rowJs, /act\.post !== "approve" && !inFlight/, "Approve must never be offered on an in-flight row");
  assert.match(rowJs, /if \(inFlight && !IN_FLIGHT_DECISIONS\.has\(spec\.key\)\) continue;/,
    "and Withdraw must be left off with it");
  assert.match(rowJs, /alsoPosts\.has\(spec\.key\)/, "a decision the server already hung off also must not be drawn twice");
});

test("To approve is the person's queue, and the run's rows are read elsewhere", () => {
  assert.match(applications, /export const needsYou = \(row\) => row\.needs_you !== false;/,
    "a server that does not carry lanes must leave every awaiting row with the person");
  assert.match(applications, /row\.needs_you === false\n\s*\|\| Boolean\(row\.action && row\.action\.kind === "in_flight"\)/,
    "an in-flight row is either flagged or says so in its action");
  assert.match(applications, /if \(tab\.key === "waiting"\) rows = rows\.filter\(needsYou\);/,
    "the To approve tab must list only what wants the person");
  assert.match(applications, /tab\.key === "shortlisted"[\s\S]*?rows\?status=awaiting_approval[\s\S]*?filter\(isInFlight\)/,
    "and the rows the run is carrying must be read under Shortlisted");
  assert.match(applications, /h\("span", \{ class: "pill", text: "in flight" \}\)/,
    "with a grey pill saying which they are");
  assert.match(applications, /tab\.key === "waiting" && typeof laneCounts\.needs_you === "number"/,
    "the tab count must be counts.needs_you when the server sends it");
  assert.match(applications, /counts\.needs_you === "number"\) laneCounts\.needs_you = counts\.needs_you;/,
    "and that count must be remembered off the rows response");
  assert.match(applications, /const counts = status === "awaiting_approval" && data \? data\.counts : null;/,
    "only the awaiting_approval response may set it; every status reports its own split");
});

test("Home counts the approvals that want the person, and says what is in flight", () => {
  assert.match(home, /api\("rows\?status=awaiting_approval"\)/, "Home must read the awaiting queue for its split");
  assert.match(home, /typeof counts\.needs_you === "number" \? counts\.needs_you : fallback/,
    "the To approve figure must be counts.needs_you, falling back to the old total");
  assert.match(home, /if \(flight > 0\) body\.append\(line\(`\$\{flight\} in flight on autopilot`/,
    "and one line under it must say what the run is already carrying");
  assert.match(home, /const \[needs, sent, waiting, resumes, keywords, digest, journal, health, runs\] = results;/,
    "the results must be unpacked in the order they were asked for");
});

test("the Sent today card counts the rows it is showing", () => {
  assert.match(home, /const sentAt = \(row\) => row\.submittedAt \|\| row\.submitted_at \|\| row\.updated_at;/,
    "a row is sent when it was submitted, not when it was last touched");
  assert.match(home, /const rows = \(result\.value\.rows \|\| \[\]\)\.filter\(\(row\) => localDay\(sentAt\(row\)\) === today\);/,
    "the list must be the rows submitted in the local calendar day");
  assert.match(home, /const count = rows\.length;/,
    "and the number must come off that list, so the card cannot contradict itself");
  assert.ok(!/summary\.sent_today/.test(home.slice(home.indexOf("function sentCard"), home.indexOf("function waitingCard"))),
    "the Sent today card must not take its figure from the summary any more");
  assert.match(app, /new Intl\.DateTimeFormat\("en-CA"\)\.format\(d\)/,
    "the day must be computed with Intl in the browser's own timezone");
});

test("the history is a timeline with a dot per move", () => {
  assert.match(rowJs, /function moveTone\(to\)/, "a move must be toned by where it went");
  assert.match(rowJs, /if \(to === "submitted"\) return "good"/, "a move to sent is green");
  assert.match(rowJs, /return "bad"/, "a move to a stop is red");
  assert.match(rowJs, /class: "timeline"/, "the history must be the timeline list");
  assert.match(rowJs, /class: "tl-dot", "aria-hidden": "true"/, "each entry must carry its own dot");
  const screensB = read(path.join(STATIC_DIR, "screens-b.css"));
  assert.match(screensB, /\.timeline \{[\s\S]*?border-left: 2px solid var\(--line\);/, "the rail must be 2 px");
  assert.match(screensB, /\.tl\.good \.tl-dot \{ background: var\(--green\); \}/, "a green dot for a send");
  assert.match(screensB, /\.tl\.bad \.tl-dot \{ background: var\(--red\); \}/, "a red dot for a stop");
  assert.match(screensB, /\.tl-when \{ margin: 0; font-size: 13px; color: var\(--grey\); \}/, "the time is 13 px grey");
  assert.match(screensB, /\.tl-move \{ margin: 0; font-size: 15px; \}/, "the move is 15 px");
  assert.ok(rowJs.includes('text: "more"'), "a long reason must still fold");
});

test("a decision says what it does, and the notes field waits to be wanted", () => {
  assert.match(rowJs, /const DECISION_HELP = \{/, "each decision must carry a plain explanation");
  for (const [key, help] of [
    ["approve", "Let the next run send it"], ["hold", "Keep it here"],
    ["reject", "Not applying"], ["withdraw", "Applied but pulling out"],
  ]) {
    assert.ok(rowJs.includes(`${key}: "${help}"`), `the decision ${key} has no explanation`);
  }
  assert.ok(src["row-actions.js"].includes("Record that you sent it through the portal"),
    "I applied myself must explain itself too");
  assert.match(applications, /if \(action\.title\) button\.setAttribute\("title", action\.title\)/,
    "a decision button must put its explanation in the title");
  assert.match(rowJs, /function decisionFields\(\)/, "the two fields belong to one helper");
  assert.ok(
    rowJs.includes('h("span", { class: "field-label", text: help ? `${text} (${help})` : text })'),
    "both fields must be visibly labelled, and the label and its aside must read on one line",
  );
  assert.ok(!/class: "field-help"/.test(rowJs), "the aside must not stack under the label as a second line");
  assert.ok(rowJs.includes('"Reason", "goes into the history"'), "the reason field must say where it goes");
  assert.ok(rowJs.includes('"Notes for the next run", "edits to the letter or package"'),
    "the notes field must say who reads it");
  assert.match(rowJs, /notesField\.hidden = true;/, "the notes field starts hidden");
  assert.match(rowJs, /approve\.addEventListener\("click", decision\.reveal\)/, "Approve reveals it");
  assert.match(rowJs, /if \(spec\.key === "hold"\) button\.addEventListener\("click", decision\.reveal\)/, "so does Hold");
  assert.match(rowJs, /redraft\.button\.addEventListener\("click", decision\.reveal\)/, "and so does Redraft");
  assert.match(rowJs, /Runs the critic and the gate again and sends through \$\{sendsThrough\(row\)\} if they pass\./,
    "Retry now must say what it runs and where it would send");
  assert.match(rowJs, /const SEND_METHOD = \{ easy_apply: "Easy Apply", quick_apply: "Quick Apply" \}/,
    "and it must name the channel's own words for the method");
});

test("the screening card is a form, not a row of loose controls", () => {
  const screening = src["screening.js"];
  assert.match(screening, /const field = \(text, control\) =>/, "the card must use one labelled control shape");
  assert.ok(screening.includes('field("Your answer", input)'), "the answer field must be labelled");
  assert.ok(screening.includes('field("Skill", skill), field("Years", years), save'),
    "skill, years and the button must sit on one row");
  assert.match(screening, /text: "Years with a skill"/, "the years form must be headed");
  assert.ok(!screening.includes("screening-input"), "the card must not carry its own input styling any more");
  assert.match(css, /\.field \{ display: grid; gap: 4px; min-width: 0; \}/, "app.css must own the labelled field");
  const screensA = read(path.join(STATIC_DIR, "screens-a.css"));
  assert.match(screensA, /\.years-row \{[\s\S]*?align-items: end;/, "the years row must share one baseline");
  assert.match(screensA, /\.screening-question \{ margin: 0; font-size: 15px; font-weight: 500; \}/,
    "the question is a 15 px 500 line");
});

test("the applications board carries the secondary actions the server offers", () => {
  assert.match(applications, /export function alsoControls\s*\(/, "applications.js must render action.also");
  assert.match(applications, /act\.kind === "decide"\) return null/, "a decide row has no primary, only its also buttons");
  assert.match(applications, /spec\.href \|\| spec\.kind === "portal"/, "an also entry with a link must render as a link");
  assert.match(applications, /actionButton\(row, \{ key: spec\.post/, "and one with a post must render as a decision");
  assert.match(applications, /const FOLLOW_UP_SHOWN = 8;/, "the follow-up strip must cap at eight rows");
  assert.match(applications, /text: `Show all \$\{rows\.length\}`/, "and offer the rest behind one press");
  const screensB = read(path.join(STATIC_DIR, "screens-b.css"));
  assert.match(screensB, /\.row-extra \{ grid-column: 1 \/ -1; \}/, "a form a row opens must run the row's width");
  assert.match(screensB, /\.action-extra \{ display: grid;/, "and on the row detail it must sit under the button row");
});

test("every date on every screen reads as 17 Sep", () => {
  assert.match(app, /const MONTHS = \["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"\]/,
    "app.js must carry the three letter months, because en-AU says Sept");
  assert.match(app, /export function shortDate\s*\(/, "app.js must own the one short date");
  assert.match(app, /export function dayStamp\s*\(/, "and the one day stamp");
  for (const name of MODULES) {
    assert.ok(!/month:\s*"short"/.test(src[name]), `${name} must not format a month itself: en-AU spells it Sept`);
  }
});

test("the applications screen reads as cards with a filter column", () => {
  for (const piece of ["Why it is here", "Filters", "Minimum score", "Details", "saved by you"]) {
    assert.ok(applications.includes(piece), `the job card or filter column never says: ${piece}`);
  }
  assert.match(css, /\.layout \{ grid-template-columns: 280px/, "the filter column must be 280 px on the desktop layout");
  assert.match(css, /\.job:hover \{ background: var\(--hover\)/, "a card must take a very light hover");
  assert.match(css, /\.pill \{|\.pill\s*\{/, "tags must render as pills");
});

test("the buttons carry the three weights and the armed states", () => {
  assert.match(css, /\.primary \{[\s\S]*?background: var\(--ink\)/, "the primary button must be black");
  assert.match(css, /\.danger \{ color: var\(--red\)/, "a destructive button must be a red-on-white secondary");
  assert.match(css, /\.armed \{[\s\S]*?background: var\(--green\)/, "an armed positive action must turn green");
  assert.match(css, /\.armed\.danger \{[\s\S]*?background: var\(--red\)/, "an armed destructive action must turn red");
});

test("a status reaches the page as words, not as a key", () => {
  assert.match(app, /export function statusLabel\s*\(/, "app.js must have one statusLabel helper");
  // "Needs you" and "Waiting for you" read as the same thing, so the two
  // statuses are named for what they actually are.
  assert.match(app, /manual_action_needed:\s*"blocked"/, "manual_action_needed must read as blocked");
  assert.match(app, /awaiting_approval:\s*"to approve"/, "awaiting_approval must read as to approve");
  assert.ok(!/"needs you"|"waiting for you"/i.test(front), "the old ambiguous labels must be gone from every module");
  assert.match(app, /replace\(\/_\/g, " "\)/, "an unmapped status must fall back to the key with spaces");
  assert.ok(
    !/\$\{item\.from \|\| "new"\}/.test(rowJs),
    "the history must not print a raw status key",
  );
});

test("the stylesheet keeps to the flat card house style", () => {
  // Prose in a comment must not satisfy or break the check, so read the rules only.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/box-shadow/i.test(rules), "app.css must not use box-shadow: surfaces are flat");
  // Uppercase and tracking are allowed now, but only on the 12 px section label.
  const shouted = [...rules.matchAll(/text-transform:\s*uppercase/gi)];
  assert.equal(shouted.length, 1, "only the small section label may be uppercase");
  assert.match(rules, /\.eyebrow\s*\{[^}]*font-size:\s*12px[^}]*text-transform:\s*uppercase[^}]*letter-spacing/,
    "the uppercase label must be the 12 px grey eyebrow with slight tracking");
  assert.match(rules, /\.card\s*\{[^}]*border-radius:\s*12px/, "a card must have a 12 px radius");
  assert.match(rules, /border-radius:\s*8px/, "controls and pills must have an 8 px radius");
  assert.match(rules, /outline:\s*2px solid var\(--ink\)/, "focus must show a 2 px outline in the ink colour");
  assert.match(rules, /prefers-reduced-motion/, "app.css must respect prefers-reduced-motion");
});

test("the Resumes screen sits between Applications and Rules", () => {
  assert.match(html, /<a href="#\/resumes" data-nav="resumes">Resumes<\/a>/, "the nav link must read Resumes");
  assert.match(html, /<a href="#\/rules" data-nav="rules">Rules<\/a>/, "the nav link must read Rules");
  assert.match(html, /<a href="#\/runs" data-nav="runs">Runs<\/a>/, "the nav link must read Runs");
  const order = ["#/applications", "#/resumes", "#/rules", "#/runs"];
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
});

test("the Resumes screen renders nothing, and approves only through the tool", () => {
  // AGENTS.md section 5: rendering belongs to resume-writer and the content
  // review to resume-critic, so neither is offered here. Approval is offered,
  // and it is the real `resume:approve` behind the API, gate and all.
  assert.ok(
    resumesJs.includes("Rendering runs through /resume-review with the person present."),
    "the note under the list must still name /resume-review for rendering",
  );
  assert.ok(
    resumesJs.includes("refuses without a current critic verdict"),
    "the note must say that approval keeps the critic gate",
  );
  assert.ok(
    resumesJs.includes("No positionings yet. Run /onboarding, then /resume-review."),
    "the empty state must point at /onboarding and /resume-review",
  );
  assert.ok(!/text:\s*"Render\b/.test(resumesJs), "resumes.js must not offer a Render button");
  for (const label of ["Open PDF", "Open DOCX", "Markdown"]) {
    assert.ok(resumesJs.includes(label), `the card footer is missing the button: ${label}`);
  }
  assert.match(resumesJs, /Critic \$\{verdict\}/, "the card must carry a critic line");
  assert.ok(resumesJs.includes("positionings"), "the count line must say how many positionings there are");
  assert.ok(home.includes("stamp"), "the Home resumes card must carry the approval stamp");
});

test("approving a render is armed, gated on the critic, and posts to the tool", () => {
  assert.match(resumesJs, /text: "Approve this render"/, "the approve control must say what it approves");
  assert.match(resumesJs, /guarded\(button, "Approve"/, "approval must arm before it posts");
  assert.match(resumesJs, /class: "btn primary approve"/, "approval is the black primary action on the card");
  assert.match(resumesJs, /critic\.verdict !== "pass" \|\| approved\) return box/,
    "approval must only be offered on a passing critic and an unapproved stamp");
  assert.match(resumesJs, /api\(`resumes\/\$\{encodeURIComponent\(item\.id\)\}\/approve`/,
    "approval must post to the resume approve route");
  assert.match(resumesJs, /needs review: \$\{plural\(critic\.findings_count/,
    "a critic that asked for a revision must be named as work, with its count");
  assert.ok(resumesJs.includes('text: "run /resume-review"'), "and it must name the skill that does the work");
  // A refusal is the tool's own words. Softening it into a pass is the failure
  // mode AGENTS.md section 3.8 exists to stop.
  assert.match(resumesJs, /text: error\.message/, "a refusal must be shown verbatim");
});

test("the gate chips are gone, replaced by a tally and a fold", () => {
  assert.match(resumesJs, /Gates: \$\{tally\.pass\} pass, \$\{tally\.warn\} warn, \$\{tally\.fail\} fail/,
    "the gates must read as one sentence");
  assert.match(resumesJs, /text: "details", "aria-expanded": "false"/, "the names must sit behind a details fold");
  assert.match(resumesJs, /class: `gate-verdict \$\{toneFor\(gate\.verdict\)\}`/,
    "the fold must carry a toned verdict beside each gate name");
  assert.ok(!/function gateChip/.test(resumesJs), "the unlabelled chip row must be gone");
  assert.match(resumesJs, /class: "resume-stamp"/, "the stamp must sit on its own line");
  assert.match(resumesJs, /text: `rendered \$\{String\(item\.last_render_at\)\.slice\(0, 10\)\}`/,
    "the render date must sit with the stamp");
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

test("the Rules screen promotes a theme, edits a rule and shows the patterns read only", () => {
  assert.match(rulesJs, /export async function viewRules\s*\(/, "rules.js must export the view");
  for (const title of ["Recurring critic themes", "Standing rules", "Never named", "Editorial bans"]) {
    assert.ok(rulesJs.includes(title), `the Rules screen is missing: ${title}`);
  }
  // A theme key is machinery. `standing-rule-4:other` is not a heading.
  assert.match(rulesJs, /export function themeTitle\s*\(/, "a theme key must reach the page as words");
  assert.match(rulesJs, /`Standing rule \$\{numbered\[1\]\}`/, "standing-rule-4 must read as Standing rule 4");
  assert.match(rulesJs, /inflate: "inflation"/, "a verb class must read as its noun");
  assert.match(rulesJs, /\(theme\.count \?\? 0\) >= 2/, "only a theme said twice is expanded");
  assert.match(rulesJs, /Show \$\{plural\(singles\.length, "single finding"\)\}/, "singletons sit behind a toggle that counts them");
  assert.match(rulesJs, /text: "Promote to standing rule"/, "a theme must offer promotion");
  assert.match(rulesJs, /guarded\(promote, "Promote"/, "promotion must arm before it writes");
  assert.match(rulesJs, /api\("rules\/standing", \{ method: "POST", body: \{ text, source_theme: theme\.key \} \}\)/,
    "promotion must post the rule text and the theme it came from");
  assert.match(rulesJs, /api\(`rules\/standing\/\$\{index\}`/, "a rule must be editable in place");
  assert.match(rulesJs, /api\(`rules\/standing\/\$\{index\}\/remove`/, "a rule must be removable");
  assert.match(rulesJs, /guarded\(remove, "Remove"/, "removal must arm before it writes");
  assert.match(rulesJs, /class: "btn danger", text: "Remove"/, "removal is the red control");
  // The patterns are read only on purpose: a regex typed into a browser is a
  // way to quietly stop blocking a client's name.
  assert.ok(
    rulesJs.includes("Edit these in the file, not here."),
    "the never-named card must say it is read only",
  );
  assert.ok(!/api\("rules\/never-named/.test(rulesJs), "nothing may post a never-named pattern");
});

test("the Runs screen lists runs newest first and opens one at a time", () => {
  assert.match(runsJs, /export async function viewRuns\s*\(/, "runs.js must export the view");
  assert.ok(runsJs.includes("runs?limit=30"), "the list must ask for the last thirty runs");
  assert.match(runsJs, /newest first/, "the count line must say the order");
  assert.ok(
    runsJs.includes("No runs yet. The first daily run writes one at 07:00."),
    "the empty state must say when the first run happens",
  );
  assert.match(runsJs, /api\(`runs\/\$\{encodeURIComponent\(run\.date\)\}`\)/,
    "a row must fetch its own detail when it is opened");
  assert.match(runsJs, /if \(!open \|\| loaded\) return/, "a row must not refetch what it already has");
  assert.match(runsJs, /Sent unattended \(\$\{letters\.length\}\)/, "the letters an unattended run sent must be named as such");
  assert.match(runsJs, /exit \$\{run\.exit_code\}/, "a nonzero exit must be shown, not hidden");
  assert.match(runsJs, /export function duration\s*\(/, "a run must say how long it took");
});

test("a run that is still going is said in amber, not red, and not as no log", () => {
  // The 07:00 run was in progress and Home called it "did not finish" in red
  // and "no log". A run that has not finished is not a run that failed.
  assert.match(home, /export const RUNNING_COLOUR = "color: var\(--amber\);";/,
    "home.js must own the one colour a run in progress is said in");
  assert.match(home, /#B45309/, "and it must name the amber the person sees, so it can be checked");
  assert.match(css, /--amber: #b45309;/, "the amber token must be the colour the card asks for");
  assert.match(home, /export function soFar\(seconds\)/, "home.js must say how long a run has been going");
  assert.ok(home.includes("`${minutes} min so far`"), "a run in progress is read in minutes, not in seconds");

  // The Harness card.
  assert.match(home, /else if \(last\.running\) \{/, "the Harness card must branch on the running state first");
  assert.ok(
    home.includes('const said = `Running now${started ? `, started ${started}` : ""}${going ? `, ${going}` : ""}`;'),
    "the Harness card must say Running now, when it started and how long it has been going",
  );
  assert.ok(
    home.includes('h("p", { class: "home-line" }, h("span", { style: RUNNING_COLOUR, text: said }))'),
    "and the whole line must be amber, not red",
  );
  assert.match(home, /if \(health\.next_run\) body\.append\(line\(`Next run/, "the Next run line must stay");

  // The Latest run card.
  assert.match(home, /if \(run && run\.running\) \{/, "the Latest run card must branch on the running state too");
  assert.ok(home.includes('h("span", { style: RUNNING_COLOUR, text: `running now${going ? `, ${going}` : ""}` })'),
    "and say it in the same amber as the card above it");
  assert.ok(home.includes('const missing = run.has_log ? "no summary yet" : "no log";'),
    "a log that exists with no summary yet must not be reported as no log");
  assert.ok(home.includes('return card("Latest run", "#/runs", body);'),
    "the Latest run card still opens the Runs screen");

  // The Runs screen row.
  assert.match(runsJs, /function runningPill\(run\)/, "a running row must have its own pill");
  assert.ok(runsJs.includes('h("span", { class: "run-exit", style: RUNNING_COLOUR },'),
    "the running pill must be amber, not the grey no-log pill");
  assert.ok(runsJs.includes("background:var(--amber)"), "and it must carry an amber dot");
  assert.ok(runsJs.includes("going ? `running, ${going}` : \"running\""),
    "the row must read running, N min so far");
  assert.match(runsJs, /if \(run\.running\) return runningPill\(run\);/, "the running state must win over the exit pill");
  assert.ok(runsJs.includes('run.note || (run.has_log ? "no finish line" : "no log")'),
    "a finished-looking row with a log must not claim there is no log");
});

test("the resume card is styled as the board asks", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(rules, /\.stamp\.approved \{ color: var\(--green\)/, "an approved stamp must be green");
  assert.match(rules, /\.stamp\.missing \{ color: var\(--red\)/, "a missing render must be red");
  assert.match(rules, /\.page-img \{[^}]*height:\s*96px/, "a page thumbnail must be 96 px tall");
  assert.match(rules, /@media \(min-width: 900px\) \{\s*\.resume-grid \{ grid-template-columns: repeat\(2/,
    "two positionings sit side by side on a desktop");
  assert.match(rules, /\.resume-body \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\)/,
    "a resume card puts the pages beside the verdicts");
  assert.match(rules, /\.resume h2 \.stamp \{ margin-left: auto; \}/, "the stamp sits hard right on the title row");
  assert.match(resumesJs, /pages\.slice\(0, 4\)/, "a card shows at most four page thumbnails");
  assert.match(rules, /\.page\.low \{ border-color: var\(--red\)/, "a low-fill page must be outlined red");
  assert.match(rules, /\.chip\.good \.dot \{ background: var\(--green\)/, "a passing gate chip must carry a green dot");
});

if (process.exitCode) {
  console.error("ui-static: FAILURES");
} else {
  console.log(`ui-static: ${passed} passed`);
}
