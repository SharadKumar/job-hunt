import assert from "node:assert/strict";
import { applyFitOps, planAutoOps, parseUnitPath, experienceTier, protectedExperienceIndices, AUTO_FIT_DROP_REASON, type FitOp } from "../tools/resume/lib/fit-ops.ts";
import type { ResumeContent, ResumeSourceProvenance } from "../templates/resume/_interface.ts";

const ref = (a: number, b: number) => [{ file: "state/profile/cv-source.md", lines: [a, b] as [number, number] }];

const content = (): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  summary: "Summary.",
  highlights: ["H1"],
  skills: [{ name: "Platform", bullets: ["Skill one", "Skill two"] }],
  experiences: [
    { placement: "feature", title: "Principal", company: "Now Co", start: "2026-03", end: "current", summary: "Recent role.", bullets: ["B0", "B1", "B2", "B3"] },
    { placement: "feature", title: "Lead", company: "Then Co", start: "2023-01", end: "2026-02", summary: "Middle role.", bullets: ["C0", "C1", "C2", "C3", "C4"] },
    { placement: "mention", title: "Engineer", company: "Old Co", start: "2019-01", end: "2022-12", one_liner: "Did the earlier thing." },
  ],
  resumeId: "test",
});

const provenance = (): ResumeSourceProvenance => ({
  evidence: {
    summary: ref(1, 2),
    highlights: [ref(3, 4)],
    skills: { Platform: ref(5, 6) },
    experiences: {
      "Principal|Now Co|2026-03|current": { summary: ref(10, 11), bullets: [ref(20, 20), ref(21, 21), ref(22, 22), ref(23, 23)] },
      "Lead|Then Co|2023-01|2026-02": { summary: ref(30, 31), bullets: [ref(40, 40), ref(41, 41), ref(42, 42), ref(43, 43), ref(44, 44)] },
      "Engineer|Old Co|2019-01|2022-12": { one_liner: ref(50, 51) },
    },
  },
});

const order = (c: ResumeContent) => c.experiences.map((e) => `${e.title}@${e.company}`);

// ---- path parsing ---------------------------------------------------------
assert.deepEqual(parseUnitPath("experiences[2].bullets[3]"), { kind: "bullet", index: 2, bullet: 3 });
assert.deepEqual(parseUnitPath("skills[1]"), { kind: "skill", index: 1 });
assert.equal(parseUnitPath("summary"), null);
assert.equal(experienceTier({ ...content().experiences[0], tier: 7 }, 0), 7);
assert.equal(experienceTier(content().experiences[1], 1), 1);
console.log("  ✓ path parsing and tier resolution");

// ---- drop_bullet is lossless and prunes the sidecar refs -------------------
const base = { content: content(), provenance: provenance() };
const dropped = applyFitOps(base, [{ op: "drop_bullet", path: "experiences[1].bullets[2]" }]);
assert.equal(dropped.applied.length, 1);
assert.equal(dropped.applied[0].text, "C2");
assert.deepEqual((dropped.content.experiences[1] as any).bullets, ["C0", "C1", "C3", "C4"]);
const droppedRefs = dropped.provenance!.evidence.experiences["Lead|Then Co|2023-01|2026-02"].bullets!;
assert.equal(droppedRefs.length, 4, "provenance refs pruned in step with the bullet");
assert.deepEqual(droppedRefs.map((r) => r[0].lines[0]), [40, 41, 43, 44]);
assert.deepEqual(dropped.content.bench!.bullets!["Lead|Then Co|2023-01|2026-02"][0].provenance, ref(42, 42), "the dropped ref travels to the bench");
assert.deepEqual(base.content.experiences[1], content().experiences[1], "input content is never mutated");
assert.deepEqual(base.provenance, provenance(), "input provenance is never mutated");
console.log("  ✓ drop_bullet prunes provenance refs and leaves the input untouched");

