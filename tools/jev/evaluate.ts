import { promises as fs } from "node:fs";
import path from "node:path";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate } from "ai";
import { log as auditLog, query as auditQuery } from "../audit.ts";
import { sha256 } from "../lib/hash.ts";
import { repoPath } from "../repo-root.ts";
import { gatewayCredential } from "./env.ts";
import { loadJevPolicy } from "./policy.ts";

export type JevMode = "live" | "record" | "replay";

export type JevEvaluationResult = {
  answers: Record<string, { type: string; choice?: string; score?: number; probability?: number; probabilities?: Record<string, number> }>;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  providerMetadata?: Record<string, unknown>;
  response: { modelId: string; timestamp?: Date | string; id?: string };
};

export type JevEvaluation = {
  status: "ok";
  result: JevEvaluationResult;
  mode: JevMode;
  question_set_hash: string;
  question_ids: string[];
  gateway_route_fingerprint: string;
  route_fingerprint_matches: boolean;
  resolved_model_version: string | null;
  model_version_observable: boolean;
  latency_ms: number;
  estimated_cost_usd: number | null;
  response_cost_usd: number | null;
  fixture_key: string;
} | {
  status: "degraded";
  reason: string;
  mode: JevMode;
  question_set_hash: string;
  question_ids: string[];
  fixture_key: string;
};

export type EvaluateWithJevOptions = {
  callSite: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  roleId?: string | null;
  channel?: string | null;
  mode?: JevMode;
  fixtureDir?: string;
  credential?: string | null;
  evaluate?: (args: Record<string, unknown>) => Promise<JevEvaluationResult>;
  spentTodayUsd?: number;
};

export function gatewayRouteFingerprint(modelId: string): string {
  return sha256(JSON.stringify({ modelId, transport: "vercel-ai-gateway-v4-evaluation" }), 24);
}

function modeFor(opts: EvaluateWithJevOptions): JevMode {
  if (opts.mode) return opts.mode;
  // An injected evaluator is an explicit test seam and must not consult a
  // fixture or the network, even when the harness test runner defaults to replay.
  if (opts.evaluate) return "live";
  const configured = process.env.JEV_MODE;
  if (configured === "live" || configured === "record" || configured === "replay") return configured;
  return process.env.HARNESS_TEST === "1" ? "replay" : "live";
}

function dayStartIso(): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export async function jevSpendTodayUsd(): Promise<number> {
  const events = await auditQuery({ sinceISO: dayStartIso() });
  return Number(events
    .filter((event) => event.event_type === "jev_call")
    .filter((event) => event.details?.mode !== "replay")
    .reduce((sum, event) => sum + Number(event.details?.estimated_cost_usd ?? 0), 0)
    .toFixed(8));
}

export async function evaluateWithJev(opts: EvaluateWithJevOptions): Promise<JevEvaluation> {
  const started = Date.now();
  const mode = modeFor(opts);
  const questionIds = Object.keys(opts.questions);
  const questionSetHash = sha256(JSON.stringify(opts.questions));
  const fixtureKey = sha256(JSON.stringify({ call_site: opts.callSite, state: opts.state, questions: opts.questions }), 32);
  const fixtureDir = opts.fixtureDir ?? process.env.JEV_FIXTURE_DIR ?? repoPath("state/jev/fixtures");
  const fixturePath = path.join(fixtureDir, `${fixtureKey}.json`);

  const degrade = async (reason: string): Promise<JevEvaluation> => {
    try {
      await auditLog({
        event_type: "jev_degraded", role_id: opts.roleId ?? null, actor: `jev-${opts.callSite}`, channel: opts.channel ?? null,
        details: { call_site: opts.callSite, reason, mode, question_set: opts.questions, question_set_hash: questionSetHash, fixture_key: fixtureKey },
      });
    } catch {}
    return { status: "degraded", reason, mode, question_set_hash: questionSetHash, question_ids: questionIds, fixture_key: fixtureKey };
  };

  try {
    const { policy } = await loadJevPolicy();
    let result: JevEvaluationResult;
    if (mode === "replay") {
      try {
        result = JSON.parse(await fs.readFile(fixturePath, "utf8")) as JevEvaluationResult;
      } catch {
        return await degrade(`Jev replay fixture is unavailable for ${opts.callSite}: ${fixtureKey}`);
      }
    } else {
      const spent = opts.spentTodayUsd ?? await jevSpendTodayUsd();
      if (spent >= policy.gateway_daily_spend_cap_usd) {
        return await degrade(`Jev daily spend cap reached: US$${spent.toFixed(6)} of US$${policy.gateway_daily_spend_cap_usd}`);
      }
      const credential = opts.credential === undefined ? await gatewayCredential() : opts.credential;
      if (!credential && !opts.evaluate) return await degrade("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is unavailable");
      const gateway = credential ? createGateway({ apiKey: credential }) : null;
      const evaluate = opts.evaluate ?? ((args: Record<string, unknown>) => experimental_evaluate(args as never) as Promise<JevEvaluationResult>);
      try {
        result = await evaluate({
          model: gateway ? gateway.evaluationModel(policy.model) : policy.model,
          state: opts.state,
          questions: opts.questions,
          maxRetries: policy.max_retries,
          abortSignal: AbortSignal.timeout(policy.timeout_ms),
          providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"], models: [] } },
        });
      } catch (error) {
        return await degrade(`Jev request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (mode === "record") {
        await fs.mkdir(fixtureDir, { recursive: true });
        await fs.writeFile(fixturePath, JSON.stringify(result, null, 2) + "\n");
      }
    }

    const latency = Date.now() - started;
    const inputTokens = result.usage.inputTokens ?? null;
    const responseCost = inputTokens == null ? null : inputTokens / 1_000_000 * policy.input_cost_per_million_usd;
    const cost = mode === "replay" ? 0 : responseCost;
    const routeFingerprint = gatewayRouteFingerprint(result.response.modelId);
    const routeFingerprintMatches = !policy.expected_gateway_route_fingerprint
      || policy.expected_gateway_route_fingerprint === routeFingerprint;
    const resolvedModelVersion = /^jev-\d+(?:\.\d+)+$/.test(result.response.modelId)
      ? result.response.modelId
      : null;
    const modelVersionObservable = resolvedModelVersion !== null;
    try {
      await auditLog({
        event_type: "jev_call", role_id: opts.roleId ?? null, actor: `jev-${opts.callSite}`, channel: opts.channel ?? null,
        details: {
          call_site: opts.callSite, mode, question_set: opts.questions, question_set_hash: questionSetHash,
          answers: result.answers, requested_model: policy.model, effective_model: result.response.modelId,
          gateway_route_fingerprint: routeFingerprint, route_fingerprint_matches: routeFingerprintMatches,
          resolved_model_version: resolvedModelVersion, model_version_observable: modelVersionObservable, latency_ms: latency,
          input_tokens: inputTokens, output_tokens: result.usage.outputTokens ?? null, estimated_cost_usd: cost,
          recorded_response_cost_usd: responseCost,
          zero_data_retention: true, fixture_key: fixtureKey,
        },
      });
    } catch {}
    return {
      status: "ok", result, mode, question_set_hash: questionSetHash, question_ids: questionIds,
      gateway_route_fingerprint: routeFingerprint, route_fingerprint_matches: routeFingerprintMatches,
      resolved_model_version: resolvedModelVersion, model_version_observable: modelVersionObservable, latency_ms: latency,
      estimated_cost_usd: cost, response_cost_usd: responseCost, fixture_key: fixtureKey,
    };
  } catch (error) {
    return await degrade(`Jev evaluation setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
