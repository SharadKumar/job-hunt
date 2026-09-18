#!/usr/bin/env tsx
/**
 * resume-edit.test.ts — one command, one process, the whole edit.
 *
 * What is load-bearing here is not "the text changed". It is that ONE run left
 * four artefacts consistent with each other:
 *   (a) the composition carries the new words and no longer carries the deleted
 *       bullet;
 *   (b) the deleted bullet's provenance ref went to the BENCH rather than being
 *       thrown away, so the material is recoverable and nothing was silently
 *       unsourced;
 *   (c) `<prefix>.critic.json` gained a round whose `composition_hash` is the
 *       hash of the file ON DISK — that is what `resume:approve` re-computes,
 *       and a round stamped with a pre-write hash is stale the instant it lands;
 *   (d) the audit ran in place and wrote its json.
 *
 * Then the ORDER: ops and edits in one file. The ops have to run first and the
 * composition has to be re-read before the edits are normalised, because an op
 * creates and moves the units the edits address.
 *
 * And then the replay: running the SAME edits file again must change nothing
 * and append no round. A simple edit has no quote of its own (resume:edit reads
 * it off the live composition), so without the delete-replay guard the second
 * run would delete whichever bullet had moved up into the freed slot.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeTempRoot, repoFile } from "./helpers/temp-root.ts";
import type { CriticReviewFile } from "../tools/resume/critic-apply.ts";
import type { ResumeContent, ResumeSourceProvenance } from "../templates/resume/_interface.ts";

/* ------------------------------------------------------------- fixtures */

// The edit re-anchors provenance and audits in place, and both read
// state/profile/cv-source.md through repoPath(). That path is git-ignored, so a
// fresh clone has none: the whole run happens inside a fixture repo root built
// from tests/fixtures/profile-min. HARNESS_REPO_ROOT must be exported before
// the first tools/ import, hence the dynamic imports below.
const { root } = makeTempRoot("resume-edit-");

const { runResumeEdit } = await import("../tools/resume/resume-edit.ts");
const { compositionContentHash, loadComposition } = await import("../tools/resume/lib/composition-io.ts");
const { benchKeyForExperience } = await import("../tools/resume/lib/fit-ops.ts");

const ref = (a: number, b: number) => [{ file: "state/profile/cv-source.md", lines: [a, b] as [number, number] }];

const dir = path.join(root, "state", "profile", "resumes", "sample");
await fs.mkdir(dir, { recursive: true });

const compositionPath = path.join(dir, "sample.composition.json");
const sample = JSON.parse(await fs.readFile(repoFile("templates/resume/classic/sample/sample-content.json"), "utf8")) as ResumeContent;
await fs.writeFile(compositionPath, `${JSON.stringify(sample, null, 2)}\n`);

const featured = sample.experiences.filter((x) => x.placement === "feature");
assert.ok(featured.length >= 2, "the classic sample needs two featured roles for this test");
const [first, second] = featured as Array<Extract<ResumeContent["experiences"][number], { placement: "feature" }>>;
const firstIndex = sample.experiences.indexOf(first);
const secondIndex = sample.experiences.indexOf(second);