// ---- restore_bullet round-trips exactly -----------------------------------
const restored = applyFitOps({ content: dropped.content, provenance: dropped.provenance }, [{ op: "restore_bullet", path: "experiences[1]" }]);
assert.deepEqual(restored.content.experiences, content().experiences, "content round-trips losslessly");
assert.deepEqual(restored.provenance, provenance(), "provenance round-trips losslessly, refs back in their slot");
assert.deepEqual(restored.content.bench!.bullets!["Lead|Then Co|2023-01|2026-02"], [], "bench emptied");
console.log("  ✓ drop_bullet → restore_bullet is lossless, in slot, refs restored");

// ---- idempotency ----------------------------------------------------------
const twice = applyFitOps(base, [
  { op: "drop_bullet", path: "experiences[1].bullets[2]", text: "C2" },
  { op: "drop_bullet", path: "experiences[1].bullets[2]", text: "C2" },
]);
assert.equal(twice.applied.length, 1);
assert.equal(twice.skipped.length, 1);
assert.match(twice.skipped[0].reason, /already benched/);
assert.deepEqual((twice.content.experiences[1] as any).bullets, ["C0", "C1", "C3", "C4"], "the second apply changed nothing");
console.log("  ✓ replaying a plan is a no-op, not a second drop");

// ---- drop_mention / restore_mention preserve experience ordering -----------
const noMention = applyFitOps(base, [{ op: "drop_mention", path: "experiences[2]" }]);
assert.equal(noMention.applied.length, 1);
assert.deepEqual(order(noMention.content), ["Principal@Now Co", "Lead@Then Co"]);
assert.equal(noMention.provenance!.evidence.experiences["Engineer|Old Co|2019-01|2022-12"], undefined, "its provenance entry left with it");
assert.deepEqual(noMention.content.bench!.mentions![0].provenance, ref(50, 51));
// A dropped role is never silent: the preservation gate reads this receipt.
assert.deepEqual(noMention.content.dropped_experiences, [{ id: "Engineer|Old Co|2019-01|2022-12", reason: AUTO_FIT_DROP_REASON }]);

const backAgain = applyFitOps({ content: noMention.content, provenance: noMention.provenance }, [{ op: "restore_mention" }]);
assert.deepEqual(order(backAgain.content), order(content()), "restored into its reverse-chronological slot, not appended");
assert.deepEqual(backAgain.content.experiences, content().experiences);
assert.deepEqual(backAgain.provenance, provenance(), "one_liner refs restored under the original key");
assert.deepEqual(backAgain.content.dropped_experiences, [], "restoring the role rescinds its drop entry");
console.log("  ✓ drop_mention → restore_mention keeps ordering, refs, and the drop receipt");

// A writer-authored drop entry is left exactly as the writer wrote it.
{
  const authored = content();
  authored.dropped_experiences = [{ id: "Analyst|Ancient Co|2001-01|2003-01", reason: "pre-dates the positioning" }];
  const withDrop = applyFitOps({ content: authored, provenance: provenance() }, [{ op: "drop_mention", path: "experiences[2]" }]);
  assert.deepEqual(withDrop.content.dropped_experiences, [
    { id: "Analyst|Ancient Co|2001-01|2003-01", reason: "pre-dates the positioning" },
    { id: "Engineer|Old Co|2019-01|2022-12", reason: AUTO_FIT_DROP_REASON },
  ], "auto-fit appends, it never rewrites the writer's editorial trail");
  const replayed = applyFitOps({ content: withDrop.content, provenance: withDrop.provenance }, [{ op: "drop_mention", path: "experiences[2]" }]);
  assert.equal(replayed.applied.length, 0);
  assert.equal(replayed.content.dropped_experiences!.length, 2, "replaying the plan does not duplicate the receipt");
  const back = applyFitOps({ content: withDrop.content, provenance: withDrop.provenance }, [{ op: "restore_mention", text: "Engineer @ Old Co" }]);
  assert.deepEqual(back.content.dropped_experiences, [{ id: "Analyst|Ancient Co|2001-01|2003-01", reason: "pre-dates the positioning" }], "only the auto-fit receipt is removed");
  console.log("  ✓ drop receipts append and rescind without touching authored ones");
}

