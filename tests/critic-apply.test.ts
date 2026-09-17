#!/usr/bin/env tsx
/**
 * critic-apply.test.ts — the durable half of the resume-critic loop.
 *
 * Three things are load-bearing and none of them are observable from a chat
 * transcript:
 *   (a) `<prefix>.critic.json` is the whole review trail: one entry per round,
 *       with the composition hash the round actually reviewed and an
 *       applied/skipped outcome per finding.
 *   (b) `metadata.json` carries the critic stamp, and `resume:approve` refuses
 *       a missing, blocking or stale one unless --skip-critic is passed.
 *   (c) a finding that recurs across two or more resumes becomes a line in the
 *       profile's prose editorial rules, so the next composition is not told
 *       the same thing a third time.
 *   (d) findings are resolved by QUOTE, not by index, so re-running a findings
 *       file is a no-op instead of a second edit aimed at a shifted index.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTempRoot, repoFile } from "./helpers/temp-root.ts";
import type { CriticFinding, CriticReviewFile } from "../tools/resume/critic-apply.ts";
import type { ResumeContent, ResumeSourceProvenance } from "../templates/resume/_interface.ts";

// The loop ends in a real `resume:audit`, which folds in the provenance gate,
// which reads state/profile/cv-source.md through repoPath(). That file is
// git-ignored, so a fresh clone has none: everything here runs inside a fixture
// repo root built from tests/fixtures/profile-min. HARNESS_REPO_ROOT has to be
// exported before the first tools/ import, hence the dynamic imports.
const { root, profileDir } = makeTempRoot("critic-apply-");

const {
  applyCriticFindings,
  criticSidecarPath,
  findRecurringFindings,
  normaliseEditInput,
  normaliseQuotePattern,
  runCriticApply,
  suggestedBanRules,
  textSlot,
} = await import("../tools/resume/critic-apply.ts");
const { writeComposition, compositionContentHash } = await import("../tools/resume/lib/composition-io.ts");

const ref = (a: number, b: number) => [{ file: "state/profile/cv-source.md", lines: [a, b] as [number, number] }];

// The observed defect, reduced: two adjacent bullets in one role, the same
// substance behind different prefixes. Every deterministic gate passes it.
const content = (): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  headline: "Principal Consultant",
  summary: "Twelve years across delivery and architecture.",
  highlights: ["Shipped the platform.", "Shipped the platform, again."],
  skills: [{ name: "Platform", bullets: ["Skill one", "Skill two"] }],
  additional_skills_summary: "Breadth sentence.",
  credentials: ["A degree"],
  experiences: [
    {
      placement: "feature", title: "Principal", company: "Now Co", start: "2026-03", end: "current",
      summary: "Recent role.",
      bullets: [
        "Widget (Now Co's open framework, non-commercial): built the runtime.",
        "Widget: built the runtime.",
        "Ran the migration for 40 teams.",
      ],
    },
    { placement: "mention", title: "Engineer", company: "Old Co", start: "2019-01", end: "2022-12", one_liner: "Did the earlier thing." },
  ],
  resumeId: "alpha",
});

const provenance = (): ResumeSourceProvenance => ({
  evidence: {
    summary: ref(1, 2),
    highlights: [ref(3, 4), ref(3, 4)],
    skills: { Platform: ref(5, 6) },
    experiences: {
      "Principal|Now Co|2026-03|current": { summary: ref(10, 11), bullets: [ref(20, 21), ref(20, 21), ref(30, 31)] },
      "Engineer|Old Co|2019-01|2022-12": { one_liner: ref(50, 51) },
    },
  },
});

/* ------------------------------------------------ unit-path addressing --- */

{
  const c = content();
  assert.equal(textSlot(c, "summary")!.read(), "Twelve years across delivery and architecture.");
  assert.equal(textSlot(c, "experiences[0].bullets[1]")!.read(), "Widget: built the runtime.");
  assert.equal(textSlot(c, "experiences[1].one_liner")!.read(), "Did the earlier thing.");
  assert.equal(textSlot(c, "skills[0].bullets[1]")!.read(), "Skill two");
  assert.equal(textSlot(c, "credentials[0]")!.read(), "A degree");
  assert.equal(textSlot(c, "experiences[1].bullets[0]"), null, "a mention has no bullets");
  assert.equal(textSlot(c, "nonsense[2]"), null);
  console.log("  ✓ unit paths address every authored text field, and nothing else");
}

/* ------------------------------------------------------ applying edits --- */

