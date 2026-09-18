#!/usr/bin/env tsx
/**
 * tests/archive.test.ts — tools/archive-compact.ts.
 *
 * The archive is the only record of what was actually sent, so the compactor
 * has to be provably conservative: it may only delete a package file whose
 * bytes still exist in the approved baseline directory, it must record the
 * reference it replaced them with, it must never touch a tailored package's
 * CV, and a dry run must change nothing at all.
 *
 * Run: npx tsx tests/archive.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { makeArchiveFixture } from "./fixtures/archive/make-archive.ts";

const fixture = makeArchiveFixture();
process.env.HARNESS_REPO_ROOT = fixture.root;

const { compactArchive } = await import("../tools/archive-compact.ts");

const run = (apply: boolean) => compactArchive({ archiveDir: fixture.archiveDir, baselinesDir: fixture.baselinesDir, apply });
const pkgFile = (name: string) => path.join(fixture.baselinePackage, name);
const readMeta = (dir: string) => JSON.parse(readFileSync(path.join(dir, "metadata.json"), "utf8"));

const tailoredDocx = path.join(fixture.tailoredPackage, "Fixture-Person_Tailored.docx");
const tailoredBefore = readFileSync(tailoredDocx);
const tailoredMetaBefore = readFileSync(path.join(fixture.tailoredPackage, "metadata.json"), "utf8");

const tests: Array<[string, () => Promise<void> | void]> = [
  ["dry run reports the work and changes nothing", async () => {
    const before = statSync(fixture.screenshot).size;
    assert.ok(before > 300 * 1024, `fixture screenshot should exceed the 300KB threshold, got ${before}`);
    const summary = await run(false);
    assert.equal(summary.dry_run, true);
    assert.equal(summary.packages, 2);
    assert.equal(summary.converted_to_ref, 1);
    assert.equal(summary.screenshots_reencoded, 1);
    assert.equal(summary.scratch_removed, 1);
    assert.ok(summary.bytes_reclaimable_or_reclaimed > 300 * 1024, "dry run should estimate real savings");

    // Nothing moved.
    assert.ok(existsSync(pkgFile(fixture.docxName)));
    assert.ok(existsSync(fixture.screenshot));
    assert.ok(existsSync(fixture.scratchFile));
    assert.equal(readMeta(fixture.baselinePackage).resume.ref, undefined);
  }],

  ["--apply converts the baseline package to a reference", async () => {
    const summary = await run(true);
    assert.equal(summary.dry_run, false);
    assert.equal(summary.converted_to_ref, 1);
    assert.equal(summary.scratch_removed, 1);

    const meta = readMeta(fixture.baselinePackage);
    assert.equal(meta.resume.mode, "baseline");
    assert.equal(meta.resume.ref, path.join("state", "profile", "resumes", "fixture-resume", fixture.docxName));
    assert.equal(meta.resume.sha256, fixture.docxSha256);
    assert.ok(meta.resume.pdf_ref?.endsWith("Fixture-Person_Architect.pdf"));
    assert.equal(meta.resume.docx, undefined, "the copy path must not survive as a claim");
    assert.equal(meta.resume.pages, 3, "unrelated metadata survives");
    // The referenced file is real and hashes to what metadata records.
    assert.ok(existsSync(path.join(fixture.root, meta.resume.ref)));

    // Duplicate copies gone, the package's own record kept.
    for (const name of [fixture.docxName, "Fixture-Person_Architect.pdf", "Fixture-Person_Architect.md"]) {
      assert.ok(!existsSync(pkgFile(name)), `${name} should have been removed`);
    }
    for (const name of ["cover-letter.md", "jd.md", "confirmation.txt", "metadata.json"]) {
      assert.ok(existsSync(pkgFile(name)), `${name} must be kept`);
    }
    assert.ok(!existsSync(fixture.scratchFile), "scratch file should be gone");
  }],

  ["--apply re-encodes the screenshot to a smaller jpeg", async () => {
    const jpeg = fixture.screenshot.replace(/\.png$/, ".jpg");
    assert.ok(!existsSync(fixture.screenshot), "the PNG should have been replaced");
    assert.ok(existsSync(jpeg), "a JPEG should be beside the confirmation");
    assert.ok(statSync(jpeg).size < 300 * 1024, "the JPEG should be well under the PNG");
  }],

  ["the tailored package is untouched", () => {
    assert.deepEqual(readFileSync(tailoredDocx), tailoredBefore);
    assert.equal(readFileSync(path.join(fixture.tailoredPackage, "metadata.json"), "utf8"), tailoredMetaBefore);
  }],

  ["a second run is a no-op", async () => {
    const summary = await run(false);
    assert.equal(summary.packages, 2);
    assert.equal(summary.converted_to_ref, 0);
    assert.equal(summary.screenshots_reencoded, 0);
    assert.equal(summary.scratch_removed, 0);
    assert.equal(summary.bytes_reclaimable_or_reclaimed, 0);
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
