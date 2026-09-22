import { promises as fs } from "node:fs";
import path from "node:path";
import { repoPath } from "../repo-root.ts";

export type JevDegradationScope = "classification" | "screening_match" | "fuzzy_dedup";

export type JevDegradationIncident = {
  active: boolean;
  reason: string;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
};

export type JevDegradation = {
  schema_version: 2;
  scopes: Partial<Record<JevDegradationScope, JevDegradationIncident>>;
};

const AUTOPILOT_BLOCKING_SCOPES: JevDegradationScope[] = ["classification"];

export function degradationPath(): string {
  return process.env.JEV_DEGRADED_PATH ?? repoPath("state/audit/jev-degraded.json");
}

export async function readDegradation(): Promise<JevDegradation | null> {
  try {
    const value = JSON.parse(await fs.readFile(degradationPath(), "utf8")) as JevDegradation;
    return value.schema_version === 2 && value.scopes && typeof value.scopes === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function recordDegradation(
  scope: JevDegradationScope,
  reason: string,
  now = new Date().toISOString(),
): Promise<JevDegradationIncident> {
  const state = await readDegradation() ?? { schema_version: 2 as const, scopes: {} };
  const before = state.scopes[scope];
  const incident: JevDegradationIncident = {
    active: true,
    reason,
    first_seen_at: before?.active ? before.first_seen_at : now,
    last_seen_at: now,
    acknowledged_at: null,
    acknowledged_by: null,
  };
  state.scopes[scope] = incident;
  await fs.mkdir(path.dirname(degradationPath()), { recursive: true });
  await fs.writeFile(degradationPath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return incident;
}

export async function clearDegradation(scope: JevDegradationScope): Promise<void> {
  const state = await readDegradation();
  const before = state?.scopes[scope];
  if (!state || !before?.active) return;
  state.scopes[scope] = { ...before, active: false, last_seen_at: new Date().toISOString() };
  await fs.writeFile(degradationPath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export async function acknowledgeDegradation(
  scope: JevDegradationScope,
  actor: string,
  now = new Date().toISOString(),
): Promise<JevDegradationIncident> {
  const state = await readDegradation();
  const before = state?.scopes[scope];
  if (!state || !before?.active) throw new Error(`There is no active Jev degradation in scope ${scope}`);
  const next = { ...before, acknowledged_at: now, acknowledged_by: actor };
  state.scopes[scope] = next;
  await fs.writeFile(degradationPath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function activeDegradations(state: JevDegradation | null): Array<{ scope: JevDegradationScope; incident: JevDegradationIncident }> {
  if (!state) return [];
  return (Object.entries(state.scopes) as [JevDegradationScope, JevDegradationIncident][])
    .filter(([, incident]) => incident.active)
    .map(([scope, incident]) => ({ scope, incident }));
}

export function blockingDegradation(state: JevDegradation | null): { scope: JevDegradationScope; incident: JevDegradationIncident } | null {
  return activeDegradations(state).find(({ scope, incident }) =>
    AUTOPILOT_BLOCKING_SCOPES.includes(scope) && !incident.acknowledged_at) ?? null;
}

export function degradationBlocksAutopilot(state: JevDegradation | null): boolean {
  return blockingDegradation(state) !== null;
}
