/**
 * plan.ts — what a confirmed decision asks the harness to do.
 *
 * Pure: given the decision record and the row it targets, return one action.
 * The runner (intake.ts) verifies provenance first and applies the action
 * through tools/pipeline.ts, so every transition still passes
 * VALID_TRANSITIONS.
 */

import type { Opportunity, PipelineStatus } from "../pipeline.ts";

export type DecisionRecord = {
  id: string;
  decisionType?: string | null;
  statusSeen?: string | null;
  letterShaSeen?: string | null;
  note?: string | null;
  value?: string | null;
  expiresAt?: string | null;
  openingId?: string | null;
  proposalId?: string | null;
  positioningId?: string | null;
  createdBy?: any;
  updatedBy?: any;
};

export type DecisionAction =
  | { kind: "transition"; to: PipelineStatus; fields?: Partial<Opportunity> }
  | { kind: "patch"; fields: Partial<Opportunity> }
  | { kind: "none"; why: string }
  | { kind: "halt" }
  | { kind: "autopilot"; enabled: boolean }
  | { kind: "proposal"; confirm: boolean; value?: string | null }
  | { kind: "baseline"; value?: string | null }
  | { kind: "engagement" }
  | { kind: "refuse"; reason: string };

const OUTCOME: Record<string, PipelineStatus> = {
  OUTCOME_RESPONDED: "responded",
  OUTCOME_INTERVIEW: "interview",
  OUTCOME_OFFERED: "offered",
  OUTCOME_WON: "won",
  OUTCOME_REJECTED: "rejected",
};

/** Types that act on an opening and so must match the status the person saw. */
const NEEDS_OPENING = new Set([
  "APPROVE", "HOLD", "REJECT", "WITHDRAW", "REOPEN", "UNPARK", "MARK_SENT",
  "REQUEST_REDRAFT", "EDIT_LETTER", "START_ENGAGEMENT", ...Object.keys(OUTCOME),
]);

export function planDecision(d: DecisionRecord, row: Opportunity | null, currentLetterSha?: string | null): DecisionAction {
  const type = d.decisionType ?? "";
  // Halts fail safe: no staleness check, no target needed.
  if (type === "HALT_SENDS") return { kind: "halt" };
  if (type === "ENABLE_AUTOPILOT") return { kind: "autopilot", enabled: true };
  if (type === "DISABLE_AUTOPILOT") return { kind: "autopilot", enabled: false };
  if (type === "CONFIRM" || type === "DECLINE") {
    if (!d.proposalId) return { kind: "refuse", reason: `${type} without a proposal` };
    return { kind: "proposal", confirm: type === "CONFIRM", value: d.value };
  }
  if (type === "APPROVE_BASELINE") {
    if (!d.positioningId) return { kind: "refuse", reason: "APPROVE_BASELINE without a positioning" };
    return { kind: "baseline", value: d.value };
  }

  if (!NEEDS_OPENING.has(type)) return { kind: "refuse", reason: `unknown decision type ${type || "(empty)"}` };
  if (!row) return { kind: "refuse", reason: "the opening no longer exists" };
  const seen = (d.statusSeen ?? "").toLowerCase();
  if (seen && seen !== row.status) return { kind: "refuse", reason: `stale: shown ${seen}, now ${row.status}` };
  if (d.letterShaSeen && currentLetterSha && d.letterShaSeen !== currentLetterSha) {
    return { kind: "refuse", reason: "stale: the letter changed after it was shown" };
  }

  switch (type) {
    case "APPROVE": return { kind: "transition", to: "approved" };
    case "HOLD": return { kind: "none", why: "hold leaves the row where it is" };
    case "REJECT": return { kind: "transition", to: "rejected" };
    case "WITHDRAW": return { kind: "transition", to: "withdrawn" };
    case "REOPEN": return { kind: "transition", to: "discovered" };
    case "UNPARK": return { kind: "transition", to: "shortlisted" };
    case "MARK_SENT": {
      const ref = (d.value ?? d.note ?? "").trim();
      return { kind: "transition", to: "submitted", fields: ref ? ({ confirmationRef: ref } as any) : undefined };
    }
    case "REQUEST_REDRAFT": return { kind: "patch", fields: { redraftRequested: true, notes: d.note ?? row.notes } as any };
    case "EDIT_LETTER": return { kind: "patch", fields: { editedLetter: d.value ?? "" } as any };
    case "START_ENGAGEMENT":
      return row.status === "won" ? { kind: "engagement" } : { kind: "refuse", reason: "an engagement starts only from a won opening" };
    default:
      if (OUTCOME[type]) return { kind: "transition", to: OUTCOME[type] };
      return { kind: "refuse", reason: `unhandled decision type ${type}` };
  }
}
