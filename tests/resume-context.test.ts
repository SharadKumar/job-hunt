#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildResumeContext, cloudsStatus, measuredFromAudit, MEASURED_STATUSES, lexiconStatus, parseCheckIds, parseEditorialRules, UNIVERSAL_CHECKS_PATH } from "../tools/resume/resume-context.ts";
import type { KeywordCloudsFile } from "../tools/keyword-clouds.ts";
import { activeResumes } from "../tools/resumes.ts";

// Pure parsers
const ids = parseCheckIds(`# x\n## Structural (text)\n### page_count\nblah\n### ats_lint\n## Visual (png)\n### layout_balance\n## Per-template overrides\n### should_be_structural\n`);
assert.deepEqual(ids.structural, ["page_count", "ats_lint", "should_be_structural"]);
assert.deepEqual(ids.visual, ["layout_balance"]);
const skips = parseCheckIds(`## Skipped universal checks (template-justified)\n### serif_font_loaded\n## Template-specific additions\n### date_alignment_right\n`);
assert.deepEqual(skips.skipped, ["serif_font_loaded"]);
assert.deepEqual(skips.structural, ["date_alignment_right"]);

const rules = parseEditorialRules(`# Rules\n\n## 2026-07-27 - No em dashes\n\n- **Never use an em dash.** Rewrite instead.\n- Second rule that is quite long ${"x".repeat(300)}\n\n## 2026-06-29 — Avoid SI\n- Spell it out.\n`, { truncate: 60 });
assert.equal(rules.length, 2);
assert.equal(rules[0].date, "2026-07-27");
assert.equal(rules[0].title, "No em dashes");
assert.equal(rules[0].rules[0], "Never use an em dash. Rewrite instead.");
assert.ok(rules[0].rules[1].length <= 60 && rules[0].rules[1].endsWith("…"));
assert.equal(rules[1].date, "2026-06-29");

// Cloud status on synthetic positionings: present / stale / missing.
{
  const day2 = 86_400_000;
  const at = new Date("2026-03-01T00:00:00Z");
  const file = (refreshed: Array<string | null>): KeywordCloudsFile => ({
    version: 1,
    clouds: refreshed.map((refreshed_at, i) => ({
      id: `c${i}`, kind: "capability" as const, label: `Cloud ${i}`, refreshed_at,
      terms: [{ term: `t${i}`, tier: "corpus" as const }],
    })),
  });
  const type = (refs: Array<{ id: string; weight: number }>) => ({ id: "synthetic", market_lens: { clouds: refs } }) as any;

  const fresh2 = cloudsStatus(type([{ id: "c0", weight: 5 }]), file([new Date(at.getTime() - 5 * day2).toISOString()]), at);
  assert.equal(fresh2.present, true);
  assert.equal(fresh2.missing, false);
  assert.equal(fresh2.stale, false);
  assert.equal(fresh2.term_count, 1);
  assert.equal(fresh2.clouds[0].weight, 5);
  assert.equal(fresh2.clouds[0].age_days, 5);

  // Only a load-bearing cloud (weight >= 4) makes the positioning stale.
  const old = new Date(at.getTime() - 60 * day2).toISOString();
  assert.equal(cloudsStatus(type([{ id: "c0", weight: 5 }]), file([old]), at).stale, true, "a stale weight-5 cloud is stale");
  assert.equal(cloudsStatus(type([{ id: "c0", weight: 2 }]), file([old]), at).stale, false, "a stale weight-2 aside does not block");

  // Unknown freshness is not freshness.
  assert.equal(cloudsStatus(type([{ id: "c0", weight: 4 }]), file([null]), at).stale, true);

  const noRefs = cloudsStatus(type([]), file([old]), at);
  assert.equal(noRefs.missing, true);
  assert.equal(noRefs.stale, false, "referencing no clouds is missing, not stale");
  assert.equal(noRefs.term_count, 0);
  assert.deepEqual(cloudsStatus(type([{ id: "nope", weight: 5 }]), file([old]), at).unknown_cloud_ids, ["nope"]);
  assert.equal(cloudsStatus(null, file([old]), at).missing, true);
}

