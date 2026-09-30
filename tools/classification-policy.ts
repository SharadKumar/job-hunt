import type { Opportunity } from "./pipeline.ts";
import { canAuthoriseApplication, canPromoteFromClassification } from "./classification.ts";

export function hasAutomaticClassification(opportunity: Pick<Opportunity, "classification">): boolean {
  return canPromoteFromClassification(opportunity.classification);
}

export function matchedResumeId(opportunity: Pick<Opportunity, "classification">): string | null {
  return opportunity.classification?.matched_resume_id ?? null;
}

export function assertAutomaticClassificationForApplication(opportunity: Pick<Opportunity, "id" | "classification">): void {
  if (!canAuthoriseApplication(opportunity.classification)) {
    const source = opportunity.classification ? `${opportunity.classification.source}/${opportunity.classification.status}` : "none";
    throw new Error(`Opportunity ${opportunity.id} requires an automatic persisted ClassificationV2 decision before drafting/apply; current source: ${source}`);
  }
  if (!matchedResumeId(opportunity)) {
    throw new Error(`Opportunity ${opportunity.id} has automatic classification but no matched resume id`);
  }
}
