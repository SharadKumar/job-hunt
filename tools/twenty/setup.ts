#!/usr/bin/env tsx
/**
 * setup.ts: workspace setup and drift for the Twenty store (plan F9).
 *
 *   npm run twenty:setup -- --check [--manifest <path>]
 *   npm run twenty:setup -- --apply [--manifest <path>]
 *
 * `--check` is read-only: GraphQL metadata queries and REST GETs only, enforced
 * by the client (any mutation or non-GET request throws). It compares the live
 * workspace with the manifest: server version, feature flags, the app and its
 * version, the app's roles, the default role, role holders, API keys (role,
 * expiry, forbidden roles), workflows by definition hash, and Twenty's demo
 * content (live and in the trash).
 *
 * `--apply` is attended and idempotent. It sets the default role and hard
 * deletes demo content (destroy, so the trash stays empty). A demo record is
 * touched only when its name is on the manifest's list AND it was created
 * within `windowMinutes` of the workspace itself. It never installs the app;
 * that is `twenty app apply`, listed under nextSteps.
 *
 * Credentials: TWENTY_API_URL and TWENTY_ADMIN_KEY (the attended break-glass
 * Admin API key) from the environment or state/twenty/keys.env. Twenty 2.60
 * refuses API keys on workflow endpoints and on setting the default role, so
 * those need TWENTY_ADMIN_SESSION (a signed-in access token of the break-glass
 * account); without it they are reported as a human step or skipped.
 *
 * Prints one JSON object. Exit 0 no drift, 1 drift, 2 unreadable, 10 waiting
 * on a human step.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { parse as parseYaml } from "yaml";
import { repoPath } from "../repo-root.ts";
import { twentyClient } from "../store/twenty-backend.ts";

// ---------- types ----------

export type DemoKind = "companies" | "people" | "opportunities" | "dashboards" | "workflows";
export const RECORD_KINDS: Exclude<DemoKind, "workflows">[] = ["opportunities", "people", "companies", "dashboards"];

export type Manifest = {
  version?: number;
  workspaceUrl?: string;
  serverVersion?: string;
  featureFlags?: Record<string, boolean>;
  defaultRole?: string;
  roles?: { label: string; universalIdentifier: string }[];
  roleHolders?: Record<string, { role: string; email: string }>;
  app?: { universalIdentifier: string; minVersion?: string };
  apiKeys?: { name: string; role: string; expiresAt?: string; rotateBy?: string }[];
  breakGlassKeys?: string[];
  forbiddenApiKeyRoles?: string[];
  workflows?: Record<string, string>;
  demoRecords?: { windowMinutes?: number } & Partial<Record<DemoKind, string[]>>;
};

export type DemoRecord = { id: string; name: string; createdAt: string; deletedAt?: string | null };

export type Snapshot = {
  serverVersion: string | null;
  workspace: { id: string; createdAt: string; defaultRole: string | null; featureFlags: Record<string, boolean> };
  roles: { id: string; label: string; universalIdentifier: string | null; memberEmails: string[] }[];
  apiKeys: { id: string; name: string; role: string | null; expiresAt: string | null; revokedAt: string | null }[];
  applications: { universalIdentifier: string; version: string | null }[];
  /** null when the workflows could not be read (no session token). */
  workflows: { id: string; name: string; createdAt: string; hash: string | null }[] | null;
  /** Records whose name is on a demo list, live and trashed. Unmatched by time yet. */
  demo: Partial<Record<DemoKind, DemoRecord[]>>;
};

export type Level = "drift" | "human" | "warn";
export type Finding = { level: Level; area: string; message: string };

// ---------- pure logic ----------

export const DEFAULT_WINDOW_MINUTES = 10;
const EXPIRY_WARN_DAYS = 14;

/** Compare dotted versions; a leading "v" is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The demo-record matcher. A record matches only on an exact name from the
 * list AND a createdAt within `windowMinutes` of the workspace's createdAt.
 * Same-named records outside the window are returned as lookalikes, untouched.
 */