// dropping a featured block via drop_mention is refused (demote is the door)
const wrongDoor = applyFitOps(base, [{ op: "drop_mention", path: "experiences[0]" }]);
assert.equal(wrongDoor.applied.length, 0);
assert.match(wrongDoor.skipped[0].reason, /demote it first/);
console.log("  ✓ drop_mention refuses a featured block");

// ---- demote refuses without a prepared bench one-liner --------------------
const noOneLiner = applyFitOps(base, [{ op: "demote", path: "experiences[1]" }]);
assert.equal(noOneLiner.applied.length, 0);
assert.match(noOneLiner.skipped[0].reason, /no bench one-liner/);
assert.deepEqual(noOneLiner.content.experiences, content().experiences, "nothing moved");
console.log("  ✓ demote refuses without a bench one-liner — it will not write prose");

const withOneLiner = content();
withOneLiner.bench = {
  mentions: [{
    experience: { placement: "mention", title: "Lead", company: "Then Co", start: "2023-01", end: "2026-02", one_liner: "Prepared hook for the middle role." },
    priority: 1,
    provenance: ref(60, 61),
  }],
};
const demoted = applyFitOps({ content: withOneLiner, provenance: provenance() }, [{ op: "demote", path: "experiences[1]" }]);
assert.equal(demoted.applied.length, 1);
const demotedXp = demoted.content.experiences[1];
assert.equal(demotedXp.placement, "mention");
assert.equal((demotedXp as any).one_liner, "Prepared hook for the middle role.");
assert.deepEqual(order(demoted.content), order(content()), "the demoted role keeps its slot");
const parked = demoted.content.bench!.bullets!["Lead|Then Co|2023-01|2026-02"];
assert.deepEqual(parked.filter((b) => (b.kind ?? "bullet") === "bullet").map((b) => b.text), ["C0", "C1", "C2", "C3", "C4"], "every bullet is parked, not deleted");
assert.equal(parked.find((b) => b.kind === "summary")!.text, "Middle role.", "the featured summary is parked too");
const demotedEvidence = demoted.provenance!.evidence.experiences["Lead|Then Co|2023-01|2026-02"];
assert.equal(demotedEvidence.bullets, undefined);
assert.deepEqual(demotedEvidence.one_liner, ref(60, 61));
console.log("  ✓ demote with a bench one-liner parks the whole featured block");

// ---- skill items ----------------------------------------------------------
const skillDropped = applyFitOps(base, [{ op: "drop_skill_item", path: "skills[0].bullets[1]" }]);
assert.deepEqual(skillDropped.content.skills[0].bullets, ["Skill one"]);
const skillBack = applyFitOps({ content: skillDropped.content, provenance: skillDropped.provenance }, [{ op: "add_skill_item", path: "skills[0]" }]);
assert.deepEqual(skillBack.content.skills[0].bullets, ["Skill one", "Skill two"], "skill item returns to its slot");
console.log("  ✓ skill items round-trip through the bench");

