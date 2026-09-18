#!/usr/bin/env tsx
/**
 * locale.test.ts — the profile's locale block and the sites that read it.
 *
 * `locale` in profile.md carries `timezone`, `language` and `currency`. The
 * accessor in tools/profile.ts resolves them, falling back to exactly the
 * values the harness hard-coded before the block existed, so a profile without
 * one behaves as it always did.
 *
 * Covers: the defaults when the block is absent; each field overriding; the
 * `location.timezone` and `english_variant` fallbacks; and, end to end, the
 * daily summary naming its output file for the calendar day in the profile's
 * timezone rather than the machine's.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

// profile.ts pins the default profile path at import time, so the fixture root
// has to be in place before the dynamic import below.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "locale-"));
function writeProfile(localeBlock: string): void {
  const file = path.join(root, "state/profile/profile.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: A Person\nemail: a@example.com\n${localeBlock}---\n\n# Profile\n`);
}
writeProfile("");
process.env.HARNESS_REPO_ROOT = root;

const { LOCALE_DEFAULTS, resolveLocale, loadLocale } = await import("../tools/profile.ts");

let failures = 0;
function ok(msg: string) { console.log(`  ok  ${msg}`); }
function fail(msg: string) { failures++; console.error(`FAIL  ${msg}`); }
function check(name: string, fn: () => void) {
  try { fn(); ok(name); } catch (e: any) { fail(`${name}: ${e?.message ?? e}`); }
}

// ---------- defaults ----------

check("defaults are the pre-existing hard-coded values", () => {
  assert.deepEqual({ ...LOCALE_DEFAULTS }, { timezone: "Australia/Sydney", language: "en-AU", currency: "AUD" });
});

check("no frontmatter at all resolves to the defaults", () => {
  assert.deepEqual(resolveLocale(null), { ...LOCALE_DEFAULTS });
  assert.deepEqual(resolveLocale(undefined), { ...LOCALE_DEFAULTS });
});

check("a profile with no locale block resolves to the defaults", () => {
  assert.deepEqual(resolveLocale({ name: "A Person", email: "a@example.com" }), { ...LOCALE_DEFAULTS });
});

// ---------- overrides ----------

check("every field overrides", () => {
  const resolved = resolveLocale({
    name: "A Person",
    email: "a@example.com",
    locale: { timezone: "Europe/London", language: "en-GB", currency: "GBP" },
  });
  assert.deepEqual(resolved, { timezone: "Europe/London", language: "en-GB", currency: "GBP" });
});

check("a partial block only overrides what it names", () => {
  const resolved = resolveLocale({ name: "A", email: "a@example.com", locale: { currency: "NZD" } });
  assert.equal(resolved.currency, "NZD");
  assert.equal(resolved.timezone, LOCALE_DEFAULTS.timezone);
  assert.equal(resolved.language, LOCALE_DEFAULTS.language);
});

check("location.timezone is used when locale.timezone is absent", () => {
  const resolved = resolveLocale({ name: "A", email: "a@example.com", location: { timezone: "Pacific/Auckland" } });
  assert.equal(resolved.timezone, "Pacific/Auckland");
});

check("locale.timezone beats location.timezone", () => {
  const resolved = resolveLocale({
    name: "A", email: "a@example.com",
    location: { timezone: "Pacific/Auckland" },
    locale: { timezone: "Europe/London" },
  });
  assert.equal(resolved.timezone, "Europe/London");
});

check("english_variant stands in for language when language is absent", () => {
  const resolved = resolveLocale({ name: "A", email: "a@example.com", locale: { english_variant: "en-GB" } });
  assert.equal(resolved.language, "en-GB");
});

// ---------- loadLocale off disk ----------

{
  const resolved = await loadLocale();
  check("loadLocale: no block on disk gives the defaults", () => {
    assert.deepEqual(resolved, { ...LOCALE_DEFAULTS });
  });
}
writeProfile("locale:\n  timezone: Europe/London\n  language: en-GB\n  currency: GBP\n");
{
  const resolved = await loadLocale();
  check("loadLocale: a block on disk overrides", () => {
    assert.deepEqual(resolved, { timezone: "Europe/London", language: "en-GB", currency: "GBP" });
  });
}
// ---------- daily-summary uses the timezone ----------

/** Calendar date right now in a given zone. */
const dateIn = (tz: string) => new Date().toLocaleDateString("en-CA", { timeZone: tz });
const systemDate = dateIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
// One of these two extremes is always on a different calendar day to the machine.
const farZone = dateIn("Pacific/Kiritimati") !== systemDate ? "Pacific/Kiritimati" : "Etc/GMT+12";

const summaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "locale-daily-"));
fs.mkdirSync(path.join(summaryRoot, "state/profile"), { recursive: true });
fs.writeFileSync(
  path.join(summaryRoot, "state/profile/profile.md"),
  `---\nname: A Person\nemail: a@example.com\nlocale:\n  timezone: ${farZone}\n---\n\n# Profile\n`,
);

const run = spawnSync("npx", ["tsx", path.join(repo, "tools/daily-summary.ts"), "--no-sheet", "--json"], {
  cwd: repo,
  encoding: "utf8",
  env: {
    ...process.env,
    HARNESS_REPO_ROOT: summaryRoot,
    PIPELINE_DB: path.join(summaryRoot, "pipeline.db"),
    AUDIT_DIR: path.join(summaryRoot, "audit"),
  },
});

check("daily-summary defaults its date to the profile timezone, not the machine's", () => {
  assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
  const expected = dateIn(farZone);
  assert.notEqual(expected, systemDate, "fixture zone must differ from the machine's calendar day");
  const written = fs.readdirSync(path.join(summaryRoot, "state/journal/summary"));
  assert.deepEqual(written, [`${expected}.md`], `summary files: ${written.join(", ")}`);
  assert.equal(JSON.parse(run.stdout).date, expected);
});

console.log(failures ? `\n${failures} failed` : "\nall locale checks passed");
process.exit(failures ? 1 : 0);
