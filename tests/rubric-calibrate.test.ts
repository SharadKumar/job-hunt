import assert from "node:assert/strict";
import YAML from "yaml";
import {
  applyCalibration,
  bandsFor,
  calibrateTemplate,
  capacityEstimate,
  loadUnits,
  rewriteDesiredChars,
  type KindCalibration,
} from "../tools/resume/rubric-calibrate.ts";

const FIXTURE = "tests/fixtures/rubric-calibrate-audit.json";

// The fixture rubric mirrors the shape of a real template rubric: leading
// comments, unrelated keys, and the three enforced caps.
const RUBRIC = `# fixture template — comment that must survive a --write.
template: fixture-template
description: Fixture.

summary:
  min_chars: 280
  max_chars: 450
  candidate_narrative: true

skills:
  min_blocks: 3
  max_chars_per_item: 130

bullets:
  max_chars: 230
  weak_starts:
    - Responsible for

line_units:
  summary:
    desired_chars: "Fixture prose: target 95-115 chars per rendered line; compose 3-4 well-filled lines."
    severity: fail
  skill_summary:
    desired_chars: "Fixture skill lede: normally 78-108 chars including the heading prefix."
    max_lines: 1
    severity: fail
  skill_item:
    desired_chars: "Fixture skill item: one rendered line, normally 72-98 chars."
    max_lines: 1
    severity: fail
  experience_bullet:
    desired_chars: "Fixture bullet: target 78-96 chars for one line, or 165-190 chars for two balanced lines."
    max_lines: 3
    severity: fail
  credential:
    desired_chars: "Fixture credential: keep to one rendered line."
    max_lines: 1
    severity: fail
`;

const rubric = YAML.parse(RUBRIC);

// --- capacity estimator -----------------------------------------------------

assert.equal(capacityEstimate({ kind: "x", chars: 95, lines: 1, last_line_fill_pct: 95 }), 100);
assert.equal(capacityEstimate({ kind: "x", chars: 190, lines: 2, last_line_fill_pct: 90 }), 100);
assert.equal(capacityEstimate({ kind: "x", chars: 40, lines: 1, last_line_fill_pct: 40 }), null, "unsaturated units teach nothing about capacity");
console.log("  ✓ capacity estimator reads chars-per-full-line off saturated units");

// --- bands ------------------------------------------------------------------

const bands = bandsFor(100, 3);
assert.deepEqual(bands.single, [90, 98]);
assert.deepEqual(bands.two, [175, 195]);
assert.deepEqual(bands.three, [275, 295]);
assert.equal(bandsFor(100, 2).three, null, "three-line band only where max_lines allows it");
console.log("  ✓ bands derive from capacity (95% single, 1.75-1.95x two-line, 2.75-2.95x three-line)");

// --- calibration over a synthetic audit -------------------------------------

const { units, used } = await loadUnits([FIXTURE], "fixture-template");
assert.equal(used.length, 1);
assert.equal(units.length, 13);
assert.deepEqual((await loadUnits([FIXTURE], "some-other-template")).used, [], "audits for other templates are ignored");

const cal = calibrateTemplate("fixture-template", units, rubric);
const byKind = new Map(cal.kinds.map((k) => [k.kind, k]));
const kind = (name: string): KindCalibration => byKind.get(name)!;

assert.equal(cal.pooledCapacity, 100);
assert.equal(kind("experience_bullet").source, "measured");
assert.equal(kind("experience_bullet").capacity, 100);
assert.equal(kind("experience_bullet").saturated, 4);
assert.equal(kind("skill_item").source, "measured");
assert.equal(kind("skill_item").capacity, 100);

// shrink-to-fit inline units always report 100% fill: refuse the measurement.
assert.equal(kind("skill_summary").source, "pooled");
assert.match(kind("skill_summary").note ?? "", /disagree/);
// one unsaturated sample is not a measurement either.
assert.equal(kind("summary").source, "pooled");
assert.match(kind("summary").note ?? "", /saturated sample/);
// declared in the rubric, absent from the render: no band at all.
assert.equal(kind("credential").source, "none");
assert.equal(kind("credential").bands, null);
console.log("  ✓ per-kind capacity, pooled fallback, and skipped kinds");

const empty = calibrateTemplate("fixture-template", [], rubric);
assert.equal(empty.pooledCapacity, null);
assert.ok(empty.kinds.every((k) => k.source === "none" && k.bands === null));
console.log("  ✓ no measurements → every kind skipped, nothing to write");

// --- desired_chars rewriting ------------------------------------------------

const bulletText = rewriteDesiredChars(rubric.line_units.experience_bullet.desired_chars, kind("experience_bullet"));
assert.equal(bulletText, "Fixture bullet: target 90-98 chars for one line, or 175-195 chars for two balanced lines.");
assert.equal(rewriteDesiredChars(bulletText, kind("experience_bullet")), bulletText, "rewriting is idempotent");

const proseText = rewriteDesiredChars(rubric.line_units.summary.desired_chars, kind("summary"));
assert.equal(proseText, "Fixture prose: target 88-100 chars per rendered line; compose 3-4 well-filled lines.");

// a string with no numeric range gets one appended sentence, never two.
const oneLiner = rewriteDesiredChars("Fixture mention: keep the role row.", kind("skill_item"));
assert.equal(oneLiner, "Fixture mention: keep the role row. Measured capacity ~100 chars per rendered line: target 90-98 chars on the single rendered line.");
assert.equal(rewriteDesiredChars(oneLiner, kind("skill_item")), oneLiner, "appended guidance is replaced, not duplicated");
console.log("  ✓ desired_chars numbers rewritten in place, idempotently");

// --- writing the rubric document -------------------------------------------

const doc = YAML.parseDocument(RUBRIC);
const edits = applyCalibration(doc, cal);
const out = doc.toString({ lineWidth: 0 });
const reparsed = YAML.parse(out);

assert.ok(out.startsWith("# fixture template — comment that must survive a --write."), "comments preserved");
assert.deepEqual(reparsed.bullets.weak_starts, ["Responsible for"], "unrelated keys preserved");
assert.equal(reparsed.summary.candidate_narrative, true);
assert.equal(reparsed.skills.min_blocks, 3);
assert.equal(reparsed.line_units.experience_bullet.max_lines, 3, "sibling keys of desired_chars preserved");

assert.equal(reparsed.summary.min_chars, 250);
assert.equal(reparsed.summary.max_chars, 400);
assert.equal(reparsed.skills.max_chars_per_item, 100);
// 2 lines x 100 chars = 200, but the corpus already renders a 295-char bullet,
// so the cap is clamped up rather than invalidating a unit that passes today.
assert.equal(reparsed.bullets.max_chars, 295);
assert.ok(edits.caps.find((c) => c.path === "bullets.max_chars")?.clampedBy?.includes("observed longest"));
// `credential` has no bands, so its prose is left exactly as authored.
assert.equal(reparsed.line_units.credential.desired_chars, "Fixture credential: keep to one rendered line.");
assert.equal(edits.desired.length, 4);
console.log("  ✓ --write updates bands and clamped caps while preserving comments and keys");

// Caps absent from a rubric are never invented.
const lean = YAML.parseDocument("line_units:\n  experience_bullet:\n    desired_chars: \"target 78-96 chars\"\n    max_lines: 2\n");
const leanEdits = applyCalibration(lean, calibrateTemplate("fixture-template", units, lean.toJS()));
assert.deepEqual(leanEdits.caps, []);
assert.ok(!lean.toString().includes("max_chars:"));
console.log("  ✓ absent caps are not invented");

console.log("rubric-calibrate: all assertions passed");
