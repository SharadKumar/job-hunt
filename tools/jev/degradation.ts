import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

async function writeDegradation(state: JevDegradation): Promise<void> {
  const target = degradationPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((error: any) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function readDegradation(): Promise<JevDegradation | null> {
  let text: string;
  try {
    text = await fs.readFile(degradationPath(), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Jev health state cannot be read; submission health is unverified");
  }
  try {
    const value = JSON.parse(text);
    const object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
    const timestamp = (v: any) => typeof v === "string" && Number.isFinite(Date.parse(v));
    if (!object(value) || value.schema_version !== 2 || !object(value.scopes)) throw new Error();
    for (const [scope, incident] of Object.entries(value.scopes) as [string, any][]) {
      if (!["classification", "screening_match", "fuzzy_dedup"].includes(scope)
        || !object(incident) || typeof incident.active !== "boolean"
        || typeof incident.reason !== "string" || !timestamp(incident.first_seen_at) || !timestamp(incident.last_seen_at)
        || !(incident.acknowledged_at === null || timestamp(incident.acknowledged_at))
        || !(incident.acknowledged_by === null || (typeof incident.acknowledged_by === "string" && incident.acknowledged_by.trim()))
        || (incident.acknowledged_at === null) !== (incident.acknowledged_by === null)) throw new Error();
    }
    return value as JevDegradation;
  } catch {
    throw new Error("Jev health state is invalid; submission health is unverified");
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
  await writeDegradation(state);
  return incident;
}

export async function clearDegradation(scope: JevDegradationScope): Promise<void> {
  const state = await readDegradation();
  const before = state?.scopes[scope];
  if (!state || !before?.active) return;
  state.scopes[scope] = { ...before, active: false, last_seen_at: new Date().toISOString() };
  await writeDegradation(state);
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
  await writeDegradation(state);
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