// A provenance sidecar the sample does not ship with: the bench assertion is
// about refs travelling WITH their bullet, so the refs have to be distinct.
const provenance: ResumeSourceProvenance = {
  evidence: {
    summary: ref(1, 2),
    highlights: (sample.highlights ?? []).map((_, i) => ref(10 + i, 11 + i)),
    skills: Object.fromEntries((sample.skills ?? []).map((s, i) => [s.name, ref(30 + i, 31 + i)])),
    experiences: Object.fromEntries(
      sample.experiences.map((xp, x) => [
        benchKeyForExperience(xp),
        xp.placement === "feature"
          ? { summary: ref(100 + x * 20, 101 + x * 20), bullets: xp.bullets.map((_, b) => ref(200 + x * 20 + b, 200 + x * 20 + b)) }
          : { one_liner: ref(100 + x * 20, 101 + x * 20) },
      ]),
    ),
  },
};
await fs.writeFile(path.join(dir, "sample.provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

const REPLACED = "Rewrote this summary line in one command, with no hand-built findings file.";
const deletedBulletText = first.bullets[1];
const droppedBulletText = second.bullets[0];
const deletedRef = provenance.evidence.experiences[benchKeyForExperience(first)].bullets![1];

const editsFile = path.join(root, "edits.json");
await fs.writeFile(editsFile, `${JSON.stringify({
  edits: [
    { path: `experiences[${firstIndex}].summary`, text: REPLACED, why: "tighter" },
    { path: `experiences[${firstIndex}].bullets[1]`, text: "delete", why: "duplicate of the bullet above" },
  ],
  // An op carrying its text is idempotent; an op without one means "whatever is
  // at that index now", which is exactly what a replay must not act on.
  ops: [{ op: "drop_bullet", path: `experiences[${secondIndex}].bullets[0]`, text: droppedBulletText }],
}, null, 2)}\n`);

/* --------------------------------------------------------------- run one */

const result = await runResumeEdit({
  composition: compositionPath,
  template: "classic",
  edits: editsFile,
});

assert.equal(result.applied.length, 2, `both edits applied, got ${JSON.stringify(result.applied)}`);
assert.deepEqual(result.applied.map((a) => a.op).sort(), ["delete", "replace"]);
assert.equal(result.skipped.length, 0, `nothing skipped, got ${JSON.stringify(result.skipped)}`);
assert.equal(result.ops_applied, 1, "the fit op applied");
console.log("  ✓ one call applied two plain edits and one fit op");

const after = await loadComposition(compositionPath);
const afterFirst = after.content.experiences[firstIndex] as Extract<ResumeContent["experiences"][number], { placement: "feature" }>;
assert.equal(afterFirst.summary, REPLACED, "the replacement landed verbatim");
assert.ok(!afterFirst.bullets.includes(deletedBulletText), "the deleted bullet is gone from the composition");
assert.equal(afterFirst.bullets.length, first.bullets.length - 1);
console.log("  ✓ composition text changed and the deleted unit is gone");

const benched = after.content.bench?.bullets?.[benchKeyForExperience(first)] ?? [];
const benchedDelete = benched.find((b) => b.text === deletedBulletText);
assert.ok(benchedDelete, "the deleted bullet is on the bench, not destroyed");
assert.deepEqual(benchedDelete!.provenance, deletedRef, "its provenance ref travelled to the bench with it");
const afterRefs = after.provenance!.evidence.experiences[benchKeyForExperience(first)].bullets!;
assert.equal(afterRefs.length, first.bullets.length - 1, "the live provenance list shrank by exactly one");
console.log("  ✓ the deleted unit's provenance ref moved to the bench");

const review = JSON.parse(await fs.readFile(path.join(dir, "sample.critic.json"), "utf8")) as CriticReviewFile;
assert.equal(review.rounds.length, 1, "exactly one round recorded");
assert.equal(review.rounds[0].round, 1);
assert.equal(review.rounds[0].composition_hash, await compositionContentHash(compositionPath), "the round carries the ON-DISK hash");
assert.equal(result.critic.round, 1);
console.log("  ✓ critic.json gained a round stamped with the on-disk hash");

assert.ok(result.audit, "the audit ran");
await fs.access(path.join(dir, "sample.audit.json"));
assert.ok(result.audit!.pages && result.audit!.pages.count! >= 1, "pages measured");
assert.ok(result.audit!.gates.evaluate, "gates folded into the one report");
assert.ok(result.next.length >= 1, "the report says what to do next");
assert.ok(result.reanchor, "provenance was re-anchored in the same process");
console.log("  ✓ audit ran in place, audit.json written, next steps reported");

/* -------------------------------------------------------------- run two */

const hashBefore = await compositionContentHash(compositionPath);
const replay = await runResumeEdit({
  composition: compositionPath,
  template: "classic",
  edits: editsFile,
});

assert.equal(replay.applied.length, 0, `replay applied nothing, got ${JSON.stringify(replay.applied)}`);
assert.equal(replay.ops_applied, 0, "the fit op was recognised as already benched");
assert.equal(replay.skipped.length, 2, "both edits reported as skipped, with reasons");
for (const s of replay.skipped) assert.match(String(s.reason), /already applied/);
assert.equal(await compositionContentHash(compositionPath), hashBefore, "the composition is byte-identical after the replay");

const reviewAfter = JSON.parse(await fs.readFile(path.join(dir, "sample.critic.json"), "utf8")) as CriticReviewFile;
assert.equal(reviewAfter.rounds.length, 1, "a replay is not a round");
const replayFirst = (await loadComposition(compositionPath)).content.experiences[firstIndex] as Extract<ResumeContent["experiences"][number], { placement: "feature" }>;
assert.equal(replayFirst.bullets.length, first.bullets.length - 1, "the replay did not delete a second bullet");
console.log("  ✓ re-running the same edits file is a no-op: nothing re-applied, no new round");

/* ------------------------------------------- ops and edits in one file */

{
  // The observed defect: `resume:edit` normalised the edits (reading each one's
  // identifying quote off the composition at `path`) BEFORE running the ops. An
  // op that restores a bullet CREATES the unit an edit is aimed at and shifts
  // every index below it, so the edit was quoted against the pre-op document
  // and landed on the neighbour that had since moved. Ops run first now, and
  // the composition is re-read between the two halves.
  const opsDir = path.join(root, "ops");
  await fs.mkdir(opsDir, { recursive: true });
  const opsComposition = path.join(opsDir, "ops.composition.json");

  const fresh = JSON.parse(JSON.stringify(sample)) as ResumeContent;
  const target = fresh.experiences[firstIndex] as Extract<ResumeContent["experiences"][number], { placement: "feature" }>;
  const neighbour = target.bullets[0];
  const BENCHED = "Restored from the bench, and then rewritten in the same run.";
  fresh.bench = { bullets: { [benchKeyForExperience(target)]: [{ text: BENCHED, priority: 1, provenance: ref(900, 901), kind: "bullet", index: 0 }] } };
  await fs.writeFile(opsComposition, `${JSON.stringify(fresh, null, 2)}\n`);

  const REWRITTEN = "The restored bullet, rewritten by an edit in the very same file.";
  const opsEdits = path.join(root, "ops-edits.json");
  await fs.writeFile(opsEdits, `${JSON.stringify({
    ops: [{ op: "restore_bullet", path: `experiences[${firstIndex}]`, text: BENCHED }],
    // Index 0 is the slot the restore CREATES. Before the fix this quoted (and
    // overwrote) whatever was at index 0 beforehand.
    edits: [{ path: `experiences[${firstIndex}].bullets[0]`, text: REWRITTEN, why: "tighter" }],
  }, null, 2)}\n`);

  const opsResult = await runResumeEdit({
    composition: opsComposition,
    template: "classic",
    edits: opsEdits,
    reanchor: false,
    audit: false,
  });

  assert.equal(opsResult.ops_applied, 1, `the restore applied, got ${JSON.stringify(opsResult)}`);
  assert.equal(opsResult.applied.length, 1, `the edit applied, got ${JSON.stringify(opsResult.skipped)}`);
  const opsAfter = await loadComposition(opsComposition);
  const opsTarget = opsAfter.content.experiences[firstIndex] as Extract<ResumeContent["experiences"][number], { placement: "feature" }>;
  assert.equal(opsTarget.bullets[0], REWRITTEN, "the edit landed on the bullet the op restored");
  assert.equal(opsTarget.bullets[1], neighbour, "the neighbour the restore pushed down was NOT overwritten");
  assert.ok(!opsTarget.bullets.includes(BENCHED), "the restored text was replaced, not duplicated");
  assert.ok(
    opsResult.next.some((n) => /ops ran BEFORE the text edits/.test(n)),
    `the report names the order, got ${JSON.stringify(opsResult.next)}`,
  );
  console.log("  \u2713 ops run before the edits are normalised, so an edit can target a restored bullet");
}

await fs.rm(root, { recursive: true, force: true });
console.log("resume-edit: all assertions passed");
