#!/usr/bin/env tsx
/**
 * letter-critic-digest.test.ts: the critic's learning loop and its mechanical
 * pre-checks.
 *
 * Three things matter here. The digest groups a fortnight of blocked verdicts
 * into themes a human can promote into `letter-critic-rules.yaml`, and it
 * ignores passes and anything outside the window. The deterministic pre-checks
 * still catch an em dash and a never-named term without a model. And output the
 * model cannot be read must close the gate with a machine-readable reason, never
 * fall through to a pass.
 *
 * The fixture archive is invented end to end: no real employer, client or row.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDigest,
  CriticError,
  deterministicFindings,
  parseSince,
  parseVerdictText,
  requisitionCodesNotInJd,
  themeKey,
  UNPARSEABLE,
  verbClass,
  verdictFromRaw,
} from "../tools/letter-critic.ts";
import { exists } from "../tools/lib/fs.ts";
import { repoPath } from "../tools/repo-root.ts";

const ARCHIVE = repoPath("tests/fixtures/letter-critic/archive");
// Fixed so the fixture's dates keep their meaning as the calendar moves on.
const NOW = new Date("2026-09-17T00:00:00.000Z");

// --- digest: grouping, counts and rule candidates ---------------------------
{
  const digest = await buildDigest({ archiveDir: ARCHIVE, since: "14d", now: NOW });

  assert.equal(digest.since, "2026-09-03T00:00:00.000Z");
  assert.equal(digest.verdicts, 5, "the verdict older than 14d is out of the window");
  assert.equal(digest.blocked, 3);

  const counts = Object.fromEntries(digest.themes.map((t) => [t.key, t.count]));
  assert.deepEqual(counts, {
    "standing-rule-3:other": 2,
    "vantor freight:inflate": 2,
    "orbis trust:misattribut": 1,
  });

  // Sorted by count desc, then key, so the recurring themes read first.
  assert.deepEqual(digest.themes.map((t) => t.key), [
    "standing-rule-3:other",
    "vantor freight:inflate",
    "orbis trust:misattribut",
  ]);

  const inflate = digest.themes.find((t) => t.key === "vantor freight:inflate")!;
  assert.deepEqual(inflate.opportunity_ids, ["invented-blocked-001", "invented-blocked-002"]);
  assert.match(inflate.sample, /^Inflation of scope\./);

  for (const theme of digest.themes) {
    assert.match(theme.proposed_rule, /^- '.*'$/, `${theme.key} is a one-line YAML list item`);
    assert.equal(theme.proposed_rule.includes("\n"), false, `${theme.key} stays on one line`);
    assert.match(theme.proposed_rule, /blocked \d+ letters?/);
  }
  assert.match(inflate.proposed_rule, /blocked 2 letters on inflation/);
  assert.match(digest.themes.find((t) => t.key === "orbis trust:misattribut")!.proposed_rule, /blocked 1 letter on misattribution/);

  // A pass verdict contributes nothing, even when it carries warn findings.
  assert.equal(digest.themes.some((t) => /stale|jd phrasing/i.test(t.sample)), false);
}

// --- digest: a window that excludes everything is empty, not an error --------
{
  const digest = await buildDigest({ archiveDir: ARCHIVE, since: "1h", now: NOW });
  assert.equal(digest.verdicts, 1);
  assert.equal(digest.blocked, 0);
  assert.deepEqual(digest.themes, []);
}

// --- theme keys and windows -------------------------------------------------
{
  assert.equal(verbClass("Conflates two separate engagements into one claim."), "conflate");
  assert.equal(verbClass("Invented outcome: the corpus says scoped, not shipped."), "invent");
  assert.equal(verbClass("The letter omits the disclosure the corpus requires."), "omit");
  assert.equal(verbClass("Wording is loose but the claim is supported."), "other");

  assert.equal(themeKey("Standing Rule 7 breach: the venture is named."), "standing-rule-7:other");
  assert.equal(themeKey("Misattribution: the Orbis Trust work was reporting."), "orbis trust:misattribut");
  // The critic's own vocabulary is never the subject, nor is a quoted corpus line.
  assert.equal(themeKey("Inflation of scope. The corpus says otherwise."), "general:inflate");
  assert.equal(themeKey("The JD's phrase is not evidence about the applicant."), "general:other");

  assert.equal(parseSince("14d", NOW).toISOString(), "2026-09-03T00:00:00.000Z");
  assert.equal(parseSince("2w", NOW).toISOString(), "2026-09-03T00:00:00.000Z");
  assert.equal(parseSince("12h", NOW).toISOString(), "2026-09-16T12:00:00.000Z");
  assert.equal(parseSince("2026-09-01T00:00:00.000Z", NOW).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.throws(() => parseSince("a fortnight", NOW), /cannot read --since/);
}

// --- deterministic pre-checks ------------------------------------------------
{
  const neverNamed = [{
    pattern: /\bVantor\s+Freight\b/i,
    issue: "Names the client behind the engagement; it may only be 'a national freight operator'.",
    fix: "Replace the name with 'a national freight operator'.",
  }];

  const dashed = "I led the discovery \u2014 six weeks of it \u2014 for a national freight operator.";
  const dashFindings = deterministicFindings(dashed, neverNamed);
  assert.equal(dashFindings.length, 1);
  assert.equal(dashFindings[0].severity, "fail");
  assert.equal(dashFindings[0].source, "deterministic");
  assert.match(dashFindings[0].issue, /em or en dash/);

  const named = deterministicFindings("I led the Vantor Freight discovery.", neverNamed);
  assert.equal(named.length, 1);
  assert.equal(named[0].severity, "fail");
  assert.match(named[0].issue, /Names the client/);
  assert.match(named[0].fix, /national freight operator/);

  assert.deepEqual(deterministicFindings("I led the discovery for a national freight operator.", neverNamed), []);

  // A clearance the profile does not hold, and the eligibility wording that is fine.
  const clearance = deterministicFindings("I hold a current Baseline clearance.", []);
  assert.equal(clearance.length, 1);
  assert.match(clearance[0].issue, /security clearance/);
  assert.deepEqual(deterministicFindings("I am an Australian citizen, eligible for a Baseline clearance.", []), []);

  // A requisition code is a warn on its own and a fail when the JD does not use it.
  const coded = deterministicFindings("Reference LH-01234 applies.", []);
  assert.equal(coded.length, 1);
  assert.equal(coded[0].severity, "warn");
  const orphan = requisitionCodesNotInJd("Reference LH-01234 applies.", "A job ad with no code in it.");
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].severity, "fail");
  assert.deepEqual(requisitionCodesNotInJd("Reference LH-01234 applies.", "Apply quoting LH-01234."), []);
}

// --- malformed model output closes the gate ---------------------------------
{
  assert.equal(parseVerdictText("I am sorry, I cannot help with that."), null);

  assert.throws(
    () => verdictFromRaw({ result: "I could not read the letter." }),
    (e: unknown) => e instanceof CriticError && e.reason === UNPARSEABLE,
  );
  assert.throws(
    () => verdictFromRaw({ structured_output: { verdict: "maybe", findings: [] } }),
    (e: unknown) => e instanceof CriticError && e.reason === UNPARSEABLE,
  );
  // Free text around the JSON is still readable; only the unreadable throws.
  assert.equal(verdictFromRaw({ result: "```json\n{\"verdict\":\"pass\",\"findings\":[]}\n```" }).verdict, "pass");
}

// --- end to end: a child that talks nonsense exits 2 with the reason ---------
// Needs a profile corpus on disk (the critic reads it before it spawns), so it
// is skipped on a fresh clone rather than failing for the wrong reason.
{
  const corpus = repoPath("state/profile/cv-source.md");
  if (await exists(corpus)) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "letter-critic-"));
    const letter = path.join(tmp, "cover-letter.md");
    await fs.writeFile(letter, "Dear hiring manager,\n\nI would like to apply.\n\nRegards\n");
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\necho 'not json at all'\n", { mode: 0o755 });

    const out = await run(repoPath("tools/letter-critic.ts"), ["--letter", letter, "--out", path.join(tmp, "verdict.json")], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(out.code, 2, `expected exit 2, got ${out.code}: ${out.stderr.slice(0, 300)}`);
    const printed = JSON.parse(out.stdout.trim());
    assert.equal(printed.reason, UNPARSEABLE);
    assert.equal(printed.verdict, "error");
    // No verdict file may be left behind: a missing file is a closed gate.
    assert.equal(await exists(path.join(tmp, "verdict.json")), false);
    await fs.rm(tmp, { recursive: true, force: true });
  } else {
    console.log("skip: no state/profile/cv-source.md, end-to-end critic path not exercised");
  }
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", script, ...args], { env, cwd: repoPath("."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

console.log("letter-critic-digest.test.ts OK");
