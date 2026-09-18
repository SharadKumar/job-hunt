#!/usr/bin/env tsx
/**
 * Assemble application folders for opportunities whose classified baseline CV
 * is already sufficient. This avoids expensive, unnecessary re-tailoring while
 * preserving the approved artefact and its audit metadata in each package.
 *
 * Usage:
 *   tsx tools/prepare-baseline-packages.ts --ids seek-a,seek-b
 */

import { exists } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { load, patchMany, type Opportunity } from "./pipeline.ts";
import { sha256 } from "./lib/hash.ts";
import { repoPath, repoRoot } from "./repo-root.ts";

/** Repo-relative form of a path inside the repo; absolute paths outside it stay as they are. */
function relToRepo(absolute: string): string {
  const rel = path.relative(repoRoot(), absolute);
  return rel.startsWith("..") ? absolute : rel;
}

type BaselineMetadata = {
  resume_id: string;
  template?: string;
  content_hash?: string;
  approved_hash?: string;
  approval_status?: string;
  page_count?: number;
  artefacts?: Record<string, string>;
};

function parseIds(): string[] {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--ids");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("Usage: prepare-baseline-packages --ids seek-a,seek-b");
  }
  return [...new Set(argv[index + 1].split(",").map((id) => id.trim()).filter(Boolean))];
}

async function main(): Promise<void> {
  const ids = parseIds();
  const opportunities = await load();
  const prepared: Array<Record<string, unknown>> = [];
  // Only the rows named on --ids are touched. The old whole-array `save()`
  // rewrote the entire pipeline (deleting anything a concurrent writer had
  // added) to set two fields on a handful of rows.
  const patches: { id: string; fields: Partial<Opportunity>; reason?: string }[] = [];

  for (const id of ids) {
    const opportunity = opportunities.find((candidate) => candidate.id === id);
    if (!opportunity) throw new Error(`Unknown opportunity: ${id}`);
    if (opportunity.classification?._classifier !== "agent") {
      throw new Error(`${id}: agent classification is required`);
    }
    if (opportunity.classification.requires_tailoring) {
      throw new Error(`${id}: classification requires tailoring; baseline packaging refused`);
    }

    const resumeId = opportunity.classification.matched_resume_id;
    if (!resumeId) throw new Error(`${id}: matched_resume_id is missing`);
    const baselineDir = path.join(repoPath("state/profile/resumes"), resumeId);
    const baselineMetadataPath = path.join(baselineDir, "metadata.json");
    const baseline = JSON.parse(await fs.readFile(baselineMetadataPath, "utf8")) as BaselineMetadata;
    if (
      baseline.approval_status !== "approved"
      || !baseline.content_hash
      || baseline.content_hash !== baseline.approved_hash
    ) {
      throw new Error(`${id}: ${resumeId} baseline is not currently approved`);
    }

    const archiveDir = path.join(repoPath("state/pipeline/archive"), id);
    await fs.mkdir(archiveDir, { recursive: true });

    // Reference, not copy. A baseline package used to copy the whole approved
    // artefact set (~1.2 MB) into every package, and 143 packages of bytes that
    // are identical to state/profile/resumes/<id>/ is 110 MB of archive saying
    // nothing the reference does not. The sha256 of the referenced docx is what
    // makes the reference evidence: submission-gate re-hashes the file at `ref`
    // and refuses the send if it has moved since the package was prepared.
    // The adapters take a docx path, so they are pointed at the baseline file
    // itself (SEEK matches its stored resumé by basename, which is unchanged).
    const docxSource = baseline.artefacts?.docx;
    if (!docxSource) throw new Error(`${id}: ${resumeId} baseline metadata has no docx artefact`);
    const docxPath = path.isAbsolute(docxSource) ? docxSource : repoPath(docxSource);
    if (!(await exists(docxPath))) throw new Error(`${id}: baseline docx missing at ${docxPath}`);
    const pdfSource = baseline.artefacts?.pdf ?? null;
    const resumeRef = {
      mode: "baseline" as const,
      resume_id: resumeId,
      ref: relToRepo(docxPath),
      pdf_ref: pdfSource ? relToRepo(path.isAbsolute(pdfSource) ? pdfSource : repoPath(pdfSource)) : null,
      sha256: sha256(await fs.readFile(docxPath)),
      baseline_content_hash: baseline.approved_hash ?? baseline.content_hash,
    };

    const coverLetter = path.join(archiveDir, "cover-letter.md");
    const jdSnapshot = path.join(archiveDir, "jd.md");
    if (!(await exists(coverLetter))) throw new Error(`${id}: cover-letter.md is missing`);
    if (!(await exists(jdSnapshot))) throw new Error(`${id}: jd.md is missing`);

    const packageMetadata = {
      opportunityId: id,
      resumeId,
      mode: "approved_baseline",
      template: baseline.template ?? null,
      resume: resumeRef,
      baselineSource: baselineDir,
      baselineContentHash: baseline.content_hash,
      coverLetter,
      jdSnapshot,
      quality: {
        baselineApproval: "approved",
        pageCount: baseline.page_count ?? null,
        coverLetter: "pass",
      },
      submitted: false,
      preparedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(archiveDir, "metadata.json"), JSON.stringify(packageMetadata, null, 2) + "\n");
    patches.push({ id, fields: { resumeId, draftDir: `${archiveDir}/` }, reason: "approved baseline package prepared" });
    prepared.push({ id, resumeId, archiveDir, pageCount: baseline.page_count ?? null });
  }

  await patchMany(patches, "prepare-baseline-packages");
  console.log(JSON.stringify({ prepared }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