export function matchDemoRecords(
  names: string[],
  records: DemoRecord[],
  workspaceCreatedAt: string,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
): { matched: DemoRecord[]; lookalikes: DemoRecord[] } {
  const wanted = new Set(names);
  const anchor = Date.parse(workspaceCreatedAt);
  const matched: DemoRecord[] = [];
  const lookalikes: DemoRecord[] = [];
  if (!Number.isFinite(anchor)) return { matched, lookalikes: records.filter((r) => wanted.has(r.name)) };
  for (const r of records) {
    if (!wanted.has(r.name)) continue;
    const at = Date.parse(r.createdAt);
    if (Number.isFinite(at) && Math.abs(at - anchor) <= windowMinutes * 60_000) matched.push(r);
    else lookalikes.push(r);
  }
  return { matched, lookalikes };
}

/** Every demo record the manifest allows `--apply` to destroy, by kind. */
export function demoMatches(manifest: Manifest, snap: Snapshot): Partial<Record<DemoKind, DemoRecord[]>> & { lookalikes: number } {
  const window = manifest.demoRecords?.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const out: Partial<Record<DemoKind, DemoRecord[]>> & { lookalikes: number } = { lookalikes: 0 };
  for (const kind of [...RECORD_KINDS, "workflows"] as DemoKind[]) {
    const names = manifest.demoRecords?.[kind] ?? [];
    if (!names.length) continue;
    const records = kind === "workflows"
      ? (snap.workflows ?? []).map((w) => ({ id: w.id, name: w.name, createdAt: w.createdAt }))
      : snap.demo[kind] ?? [];
    const { matched, lookalikes } = matchDemoRecords(names, records, snap.workspace.createdAt, window);
    if (matched.length) out[kind] = matched;
    out.lookalikes += lookalikes.length;
  }
  return out;
}

const day = (iso: string) => iso.slice(0, 10);
const placeholderEmail = (e?: string) => !e || /@example\.(com|org|net)$/i.test(e);

