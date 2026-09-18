import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { makeTempRoot, repoFile } from "./helpers/temp-root.ts";

// The audit folds in the provenance gate, which reads state/profile/cv-source.md
// through repoPath(). That file is git-ignored, so a fresh clone has none: the
// audit is run against the fixture profile in a temp repo root instead, which
// also keeps the person's CV out of a template-sample audit. HARNESS_REPO_ROOT
// must be set before the first tools/ import, hence the dynamic one.
makeTempRoot("resume-audit-test-");
const { runAudit } = await import("../tools/resume/resume-audit.ts");

const SAMPLE = repoFile("templates/resume/classic/sample/sample-content.json");

// One audit = one Chromium launch. Inject a counting launcher so the assertion
// is structural, not inferred from timings.
let launches = 0;
const countingLaunch = async () => {
  launches += 1;
  return chromium.launch({ headless: true });
};

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-audit-test-"));
const started = Date.now();
const { compact, full, verdict } = await runAudit({
  contentJson: SAMPLE,
  template: "classic",
  outDir,
  filenamePrefix: "sample",
  strictLineUnits: false,
  images: true,
  dpi: 40,
  launch: countingLaunch,
});
const elapsed = Date.now() - started;

assert.equal(launches, 1, `expected exactly one chromium launch, got ${launches}`);
console.log("  ✓ resume:audit launches Chromium exactly once");

assert.ok(["pass", "warn", "fail"].includes(verdict));
assert.equal(compact.verdict, verdict);
assert.equal(compact.template, "classic");
assert.ok(compact.pages && compact.pages.count >= 1, "page count measured from pdftotext");
assert.ok(compact.fit && typeof compact.fit.lines_to_add === "number", "fit arithmetic present");
assert.ok(Array.isArray(compact.failing_units));
assert.ok(compact.gates.ats && compact.gates.ats.verdict, "ATS lint folded in");
assert.ok(compact.gates.provenance.verdict, "provenance folded in");
assert.ok(compact.gates.term_grounding.verdict, "term grounding folded in");
// Sample audits carry no positioning, so the keyword-cloud gate skips rather
// than failing a template sample against clouds it never had.
assert.equal(compact.gates.clouds.verdict, "skip", "clouds gate skips without --resume");
assert.ok(compact.gates.clouds.detail?.includes("no --resume"));
// DEPRECATED (one release): `lexicon` mirrors `clouds` for unmigrated readers.
assert.deepEqual(compact.gates.lexicon, compact.gates.clouds, "the lexicon alias key mirrors the clouds gate");
console.log("  ✓ compact report carries pages, fit, failing units and every gate");

const stdoutBytes = Buffer.byteLength(JSON.stringify(compact, null, 2));
// 16 KB, raised from 12 KB when `fit.candidates.short_single_lines` joined the
// compact report: an under-filled page now gets told where to ADD chars, not
// just where to shave them, which is worth ~1.6 KB on a sample this short.
assert.ok(stdoutBytes < 16 * 1024, `compact report is ${stdoutBytes} bytes; expected < 16 KB for a sample with no strict line units`);
// Passing units are never listed: every failing unit must carry a rule.
for (const unit of compact.failing_units) assert.ok(unit.rule && unit.unit_path);
console.log(`  ✓ compact report is ${stdoutBytes} bytes and lists only failing units`);

assert.equal(compact.images.pages.length, compact.pages!.count, "one PNG per page");
assert.deepEqual(compact.images.changed_pages, compact.pages!.fills.map((_, i) => i + 1), "first audit marks every page changed");
console.log("  ✓ page images produced and changed_pages covers every page on first audit");

for (const key of ["pdf", "html", "docx", "md", "audit_json"] as const) {
  const p = compact.artefacts[key];
  assert.ok(p, `artefact ${key} path present`);
  await fs.access(p!);
}
const persisted = JSON.parse(await fs.readFile(compact.artefacts.audit_json, "utf8"));
assert.ok(Array.isArray(persisted.pages.hashes) && persisted.pages.hashes.length === compact.pages!.count, "audit.json persists per-page hashes");
assert.ok(Array.isArray(persisted.line_units) && persisted.line_units.length > 0, "audit.json persists every measured unit");
assert.equal(full.evaluate.stats.fail_count + full.evaluate.stats.warn_count, full.evaluate.issues.length);
console.log("  ✓ artefacts written; audit.json holds hashes and full metrics");

// Re-audit with unchanged content: nothing changed.
launches = 0;
const second = await runAudit({
  contentJson: SAMPLE,
  template: "classic",
  outDir,
  filenamePrefix: "sample",
  strictLineUnits: false,
  launch: countingLaunch,
});
assert.equal(launches, 1);
assert.deepEqual(second.compact.images.changed_pages, [], "unchanged content → no changed pages");
console.log("  ✓ re-audit of unchanged content reports no changed pages");

assert.ok(elapsed < 20000, `audit took ${elapsed}ms; expected < 20s`);
console.log(`  ✓ audit wall clock ${elapsed}ms (${compact.timings_ms.total}ms measured)`);
