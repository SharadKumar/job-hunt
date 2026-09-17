import assert from "node:assert/strict";
import { runAutoFit, type FitSnapshot, type ShaveTarget } from "../tools/resume/resume-fit-apply.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";

/**
 * The ladder LOOP, with the audit stubbed. No browser, no render: these are the
 * three stopping rules that six real resumes needed and the loop did not have —
 * shave the text before dropping anything, never restore what this run just
 * dropped, and plan without touching the caller's composition.
 */

const content = (): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  summary: "Summary.",
  highlights: ["H1"],
  skills: [{ name: "Platform", bullets: ["Skill one"] }],
  experiences: [
    { placement: "feature", title: "Principal", company: "Now Co", start: "2026-03", end: "current", summary: "Recent role.", bullets: ["B0", "B1", "B2", "B3"] },
    { placement: "feature", title: "Lead", company: "Then Co", start: "2023-01", end: "2026-02", summary: "Middle role.", bullets: ["C0", "C1", "C2", "C3", "C4"] },
    { placement: "mention", title: "Engineer", company: "Old Co", start: "2019-01", end: "2022-12", one_liner: "Did the earlier thing." },
  ],
  resumeId: "test",
});

const snap = (fit: FitSnapshot["fit"], extra: Partial<FitSnapshot> = {}): FitSnapshot =>
  ({ fit, unitLines: {}, shaveableLines: 0, shaveTargets: [], ...extra });

const OVER = { verdict: "over_budget", lines_to_remove: 2, lines_to_add: 0 };
const CONVERGED = { verdict: "converged", lines_to_remove: 0, lines_to_add: 0 };
const targets: ShaveTarget[] = [
  { unit_path: "experiences[1].bullets[0]", kind: "experience_bullet", lines: 2, last_line_fill_pct: 18.4, shave_chars: 9 },
  { unit_path: "experiences[0].bullets[2]", kind: "experience_bullet", lines: 3, last_line_fill_pct: 22.0, shave_chars: 14 },
];

// ---- text first: an editing job is never answered by dropping -------------
{
  const result = await runAutoFit({
    content: content(),
    initial: snap(OVER, { shaveableLines: 2, shaveTargets: targets }),
    audit: async () => { throw new Error("the ladder must not re-audit after stopping for text edits"); },
  });
  assert.equal(result.stopped_because, "text_edits_would_suffice");
  assert.deepEqual(result.applied, [], "nothing was dropped");
  assert.deepEqual(result.shave_targets, targets, "the shave targets come back for the caller to print");
  assert.equal(result.passes, 0);
  assert.deepEqual(result.content.experiences, content().experiences, "the composition is unchanged");
  console.log("  ✓ over_budget stops for text edits when the ragged tails carry the deficit");
}

// Tails that do NOT carry the whole deficit are not an excuse to stop.
{
  let audits = 0;
  const result = await runAutoFit({
    content: content(),
    initial: snap(OVER, { shaveableLines: 1, shaveTargets: targets.slice(0, 1) }),
    audit: async () => { audits += 1; return snap(CONVERGED); },
  });
  assert.equal(result.stopped_because, "converged");
  assert.equal(audits, 1);
  assert.ok(result.applied.length > 0, "a deficit the tails cannot cover still drops");
  console.log("  ✓ shaveable lines short of the deficit do not stop the ladder");
}

// --force-drops overrides the text-first stop.
{
  const result = await runAutoFit({
    content: content(),
    textFirst: false,
    initial: snap(OVER, { shaveableLines: 9, shaveTargets: targets }),
    audit: async () => snap(CONVERGED),
  });
  assert.equal(result.stopped_because, "converged");
  assert.deepEqual(result.applied.map((o) => o.text), ["C4", "C3"], "--force-drops drops from the lowest-tier role");
  assert.equal(result.shave_targets, undefined);
  console.log("  ✓ --force-drops (textFirst false) lets the ladder drop anyway");
}

// ---- protected roles survive the loop, not just the plan ------------------
{
  const result = await runAutoFit({
    content: content(),
    textFirst: false,
    protectedExperiences: [1, 2],
    initial: snap({ verdict: "over_budget", lines_to_remove: 20, lines_to_add: 0 }),
    audit: async () => snap(CONVERGED),
  });
  assert.ok(result.applied.length > 0);
  assert.ok(
    result.applied.every((o) => o.op === "drop_bullet" && o.path.startsWith("experiences[0]")),
    "only the unprotected role gave anything up",
  );
  assert.equal(result.content.experiences.length, 3, "the protected mention stayed on the page");
  console.log("  ✓ protected experiences survive every pass of the loop");
}

// ---- oscillation: a drop this run is never restored in the same run -------
{
  // Pass 0 is over budget by one line → drop C4. The re-audit then reports the
  // page under-filled, and the only restore available is the C4 just benched:
  // that is the 19-drops/14-restores loop, and it stops here instead.
  const verdicts = [
    snap({ verdict: "under_filled", lines_to_remove: 0, lines_to_add: 2 }),
    snap({ verdict: "under_filled", lines_to_remove: 0, lines_to_add: 2 }),
  ];
  let audits = 0;
  const result = await runAutoFit({
    content: content(),
    keepAllMentions: true,
    initial: snap({ verdict: "over_budget", lines_to_remove: 1, lines_to_add: 0 }),
    audit: async () => verdicts[audits++] ?? snap(CONVERGED),
  });
  assert.equal(result.stopped_because, "oscillation");
  assert.equal(result.passes, 1, "one drop pass, then the loop refuses to undo itself");
  assert.deepEqual(result.applied.map((o) => o.text), ["C4"]);
  assert.deepEqual((result.content.experiences[1] as any).bullets, ["C0", "C1", "C2", "C3"]);
  console.log("  ✓ a restore of what this run dropped stops the ladder instead of oscillating");
}

// ---- dry run: planning never touches the caller's inputs ------------------
{
  // `--dry-run` is safe precisely because the loop is pure: the caller decides
  // whether to write the returned composition, and the one it handed in is
  // byte-identical afterwards.
  const input = content();
  const before = structuredClone(input);
  const provenance = { evidence: { experiences: { "Lead|Then Co|2023-01|2026-02": { bullets: [[], [], [], [], []] } } } } as any;
  const provenanceBefore = structuredClone(provenance);
  const result = await runAutoFit({
    content: input,
    provenance,
    textFirst: false,
    initial: snap({ verdict: "over_budget", lines_to_remove: 3, lines_to_add: 0 }),
    audit: async () => snap(CONVERGED),
  });
  assert.ok(result.applied.length > 0, "the ladder planned and applied against its own copy");
  assert.deepEqual(input, before, "the caller's composition is untouched");
  assert.deepEqual(provenance, provenanceBefore, "the caller's provenance is untouched");
  assert.notDeepEqual(result.content.experiences, before.experiences, "the RETURNED composition is the fitted one");
  console.log("  ✓ dry run: the loop plans without mutating the composition or provenance it was given");
}

console.log("auto-fit: all assertions passed");