/** The drift diff: manifest plus live snapshot to findings. Pure. */
export function diffWorkspace(manifest: Manifest, snap: Snapshot, now = new Date()): Finding[] {
  const f: Finding[] = [];
  const add = (level: Level, area: string, message: string) => f.push({ level, area, message });

  // server
  if (manifest.serverVersion) {
    if (!snap.serverVersion) add("warn", "server", "server version not reported");
    else if (compareVersions(snap.serverVersion, manifest.serverVersion) < 0)
      add("drift", "server", `server ${snap.serverVersion} is older than ${manifest.serverVersion}`);
    else if (compareVersions(snap.serverVersion, manifest.serverVersion) !== 0)
      add("warn", "server", `server ${snap.serverVersion} differs from manifest ${manifest.serverVersion}`);
  }

  // feature flags: set by the operator, so a human step
  for (const [key, want] of Object.entries(manifest.featureFlags ?? {})) {
    const have = snap.workspace.featureFlags[key] ?? false;
    if (have !== want) add("human", "featureFlags", `${key} is ${have}; ask the operator to set it to ${want}`);
  }

  // app
  if (manifest.app) {
    const app = snap.applications.find((a) => a.universalIdentifier === manifest.app!.universalIdentifier);
    if (!app) add("human", "app", "app not installed; run `twenty app apply` in twenty-app/");
    else if (manifest.app.minVersion && (!app.version || compareVersions(app.version, manifest.app.minVersion) < 0))
      add("drift", "app", `app ${app.version ?? "unknown"} is older than ${manifest.app.minVersion}; run \`twenty app apply\``);
  }

  // roles
  for (const role of manifest.roles ?? []) {
    const live = snap.roles.find((r) => r.universalIdentifier === role.universalIdentifier) ?? snap.roles.find((r) => r.label === role.label);
    if (!live) add("drift", "roles", `role ${role.label} missing`);
    else if (live.label !== role.label) add("warn", "roles", `role ${role.universalIdentifier} is labelled ${live.label}, manifest says ${role.label}`);
  }

  // default role
  if (manifest.defaultRole && snap.workspace.defaultRole !== manifest.defaultRole)
    add("drift", "defaultRole", `default role is ${snap.workspace.defaultRole ?? "unset"}, want ${manifest.defaultRole}`);

  // role holders
  for (const [id, holder] of Object.entries(manifest.roleHolders ?? {})) {
    if (placeholderEmail(holder.email)) { add("human", "roleHolders", `${id}: fill in the email in the private manifest`); continue; }
    const email = holder.email.toLowerCase();
    const holds = snap.roles.filter((r) => r.memberEmails.some((e) => e.toLowerCase() === email)).map((r) => r.label);
    if (!holds.length) add("human", "roleHolders", `${id}: no workspace member with that email yet`);
    else if (!holds.includes(holder.role)) add("drift", "roleHolders", `${id} holds ${holds.join(", ")}, want ${holder.role}`);
  }

  // api keys
  const active = snap.apiKeys.filter((k) => !k.revokedAt);
  const expected = new Set((manifest.apiKeys ?? []).map((k) => k.name));
  const breakGlass = new Set(manifest.breakGlassKeys ?? []);
  const forbidden = new Set(manifest.forbiddenApiKeyRoles ?? []);
  const checkExpiry = (name: string, expiresAt: string | null) => {
    if (!expiresAt) return;
    const left = (Date.parse(expiresAt) - now.getTime()) / 86_400_000;
    if (left <= 0) add("drift", "apiKeys", `${name} expired ${day(expiresAt)}`);
    else if (left <= EXPIRY_WARN_DAYS) add("warn", "apiKeys", `${name} expires ${day(expiresAt)} (${Math.ceil(left)} days)`);
  };
  for (const want of manifest.apiKeys ?? []) {
    const live = active.filter((k) => k.name === want.name);
    if (!live.length) { add("human", "apiKeys", `key ${want.name} not created yet (role ${want.role})`); continue; }
    if (live.length > 1) add("drift", "apiKeys", `${live.length} active keys named ${want.name}; revoke the extras`);
    for (const k of live) {
      if (k.role !== want.role) add("drift", "apiKeys", `${want.name} holds role ${k.role ?? "none"}, want ${want.role}`);
      checkExpiry(want.name, k.expiresAt);
    }
    if (want.rotateBy && Date.parse(want.rotateBy) <= now.getTime()) add("warn", "apiKeys", `${want.name} was due for rotation on ${want.rotateBy}`);
  }
  for (const k of active) {
    if (breakGlass.has(k.name)) {
      add("warn", "apiKeys", `break-glass key ${k.name} is active; revoke it after use`);
      checkExpiry(k.name, k.expiresAt);
      continue;
    }
    if (k.role && forbidden.has(k.role)) add("drift", "apiKeys", `key ${k.name} holds forbidden role ${k.role}`);
    else if (!expected.has(k.name)) add("drift", "apiKeys", `key ${k.name} is not in the manifest`);
  }

  // demo content (matched by name and time window)
  const demo = demoMatches(manifest, snap);
  for (const kind of [...RECORD_KINDS, "workflows"] as DemoKind[]) {
    const hits = demo[kind];
    if (!hits?.length) continue;
    const trashed = hits.filter((r) => r.deletedAt).length;
    add("drift", "demo", `${hits.length} demo ${kind} present${trashed ? ` (${trashed} in the trash)` : ""}: ${[...new Set(hits.map((r) => r.name))].join(", ")}`);
  }
  if (demo.lookalikes) add("warn", "demo", `${demo.lookalikes} record(s) share a demo name but were created later; left alone`);

  // workflows
  const wanted = manifest.workflows ?? {};
  if (snap.workflows === null) {
    add("human", "workflows", "workflows unread: Twenty refuses API keys here; set TWENTY_ADMIN_SESSION to the break-glass sign-in token");
  } else {
    const demoIds = new Set((demo.workflows ?? []).map((w) => w.id));
    for (const w of snap.workflows) {
      if (demoIds.has(w.id)) continue;
      if (!(w.name in wanted)) add("drift", "workflows", `workflow "${w.name}" is not in the manifest (hash ${w.hash ?? "none"})`);
      else if (wanted[w.name] && w.hash !== wanted[w.name]) add("drift", "workflows", `workflow "${w.name}" definition changed (hash ${w.hash?.slice(0, 12) ?? "none"})`);
    }
    for (const name of Object.keys(wanted)) {
      if (!snap.workflows.some((w) => w.name === name)) add("drift", "workflows", `workflow "${name}" missing`);
    }
  }
  return f;
}

export function exitCodeFor(findings: Finding[]): 0 | 1 | 10 {
  if (findings.some((x) => x.level === "drift")) return 1;
  if (findings.some((x) => x.level === "human")) return 10;
  return 0;
}

/** Stable JSON with sorted keys. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const VOLATILE = new Set(["outputSchema", "position"]);
function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as object).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, stripVolatile(x)]));
  }
  return v;
}

/** sha256 of a workflow version's trigger and steps, derived fields removed. */
export function workflowHash(version: { trigger?: unknown; steps?: unknown } | null): string | null {
  if (!version) return null;
  return createHash("sha256").update(canonicalJson(stripVolatile({ trigger: version.trigger ?? null, steps: version.steps ?? [] }))).digest("hex");
}

