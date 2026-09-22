import { promises as fs } from "node:fs";
import YAML from "yaml";
import { repoPath } from "../repo-root.ts";
import { sha256 } from "../lib/hash.ts";

export type JevPolicy = {
  decision_logic_version: number;
  model: string;
  input_cost_per_million_usd: number;
  timeout_ms: number;
  max_retries: number;
  thresholds: {
    discipline_confidence: number;
    discipline_margin: number;
    resume_confidence: number;
    resume_margin: number;
    /** Minimum winning-option margin for every other consequential answer. */
    operational_margin: number;
  };
  expected_gateway_route_fingerprint?: string | null;
  /** Operational kill switch for applying healthy automatic decisions to pipeline state. */
  classification_state_application_enabled: boolean;
  gateway_daily_spend_cap_usd: number;
};

const DEFAULTS: JevPolicy = {
  decision_logic_version: 3,
  model: "typesafe-ai/jev",
  input_cost_per_million_usd: 0.04,
  timeout_ms: 20_000,
  max_retries: 1,
  thresholds: { discipline_confidence: 0.75, discipline_margin: 0.2, resume_confidence: 0.65, resume_margin: 0.15, operational_margin: 0.2 },
  expected_gateway_route_fingerprint: null,
  classification_state_application_enabled: true,
  gateway_daily_spend_cap_usd: 1,
};

export async function loadJevPolicy(): Promise<{ policy: JevPolicy; hash: string }> {
  const paths = [repoPath("state/profile/jev-policy.yaml"), repoPath("templates/profile/jev-policy.yaml")];
  let parsed: Partial<JevPolicy> = {};
  for (const file of paths) {
    try { parsed = YAML.parse(await fs.readFile(file, "utf8")) ?? {}; break; } catch {}
  }
  const policy: JevPolicy = { ...DEFAULTS, ...parsed, thresholds: { ...DEFAULTS.thresholds, ...(parsed.thresholds ?? {}) } };
  // Operational switches do not change the decision itself and must not
  // invalidate the content-addressed classification cache.
  const {
    classification_state_application_enabled: _stateApplication,
    gateway_daily_spend_cap_usd: _spendCap,
    ...decisionPolicy
  } = policy;
  return { policy, hash: sha256(JSON.stringify(decisionPolicy)) };
}