// ---- bench keys follow role identity, not array slot ----------------------
{
  const four = (): ResumeContent => {
    const c = content();
    c.experiences = [
      { placement: "feature", title: "Principal", company: "Now Co", start: "2026-03", end: "current", summary: "Recent role.", bullets: ["B0", "B1"] },
      { placement: "feature", title: "Lead", company: "Then Co", start: "2023-01", end: "2026-02", summary: "Middle role.", bullets: ["C0", "C1"] },
      { placement: "feature", title: "Manager", company: "Mid Co", start: "2020-01", end: "2022-12", summary: "Earlier role.", bullets: ["D0", "D1"] },
      { placement: "feature", title: "Engineer", company: "Goldman Sachs", start: "2016-01", end: "2019-12", summary: "Bank role.", bullets: ["E0", "E1", "E2"] },
    ];
    return c;
  };
  const benchedFour = applyFitOps({ content: four(), provenance: null }, [{ op: "drop_bullet", path: "experiences[3].bullets[2]" }]);
  assert.equal(benchedFour.applied[0].text, "E2");
  assert.deepEqual(
    Object.keys(benchedFour.content.bench!.bullets!),
    ["Engineer|Goldman Sachs|2016-01|2019-12"],
    "the bench bucket is keyed by role identity, not by slot",
  );

  // A hand edit (or another tool) deletes a role ABOVE the benched one.
  const edited = structuredClone(benchedFour.content);
  edited.experiences.splice(1, 1);
  assert.deepEqual(order(edited), ["Principal@Now Co", "Manager@Mid Co", "Engineer@Goldman Sachs"]);

  const backHome = applyFitOps({ content: edited, provenance: null }, [{ op: "restore_bullet", path: "experiences[2]" }]);
  assert.equal(backHome.applied.length, 1, "the restore lands");
  assert.deepEqual((backHome.content.experiences[2] as any).bullets, ["E0", "E1", "E2"], "the benched bullet goes back to Goldman Sachs");
  assert.deepEqual((backHome.content.experiences[1] as any).bullets, ["D0", "D1"], "the role that shifted into slot 3's neighbourhood is untouched");
  assert.deepEqual(backHome.content.bench!.bullets!["Engineer|Goldman Sachs|2016-01|2019-12"], [], "its bucket empties");
  console.log("  ✓ a deletion above a benched role cannot misroute its bullets");

  // Legacy index-keyed benches are still read, then rewritten to identity.
  const legacy = four();
  legacy.bench = { bullets: { "experiences[3]": [{ text: "E-bench", priority: 1, index: 3 }] } };
  const fromLegacy = applyFitOps({ content: legacy, provenance: null }, [{ op: "restore_bullet", path: "experiences[3]" }]);
  assert.deepEqual((fromLegacy.content.experiences[3] as any).bullets, ["E0", "E1", "E2", "E-bench"], "a legacy experiences[i] key still resolves");
  assert.deepEqual(Object.keys(fromLegacy.content.bench!.bullets!), ["Engineer|Goldman Sachs|2016-01|2019-12"], "and is rewritten to identity on the next write");
  console.log("  ✓ legacy experiences[i] bench keys are read once and re-keyed");
}

// ---- unknown / unusable ops are reported, never thrown --------------------
const junk = applyFitOps(base, [
  { op: "drop_bullet", path: "experiences[9].bullets[0]" },
  { op: "restore_bullet", path: "experiences[0]" },
  { op: "nonsense" } as unknown as FitOp,
]);
assert.equal(junk.applied.length, 0);
assert.equal(junk.skipped.length, 3);
assert.match(junk.skipped[2].reason, /unknown op/);
console.log("  ✓ unusable ops are skipped with a reason, never thrown");

// ---- paths in a plan address the PRE-PLAN composition ---------------------
const many = (): ResumeContent => {
  const c = content();
  c.experiences = [
    { placement: "feature", title: "Principal", company: "Now Co", start: "2026-03", end: "current", summary: "Recent role.", bullets: ["B0", "B1", "B2", "B3"] },
    ...Array.from({ length: 5 }, (_, i) => ({
      placement: "mention" as const,
      title: `Role ${i}`,
      company: `Co ${i}`,
      start: `20${10 + i}-01`,
      end: `20${11 + i}-12`,
      one_liner: `Did thing ${i}.`,
    })),
  ];
  return c;
};

// Two drops on ascending ORIGINAL indices must remove exactly those two roles.
const twoDrops = applyFitOps({ content: many(), provenance: null }, [
  { op: "drop_mention", path: "experiences[1]" },
  { op: "drop_mention", path: "experiences[3]" },
]);
assert.equal(twoDrops.applied.length, 2, "both drops apply");
assert.deepEqual(
  order(twoDrops.content),
  ["Principal@Now Co", "Role 1@Co 1", "Role 3@Co 3", "Role 4@Co 4"],
  "the plan's second path still means the ORIGINAL experiences[3], not the shifted one",
);
assert.deepEqual(twoDrops.applied.map((o) => o.text), ["Role 0 @ Co 0", "Role 2 @ Co 2"]);
assert.deepEqual(twoDrops.applied.map((o) => o.original_path), ["experiences[1]", "experiences[3]"], "original_path is reported");
console.log("  ✓ two drop_mention ops on ascending original indices drop exactly the intended two");