export function normaliseUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").toLowerCase();
}

export function isLocalUrl(u: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normaliseUrl(u));
}

/** `--apply` may run only against the private manifest's URL, or localhost. */
export function applyTargetAllowed(apiUrl: string, privateManifestUrl: string | undefined): boolean {
  if (isLocalUrl(apiUrl)) return true;
  return Boolean(privateManifestUrl) && normaliseUrl(apiUrl) === normaliseUrl(privateManifestUrl!);
}

// ---------- IO ----------

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

/** A client that refuses every mutation: REST GET and GraphQL queries only. */
export function readOnly(call: Call): Call {
  return async (method, path, body) => {
    const m = method.toUpperCase();
    if (m === "GET") return call(method, path, body);
    const isGraphql = m === "POST" && /^\/(metadata|graphql)(\?|$)/.test(path);
    const doc = String((body as any)?.query ?? "").replace(/#[^\n]*/g, "").trim();
    if (!isGraphql || !(doc.startsWith("{") || /^query\b/.test(doc))) {
      throw new Error(`read-only: refused ${m} ${path}${isGraphql ? " (mutation)" : ""}`);
    }
    return call(method, path, body);
  };
}

async function gql(call: Call, endpoint: "/metadata" | "/graphql", query: string, variables?: Record<string, unknown>): Promise<any> {
  const j = await call("POST", endpoint, { query, variables });
  if (j.errors?.length) throw new Error(`GraphQL ${endpoint}: ${j.errors.map((e: any) => e.message).join("; ").slice(0, 300)}`);
  return j.data;
}

const REST_NAME_FILTER: Record<Exclude<DemoKind, "workflows">, (names: string[]) => string> = {
  companies: (n) => `name[in]:${JSON.stringify(n)}`,
  opportunities: (n) => `name[in]:${JSON.stringify(n)}`,
  dashboards: (n) => `title[in]:${JSON.stringify(n)}`,
  people: (n) => `name.firstName[in]:${JSON.stringify([...new Set(n.map((x) => x.split(" ")[0]))])}`,
};

const SINGULAR: Record<DemoKind, string> = { companies: "company", people: "person", opportunities: "opportunity", dashboards: "dashboard", workflows: "workflow" };

function recordName(kind: DemoKind, r: any): string {
  if (kind === "people") return [r.name?.firstName, r.name?.lastName].filter(Boolean).join(" ");
  if (kind === "dashboards") return r.title ?? "";
  return r.name ?? "";
}

async function readDemoRecords(call: Call, kind: Exclude<DemoKind, "workflows">, names: string[]): Promise<DemoRecord[]> {
  const out: DemoRecord[] = [];
  const wanted = new Set(names);
  for (const trash of [false, true]) {
    const filter = trash ? `and(${REST_NAME_FILTER[kind](names)},deletedAt[is]:NOT_NULL)` : REST_NAME_FILTER[kind](names);
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ filter, limit: "200" });
      if (cursor) qs.set("starting_after", cursor);
      let j: any;
      try {
        j = await call("GET", `/rest/${kind}?${qs}`);
      } catch (e: any) {
        // An object the workspace has removed (for example the standard opportunity) has no demo content.
        if (/not found/i.test(String(e?.message)) && / 400:| 404:/.test(String(e?.message))) return out;
        throw e;
      }
      const rows: any[] = (Object.values(j.data ?? {})[0] as any[]) ?? [];
      for (const r of rows) {
        const name = recordName(kind, r);
        if (wanted.has(name)) out.push({ id: r.id, name, createdAt: r.createdAt, deletedAt: r.deletedAt ?? null });
      }
      if (!j.pageInfo?.hasNextPage || !rows.length) break;
      cursor = j.pageInfo.endCursor;
    }
  }
  return out;
}

