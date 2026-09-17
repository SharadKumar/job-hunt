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
  "app.js", "applications.js", "row.js", "keywords.js",
  "home.js", "settings.js", "today.js", "digest.js", "resumes.js",
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
  for (const name of MODULES.filter((m) => m !== "app.js")) {
    assert.ok(app.includes(`from "./${name}"`), `app.js does not import ./${name}`);
  }
  assert.match(app, /import \{ viewResumes \} from "\.\/resumes\.js"/, "app.js must import the resumes view");
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
  assert.match(keywords, /\["Must have", shown\.filter/, "the list must lead with the must-have group");
  assert.match(keywords, /\["Other", shown\.filter/, "and follow it with the rest");
  assert.match(keywords, /class: "kw-group eyebrow"/, "each group carries a small heading");
  assert.match(css, /\.must \{[\s\S]*?background: var\(--green\);/, "must-have is a green dot");
  assert.match(css, /@media \(min-width: 900px\) \{\s*\.kw-layout \{ grid-template-columns: 240px/,
    "the term list must be 240 px on a desktop");
  assert.match(css, /\.kw-list \{ position: sticky; top: 88px; \}/, "and it must stay in view while the cards scroll");
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

test("every route is present, and Home is the default", () => {
  for (const route of ["home", "applications", "queue", "row", "resumes", "keywords", "today", "digest", "settings"]) {
    assert.ok(app.includes(`"${route}"`), `app.js does not name the route: ${route}`);
  }
  for (const hash of ["#/home", "#/applications", "#/resumes", "#/keywords", "#/today", "#/digest", "#/settings"]) {
    assert.ok(html.includes(hash), `index.html has no nav link for ${hash}`);
  }
  assert.ok(applications.includes("#/row/"), "app.js must link an application card to #/row/<id>");
  assert.match(app, /location\.hash \|\| "#\/home"/, "an empty hash must resolve to Home");
  assert.match(app, /if \(!location\.hash\) location\.hash = "#\/home"/, "a first load must land on Home");
  assert.match(app, /!ROUTES\.includes\(name\) \? "home"/, "an unknown hash must fall back to Home");
});

test("the nav is in the agreed order, with the switch then the cog last", () => {
  const order = ["#/home", "#/applications", "#/resumes", "#/keywords", "#/today", "#/digest"];
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
  assert.match(app, /name === "queue"/, "app.js must still accept the old #/queue address");
  assert.match(app, /history\.replaceState\(null, "", "#\/applications"\)/, "#/queue must redirect to the canonical address");
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
    "Blocked", "Sent today", "To approve", "Resumes", "Keywords",
    "Recurring critic themes", "Today's run",
  ]) {
    assert.ok(home.includes(`"${title}"`), `Home is missing the card: ${title}`);
  }
  for (const href of ["#/applications/needs", "#/applications/sent", "#/applications/waiting",
    "#/resumes", "#/keywords", "#/digest", "#/today"]) {
    assert.ok(home.includes(href), `a Home card does not link to ${href}`);
  }
  assert.ok(home.includes("Start deciding"), "the keywords card must carry the primary Start deciding button");
  assert.match(home, /See all \$\{rows\.length\}/, "the needs card must offer to see all of them");
  assert.match(home, /rows\.slice\(0, 5\)/, "the needs card must show the top five rows");
  assert.match(home, /slice\(0, 3\)/, "the digest card must show the top three themes");
  assert.match(home, /slice\(0, 12\)/, "the run card must show the first twelve lines of the summary");
  assert.match(home, /Read today/, "the run card must link to Today");
  assert.match(applications, /TABS\.some\(\(t\) => t\.key === which\)/, "a Home link must open the right applications tab");
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
});

test("the Home cards are in priority order", () => {
  // What is stuck first, then what waits on a decision, then the backlog,
  // then the record of what already happened.
  const call = /grid\.append\(\n([\s\S]*?)\n  \);/.exec(home);
  assert.ok(call, "home.js must append the cards in one call");
  const order = [...call![1].matchAll(/(\w+Card)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(
    order,
    ["needsCard", "waitingCard", "keywordsCard", "sentCard", "resumesCard", "digestCard", "todayCard"],
    "the Home cards are out of priority order",
  );
});

test("the run card renders markdown rather than printing the source", () => {
  assert.ok(
    home.includes("richMarkdown"),
    "home.js must use the shared markdown renderer from app.js",
  );
  assert.match(app, /export function richMarkdown\s*\(/, "app.js must export the shared renderer");
  assert.ok(src["today.js"].includes("richMarkdown"), "Today must use the same renderer as Home");
  assert.ok(
    !/h\("pre", \{ class: "home-journal"/.test(home),
    "the run card must not print the journal as raw preformatted source",
  );
});

test("Home says which lane is in force, once, at the top", () => {
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
  for (const name of ["home.js", "applications.js", "row.js", "resumes.js", "keywords.js", "today.js", "digest.js", "settings.js"]) {
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
  assert.match(css, /\.lede \{\s*margin: 4px 0 0;/, "the lede must sit 4 px under the title");
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
  for (const stamp of ["Critic blocked", "Critic pass", "not recorded", "Gate waiting", "Gate passed", "Score"]) {
    assert.ok(rowJs.includes(stamp), `the stats row never says: ${stamp}`);
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

test("the Resumes screen sits between Applications and Keywords", () => {
  assert.match(html, /<a href="#\/resumes" data-nav="resumes">Resumes<\/a>/, "the nav link must read Resumes");
  const order = ["#/applications", "#/resumes", "#/keywords"];
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

test("the Resumes screen renders nothing and approves nothing", () => {
  // AGENTS.md section 5: both belong to resume-writer, resume-critic and an
  // attended `npm run resume:approve`. The screen says so in as many words.
  assert.ok(
    resumesJs.includes("Rendering and approval run through /resume-review with the person present."),
    "the note under the list must name /resume-review",
  );
  assert.ok(
    resumesJs.includes("No positionings yet. Run /onboarding, then /resume-review."),
    "the empty state must point at /onboarding and /resume-review",
  );
  assert.ok(
    !/text:\s*"(Render|Approve)(\s+[A-Za-z]+)?"/.test(resumesJs),
    "resumes.js must not offer a Render or an Approve button",
  );
  for (const label of ["Open PDF", "Open DOCX", "Markdown"]) {
    assert.ok(resumesJs.includes(label), `the card footer is missing the button: ${label}`);
  }
  assert.match(resumesJs, /Critic \$\{verdict\}/, "the card must carry a critic line");
  assert.ok(resumesJs.includes("positionings"), "the count line must say how many positionings there are");
  assert.ok(home.includes("stamp"), "the Home resumes card must carry the approval stamp");
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
