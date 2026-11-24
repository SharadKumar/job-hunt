/**
 * send-switch.ts — may the autopilot send right now? (plan Principle 1, R44)
 *
 * The switch is the person's own decisions in Twenty, re-derived immediately
 * before every send (never from the `control` display, never from intake):
 *   - sends are allowed only after a verified ENABLE_AUTOPILOT (both stamps
 *     MANUAL by the owner) that is newer than every DISABLE_AUTOPILOT and
 *     every HALT_SENDS, and not past its optional expiresAt;
 *   - any HALT_SENDS counts, verified or not (a halt fails safe);
 *   - an unverified DISABLE also counts (turning sends off is always safe);
 *   - if Twenty can't be read, nothing is sent.
 */

import { verifyConfirmation, type ActorStamp } from "./provenance.ts";

export type SwitchDecision = {
  decisionType?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  createdBy?: ActorStamp | null;
  result?: string | null;
  updatedBy?: ActorStamp | null;
};

export type SwitchState = { allowed: boolean; reason: string };

/**
 * An enable counts when it is the owner's own button: both stamps MANUAL by
 * the owner. Intake verifies exactly that and then writes the result, which
 * re-stamps updatedBy as the harness key; so an enable intake has APPLIED
 * still counts when its createdBy is the owner's MANUAL stamp. Only the
 * harness key can write result (the person's role cannot), so this opens
 * nothing to the person's other accounts, AI chat or Grok.
 */
export function enableVerified(d: SwitchDecision, ownerMemberId: string): { ok: true } | { ok: false; reason: string } {
  const direct = verifyConfirmation(d, ownerMemberId);
  if (direct.ok) return direct;
  const c = d.createdBy;
  const createdByOwner = c?.source === "MANUAL" && c.workspaceMemberId === ownerMemberId && !(c.context && "workflowId" in c.context);
  if (d.result === "APPLIED" && createdByOwner) return { ok: true };
  return direct;
}

export function deriveSendSwitch(decisions: SwitchDecision[], ownerMemberId: string, now = new Date()): SwitchState {
  const at = (d: SwitchDecision) => Date.parse(d.createdAt) || 0;
  const latest = (pred: (d: SwitchDecision) => boolean) =>
    decisions.filter(pred).reduce<SwitchDecision | null>((best, d) => (!best || at(d) > at(best) ? d : best), null);

  const enable = latest((d) => d.decisionType === "ENABLE_AUTOPILOT" && enableVerified(d, ownerMemberId).ok);
  if (!enable) {
    // Say why an enable that exists does not count (for example, made from
    // another member's account), instead of implying none was ever made.
    const other = latest((d) => d.decisionType === "ENABLE_AUTOPILOT");
    if (other) {
      const why = enableVerified(other, ownerMemberId);
      const who = (other.createdBy as any)?.name ? ` (made by ${(other.createdBy as any).name})` : "";
      return { allowed: false, reason: `the latest Enable autopilot${who} is not the owner's own confirmation: ${why.ok ? "unverified" : why.reason}` };
    }
    return { allowed: false, reason: "autopilot has never been enabled by the owner" };
  }
  const stop = latest((d) => d.decisionType === "HALT_SENDS" || d.decisionType === "DISABLE_AUTOPILOT");
  if (stop && at(stop) >= at(enable)) {
    return { allowed: false, reason: stop.decisionType === "HALT_SENDS" ? "sends halted" : "autopilot disabled" };
  }
  if (enable.expiresAt && Date.parse(enable.expiresAt) <= now.getTime()) {
    return { allowed: false, reason: "the owner's autopilot enable has expired; confirm it again" };
  }
  return { allowed: true, reason: "enabled by the owner" };
}

/** Read the switch decisions from Twenty and derive the state; any failure means no send. */
export async function readSendSwitch(opts: { url: string; key: string; ownerMemberId: string; fetchImpl?: typeof fetch; now?: Date }): Promise<SwitchState> {
  try {
    const f = opts.fetchImpl ?? fetch;
    const filter = encodeURIComponent("decisionType[in]:[ENABLE_AUTOPILOT,DISABLE_AUTOPILOT,HALT_SENDS]");
    const res = await f(`${opts.url.replace(/\/+$/, "")}/rest/decisions?filter=${filter}&order_by=createdAt[DescNullsLast]&limit=200`, {
      headers: { Authorization: `Bearer ${opts.key}` },
    });
    if (!res.ok) return { allowed: false, reason: `Twenty answered ${res.status}; not sending` };
    const json: any = await res.json();
    return deriveSendSwitch(json?.data?.decisions ?? [], opts.ownerMemberId, opts.now);
  } catch (e: any) {
    return { allowed: false, reason: `Twenty unreadable (${String(e?.message ?? e).slice(0, 120)}); not sending` };
  }
}
