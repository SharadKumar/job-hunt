#!/usr/bin/env tsx
/**
 * ui-static.test.ts - the local harness UI is three static files with no build
 * step, so nothing else checks them. This test pins the properties that make
 * them safe to serve and load:
 *
 *   - index.html loads app.js and app.css and nothing from the network. A CDN
 *     reference would send the person's browsing to a third party and break the
 *     page offline.
 *   - app.js never uses a browser modal (alert / confirm / prompt). Every
 *     action confirms inline, with a second deliberate press.
 *   - the four fixed keyword answers appear verbatim (AGENTS.md section 9).
 *   - every hash route the work package specifies is present.
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
  for (const route of ["queue", "row", "keywords", "today", "digest"]) {
    assert.ok(js.includes(`"${route}"`), `app.js does not name the route: ${route}`);
  }
  for (const hash of ["#/queue", "#/keywords", "#/today", "#/digest"]) {
    assert.ok(html.includes(hash), `index.html has no nav link for ${hash}`);
  }
  assert.ok(js.includes("#/row/"), "app.js must link a queue card to #/row/<id>");
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
  assert.match(html, /id="token-input"/, "index.html must have the token field");
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

test("app.js stays small enough to read in one sitting", () => {
  const lines = js.split("\n").length;
  assert.ok(lines <= 900, `app.js is ${lines} lines; the budget is 900`);
});

if (process.exitCode) {
  console.error("ui-static: FAILURES");
} else {
  console.log(`ui-static: ${passed} passed`);
}
