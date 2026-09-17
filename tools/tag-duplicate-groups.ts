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

import { promises as fs } from "node:fs";
import { load, save, type Opportunity } from "./pipeline.ts";

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

const GROUPS_PATH = "state/pipeline/duplicate-groups.json";

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

async function main(): Promise<void> {
  const groups = JSON.parse(await fs.readFile(GROUPS_PATH, "utf8")) as DuplicateGroup[];
  const result = tagDuplicateGroups(await load(), groups);
  await save(result.opportunities);
  console.error(`[duplicate-groups] tagged ${result.tagged} opportunities across ${groups.length} group(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