// DEPRECATED (one release): the flat domain_lexicon path.
const day = 86_400_000;
const now = new Date("2026-03-01T00:00:00Z");
const synthetic = (refreshed_at: string | undefined, terms: number) => ({
  id: "synthetic",
  market_lens: { domain_lexicon: { refreshed_at, terms: Array.from({ length: terms }, (_, i) => ({ term: `t${i}`, tier: "corpus" })) } },
}) as any;

const fresh = lexiconStatus(synthetic(new Date(now.getTime() - 5 * day).toISOString(), 3), now);
assert.equal(fresh.present, true);
assert.equal(fresh.missing, false);
assert.equal(fresh.stale, false);
assert.equal(fresh.age_days, 5);
assert.equal(fresh.term_count, 3);

const stale = lexiconStatus(synthetic(new Date(now.getTime() - (fresh.stale_after_days + 1) * day).toISOString(), 2), now);
assert.equal(stale.present, true);
assert.equal(stale.stale, true, "older than the staleness window is stale");
assert.equal(stale.missing, false);

// Unknown freshness is not freshness.
const undated = lexiconStatus(synthetic(undefined, 1), now);
assert.equal(undated.present, true);
assert.equal(undated.age_days, null);
assert.equal(undated.stale, true);

const missing = lexiconStatus({ id: "synthetic", market_lens: {} } as any, now);
assert.equal(missing.missing, true);
assert.equal(missing.present, false);
assert.equal(missing.stale, false, "a missing lexicon is missing, not stale");
assert.equal(missing.term_count, 0);
assert.equal(lexiconStatus(null, now).missing, true);

// Live brief for the first active resume: every declared check id present, page policy resolved.
const [resume] = await activeResumes();
assert.ok(resume, "at least one active resume is required for this test");
const brief: any = await buildResumeContext({ resume: resume.id });
assert.equal(brief.resume.id, resume.id);
assert.ok(typeof brief.template.name === "string");
assert.ok(typeof brief.template.page_policy.hard_max === "number", "hard_max resolved from rubric or resume policy");
if (resume.page_policy?.hard_max) assert.equal(brief.template.page_policy.hard_max, resume.page_policy.hard_max, "resume page_policy overrides the rubric");

const declared = parseCheckIds(readFileSync(UNIVERSAL_CHECKS_PATH, "utf8"));
for (const id of declared.structural) assert.ok(brief.check_ids.structural.includes(id), `missing structural check id ${id}`);
for (const id of declared.visual) assert.ok(brief.check_ids.visual.includes(id), `missing visual check id ${id}`);
assert.ok(Array.isArray(brief.editorial_rules.profile));
assert.ok(brief.market_confirmations.confirmed && brief.market_confirmations.pending);
assert.ok(["approved", "stale", "fresh", "missing"].includes(brief.baseline.approval_status));

// The brief always carries the keyword-cloud status, so every caller can
// refuse to render a positioning whose market narrative is missing or stale.
assert.ok(brief.clouds, "brief carries a clouds block");
assert.equal(typeof brief.clouds.present, "boolean");
assert.equal(typeof brief.clouds.missing, "boolean");
assert.equal(typeof brief.clouds.stale, "boolean");
assert.equal(typeof brief.clouds.term_count, "number");
assert.equal(brief.clouds.stale_after_days, 30);
assert.ok(Array.isArray(brief.clouds.clouds));
assert.equal(brief.clouds.missing, !brief.clouds.present);
for (const c of brief.clouds.clouds) {
  assert.ok(c.id && c.label, "each cloud row names itself");
  assert.ok(c.weight >= 1 && c.weight <= 5, `cloud ${c.id} weight in range`);
}
assert.ok(Array.isArray(brief.resume.market_lens.clouds), "the compact market lens lists the referenced clouds");

