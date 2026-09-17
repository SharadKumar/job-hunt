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
import { load, save } from "./pipeline.ts";
import { repoPath } from "./repo-root.ts";

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
    const copied: Record<string, string> = {};
    for (const [kind, sourcePath] of Object.entries(baseline.artefacts ?? {})) {
      if (!["docx", "pdf", "composition_json", "provenance_json", "html", "md"].includes(kind)) continue;
      const targetPath = path.join(archiveDir, path.basename(sourcePath));
      await fs.copyFile(sourcePath, targetPath);
      copied[kind] = targetPath;
    }

    const coverLetter = path.join(archiveDir, "cover-letter.md");
    const jdSnapshot = path.join(archiveDir, "jd.md");
    if (!(await exists(coverLetter))) throw new Error(`${id}: cover-letter.md is missing`);
    if (!(await exists(jdSnapshot))) throw new Error(`${id}: jd.md is missing`);

    const packageMetadata = {
      opportunityId: id,
      resumeId,
      mode: "approved_baseline",
      template: baseline.template ?? null,
      resume: copied,
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
    opportunity.resumeId = resumeId;
    opportunity.draftDir = `${archiveDir}/`;
    prepared.push({ id, resumeId, archiveDir, pageCount: baseline.page_count ?? null });
  }

  await save(opportunities);
  console.log(JSON.stringify({ prepared }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
