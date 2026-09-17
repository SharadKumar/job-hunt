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
  assert.match(app, /Autopilot \$\{on \? "on" : "off"\}/, "the switch must say whether autopilot is on");
  assert.match(css, /\.switch\.on::before \{ background: var\(--green\)/, "the on state must be green");
});

test("a missing policy API degrades to a disabled switch", () => {
  assert.ok(app.includes("policy API unavailable"), "app.js must say when the policy API is not there");
  assert.match(app, /error\.status === 404\) policyAvailable = false/, "a 404 must mark the policy API unavailable");
  assert.match(app, /class: "switch off", disabled: true/, "the fallback switch must be disabled");
  assert.ok(home.includes("policy API"), "Home must say so too rather than guess the lane");
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
    "Needs you", "Sent today", "Waiting for you", "Resumes", "Keywords",
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

test("the product is named Job Hunt", () => {
  assert.match(html, /<title>Job Hunt<\/title>/, "the document title must be Job Hunt");
  assert.match(html, /class="brand"[^>]*>Job Hunt</, "the wordmark must read Job Hunt");
  assert.ok(applications.includes("Job Hunt drafts and sends applications overnight."), "the applications lede must name Job Hunt");
  assert.ok(!/\bHarness\b/.test(html), "index.html must not still call the product Harness");
});

test("the stylesheet handles dark mode and phone width", () => {
  assert.match(css, /prefers-color-scheme:\s*dark/, "app.css must define a dark scheme");
  assert.match(css, /@media\s*\(min-width/, "app.css must have at least one responsive breakpoint");
  assert.match(css, /:focus-visible/, "app.css must keep a visible focus ring for keyboard use");
  assert.match(html, /name="viewport"/, "index.html must set a viewport for phone width");
  assert.match(css, /\.home-grid \{ grid-template-columns: repeat\(2/, "Home must go to two columns on a desktop");
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
  const labels = ["Needs you", "Waiting", "Shortlisted", "Parked", "Sent"];
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
  assert.match(app, /manual_action_needed:\s*"needs you"/, "manual_action_needed must read as needs you");
  assert.match(app, /awaiting_approval:\s*"waiting for you"/, "awaiting_approval must read as waiting for you");
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
  assert.match(rules, /\.page-img \{[^}]*height:\s*120px/, "a page thumbnail must be 120 px tall");
  assert.match(rules, /\.page\.low \{ border-color: var\(--red\)/, "a low-fill page must be outlined red");
  assert.match(rules, /\.chip\.good \.dot \{ background: var\(--green\)/, "a passing gate chip must carry a green dot");
});

if (process.exitCode) {
  console.error("ui-static: FAILURES");
} else {
  console.log(`ui-static: ${passed} passed`);
}
