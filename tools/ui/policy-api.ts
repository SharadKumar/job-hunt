/**
 * tools/ui/policy-api.ts - the two switches the local UI is allowed to flip.
 *
 * `autopilot.enabled` and `kill_switch` in the profile's submission-policy.yaml
 * are the gates every unattended send passes through (AGENTS.md section 2).
 * The person may flip them, attended, from their own machine; this module is
 * that surface and nothing more. It reads the policy, it writes exactly one
 * key, and it records who did it in the audit log. It never submits anything,
 * never touches another key, and never creates the policy file: a profile with
 * no submission-policy.yaml is a profile that has not been set up, and the
 * answer to that is `/setup`, not a file conjured by a browser click.
 *
 * The write goes through `YAML.parseDocument` and mutates the existing scalar
 * node in place, so the file the person reads afterwards is the file they
 * wrote: every comment (including the trailing one on `kill_switch` itself),
 * every blank line and every key order survives. The write is atomic, so a
 * crash mid-save leaves the previous policy intact rather than a truncated one
 * that would read as "autopilot off" for the wrong reason.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import YAML, { isScalar } from "yaml";

import { log, type AuditEventType } from "../audit.ts";
import { writeAtomic } from "../lib/fs.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoRoot } from "../repo-root.ts";
import { ApiError } from "./api.ts";

/**
 * A policy flip is the first writer of this event, and `AuditEventType` is
 * owned by tools/audit.ts. Name it once here rather than reaching into another
 * module's type; the audit log itself is untyped JSONL and reads it fine.
 */
const POLICY_CHANGE = "policy_change" as AuditEventType;

/** Where the keys live in the YAML, so the two endpoints differ only by path. */
const AUTOPILOT_ENABLED = ["autopilot", "enabled"] as const;
const KILL_SWITCH = ["kill_switch"] as const;

export type PolicySnapshot = {
  autopilot_enabled: boolean;
  kill_switch: boolean;
  max_per_day: number | null;
  channels: string[];
  sheet_enabled: boolean;
  /** Repo-relative, so the UI can name the file the person should open. */
  path: string;
};

export type PolicyToggleBody = {
  enabled?: unknown;
  reason?: unknown;
};

export type PolicyContext = {
  profileId?: string | null;
};

function policyPath(profileId: string | null | undefined): string {
  return path.join(resolveProfileContext(profileId ?? null).profileDir, "submission-policy.yaml");
}

function relativeToRepo(file: string): string {
  const rel = path.relative(repoRoot(), file);
  return rel.startsWith("..") ? file : rel;
}

/** The raw text, or null when there is no policy file at all. */
async function readPolicyText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** GET /api/policy */
export async function getPolicy(ctx: PolicyContext = {}): Promise<PolicySnapshot> {
  const file = policyPath(ctx.profileId);
  const text = await readPolicyText(file);
  // A fresh clone has no policy. That is "nothing is switched on", not an
  // error: the UI still needs somewhere to point the person at.
  if (text === null) {
    return {
      autopilot_enabled: false,
      kill_switch: false,
      max_per_day: null,
      channels: [],
      sheet_enabled: false,
      path: relativeToRepo(file),
    };
  }

  const policy = (YAML.parse(text) ?? {}) as any;
  const maxPerDay = policy?.autopilot?.max_per_day;
  const channels = policy?.autopilot?.channels;
  return {
    autopilot_enabled: policy?.autopilot?.enabled === true,
    kill_switch: policy?.kill_switch === true,
    max_per_day: typeof maxPerDay === "number" && Number.isFinite(maxPerDay) ? maxPerDay : null,
    channels: Array.isArray(channels) ? channels.map((c: unknown) => String(c)) : [],
    // Matches `sheetEnabled` in tools/sheets-sync.ts: an older profile with no
    // `sheet:` block at all keeps mirroring until it says otherwise.
    sheet_enabled: policy?.sheet?.enabled !== false,
    path: relativeToRepo(file),
  };
}

function readEnabled(body: PolicyToggleBody): boolean {
  if (typeof body?.enabled !== "boolean") {
    throw new ApiError(400, "enabled must be true or false");
  }
  return body.enabled;
}

function readReason(body: PolicyToggleBody): string | null {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  return reason ? reason : null;
}

/**
 * Replace the scalar's own source text and leave every other byte alone.
 *
 * Re-serialising the document is not good enough here: `String(doc)` collapses
 * the column-aligned trailing comments this policy file is full of, re-spaces
 * flow sequences and folds the long `notes:` strings. All of that is valid
 * YAML and none of it is the file the person wrote. The parsed node carries
 * its source range, so the edit is a splice: the value changes, and the diff
 * is one line.
 */
function spliceScalar(text: string, node: unknown, value: boolean): string | null {
  if (!isScalar(node) || !node.range) return null;
  const [start, end] = node.range;
  return text.slice(0, start) + String(value) + text.slice(end);
}

/**
 * Set one boolean key and audit the change. The common path is a splice of the
 * existing scalar. A key that is not in the file at all has no source range to
 * splice, so it is added through the document and re-serialised; there is no
 * comment on an absent key to lose, and `lineWidth: 0` keeps the rest of the
 * file from being re-wrapped on the way out.
 */
async function setPolicyFlag(
  keyPath: readonly string[],
  body: PolicyToggleBody,
  ctx: PolicyContext,
): Promise<{ from: boolean; to: boolean }> {
  const enabled = readEnabled(body);
  const reason = readReason(body);
  const file = policyPath(ctx.profileId);
  const text = await readPolicyText(file);
  if (text === null) {
    throw new ApiError(409, `no submission policy at ${relativeToRepo(file)}; run the setup skill before switching anything on`);
  }

  const doc = YAML.parseDocument(text);
  const node = doc.getIn(keyPath as string[], true);
  const from = (isScalar(node) ? node.value : doc.getIn(keyPath as string[])) === true;

  let next = spliceScalar(text, node, enabled);
  if (next === null) {
    doc.setIn(keyPath as string[], enabled);
    next = doc.toString({ lineWidth: 0 });
  }

  await writeAtomic(file, next);

  await log({
    event_type: POLICY_CHANGE,
    role_id: null,
    actor: "ui",
    details: { key: keyPath.join("."), from, to: enabled, reason },
  });

  return { from, to: enabled };
}

/** POST /api/policy/autopilot */
export async function postAutopilot(
  body: PolicyToggleBody,
  ctx: PolicyContext = {},
): Promise<{ ok: true; autopilot_enabled: boolean }> {
  const { to } = await setPolicyFlag(AUTOPILOT_ENABLED, body, ctx);
  return { ok: true, autopilot_enabled: to };
}

/** POST /api/policy/kill-switch */
export async function postKillSwitch(
  body: PolicyToggleBody,
  ctx: PolicyContext = {},
): Promise<{ ok: true; kill_switch: boolean }> {
  const { to } = await setPolicyFlag(KILL_SWITCH, body, ctx);
  return { ok: true, kill_switch: to };
}