{
  const findings: CriticFinding[] = [
    // The merge: keep one bullet, carrying both cited facts.
    { id: "f1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[0]", quote: "Widget (Now Co's open framework, non-commercial): built the runtime.", why: "Same substance as the next bullet.", proposed_edit: "Built the Widget runtime, Now Co's open non-commercial framework." },
    // ...and delete the other.
    { id: "f2", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", quote: "Widget: built the runtime.", why: "Second lap on the same fact.", proposed_edit: "delete" },
    // Judgement only: no exact text, so nothing is applied and it stays open.
    { id: "f3", kind: "register", severity: "warn", unit_path: "summary", quote: "Twelve years", why: "Reads like a job advert.", proposed_edit: "" },
    // A duplicate highlight, deleted without a fit op.
    { id: "f4", kind: "duplicate", severity: "warn", unit_path: "highlights[1]", quote: "Shipped the platform, again.", why: "Restates highlights[0].", proposed_edit: "delete" },
    // Addresses nothing in this composition.
    { id: "f5", kind: "clarity", severity: "warn", unit_path: "experiences[9].summary", why: "Gone.", proposed_edit: "Whatever." },
  ];

  const result = applyCriticFindings({ content: content(), provenance: provenance(), findings });
  const xp = result.content.experiences[0] as { bullets: string[] };

  assert.deepEqual(xp.bullets, [
    "Built the Widget runtime, Now Co's open non-commercial framework.",
    "Ran the migration for 40 teams.",
  ], "the merge lands and the duplicate goes");
  assert.deepEqual(result.content.highlights, ["Shipped the platform."], "the duplicate highlight goes");

  const refs = result.provenance!.evidence.experiences["Principal|Now Co|2026-03|current"].bullets!;
  assert.equal(refs.length, 2, "the sidecar loses exactly the deleted bullet's ref");
  assert.deepEqual(refs.map((r) => r[0].lines[0]), [20, 30]);
  assert.equal(result.provenance!.evidence.highlights.length, 1, "the deleted highlight's ref goes with it");

  const by = (id: string) => result.outcomes.find((o) => o.id === id)!;
  assert.equal(by("f1").status, "applied");
  assert.equal(by("f2").status, "applied");
  assert.equal(by("f3").status, "skipped");
  assert.match(by("f3").reason!, /no exact proposed_edit/);
  assert.equal(by("f4").status, "applied");
  assert.equal(by("f5").status, "skipped", "an unresolvable unit path is skipped, never guessed at");
  console.log("  ✓ findings apply by unit path, prune the sidecar, and skip anything without exact text");
}

{
  // Two deletes in one plan must not let the first splice redirect the second.
  const result = applyCriticFindings({
    content: content(),
    provenance: provenance(),
    findings: [
      { id: "d1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[0]", why: "x", proposed_edit: "delete" },
      { id: "d2", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", why: "x", proposed_edit: "delete" },
    ],
  });
  assert.deepEqual((result.content.experiences[0] as { bullets: string[] }).bullets, ["Ran the migration for 40 teams."]);
  console.log("  ✓ a two-delete plan means what it says, whatever the first splice moved");
}

/* ------------------------------------------ (a) the durable review trail -- */

const resumesDir = path.join(profileDir, "resumes");
const alphaDir = path.join(resumesDir, "alpha");
await fs.mkdir(alphaDir, { recursive: true });
const compositionPath = path.join(alphaDir, "A-Person_Alpha.composition.json");
await writeComposition(compositionPath, content(), { provenance: provenance() });
await fs.writeFile(path.join(profileDir, "resume-editorial-rules.md"), "# Profile resume editorial rules\n\nAppend-only.\n");
await fs.writeFile(path.join(alphaDir, "metadata.json"), JSON.stringify({ resume_id: "alpha", content_hash: "c0ffee", approved_at: null, approved_hash: null, approval_status: "fresh" }, null, 2));

const reviewedHash = await compositionContentHash(compositionPath);

// The fixture profile ships an editorial-bans.yaml; nothing below may touch it.
const bansBefore = await fs.readFile(path.join(profileDir, "editorial-bans.yaml"), "utf8").catch(() => null);

const round1 = path.join(root, "round1.json");
await fs.writeFile(round1, JSON.stringify({
  resume: "alpha",
  verdict: "revise",
  summary_sentence: "Two bullets say the same thing.",
  findings: [
    { id: "f1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", quote: "Widget: built the runtime.", why: "Second lap on the same fact.", proposed_edit: "delete", source_lines: ["state/profile/cv-source.md:20-21"] },
    { id: "f2", kind: "register", severity: "warn", unit_path: "summary", quote: "Twelve years", why: "Reads like a job advert.", proposed_edit: "" },
  ],
}, null, 2));

{
  const result = await runCriticApply({ composition: compositionPath, findings: round1 });
  assert.equal(result.round, 1);
  assert.equal(result.verdict, "revise");
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.notEqual(result.composition_hash, reviewedHash, "an applying round moved the composition, so the stamp must move with it");
  assert.equal(result.composition_hash, await compositionContentHash(compositionPath),
    "the round records the hash of the composition it LEFT ON DISK, the one resume:approve will hash");

  const review = JSON.parse(await fs.readFile(criticSidecarPath(compositionPath), "utf8")) as CriticReviewFile;
  assert.equal(review.rounds.length, 1);
  assert.equal(review.rounds[0].round, 1);
  assert.equal(review.rounds[0].composition_hash, await compositionContentHash(compositionPath));
  assert.ok(Date.parse(review.rounds[0].generated_at) > 0, "generated_at is a real timestamp");
  assert.equal(review.rounds[0].findings.length, 2, "the findings themselves are part of the trail");
  assert.equal(review.rounds[0].outcomes.length, 2, "one outcome per finding, applied or skipped");
  assert.equal(review.rounds[0].outcomes.find((o) => o.id === "f1")!.status, "applied");
  assert.equal(review.rounds[0].outcomes.find((o) => o.id === "f2")!.status, "skipped");
  assert.equal(review.summary_sentence, "Two bullets say the same thing.");

  const after = JSON.parse(await fs.readFile(compositionPath, "utf8"));
  assert.deepEqual(after.experiences[0].bullets, [
    "Widget (Now Co's open framework, non-commercial): built the runtime.",
    "Ran the migration for 40 teams.",
  ], "the edit is on disk, not only in the report");
  assert.equal(after.source_provenance, undefined, "the composition never regrows an inline sidecar");
  console.log("  ✓ (a) round 1 lands in <prefix>.critic.json with hash, timestamp, findings and outcomes");
}

const appliedHash = await compositionContentHash(compositionPath);

{
  // Round 2: a pass, recorded without touching anything.
  const round2 = path.join(root, "round2.json");
  await fs.writeFile(round2, JSON.stringify({ resume: "alpha", verdict: "pass", summary_sentence: "Clean.", findings: [] }, null, 2));
  const result = await runCriticApply({ composition: compositionPath, findings: round2, recordOnly: true });
  assert.equal(result.round, 2, "rounds accumulate rather than overwrite");

  const review = JSON.parse(await fs.readFile(criticSidecarPath(compositionPath), "utf8")) as CriticReviewFile;
  assert.deepEqual(review.rounds.map((r) => r.round), [1, 2], "round 1 survives round 2");
  assert.equal(review.verdict, "pass", "the top level tracks the latest round");
  assert.equal(review.rounds[1].composition_hash, appliedHash, "round 2 reviewed the edited composition");
  console.log("  ✓ (a) the file is the whole trail: both rounds, each against its own composition hash");
}

/* ----------------------------- (b) metadata stamp and the approval gate --- */

{
  const meta = JSON.parse(await fs.readFile(path.join(alphaDir, "metadata.json"), "utf8"));
  assert.deepEqual(Object.keys(meta.critic).sort(), ["at", "composition_hash", "round", "verdict"]);
  assert.equal(meta.critic.verdict, "pass");
  assert.equal(meta.critic.round, 2);
  assert.equal(meta.critic.composition_hash, appliedHash);
  console.log("  ✓ (b) metadata.json carries {verdict, round, at, composition_hash}");
}

const approveScript = repoFile("tools/resume/resume-approve.ts");
const tsxBin = repoFile("node_modules/.bin/tsx");
const approve = (args: string[]) => spawnSync(tsxBin, [approveScript, ...args], {
  encoding: "utf8",
  env: { ...process.env, HARNESS_REPO_ROOT: root, HARNESS_PROFILE: "" },
});
const setCritic = async (critic: unknown) => {
  const file = path.join(alphaDir, "metadata.json");
  const meta = JSON.parse(await fs.readFile(file, "utf8"));
  meta.critic = critic;
  meta.approved_at = null;
  meta.approved_hash = null;
  meta.approval_status = "fresh";
  await fs.writeFile(file, JSON.stringify(meta, null, 2));
};

{
  const ok = approve(["--resume", "alpha"]);
  assert.equal(ok.status, 0, `a current critic pass approves:\n${ok.stderr}`);
  const meta = JSON.parse(await fs.readFile(path.join(alphaDir, "metadata.json"), "utf8"));
  assert.equal(meta.approval_status, "approved");

  await setCritic(null);
  const missing = approve(["--resume", "alpha"]);
  assert.equal(missing.status, 1, "no critic verdict refuses approval");
  assert.match(missing.stderr, /no critic review on record/);

  await setCritic({ verdict: "block", round: 1, at: new Date().toISOString(), composition_hash: appliedHash });
  const blocked = approve(["--resume", "alpha"]);
  assert.equal(blocked.status, 1, "a block verdict refuses approval");
  assert.match(blocked.stderr, /returned 'block'/);

  await setCritic({ verdict: "pass", round: 1, at: new Date().toISOString(), composition_hash: "a-hash-of-something-else" });
  const stale = approve(["--resume", "alpha"]);
  assert.equal(stale.status, 1, "a review of a different composition refuses approval");
  assert.match(stale.stderr, /reviewed a different composition/);

  const skipped = approve(["--resume", "alpha", "--skip-critic"]);
  assert.equal(skipped.status, 0, `--skip-critic overrides:\n${skipped.stderr}`);
  assert.match(skipped.stderr, /--skip-critic/);
  const meta2 = JSON.parse(await fs.readFile(path.join(alphaDir, "metadata.json"), "utf8"));
  assert.equal(meta2.approval_status, "approved");
  assert.ok(meta2.critic_skipped?.reason, "the override is logged into metadata, not only printed");
  console.log("  ✓ (b) resume:approve refuses missing / block / stale critic verdicts, and logs --skip-critic");
}

/* ------------------------------------------- (c) the recurrence rule ------ */

{
  const finding = (quote: string, kind: CriticFinding["kind"] = "duplicate"): CriticFinding =>
    ({ id: "x", kind, severity: "warn", unit_path: "summary", quote, why: "Same substance twice under a repeated prefix.", proposed_edit: "delete" });

  assert.equal(normaliseQuotePattern("  Widget (Now Co's open framework)!  "), "widget now co's open framework");
  assert.equal(normaliseQuotePattern("Widget — Now  Co"), "widget now co");

  // One resume complaining twice is a render loop, not a rule.
  assert.deepEqual(
    findRecurringFindings([{ resume: "alpha", findings: [finding("Widget: built it"), finding("Widget: built it.")] }]),
    [],
  );

  // Two resumes, same kind, same normalised pattern: that is a preference.
  const recurring = findRecurringFindings([
    { resume: "alpha", findings: [finding("Widget: built it")] },
    { resume: "beta", findings: [finding("Widget:  built  it.")] },
  ]);
  assert.equal(recurring.length, 1);
  assert.deepEqual(recurring[0].resumes, ["alpha", "beta"]);
  assert.equal(recurring[0].pattern, "widget built it");

  // Only rule / register / duplicate are learnable; the rest are per-render facts.
  assert.deepEqual(
    findRecurringFindings([
      { resume: "alpha", findings: [finding("Ten teams", "inconsistency")] },
      { resume: "beta", findings: [finding("Ten teams", "inconsistency")] },
    ]),
    [],
    "an inconsistency is a fact about one render, never a standing rule",
  );

  // Same pattern, different kind: not the same complaint.
  assert.deepEqual(
    findRecurringFindings([
      { resume: "alpha", findings: [finding("Widget: built it", "duplicate")] },
      { resume: "beta", findings: [finding("Widget: built it", "register")] },
    ]),
    [],
  );
  console.log("  ✓ (c) recurrence needs two distinct resumes, one learnable kind, one normalised pattern");
}

{
  // End to end: a second resume raising the same finding writes the rule.
  const betaDir = path.join(resumesDir, "beta");
  await fs.mkdir(betaDir, { recursive: true });
  const betaComposition = path.join(betaDir, "A-Person_Beta.composition.json");
  await writeComposition(betaComposition, { ...content(), resumeId: "beta" }, { provenance: provenance() });

  const betaFindings = path.join(root, "beta.json");
  const body = {
    resume: "beta",
    verdict: "revise",
    summary_sentence: "Same repeated prefix as alpha.",
    findings: [{ id: "f1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", quote: "Widget: built the runtime.", why: "Second lap on the same fact under a shorter prefix.", proposed_edit: "delete" }],
  };
  await fs.writeFile(betaFindings, JSON.stringify(body, null, 2));

  const rulesPath = path.join(profileDir, "resume-editorial-rules.md");
  const before = await fs.readFile(rulesPath, "utf8");
  const result = await runCriticApply({ composition: betaComposition, findings: betaFindings });
  const after = await fs.readFile(rulesPath, "utf8");

  assert.equal(result.learned_rules.length, 1, "alpha round 1 plus beta round 1 is two resumes");
  assert.ok(after.startsWith(before.trimEnd()), "the rules file is appended to, never rewritten");
  assert.match(after, /Learned from review/);
  assert.match(after, /pattern: `widget built the runtime`/);
  assert.match(after, /alpha, beta/);
  assert.match(after, /Second lap on the same fact/);

  // Idempotent: the same recurrence must not append a second time.
  await fs.writeFile(betaFindings, JSON.stringify({ ...body, findings: body.findings.map((f) => ({ ...f, proposed_edit: "" })) }, null, 2));
  const again = await runCriticApply({ composition: betaComposition, findings: betaFindings });
  assert.equal(again.learned_rules.length, 0, "a rule already in the file is never restated");
  assert.equal(await fs.readFile(rulesPath, "utf8"), after);
  console.log("  ✓ (c) a recurrence is appended to resume-editorial-rules.md exactly once");
}

/* ------------------------------- (d) re-running a findings file is a no-op -- */

{
  // The observed defect: the same findings file run twice re-applied its
  // `delete` findings against index-shifted paths and removed a second,
  // innocent unit. A finding is identified by its quote, so a second run must
  // change nothing at all.
  const replayRoot = await fs.mkdtemp(path.join(os.tmpdir(), "critic-replay-"));
  const replayResumes = path.join(replayRoot, "state", "profile", "resumes");
  const dir = path.join(replayResumes, "alpha");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(replayRoot, "state", "profile", "resume-editorial-rules.md"), "# Rules\n\nAppend-only.\n");
  await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify({ resume_id: "alpha", approval_status: "fresh" }, null, 2));
  const comp = path.join(dir, "A-Person_Alpha.composition.json");
  await writeComposition(comp, content(), { provenance: provenance() });

  const findingsFile = path.join(replayRoot, "round1.json");
  await fs.writeFile(findingsFile, JSON.stringify({
    resume: "alpha",
    verdict: "revise",
    summary_sentence: "One merge, one delete.",
    findings: [
      { id: "f1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[0]", quote: "Widget (Now Co's open framework, non-commercial): built the runtime.", why: "Merge.", proposed_edit: "Built the Widget runtime, Now Co's open non-commercial framework." },
      { id: "f2", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", quote: "Widget: built the runtime.", why: "Second lap.", proposed_edit: "delete" },
      { id: "f3", kind: "duplicate", severity: "warn", unit_path: "highlights[1]", quote: "Shipped the platform, again.", why: "Restates highlights[0].", proposed_edit: "delete" },
    ],
  }, null, 2));

  const first = await runCriticApply({ composition: comp, findings: findingsFile });
  assert.equal(first.recorded, true);
  assert.equal(first.applied.length, 3, "all three findings land on the first run");

  const afterFirst = await fs.readFile(comp, "utf8");
  const criticAfterFirst = await fs.readFile(criticSidecarPath(comp), "utf8");
  const parsedFirst = JSON.parse(afterFirst);
  assert.deepEqual(parsedFirst.experiences[0].bullets, [
    "Built the Widget runtime, Now Co's open non-commercial framework.",
    "Ran the migration for 40 teams.",
  ]);
  assert.deepEqual(parsedFirst.highlights, ["Shipped the platform."]);

  const second = await runCriticApply({ composition: comp, findings: findingsFile });
  assert.equal(second.applied.length, 0, "a replay applies nothing");
  assert.equal(second.recorded, false, "a pure no-op run is not a round");
  assert.equal(second.round, 1, "the reported round is still the one on disk");
  assert.deepEqual(
    second.skipped.map((o) => o.id).sort(),
    ["f1", "f2", "f3"],
    "every finding is accounted for as skipped",
  );
  assert.equal(second.skipped.find((o) => o.id === "f1")!.reason, "already applied");
  assert.match(second.skipped.find((o) => o.id === "f2")!.reason!, /quote not found/);
  assert.match(second.skipped.find((o) => o.id === "f3")!.reason!, /quote not found/);

  assert.equal(await fs.readFile(comp, "utf8"), afterFirst, "the composition is byte-identical after the replay");
  assert.equal(await fs.readFile(criticSidecarPath(comp), "utf8"), criticAfterFirst, "no second round is appended");
  const review = JSON.parse(criticAfterFirst) as CriticReviewFile;
  assert.equal(review.rounds.length, 1);

  // ...but a real second review still records, even with nothing to apply.
  const passFile = path.join(replayRoot, "round2.json");
  await fs.writeFile(passFile, JSON.stringify({ resume: "alpha", verdict: "pass", summary_sentence: "Clean.", findings: [] }, null, 2));
  const third = await runCriticApply({ composition: comp, findings: passFile });
  assert.equal(third.recorded, true, "a judgement-only round is a real round, not a replay");
  assert.equal(third.round, 2);

  await fs.rm(replayRoot, { recursive: true, force: true });
  console.log("  \u2713 (d) re-running the same findings file changes nothing and appends no round");
}

{
  // The second half of the defect: a findings file written against the ORIGINAL
  // composition names bullets[2], but an earlier delete already shifted that
  // bullet to index 1. The quote, not the index, decides which one goes.
  const afterFirstDelete = applyCriticFindings({
    content: content(),
    provenance: provenance(),
    findings: [{ id: "d1", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[0]", quote: "Widget (Now Co's open framework, non-commercial): built the runtime.", why: "x", proposed_edit: "delete" }],
  });
  assert.deepEqual((afterFirstDelete.content.experiences[0] as { bullets: string[] }).bullets, [
    "Widget: built the runtime.",
    "Ran the migration for 40 teams.",
  ]);

  const stale = applyCriticFindings({
    content: afterFirstDelete.content,
    provenance: afterFirstDelete.provenance,
    findings: [{ id: "d2", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[2]", quote: "Ran the migration for 40 teams.", why: "x", proposed_edit: "delete" }],
  });
  assert.deepEqual((stale.content.experiences[0] as { bullets: string[] }).bullets, [
    "Widget: built the runtime.",
  ], "the quoted bullet goes, not whatever now sits at the stale index");
  assert.equal(stale.outcomes[0].status, "applied");
  assert.equal(stale.outcomes[0].unit_path, "experiences[0].bullets[1]", "the outcome records the unit actually edited");

  const refs = stale.provenance!.evidence.experiences["Principal|Now Co|2026-03|current"].bullets!;
  assert.deepEqual(refs.map((r) => r[0].lines[0]), [20], "the sidecar loses the right ref too");

  // The same stale path with a quote that no longer exists anywhere is a skip,
  // never a guess at the index.
  const gone = applyCriticFindings({
    content: stale.content,
    provenance: stale.provenance,
    findings: [{ id: "d3", kind: "duplicate", severity: "warn", unit_path: "experiences[0].bullets[1]", quote: "Ran the migration for 40 teams.", why: "x", proposed_edit: "delete" }],
  });
  assert.deepEqual((gone.content.experiences[0] as { bullets: string[] }).bullets, ["Widget: built the runtime."]);
  assert.equal(gone.outcomes[0].status, "skipped");
  assert.match(gone.outcomes[0].reason!, /quote not found/);
  console.log("  \u2713 (d) a shifted index still deletes the quoted unit, and a vanished quote deletes nothing");
}

/* --------------------------------------------- ban suggestions, printed --- */

{
  const suggestions = suggestedBanRules([
    { id: "f1", kind: "rule", severity: "fail", unit_path: "summary", quote: "alongside other contract work", why: "Divided-attention signal.", proposed_edit: "delete" },
    { id: "f2", kind: "clarity", severity: "warn", unit_path: "summary", quote: "banned only for learnable kinds", why: "x", proposed_edit: "delete" },
    { id: "f3", kind: "register", severity: "warn", unit_path: "summary", quote: "This is a whole sentence that runs on well past the length at which a literal phrase ban could ever be safe.", why: "x", proposed_edit: "delete" },
  ]);
  assert.equal(suggestions.length, 1, "only a learnable kind with a short literal phrase is bannable from text alone");
  assert.match(suggestions[0], /forbidden_phrases: \["alongside other contract work"\]/);
  assert.match(suggestions[0], /severity: warn/);
  console.log("  ✓ ban rules are suggested for plain phrases only, and never written to editorial-bans.yaml");
}

{
  const bansPath = path.join(profileDir, "editorial-bans.yaml");
  assert.equal(
    await fs.readFile(bansPath, "utf8").catch(() => null),
    bansBefore,
    "critic-apply never writes the machine bans file: suggestions are printed, a human adds the rule",
  );
}

/* ------- (e) apply a finding, re-audit, approve: no --skip-critic needed --- */

{
  // The observed defect: `resume:critic:apply` stamped the hash of the
  // composition it READ, then wrote its edits, so `resume:approve` compared a
  // pre-edit stamp against a post-edit file and refused every time. A second
  // failure mode hid behind it: the stamp covered `source_provenance`, which
  // `resume:audit` re-writes on every pass, so even a round that changed
  // nothing went stale as soon as the CV was re-audited.
  //
  // This is the whole loop against the real audit: apply, re-audit, approve.
  const { runAudit } = await import("../tools/resume/resume-audit.ts");
  const gammaDir = path.join(resumesDir, "gamma");
  await fs.mkdir(gammaDir, { recursive: true });
  const sample = JSON.parse(await fs.readFile(repoFile("templates/resume/classic/sample/sample-content.json"), "utf8")) as ResumeContent;
  const prefix = "Sample_Gamma";
  const gammaComposition = path.join(gammaDir, `${prefix}.composition.json`);
  await writeComposition(gammaComposition, sample, { provenance: provenance() });
  await fs.writeFile(path.join(gammaDir, "metadata.json"), JSON.stringify({ resume_id: "gamma", content_hash: "c0ffee", approved_at: null, approved_hash: null, approval_status: "fresh" }, null, 2));

  const gammaFindings = path.join(root, "gamma.json");
  await fs.writeFile(gammaFindings, JSON.stringify({
    resume: "gamma",
    verdict: "pass",
    summary_sentence: "One highlight restates the summary.",
    findings: [{
      id: "g1", kind: "duplicate", severity: "warn", unit_path: "highlights[0]",
      quote: sample.highlights[0], why: "Restates the summary.", proposed_edit: "delete",
    }],
  }, null, 2));

  const applied = await runCriticApply({ composition: gammaComposition, findings: gammaFindings });
  assert.equal(applied.applied.length, 1, "the finding actually edited the composition");
  assert.equal(applied.composition_hash, await compositionContentHash(gammaComposition), "the stamp matches the post-edit file");

  await runAudit({
    contentJson: gammaComposition,
    template: "classic",
    outDir: gammaDir,
    filenamePrefix: prefix,
    strictLineUnits: false,
  });

  assert.equal(await compositionContentHash(gammaComposition), applied.composition_hash,
    "resume:audit re-persists the composition without changing its hash");

  const approved = approve(["--resume", "gamma"]);
  assert.equal(approved.status, 0, `apply then audit then approve must not need --skip-critic:\n${approved.stderr}`);
  const gammaMeta = JSON.parse(await fs.readFile(path.join(gammaDir, "metadata.json"), "utf8"));
  assert.equal(gammaMeta.approval_status, "approved");
  assert.equal(gammaMeta.critic_skipped, undefined, "the critic gate opened on its own merits");
  console.log("  ✓ (e) apply a finding, re-run the audit, approve: no critic mismatch");
}

/* ------------------------------------------- (f) the simple edit format --- */

{
  const c = content();

  // (1) a full critic report passes through untouched.
  const report = { resume: "alpha", verdict: "revise" as const, findings: [{ id: "c1", kind: "duplicate" as const, severity: "warn" as const, unit_path: "summary", quote: "x", why: "y" }], summary_sentence: "one" };
  const passed = normaliseEditInput(report, c);
  assert.equal(passed.report, report, "a report with findings is handed back as-is");
  assert.deepEqual(passed.ops, []);

  // (2) { edits, ops } — quote is read from the LIVE text, not from the caller.
  const bag = normaliseEditInput({
    edits: [
      { path: "summary", text: "Thirteen years." },
      { path: "experiences[0].bullets[1]", text: "delete", why: "duplicate", kind: "duplicate", severity: "fail", source_lines: ["L20-21"] },
    ],
    ops: [{ op: "drop_bullet", path: "experiences[0].bullets[2]" }],
  }, c);
  assert.equal(bag.report.verdict, "revise");
  assert.equal(bag.report.summary_sentence, "2 edits applied via resume:edit");
  assert.equal(bag.report.resume, "alpha", "resume falls back to the composition's own id");
  assert.deepEqual(bag.report.findings.map((f) => f.id), ["e1", "e2"]);
  assert.equal(bag.report.findings[0].quote, "Twelve years across delivery and architecture.", "quote taken from the live composition");
  assert.equal(bag.report.findings[0].kind, "clarity", "kind defaults to clarity");
  assert.equal(bag.report.findings[0].severity, "warn", "severity defaults to warn");
  assert.equal(bag.report.findings[0].why, "edit");
  assert.equal(bag.report.findings[1].quote, "Widget: built the runtime.");
  assert.equal(bag.report.findings[1].kind, "duplicate", "a given kind wins");
  assert.equal(bag.report.findings[1].severity, "fail");
  assert.deepEqual(bag.report.findings[1].source_lines, ["L20-21"]);
  assert.deepEqual(bag.ops, [{ op: "drop_bullet", path: "experiences[0].bullets[2]" }]);

  // (3) a bare array of edits.
  const bare = normaliseEditInput([{ path: "highlights[0]", text: "Shipped it." }], c);
  assert.equal(bare.report.findings.length, 1);
  assert.equal(bare.report.findings[0].quote, "Shipped the platform.");
  assert.deepEqual(bare.ops, []);

  // A path that does not resolve is an ERROR, never a silently skipped finding:
  // the whole failure mode this format exists to kill is "reported an edit that
  // never landed".
  assert.throws(() => normaliseEditInput([{ path: "experiences[9].bullets[0]", text: "x" }], c), /does not resolve/);
  assert.throws(() => normaliseEditInput([{ path: "summary", text: "  " }], c), /missing "text"/);
  assert.throws(() => normaliseEditInput([{ text: "x" } as never], c), /missing "path"/);
  assert.throws(() => normaliseEditInput({ nonsense: true }, c), /expected a critic report/);
  console.log("  ✓ (f) simple edits normalise to findings, with the quote read off live text");
}


/* ------------------------- (g) credential deletion, sidecar in step ------- */

{
  // The observed defect: `{"path":"credentials[2]","text":"delete"}` came back
  // "delete is not supported for this unit kind", so six agents hand-edited
  // `credentials[]` AND `provenance.evidence.credentials[]` and got the pairing
  // wrong. Credentials are a flat list with a parallel evidence list and no
  // bench: the delete is a splice of both, or it is a mis-paired sidecar.
  const c = content();
  c.credentials = ["A degree", "A certification", "A licence"];
  const p = provenance();
  p.evidence.credentials = [ref(60, 61), ref(62, 63), ref(64, 65)];

  const findings: CriticFinding[] = [{
    id: "cr1", kind: "unsupported", severity: "warn", unit_path: "credentials[1]",
    quote: "A certification", why: "Lapsed and unsourced.", proposed_edit: "delete",
  }];

  const result = applyCriticFindings({ content: c, provenance: p, findings });
  assert.deepEqual(result.content.credentials, ["A degree", "A licence"], "the named credential goes");
  assert.deepEqual(
    result.provenance!.evidence.credentials!.map((r) => r[0].lines[0]),
    [60, 64],
    "its evidence entry goes with it, so the survivors stay paired with their own lines",
  );
  assert.equal(result.outcomes[0].status, "applied");
  assert.equal(result.outcomes[0].op, "delete");
  assert.match(result.outcomes[0].note!, /provenance\.evidence\.credentials\[1\]/);

  // Replay with the critic's own quote: the quote is gone, so nothing happens.
  const replay = applyCriticFindings({ content: result.content, provenance: result.provenance, findings });
  assert.deepEqual(replay.content.credentials, ["A degree", "A licence"], "the replay did not eat the neighbour");
  assert.equal(replay.outcomes[0].status, "skipped");
  assert.match(replay.outcomes[0].reason!, /quote not found/);

  // Replay of a SIMPLE edit, which has no quote of its own: `credentials[1]`
  // now reads "A licence", so only the review trail can tell this is a replay.
  const simple = normaliseEditInput([{ path: "credentials[1]", text: "delete" }], result.content);
  assert.equal(simple.report.findings[0].quote, "A licence", "the live text is what a simple edit quotes");
  const priorRounds = [{
    resume: "alpha", verdict: "revise" as const, summary_sentence: "", round: 1,
    generated_at: new Date().toISOString(), composition_hash: null,
    findings, outcomes: result.outcomes,
  }];
  const replayed = applyCriticFindings({
    content: result.content, provenance: result.provenance,
    findings: simple.report.findings, priorRounds,
  });
  assert.deepEqual(replayed.content.credentials, ["A degree", "A licence"], "the trail stopped a second, differently-aimed delete");
  assert.equal(replayed.outcomes[0].status, "skipped");
  assert.match(replayed.outcomes[0].reason!, /already applied/);
  console.log("  \u2713 (g) a credential delete splices its provenance entry and replays as a no-op");
}

/* --------------------- (h) renaming a skills block carries its keys ------- */

{
  // The observed defect: a rename of `skills[i].name` left
  // `provenance.evidence.skills["<old name>"]` behind, and the provenance gate
  // then reported "skills['<new name>']: no source references" for a block
  // whose evidence was sitting right there under the old key. The bench is
  // keyed by block name too (`benchKeyForSkill`), so it orphans identically.
  const c = content();
  c.bench = { skill_items: { Platform: [{ text: "A benched skill item", priority: 3 }] } };
  const result = applyCriticFindings({
    content: c,
    provenance: provenance(),
    findings: [{
      id: "s1", kind: "clarity", severity: "warn", unit_path: "skills[0].name",
      quote: "Platform", why: "Screener vocabulary.", proposed_edit: "Platform Engineering",
    }],
  });

  assert.equal(result.content.skills[0].name, "Platform Engineering");
  const evidence = result.provenance!.evidence.skills;
  assert.ok(!("Platform" in evidence), "no orphan under the old name");
  assert.deepEqual(evidence["Platform Engineering"], ref(5, 6), "the evidence moved, it was not re-derived");
  assert.deepEqual(Object.keys(result.content.bench!.skill_items!), ["Platform Engineering"], "the bench key moved too");
  assert.equal(result.content.bench!.skill_items!["Platform Engineering"][0].text, "A benched skill item");
  assert.equal(result.outcomes[0].status, "applied");
  assert.match(result.outcomes[0].note!, /provenance\.evidence\.skills\['Platform'\]/);
  assert.match(result.outcomes[0].note!, /bench\.skill_items\['Platform'\]/);

  // A summary edit on the same block is NOT a rename and touches no key.
  const summaryEdit = applyCriticFindings({
    content: content(),
    provenance: provenance(),
    findings: [{ id: "s2", kind: "clarity", severity: "warn", unit_path: "skills[0].bullets[0]", quote: "Skill one", why: "x", proposed_edit: "Skill one, tightened" }],
  });
  assert.deepEqual(Object.keys(summaryEdit.provenance!.evidence.skills), ["Platform"]);
  assert.equal(summaryEdit.outcomes[0].note, undefined, "a note is only written when a sidecar actually moved");
  console.log("  \u2713 (h) renaming a skills block carries its provenance and bench keys");
}


await fs.rm(root, { recursive: true, force: true });
console.log("critic-apply: all assertions passed");