assert.ok(brief.lexicon, "brief still carries the deprecated lexicon alias");
assert.equal(typeof brief.lexicon.present, "boolean");
assert.equal(typeof brief.lexicon.missing, "boolean");
assert.equal(typeof brief.lexicon.stale, "boolean");
assert.equal(typeof brief.lexicon.term_count, "number");
assert.equal(brief.lexicon.missing, !brief.lexicon.present);
assert.equal(brief.lexicon.stale_after_days, 30);
const bytes = Buffer.byteLength(JSON.stringify(brief));
// The brief is deliberately bigger since `measured` landed: it now carries the
// full text of every measured line unit so an agent can quote one exactly
// without opening the composition or the audit json.
const withoutMeasured = Buffer.byteLength(JSON.stringify({ ...brief, measured: null }));
assert.ok(withoutMeasured < 40_000, `brief minus measurements unexpectedly large: ${withoutMeasured} bytes`);
assert.ok(bytes < 120_000, `brief unexpectedly large: ${bytes} bytes`);

// Personal details never come from code: the brief carries paths, and the
// profile name is only present if state supplies it (never a literal here).
assert.ok(!JSON.stringify(brief).includes("__PLACEHOLDER__"));

console.log(`resume-context tests passed (${bytes} bytes for ${resume.id})`);

// ---------------------------------------------------------------------------
// measured: the audit's observations, folded into the brief so an agent sizes
// an edit without opening the composition, the provenance or the audit json.
// ---------------------------------------------------------------------------
{
  const spec = {
    experience_bullet: { max_lines: 2, single_line_min_fill_pct: 90, wrapped_last_line_min_fill_pct: 75 },
    credential: { max_lines: 1 },
  };
  const audit = {
    generated_at: "2026-09-11T00:00:00.000Z",
    verdict: "warn",
    pages: { count: 3, target: 3, hard_max: 4, fills: [95, 92, 61], last_page_fill_pct: 61, min_last_page_fill_pct: 75, hashes: ["a"] },
    fit: { verdict: "short", lines_to_remove: 0, lines_to_add: 5, pct_per_line: 1.9 },
    line_units: [
      { unit_path: "experiences[0].bullets[0]", kind: "experience_bullet", page: 1, lines: 1, last_line_fill_pct: 96, chars: 100, chars_per_line: 104, text: "A well-filled single line." },
      { unit_path: "experiences[0].bullets[1]", kind: "experience_bullet", page: 1, lines: 1, last_line_fill_pct: 50, chars: 52, text: "Too short." },
      { unit_path: "experiences[0].bullets[2]", kind: "experience_bullet", page: 2, lines: 2, last_line_fill_pct: 30, chars: 140, chars_per_line: 104, text: "A ragged tail." },
      { unit_path: "experiences[0].bullets[3]", kind: "experience_bullet", page: 2, lines: 3, last_line_fill_pct: 95, chars: 300, chars_per_line: 104, text: "One line too many." },
      { unit_path: "credentials[0]", kind: "credential", page: 3, lines: 1, last_line_fill_pct: 40, chars: 43, text: "A short credential with no single-line floor." },
    ],
    failing_units: [
      { unit_path: "experiences[0].bullets[3]", kind: "experience_bullet", rule: "line_count", severity: "fail", page: 2, lines: 3, last_line_fill_pct: 95, max_lines: 2, text: "One line too many." },
      { unit_path: "experiences[0].bullets[3]", kind: "experience_bullet", rule: "single_line_fill", severity: "fail", page: 2, lines: 3, last_line_fill_pct: 95, text: "One line too many." },
      { unit_path: "gone[0]", kind: "experience_bullet", rule: "line_count", severity: "fail", page: 9, lines: 4, last_line_fill_pct: 12, text: "Not in line_units." },
    ],
  };
  const m = measuredFromAudit(audit, spec as any);
  assert.equal(m.audit_generated_at, "2026-09-11T00:00:00.000Z");
  assert.equal(m.verdict, "warn");
  assert.equal(m.pages!.count, 3);
  assert.equal(m.pages!.hard_max, 4);
  assert.equal(m.fit!.lines_to_add, 5);

  // Document order is preserved, and each status is derived from the kind's band.
  assert.deepEqual(m.units.map((u) => u.status), ["ok", "short", "ragged", "over", "ok"]);
  assert.deepEqual(m.units.map((u) => u.path), audit.line_units.map((u) => u.unit_path));
  assert.deepEqual(m.summary, { units: 5, short_single_lines: 1, ragged_tails: 1, over_max_lines: 1 });

  // chars_per_line: measured when the audit carries it, back-estimated for a
  // single-line unit when it doesn't.
  assert.equal(m.units[1].chars_per_line, 104, "52 chars at 50% fill is a 104-char line");
  assert.equal(m.chars_per_line.experience_bullet, 104);
  assert.equal(m.chars_per_line.credential, 108, "43 chars at 40% fill");

  // Bands: single = [cpl * single_line_min_fill, cpl * 0.98]; null without a floor.
  assert.deepEqual(m.bands.experience_bullet.single, [94, 102]);
  assert.equal(m.bands.experience_bullet.max_lines, 2);
  assert.equal(m.bands.experience_bullet.wrapped_last_line_min_fill_pct, 75);
  assert.equal(m.bands.credential.single, null, "no single_line_min_fill_pct means no band");

  // Failing units are deduplicated per unit and carry the full (untruncated) text.
  assert.deepEqual(m.failing.map((u) => u.path), ["experiences[0].bullets[3]", "gone[0]"]);
  assert.equal(m.failing[0].chars, 300, "projected back onto the measured unit");
  assert.equal(m.failing[1].chars, null, "a unit absent from line_units still reports");

  // A unit whose kind has no rubric band is never failed on a band it doesn't have.
  const noSpec = measuredFromAudit(audit, {} as any);
  assert.ok(noSpec.units.every((u) => u.status === "ok"));
  assert.deepEqual(measuredFromAudit({}, spec as any).units, []);
  assert.equal(measuredFromAudit({}, spec as any).pages, null);
}

