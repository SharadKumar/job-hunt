#!/usr/bin/env tsx
/**
 * ui-static.test.ts - the local Job Hunt UI is three static files with no build
 * step, so nothing else checks them. This test pins the properties that make
 * them safe to serve and load:
 *
 *   - index.html loads app.js and app.css and nothing from the network. A CDN
 *     reference would send the person's browsing to a third party and break the
 *     page offline.
 *   - app.js never uses a browser modal (alert / confirm / prompt). Every
 *     action confirms inline, with a second deliberate press.
 *   - the four fixed keyword answers appear verbatim (AGENTS.md section 9).
 *   - every hash route the work package specifies is present, settings included.
 *   - the visual contract of the board design: system sans, the fixed palette,
 *     flat cards, one uppercase label, and the three button weights.
 *   - no em dash and no en dash anywhere (AGENTS.md section 3.2).
 *   - app.js actually parses.
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
const JS_PATH = path.join(STATIC_DIR, "app.js");
const CSS_PATH = path.join(STATIC_DIR, "app.css");

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
const js = read(JS_PATH);
const css = read(CSS_PATH);

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

test("app.js and app.css pull nothing off the network", () => {
  // The only absolute URLs allowed in the front end are the ones the person's
  // own pipeline rows carry (row.url), which are data, not assets.
  assert.ok(!/@import\s+url\(/i.test(css), "app.css must not @import a remote stylesheet");
  assert.ok(!/https?:\/\//i.test(css), "app.css must not contain an http(s) URL");
  assert.ok(!/\bimport\s+[^\n]*["']https?:/i.test(js), "app.js must not import from a URL");
});

test("app.js uses no browser modal", () => {
  for (const banned of ["alert(", "confirm(", "prompt("]) {
    assert.ok(!js.includes(banned), `app.js must not call ${banned.slice(0, -1)}(): confirmation is inline`);
  }
});

test("app.js confirms inline, with a second press", () => {
  assert.match(js, /Confirm/, "app.js must label the armed state");
  assert.match(js, /guarded\s*\(/, "app.js must route action buttons through the inline confirm helper");
});

test("app.js never builds markup from a string", () => {
  assert.ok(!/\.innerHTML\s*=/.test(js), "app.js must not assign innerHTML");
  assert.ok(!/\bdocument\.write\b/.test(js), "app.js must not use document.write");
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
    assert.ok(js.includes(option), `app.js is missing the fixed answer: ${option}`);
  }
  const first = js.indexOf(options[0]);
  for (const option of options.slice(1)) {
    assert.ok(first < js.indexOf(option), `"${options[0]}" must be offered first, before "${option}"`);
  }
  assert.match(js, /\(Recommended\)/, "the recommended answer must be marked");
});

test("keyword bundles are capped at four", () => {
  assert.match(js, /KEYWORD_BUNDLE\s*=\s*4/, "app.js must cap a keyword bundle at four terms");
});

test("every route is present", () => {
  for (const route of ["queue", "row", "keywords", "today", "digest", "settings"]) {
    assert.ok(js.includes(`"${route}"`), `app.js does not name the route: ${route}`);
  }
  for (const hash of ["#/queue", "#/keywords", "#/today", "#/digest", "#/settings"]) {
    assert.ok(html.includes(hash), `index.html has no nav link for ${hash}`);
  }
  assert.ok(js.includes("#/row/"), "app.js must link a queue card to #/row/<id>");
});

test("settings opens from a cog in the header, drawn in the page itself", () => {
  assert.match(html, /aria-label="Settings"/, "the header must carry a cog labelled Settings");
  assert.match(html, /<svg[^>]*width="20"/, "the cog must be an inline 20 px svg");
  assert.ok(!/<img/i.test(html), "the cog must not be an external image");
  assert.match(js, /function viewSettings\s*\(/, "app.js must draw the settings view");
  for (const command of ["npm run ui -- --open", "bash scripts/install-ui-launchd.sh", "Tailscale", "enabled: false"]) {
    assert.ok(js.includes(command), `the settings About card never says: ${command}`);
  }
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
  ]) {
    assert.ok(js.includes(endpoint), `app.js never calls the API endpoint: ${endpoint}`);
  }
});

test("the token is read from localStorage and sent as a bearer header", () => {
  assert.match(js, /harnessUiToken/, "app.js must use the localStorage key harnessUiToken");
  assert.match(js, /Authorization/, "app.js must set an Authorization header");
  assert.match(js, /Bearer \$\{token\}|Bearer " \+ token|Bearer \$\{/, "the token must go out as Bearer");
  assert.match(js, /id: "token-input"/, "app.js must draw the token field on the settings view");
});

test("no em dash and no en dash in any of the three files", () => {
  for (const [file, body] of [[HTML_PATH, html], [JS_PATH, js], [CSS_PATH, css]] as const) {
    const hit = /[\u2013\u2014]/.exec(body);
    if (hit) {
      const line = body.slice(0, hit.index).split("\n").length;
      assert.fail(`${path.relative(ROOT, file)}:${line} contains a dash character that is banned`);
    }
  }
});

test("the product is named Job Hunt", () => {
  assert.match(html, /<title>Job Hunt<\/title>/, "the document title must be Job Hunt");
  assert.match(html, /class="brand"[^>]*>Job Hunt</, "the wordmark must read Job Hunt");
  assert.ok(js.includes("Job Hunt drafts and sends applications overnight."), "the queue lede must name Job Hunt");
  assert.ok(!/\bHarness\b/.test(html), "index.html must not still call the product Harness");
});

test("the stylesheet handles dark mode and phone width", () => {
  assert.match(css, /prefers-color-scheme:\s*dark/, "app.css must define a dark scheme");
  assert.match(css, /@media\s*\(min-width/, "app.css must have at least one responsive breakpoint");
  assert.match(css, /:focus-visible/, "app.css must keep a visible focus ring for keyboard use");
  assert.match(html, /name="viewport"/, "index.html must set a viewport for phone width");
});

test("app.js parses", () => {
  // node --check treats a bare .js file as a script, so strip the module
  // syntax first. app.js has none today, and this keeps the check honest if
  // that changes.
  const stripped = js
    .split("\n")
    .map((line) => (/^\s*(import|export)\b/.test(line) ? "" : line))
    .join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-static-test-"));
  const copy = path.join(dir, "app.check.js");
  try {
    fs.writeFileSync(copy, stripped);
    execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? error);
    assert.fail(`app.js does not parse:\n${stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("the five queue tabs are named as the person names them", () => {
  const labels = ["Needs you", "Waiting", "Shortlisted", "Parked", "Sent"];
  let at = -1;
  for (const label of labels) {
    const found = js.indexOf(`"${label}"`);
    assert.ok(found > -1, `app.js is missing the queue tab label: ${label}`);
    assert.ok(found > at, `queue tab "${label}" is out of order`);
    at = found;
  }
  // The labels must still map onto the pipeline statuses the API filters by.
  for (const status of ["manual_action_needed", "awaiting_approval", "shortlisted", "parked", "submitted"]) {
    assert.ok(js.includes(status), `app.js does not map a tab onto the status: ${status}`);
  }
});

test("the row detail carries the three stat cards", () => {
  assert.match(js, /function statsRow\s*\(/, "app.js must build the stats row on the row detail");
  assert.match(css, /\.stats\s*\{/, "app.css must style the stats row");
  assert.match(css, /\.stat\.good \.value\s*\{\s*color:\s*var\(--green\)/, "a passing verdict must be green");
  assert.match(css, /\.stat\.bad \.value\s*\{\s*color:\s*var\(--red\)/, "a failed verdict must be red");
  for (const stamp of ["Critic blocked", "Critic pass", "not recorded", "Gate waiting", "Gate passed", "Score"]) {
    assert.ok(js.includes(stamp), `the stats row never says: ${stamp}`);
  }
});

test("the queue reads as cards with a filter column", () => {
  for (const piece of ["Why it is here", "Filters", "Minimum score", "Details", "saved by you"]) {
    assert.ok(js.includes(piece), `the queue card or filter column never says: ${piece}`);
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
  assert.match(js, /function statusLabel\s*\(/, "app.js must have one statusLabel helper");
  assert.match(js, /manual_action_needed:\s*"needs you"/, "manual_action_needed must read as needs you");
  assert.match(js, /awaiting_approval:\s*"waiting for you"/, "awaiting_approval must read as waiting for you");
  assert.match(js, /replace\(\/_\/g, " "\)/, "an unmapped status must fall back to the key with spaces");
  assert.ok(
    !/\$\{item\.from \|\| "new"\}/.test(js),
    "the history must not print a raw status key",
  );
});

test("the stylesheet keeps to the flat card house style", () => {
  // Prose in a comment must not satisfy or break the check, so read the rules only.
  const rules = read(CSS_PATH).replace(/\/\*[\s\S]*?\*\//g, "");
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

test("app.js stays small enough to read in one sitting", () => {
  const lines = js.split("\n").length;
  assert.ok(lines <= 900, `app.js is ${lines} lines; the budget is 900`);
});

if (process.exitCode) {
  console.error("ui-static: FAILURES");
} else {
  console.log(`ui-static: ${passed} passed`);
}
