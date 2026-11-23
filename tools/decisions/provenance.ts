/**
 * provenance.ts — is this record the person's own confirmation?
 *
 * Measured on Twenty 2.60.3 (plan V3):
 *
 *   path                                  createdBy            updatedBy
 *   button (front component) as member    MANUAL · member      MANUAL · member
 *   API key                               API                  API
 *   API key, forged createdBy             MANUAL (forged)      API
 *   app logic function, forged createdBy  MANUAL (forged)      APPLICATION
 *   workflow                              WORKFLOW · workflowId APPLICATION
 *   built-in MCP as the member            AGENT · member       MANUAL · member
 *   MCP as the member, forged createdBy   AGENT (forge undone) MANUAL · member
 *
 * Neither stamp alone separates a button from every other path: updatedBy is
 * MANUAL for MCP writes, and createdBy can be forged by keys and functions.
 * The pair can: both MANUAL, both the owner's member, no workflow context.
 */

export type ActorStamp = {
  source?: string | null;
  workspaceMemberId?: string | null;
  context?: Record<string, unknown> | null;
};

export type ProvenanceVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function verifyConfirmation(
  record: { createdBy?: ActorStamp | null; updatedBy?: ActorStamp | null },
  ownerMemberId: string,
): ProvenanceVerdict {
  if (!ownerMemberId) return { ok: false, reason: "no owner member configured" };
  const checks: [string, ActorStamp | null | undefined][] = [["createdBy", record.createdBy], ["updatedBy", record.updatedBy]];
  for (const [name, stamp] of checks) {
    if (!stamp) return { ok: false, reason: `${name} missing` };
    if (stamp.source !== "MANUAL") return { ok: false, reason: `${name} source is ${stamp.source ?? "empty"}, not MANUAL` };
    if (stamp.workspaceMemberId !== ownerMemberId) return { ok: false, reason: `${name} is not the owner` };
    if (stamp.context && "workflowId" in stamp.context) return { ok: false, reason: `${name} carries a workflow` };
  }
  return { ok: true };
}