// Same inside one experience: a second drop_bullet at a higher original index.
const twoBullets = applyFitOps(base, [
  { op: "drop_bullet", path: "experiences[1].bullets[1]" },
  { op: "drop_bullet", path: "experiences[1].bullets[3]" },
]);
assert.equal(twoBullets.applied.length, 2);
assert.deepEqual(twoBullets.applied.map((o) => o.text), ["C1", "C3"], "the second path is C3, not the post-splice occupant");
assert.deepEqual((twoBullets.content.experiences[1] as any).bullets, ["C0", "C2", "C4"]);
const twoBulletRefs = twoBullets.provenance!.evidence.experiences["Lead|Then Co|2023-01|2026-02"].bullets!;
assert.deepEqual(twoBulletRefs.map((r) => r[0].lines[0]), [40, 42, 44], "refs pruned in step with the right bullets");
assert.deepEqual(twoBullets.applied.map((o) => o.original_path), ["experiences[1].bullets[1]", "experiences[1].bullets[3]"]);
console.log("  ✓ drop_bullet then drop_bullet at a higher original index in the same experience");

// Mixed plan: a drop that shifts the array, then ops written against the original.
const mixed = applyFitOps({ content: many(), provenance: null }, [
  { op: "drop_mention", path: "experiences[1]" },
  { op: "drop_mention", path: "experiences[2]" },
  { op: "restore_mention", text: "Role 0 @ Co 0" },
  { op: "drop_bullet", path: "experiences[0].bullets[1]" },
]);
assert.equal(mixed.applied.length, 4, "every op in the mixed plan lands");
// Role 0 is the oldest, so restore_mention puts it back at the reverse-chronological tail.
assert.deepEqual(order(mixed.content), ["Principal@Now Co", "Role 2@Co 2", "Role 3@Co 3", "Role 4@Co 4", "Role 0@Co 0"]);
assert.deepEqual((mixed.content.experiences[0] as any).bullets, ["B0", "B2", "B3"], "the bullet path survived two mention splices and a restore");
console.log("  ✓ mixed drop + restore plan keeps every path meaning its pre-plan target");

// restore_mention targets loosely: "AT Kearney" finds "A.T. Kearney".
const loose = content();
loose.bench = {
  mentions: [{
    experience: { placement: "mention", title: "Engagement Manager", company: "A.T. Kearney", start: "2014-01", end: "2015-12", one_liner: "Advised the thing." },
    priority: 1,
  }],
};
const looseBack = applyFitOps({ content: loose, provenance: null }, [{ op: "restore_mention", text: "AT Kearney" }]);
assert.equal(looseBack.applied.length, 1, "a punctuation-insensitive company name still finds its bench mention");
assert.ok(order(looseBack.content).includes("Engagement Manager@A.T. Kearney"));
console.log("  ✓ restore_mention matches a single bench mention loosely");

// ---- the ladder -----------------------------------------------------------
const overOps = planAutoOps({
  content: content(),
  fit: { verdict: "over_budget", lines_to_remove: 3, lines_to_add: 0 },
  unitLines: { "experiences[1].bullets[4]": 2 },
  minBulletsPerFeature: 3,
});
assert.deepEqual(overOps.map((o) => o.path), ["experiences[1].bullets[4]", "experiences[1].bullets[3]"], "lowest-tier role first, last bullet first");
assert.ok(overOps.every((o) => o.op === "drop_bullet"));
const overApplied = applyFitOps({ content: content(), provenance: provenance() }, overOps);
assert.equal(overApplied.applied.length, 2);
assert.deepEqual((overApplied.content.experiences[1] as any).bullets, ["C0", "C1", "C2"], "the floor of 3 bullets holds");

const deepOps = planAutoOps({
  content: content(),
  fit: { verdict: "over_budget", lines_to_remove: 20, lines_to_add: 0 },
  minBulletsPerFeature: 3,
});
assert.equal(deepOps.filter((o) => o.op === "drop_mention").length, 1, "mentions go only after bullets");
assert.equal(deepOps[deepOps.length - 1].op, "drop_mention");

