import type { Opportunity } from "./pipeline.ts";

export function hasAgentClassification(opportunity: Pick<Opportunity, "classification" | "classificationSource">): boolean {
  return opportunity.classification?._classifier === "agent" && (opportunity.classificationSource == null || opportunity.classificationSource === "agent");
}

export function matchedResumeId(opportunity: Pick<Opportunity, "classification">): string | null {
  return opportunity.classification?.matched_resume_id ?? null;
}

export function assertAgentClassificationForApplication(opportunity: Pick<Opportunity, "id" | "classification" | "classificationSource">): void {
  if (!hasAgentClassification(opportunity)) {
    const source = opportunity.classification?._classifier ?? opportunity.classificationSource ?? "none";
    throw new Error(`Opportunity ${opportunity.id} requires persisted agent classification before drafting/apply; current source: ${source}`);
  }
  if (!matchedResumeId(opportunity)) {
    throw new Error(`Opportunity ${opportunity.id} has agent classification but no matched resume id`);
  }
}
