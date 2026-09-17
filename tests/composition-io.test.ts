import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadComposition,
  writeComposition,
  provenanceSidecarPath,
  splitProvenance,
  compositionContentHash,
} from "../tools/resume/lib/composition-io.ts";
import type { ResumeContent, ResumeSourceProvenance } from "../templates/resume/_interface.ts";

const provenance: ResumeSourceProvenance = {
  cv_source_hash: "abc",
  evidence: {
    summary: [{ file: "state/profile/cv-source.md", lines: [1, 4] }],
    highlights: [[{ file: "state/profile/cv-source.md", lines: [5, 6] }]],
    skills: { Platform: [{ file: "state/profile/cv-source.md", lines: [7, 8] }] },
    experiences: {},
  },
};

const content = (): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  summary: "Summary line.",
  highlights: ["One highlight."],
  skills: [{ name: "Platform", bullets: ["Thing"] }],
  experiences: [],
  resumeId: "test",
});

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composition-io-"));
const compositionPath = path.join(dir, "Sample_Resume.composition.json");

assert.equal(provenanceSidecarPath(compositionPath), path.join(dir, "Sample_Resume.provenance.json"));
assert.equal(provenanceSidecarPath("/tmp/x.json"), "/tmp/x.provenance.json");
console.log("  ✓ sidecar path derivation");

// ---- inline (pre-sidecar artefacts) --------------------------------------
const inline = { ...content(), source_provenance: provenance };
await fs.writeFile(compositionPath, JSON.stringify(inline, null, 2));
const loadedInline = await loadComposition(compositionPath);
assert.equal(loadedInline.provenancePath, null, "no sidecar on disk");
assert.deepEqual(loadedInline.provenance, provenance, "provenance falls back to the inline field");
assert.deepEqual(loadedInline.content.source_provenance, provenance, "content carries provenance for downstream validators");
console.log("  ✓ loads an older composition with an inline source_provenance");

// ---- writing splits the sidecar out --------------------------------------
const written = await writeComposition(compositionPath, inline);
assert.equal(written.provenancePath, provenanceSidecarPath(compositionPath));
const onDisk = JSON.parse(await fs.readFile(compositionPath, "utf8"));
assert.equal(onDisk.source_provenance, undefined, "composition file must NOT carry source_provenance");
assert.equal(onDisk.summary, "Summary line.", "the rest of the composition is untouched");
assert.deepEqual(JSON.parse(await fs.readFile(written.provenancePath!, "utf8")), provenance);
console.log("  ✓ writeComposition strips provenance into the sidecar");

const loadedSidecar = await loadComposition(compositionPath);
assert.equal(loadedSidecar.provenancePath, written.provenancePath);
assert.deepEqual(loadedSidecar.provenance, provenance);
assert.deepEqual(loadedSidecar.content.source_provenance, provenance);
console.log("  ✓ loads provenance back from the sidecar");

// ---- the sidecar wins over a stale inline field ---------------------------
const stale = { ...content(), source_provenance: { evidence: { summary: [], highlights: [], skills: {}, experiences: {} } } };
await fs.writeFile(compositionPath, JSON.stringify(stale, null, 2));
await fs.writeFile(provenanceSidecarPath(compositionPath), JSON.stringify(provenance, null, 2));
assert.deepEqual((await loadComposition(compositionPath)).provenance, provenance, "sidecar is authoritative");
console.log("  ✓ sidecar beats a stale inline field");

// ---- hashing is stable across the migration -------------------------------
const inlineOnly = path.join(dir, "Inline_Only.composition.json");
await fs.writeFile(inlineOnly, JSON.stringify({ ...content(), source_provenance: provenance }, null, 2));
const split = path.join(dir, "Split.composition.json");
await writeComposition(split, { ...content(), source_provenance: provenance });
assert.equal(await compositionContentHash(inlineOnly), await compositionContentHash(split), "hash must not change just because provenance moved files");
console.log("  ✓ composition hash is identical inline vs sidecar");

// The hash answers "is this the same document?", so provenance churn — which
// the audit does on every pass without touching a word — must not move it.
const reProvenanced = path.join(dir, "Reprovenanced.composition.json");
await writeComposition(reProvenanced, { ...content(), source_provenance: provenance });
const beforeProvenanceChurn = await compositionContentHash(reProvenanced);
await writeComposition(reProvenanced, { ...content() }, {
  provenance: { evidence: { summary: [{ file: "state/profile/cv-source.md", lines: [99, 100] }], highlights: [], skills: {}, experiences: {} } } as typeof provenance,
});
assert.equal(await compositionContentHash(reProvenanced), beforeProvenanceChurn, "re-anchored provenance is not a content change");
console.log("  ✓ composition hash ignores provenance churn");

// ---- no provenance: no orphan sidecar -------------------------------------
const bare = path.join(dir, "Bare.composition.json");
await fs.writeFile(provenanceSidecarPath(bare), "{}");
const bareWritten = await writeComposition(bare, content());
assert.equal(bareWritten.provenancePath, null);
assert.equal(await fs.access(provenanceSidecarPath(bare)).then(() => true, () => false), false, "stale sidecar removed");
console.log("  ✓ a provenance-free composition leaves no orphan sidecar");

// ---- splitProvenance is pure ----------------------------------------------
const source = { ...content(), source_provenance: provenance };
const result = splitProvenance(source);
assert.equal(result.content.source_provenance, undefined);
assert.deepEqual(source.source_provenance, provenance, "input untouched");
console.log("  ✓ splitProvenance does not mutate its input");

// ---- the writers route through writeComposition ---------------------------
// Guards the regression this split exists to prevent: a hand-rolled
// `fs.writeFile(<prefix>.composition.json, JSON.stringify(content))` putting the
// inline field back. Verified for real by rendering the classic sample.
for (const tool of ["tools/resume/resume-renderer.ts", "tools/resume/resume-audit.ts"]) {
  const src = await fs.readFile(new URL(`../${tool}`, import.meta.url), "utf8");
  assert.ok(src.includes("writeComposition("), `${tool} must write compositions via writeComposition()`);
  assert.ok(!/writeFile\([^)]*compositionJsonPath/.test(src) && !/writeFile\(compositionPath/.test(src), `${tool} must not write the composition directly`);
}
console.log("  ✓ renderer and audit persist compositions through writeComposition");

await fs.rm(dir, { recursive: true, force: true });
console.log("composition-io: all assertions passed");
