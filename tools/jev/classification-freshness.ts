import { classificationContentHash } from "../classification.ts";
import type { Opportunity } from "../pipeline.ts";
import { currentJevCacheIdentity } from "./classifier.ts";

export type ClassificationIdentity = Awaited<ReturnType<typeof currentJevCacheIdentity>>;

/** An agent decision can authorise unattended work only for the exact advert
 * and decision context it reviewed. A changed profile or resume set requires
 * the bounded verification path again, even when the package is still ready. */
export function classificationFreshnessIssue(row: Opportunity, identity: ClassificationIdentity): string | null {
  const c = row.classification;
  if (!c || c.source !== "agent_fallback" || c.status !== "automatic") return "automatic agent verification is missing";
  const p = c.provenance;
  if (p.confidence_source !== "agent" || !p.requested_model || p.effective_model !== p.requested_model) {
    return "supported agent verification provenance is missing";
  }
  const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
  if (p.content_hash !== contentHash) return "advert content changed since agent verification";
  if (p.policy_hash !== identity.policyHash) return "classification policy changed since agent verification";
  if (p.profile_hash !== identity.profileHash) return "profile evidence changed since agent verification";
  if (p.resume_set_hash !== identity.resumeHash) return "resume choices changed since agent verification";
  if (p.question_schema_hash !== identity.questionSchemaHash) return "classification questions changed since agent verification";
  return null;
}