// The live brief carries the same block for a real baseline.
assert.equal(typeof brief.how_to_edit, "string");
assert.ok(brief.how_to_edit.includes("resume:edit"), "the brief documents how an edit is applied");
assert.ok("measured" in brief, "the brief always declares the measured block");
if (brief.baseline.artefacts?.audit_json) {
  const m = brief.measured;
  assert.ok(m, "an audited baseline carries measurements");
  assert.ok(m.units.length > 0, "measured units are present");
  for (const u of m.units) {
    assert.ok(typeof u.path === "string" && u.path.length > 0, "each unit names its path");
    assert.ok(u.chars_per_line === null || typeof u.chars_per_line === "number", `${u.path} chars_per_line is a number or null`);
    assert.ok(MEASURED_STATUSES.includes(u.status), `${u.path} status ${u.status} is allowed`);
    assert.equal(typeof u.text, "string");
  }
  for (const kind of Object.keys(brief.template.line_units)) {
    assert.ok(m.bands[kind], `bands cover rubric kind ${kind}`);
  }
  assert.equal(m.summary.units, m.units.length);
  console.log(`measured.summary: ${JSON.stringify(m.summary)}`);
  console.log(`measured.units[0]: ${JSON.stringify(m.units[0])}`);
} else {
  assert.equal(brief.measured, null, "no audit json means no measurements");
}

const bytesWithMeasured = Buffer.byteLength(JSON.stringify(brief));
console.log(`brief bytes: ${bytesWithMeasured}`);