async function readWorkflows(session: Call): Promise<NonNullable<Snapshot["workflows"]>> {
  const out: NonNullable<Snapshot["workflows"]> = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d = await gql(session, "/graphql",
      `query($after: String) { coreWorkflows(first: 200, after: $after) { edges { node { id name createdAt lastPublishedCoreWorkflowVersionId } } pageInfo { hasNextPage endCursor } } }`,
      { after });
    for (const { node } of d.coreWorkflows.edges) {
      let hash: string | null = null;
      if (node.lastPublishedCoreWorkflowVersionId) {
        const v = await gql(session, "/graphql",
          `query($id: UUID!) { coreWorkflowVersionById(coreWorkflowVersionId: $id) { trigger steps } }`,
          { id: node.lastPublishedCoreWorkflowVersionId });
        hash = workflowHash(v.coreWorkflowVersionById);
      }
      out.push({ id: node.id, name: node.name ?? "", createdAt: node.createdAt, hash });
    }
    if (!d.coreWorkflows.pageInfo?.hasNextPage) break;
    after = d.coreWorkflows.pageInfo.endCursor;
  }
  return out;
}

export async function readSnapshot(call: Call, manifest: Manifest, opts: { session?: Call; url: string; fetchImpl?: typeof fetch }): Promise<Snapshot> {
  const d = await gql(call, "/metadata", `{
    currentWorkspace { id createdAt defaultRole { label } featureFlags { key value } }
    getRoles { id label universalIdentifier workspaceMembers { userEmail } }
    apiKeys { id name expiresAt revokedAt role { label } }
    findManyApplications { universalIdentifier version }
  }`);
  let serverVersion: string | null = null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.url}/client-config`);
    if (res.ok) serverVersion = ((await res.json()) as any).appVersion ?? null;
  } catch { /* reported as a warning */ }
  const demo: Snapshot["demo"] = {};
  for (const kind of RECORD_KINDS) {
    const names = manifest.demoRecords?.[kind] ?? [];
    if (names.length) demo[kind] = await readDemoRecords(call, kind, names);
  }
  let workflows: Snapshot["workflows"] = null;
  if (opts.session) workflows = await readWorkflows(opts.session);
  const ws = d.currentWorkspace;
  return {
    serverVersion,
    workspace: {
      id: ws.id,
      createdAt: ws.createdAt,
      defaultRole: ws.defaultRole?.label ?? null,
      featureFlags: Object.fromEntries((ws.featureFlags ?? []).map((x: any) => [x.key, Boolean(x.value)])),
    },
    roles: (d.getRoles ?? []).map((r: any) => ({ id: r.id, label: r.label, universalIdentifier: r.universalIdentifier ?? null, memberEmails: (r.workspaceMembers ?? []).map((m: any) => m.userEmail).filter(Boolean) })),
    apiKeys: (d.apiKeys ?? []).map((k: any) => ({ id: k.id, name: k.name, role: k.role?.label ?? null, expiresAt: k.expiresAt ?? null, revokedAt: k.revokedAt ?? null })),
    applications: (d.findManyApplications ?? []).map((a: any) => ({ universalIdentifier: a.universalIdentifier, version: a.version ?? null })),
    workflows,
    demo,
  };
}

/** Destroys matched demo content and sets the default role. Returns what it did. */
export async function applyWorkspace(call: Call, manifest: Manifest, snap: Snapshot, session?: Call) {
  const actions: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];

  if (manifest.defaultRole && snap.workspace.defaultRole !== manifest.defaultRole) {
    const role = snap.roles.find((r) => r.label === manifest.defaultRole);
    if (!role) errors.push(`default role: no role labelled ${manifest.defaultRole}; run \`twenty app apply\` first`);
    else if (!session) skipped.push(`default role: Twenty 2.60 refuses API keys here; set TWENTY_ADMIN_SESSION, or set ${role.label} by hand under Settings, Roles`);
    else {
      try {
        await gql(session, "/metadata", `mutation($id: UUID!) { updateWorkspace(data: { defaultRoleId: $id }) { id } }`, { id: role.id });
        actions.push(`default role set to ${role.label}`);
      } catch (e: any) {
        errors.push(`default role: ${String(e?.message ?? e).slice(0, 200)}; set it by hand under Settings, Roles`);
      }
    }
  }

  const demo = demoMatches(manifest, snap);
  for (const kind of RECORD_KINDS) {
    for (const r of demo[kind] ?? []) {
      try {
        await call("DELETE", `/rest/${kind}/${r.id}`); // no soft_delete: destroy, not trash
        actions.push(`destroyed ${SINGULAR[kind]} "${r.name}"${r.deletedAt ? " (was in the trash)" : ""}`);
      } catch (e: any) {
        if (/ 404:/.test(String(e?.message))) continue;
        errors.push(`destroy ${kind} "${r.name}": ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  }
  const wf = demo.workflows ?? [];
  if (wf.length) {
    if (!session) skipped.push("demo workflows: set TWENTY_ADMIN_SESSION to delete them");
    else {
      try {
        await gql(session, "/graphql", `mutation($ids: [UUID!]!) { deleteCoreWorkflows(input: { coreWorkflowIds: $ids }) { id } }`, { ids: wf.map((w) => w.id) });
        for (const w of wf) actions.push(`deleted workflow "${w.name}"`);
      } catch (e: any) {
        errors.push(`delete demo workflows: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  } else if (snap.workflows === null && (manifest.demoRecords?.workflows ?? []).length) {
    skipped.push("demo workflows unread: set TWENTY_ADMIN_SESSION");
  }
  return { actions, errors, skipped };
}

async function loadKeysEnv(): Promise<void> {
  try {
    const text = await fs.readFile(repoPath("state", "twenty", "keys.env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
}

export async function loadManifest(file: string): Promise<Manifest> {
  const doc = parseYaml(await fs.readFile(file, "utf8"));
  if (!doc || typeof doc !== "object") throw new Error(`${file}: not a manifest`);
  return doc as Manifest;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--check") ? "check" : null;
  const out = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
  if (!mode) { out({ ok: false, error: "usage: twenty:setup -- --check | --apply [--manifest <path>]" }); return 2; }

  await loadKeysEnv();
  const url = (process.env.TWENTY_API_URL ?? "").replace(/\/+$/, "");
  const key = process.env.TWENTY_ADMIN_KEY ?? "";
  const sessionToken = process.env.TWENTY_ADMIN_SESSION ?? "";
  if (!url || !key) { out({ ok: false, mode, exit: 10, error: "set TWENTY_API_URL and TWENTY_ADMIN_KEY (state/twenty/keys.env)" }); return 10; }

  const privatePath = repoPath("state", "twenty", "manifest.yaml");
  const manifestPath = arg("--manifest") ?? privatePath;
  let manifest: Manifest;
  try { manifest = await loadManifest(manifestPath); } catch (e: any) {
    out({ ok: false, mode, exit: 10, error: `no manifest at ${manifestPath}; copy templates/twenty/manifest.yaml there and fill it in`, detail: String(e?.message ?? e).slice(0, 200) });
    return 10;
  }

  if (mode === "apply") {
    let privateUrl: string | undefined;
    try { privateUrl = (await loadManifest(privatePath)).workspaceUrl; } catch { /* absent */ }
    if (!applyTargetAllowed(url, privateUrl)) {
      out({ ok: false, mode, exit: 2, error: "refused: --apply runs only against workspaceUrl in state/twenty/manifest.yaml (or localhost)" });
      return 2;
    }
  }

  const raw = twentyClient({ url, key }).call;
  const rawSession = sessionToken ? twentyClient({ url, key: sessionToken }).call : undefined;
  const ro = readOnly(raw);
  const roSession = rawSession ? readOnly(rawSession) : undefined;

  let snap: Snapshot;
  try { snap = await readSnapshot(ro, manifest, { session: roSession, url }); } catch (e: any) {
    out({ ok: false, mode, exit: 2, error: `unreadable: ${String(e?.message ?? e).slice(0, 300)}` });
    return 2;
  }

  if (mode === "check") {
    const findings = diffWorkspace(manifest, snap);
    const exit = exitCodeFor(findings);
    out({ ok: exit === 0, mode, exit, url, workspaceCreatedAt: snap.workspace.createdAt, findings });
    return exit;
  }

  const result = await applyWorkspace(raw, manifest, snap, rawSession);
  let after: Snapshot;
  try { after = await readSnapshot(ro, manifest, { session: roSession, url }); } catch (e: any) {
    out({ ok: false, mode, exit: 2, ...result, error: `unreadable after apply: ${String(e?.message ?? e).slice(0, 300)}` });
    return 2;
  }
  const findings = diffWorkspace(manifest, after);
  const exit = result.errors.length ? 2 : exitCodeFor(findings);
  out({
    ok: exit === 0, mode, exit, url, ...result,
    nextSteps: ["install or upgrade the app with `twenty app apply` in twenty-app/", "run `npm run twenty:setup -- --check`"],
    findings,
  });
  return exit;
}

const isMain = process.argv[1] && /setup\.ts$/.test(process.argv[1]);
if (isMain) main().then((code) => process.exit(code));
