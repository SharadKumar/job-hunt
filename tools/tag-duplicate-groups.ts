#!/usr/bin/env tsx
/**
 * Apply evidence-backed cross-ad duplicate groups to pipeline opportunities.
 *
 * Recruiters frequently advertise one buyer requisition under small title
 * variants. Curated groups live in state/pipeline/duplicate-groups.json so
 * findings survive future hunts and can be reapplied after every refresh.
 * Grouping is informational and enables shared tailoring/research: every
 * distinct recruiter remains independently eligible for application.
 */

import { repoPath } from "./repo-root.ts";
import { promises as fs } from "node:fs";
import { load, patchMany, type Opportunity } from "./pipeline.ts";

type DuplicateGroup = {
  group: string;
  titlePattern: string;
  endEmployer: string;
  requisitionId: string;
  canonicalOpportunityId: string;
  applicationStrategy?: "apply_each_representative";
  sharedDraftDir?: string;
  sharedTailoredResume?: {
    baseResumeId?: string;
    sourceOpportunityId: string;
    docxPath?: string;
    pdfPath?: string;
    approvalStatus: "pending" | "approved" | "stale" | "rejected";
  };
  evidence?: string[];
};

const GROUPS_PATH = repoPath("state/pipeline/duplicate-groups.json");

export function tagDuplicateGroups(
  opportunities: Opportunity[],
  groups: DuplicateGroup[],
): { opportunities: Opportunity[]; tagged: number } {
  let tagged = 0;
  const next = opportunities.map((opportunity) => {
    const group = groups.find((candidate) => new RegExp(candidate.titlePattern, "i").test(opportunity.title));
    if (!group) return opportunity;
    tagged += 1;
    const sharedResume = group.sharedTailoredResume;
    return {
      ...opportunity,
      endEmployer: group.endEmployer,
      requisitionId: group.requisitionId,
      duplicateGroup: group.group,
      duplicateOf: opportunity.id === group.canonicalOpportunityId ? undefined : group.canonicalOpportunityId,
      resumeId: sharedResume?.baseResumeId ?? opportunity.resumeId,
      draftDir: group.sharedDraftDir ?? opportunity.draftDir,
      tailoredResume: sharedResume ? {
        sourceOpportunityId: sharedResume.sourceOpportunityId,
        docxPath: sharedResume.docxPath,
        pdfPath: sharedResume.pdfPath,
        approvalStatus: opportunity.tailoredResume?.approvalStatus ?? sharedResume.approvalStatus,
        approvedAt: opportunity.tailoredResume?.approvedAt,
        approvedBy: opportunity.tailoredResume?.approvedBy,
        contentHash: opportunity.tailoredResume?.contentHash,
      } : opportunity.tailoredResume,
    };
  });
  return { opportunities: next, tagged };
}

/** The fields tagging may set; everything else on the row is left alone. */
const TAGGED_FIELDS = [
  "endEmployer", "requisitionId", "duplicateGroup", "duplicateOf", "resumeId", "draftDir", "tailoredResume",
] as const;

async function main(): Promise<void> {
  const groups = JSON.parse(await fs.readFile(GROUPS_PATH, "utf8")) as DuplicateGroup[];
  const before = await load();
  const result = tagDuplicateGroups(before, groups);

  // Patch only the rows whose tagging fields actually moved. The legacy
  // whole-array `save()` rewrote every row in the pipeline (and would have
  // deleted any row a concurrent writer had added in the meantime) to set a
  // handful of fields on a few of them.
  const previous = new Map(before.map((row) => [row.id, row]));
  const entries: { id: string; fields: Partial<Opportunity>; reason?: string }[] = [];
  for (const row of result.opportunities) {
    const prior = previous.get(row.id);
    if (!prior) continue;
    const fields: Partial<Opportunity> = {};
    for (const key of TAGGED_FIELDS) {
      if (JSON.stringify(row[key] ?? null) !== JSON.stringify(prior[key] ?? null)) (fields as any)[key] = row[key];
    }
    if (Object.keys(fields).length) entries.push({ id: row.id, fields, reason: `duplicate group ${row.duplicateGroup ?? "(none)"}` });
  }
  await patchMany(entries, "tag-duplicate-groups");
  console.error(`[duplicate-groups] tagged ${result.tagged} opportunities across ${groups.length} group(s); patched ${entries.length} row(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