const under = content();
under.bench = {
  bullets: { "experiences[0]": [{ text: "Benched recent bullet", priority: 1 }] },
  mentions: [{ experience: { placement: "mention", title: "Analyst", company: "First Co", start: "2016-01", end: "2018-12", one_liner: "Earliest role." }, priority: 1 }],
  skill_items: { "skills[0]": [{ text: "Benched skill" }] },
};
const underOps = planAutoOps({ content: under, fit: { verdict: "under_filled", lines_to_remove: 0, lines_to_add: 6 } });
assert.deepEqual(underOps.map((o) => o.op), ["restore_bullet", "restore_mention", "add_skill_item"], "bullets on recent roles, then mentions, then skill items");
const underApplied = applyFitOps({ content: under, provenance: provenance() }, underOps);
assert.equal(underApplied.applied.length, 3);
assert.ok((underApplied.content.experiences[0] as any).bullets.includes("Benched recent bullet"));
assert.deepEqual(order(underApplied.content).at(-1), "Analyst@First Co", "the restored oldest role lands last");
assert.ok(underApplied.content.skills[0].bullets.includes("Benched skill"));
assert.deepEqual(Object.keys(underApplied.content.bench!.skill_items!), ["Platform"], "a legacy skills[i] key is re-keyed to the block name");

assert.deepEqual(planAutoOps({ content: content(), fit: { verdict: "converged", lines_to_remove: 0, lines_to_add: 0 } }), [], "converged plans nothing");
console.log("  ✓ ladder: drop lowest tier first, restore most recent first, converged does nothing");

// ---- the positioning's protected roles are not page budget ----------------
// evidence_strategy names roles in prose; they resolve by company first, title
// second, so a role named for its employer is never shadowed by a title match.
assert.deepEqual(protectedExperienceIndices(content(), { magnify: [{ experience: "Now Co" }], support: [{ experience: "Then Co" }] }), [0, 1]);
assert.deepEqual(protectedExperienceIndices(content(), { magnify: [{ experience: "Principal" }] }), [0], "falls back to title when no company matches");
assert.deepEqual(protectedExperienceIndices(content(), { magnify: [{ experience: "Nowhere Ltd" }] }), [], "an unmatched name protects nothing");
assert.deepEqual(protectedExperienceIndices(content(), null), []);

const protectedOps = planAutoOps({
  content: content(),
  fit: { verdict: "over_budget", lines_to_remove: 20, lines_to_add: 0 },
  minBulletsPerFeature: 3,
  protectedExperiences: [1, 2],
});
assert.ok(protectedOps.length, "the ladder still plans against the unprotected role");
assert.ok(
  protectedOps.every((o) => !o.path?.startsWith("experiences[1]") && !o.path?.startsWith("experiences[2]")),
  "no bullet leaves a magnified role and no protected mention is benched",
);
assert.deepEqual(protectedOps.map((o) => o.text), ["B3"], "only the unprotected role gives up a bullet, down to the floor");
console.log("  ✓ ladder: protected experiences are never dropped, demoted or benched");

// ---- keep_all: full career breadth is not negotiable for a line -----------
const keepAll = planAutoOps({
  content: content(),
  fit: { verdict: "over_budget", lines_to_remove: 20, lines_to_add: 0 },
  minBulletsPerFeature: 3,
  keepAllMentions: true,
});
assert.equal(keepAll.filter((o) => o.op === "drop_mention").length, 0, "keep_all blocks drop_mention entirely");
assert.ok(keepAll.some((o) => o.op === "drop_bullet"), "bullets are still fair game");

// ---- the per-role bullet floor comes from content_policy ------------------
const floorOps = planAutoOps({
  content: content(),
  fit: { verdict: "over_budget", lines_to_remove: 20, lines_to_add: 0 },
  minBulletsPerFeature: 4,
  keepAllMentions: true,
});
assert.deepEqual(floorOps.map((o) => o.text), ["C4"], "a floor of 4 stops both roles at 4 bullets");
console.log("  ✓ ladder: keep_all blocks drop_mention; the bullet floor is honoured");

console.log("fit-ops: all assertions passed");
