#!/usr/bin/env tsx
/**
 * intake.ts — apply the person's confirmed decisions from Twenty (plan F11).
 *
 * For each decision with no consumedAt:
 *   1. provenance: both stamps MANUAL by the owner, no workflow (provenance.ts);
 *   2. staleness and mapping: plan.ts (halts are exempt and still halt);
 *   3. apply through tools/pipeline.ts, so VALID_TRANSITIONS still rules;
 *   4. write consumedAt, result (APPLIED or REFUSED) and resultReason.
 * Each verdict is printed as one JSON line (the run log keeps the stamp).
 *
 * Confirm and decline set the proposal's status for the executor queue
 * (proposals.ts). Baseline and engagement decisions stay unconsumed until
 * their executors exist, so nothing the person confirmed is dropped.
 *
 * Needs HARNESS_STORE=twenty, TWENTY_API_URL, TWENTY_API_KEY (Harness role)
 * and TWENTY_OWNER_MEMBER_ID (state/twenty/keys.env).
 */

import { twentyBackend, twentyClient } from "../store/twenty-backend.ts";
import { useRowBackend } from "../store/index.ts";
import * as pipeline from "../pipeline.ts";
import { verifyConfirmation } from "./provenance.ts";
import { planDecision, type DecisionRecord } from "./plan.ts";

type Verdict = { id: string; type?: string | null; result: "APPLIED" | "REFUSED" | "DEFERRED"; reason: string; stamp?: unknown };

export async function runIntake(opts: { url: string; key: string; ownerMemberId: string; fetchImpl?: typeof fetch }): Promise<Verdict[]> {
  const { call } = twentyClient({ url: opts.url, key: opts.key }, opts.fetchImpl);
  useRowBackend(await twentyBackend({ config: { url: opts.url, key: opts.key }, fetchImpl: opts.fetchImpl }));
  const filter = encodeURIComponent("consumedAt[is]:NULL");
  const j = await call("GET", `/rest/decisions?filter=${filter}&order_by=createdAt&limit=200`);
  const decisions: DecisionRecord[] = j.data?.decisions ?? [];
  const out: Verdict[] = [];

  for (const d of decisions) {
    const stamp = { createdBy: d.createdBy, updatedBy: d.updatedBy };
    const consume = async (result: "APPLIED" | "REFUSED", reason: string) => {
      // The stamp was checked above, before this write re-stamps updatedBy as the Harness key.
      await call("PATCH", `/rest/decisions/${d.id}`, { consumedAt: new Date().toISOString(), result, resultReason: reason.slice(0, 500) });
      out.push({ id: d.id, type: d.decisionType, result, reason, stamp });
    };

    const prov = verifyConfirmation(stamp, opts.ownerMemberId);
    if (!prov.ok) {
      // A halt fails safe: it still halts even when its stamp doesn't verify.
      if (d.decisionType === "HALT_SENDS") { await consume("APPLIED", `halt applied with unverified stamp: ${prov.reason}`); continue; }
      await consume("REFUSED", `provenance: ${prov.reason}`);
      continue;
    }

    let row: pipeline.Opportunity | null = null;
    if (d.openingId) {
      try {
        const o = await call("GET", `/rest/openings/${d.openingId}`);
        const harnessId = o.data?.opening?.harnessId;
        row = harnessId ? await pipeline.get(harnessId) : null;
      } catch { row = null; }
    }
    const action = planDecision(d, row);
    try {
      switch (action.kind) {
        case "refuse": await consume("REFUSED", action.reason); break;
        case "none": await consume("APPLIED", action.why); break;
        case "halt": await consume("APPLIED", "sends halted"); break;
        case "autopilot": await consume("APPLIED", action.enabled ? "autopilot enabled" : "autopilot disabled"); break;
        case "transition":
          await pipeline.setStatus(row!.id, action.to, d.note ?? `decision ${d.decisionType}`, { actor: "twenty:decision", expectedStatus: row!.status });
          if (action.fields) await pipeline.patch(row!.id, action.fields, "twenty:decision", `decision ${d.decisionType}`);
          await consume("APPLIED", `${row!.status} → ${action.to}`);
          break;
        case "patch":
          await pipeline.patch(row!.id, action.fields, "twenty:decision", `decision ${d.decisionType}`);
          await consume("APPLIED", `updated ${Object.keys(action.fields).join(", ")}`);
          break;
        case "proposal": {
          const pr = (await call("GET", `/rest/proposals/${d.proposalId}`)).data?.proposal;
          if (!pr) { await consume("REFUSED", "the proposal no longer exists"); break; }
          if (pr.status !== "PROPOSED") { await consume("REFUSED", `the proposal is already ${String(pr.status).toLowerCase()}`); break; }
          // The confirm button may carry an edited value (an answer, a letter): it becomes the payload the executor uses.
          const patch: Record<string, unknown> = { status: action.confirm ? "CONFIRMED" : "DECLINED" };
          if (action.confirm && action.value) patch.payload = { ...(pr.payload ?? {}), confirmedValue: action.value };
          await call("PATCH", `/rest/proposals/${d.proposalId}`, patch);
          await consume("APPLIED", action.confirm ? "proposal confirmed for the executor" : "proposal declined");
          break;
        }
        default:
          out.push({ id: d.id, type: d.decisionType, result: "DEFERRED", reason: `${action.kind} executor not available yet`, stamp });
      }
    } catch (e: any) {
      await consume("REFUSED", `could not apply: ${String(e?.message ?? e)}`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { loadLocalEnv } = await import("../jev/env.ts");
    await loadLocalEnv();
    await twentyBackend().catch(() => null); // loads state/twenty/keys.env into the environment
    const url = process.env.TWENTY_API_URL ?? "";
    const key = process.env.TWENTY_API_KEY ?? "";
    const owner = process.env.TWENTY_OWNER_MEMBER_ID ?? "";
    if (!url || !key || !owner) {
      console.log(JSON.stringify({ ok: false, error: "needs TWENTY_API_URL, TWENTY_API_KEY and TWENTY_OWNER_MEMBER_ID" }));
      process.exit(2);
    }
    const verdicts = await runIntake({ url, key, ownerMemberId: owner });
    for (const v of verdicts) console.log(JSON.stringify(v));
    console.log(JSON.stringify({ ok: true, applied: verdicts.filter((v) => v.result === "APPLIED").length, refused: verdicts.filter((v) => v.result === "REFUSED").length, deferred: verdicts.filter((v) => v.result === "DEFERRED").length }));
  })().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
}
