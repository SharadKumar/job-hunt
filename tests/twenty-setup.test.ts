#!/usr/bin/env tsx
/**
 * twenty-setup.test.ts: workspace setup and drift (plan F9, V9).
 *
 * Unit part (always): the demo-record matcher (exact name and a time window
 * around the workspace's createdAt; a same-named record created later is never
 * matched), the diff from manifest plus snapshot to findings, exit codes, the
 * read-only client guard, the --apply target guard, the workflow hash, and the
 * committed template.
 *
 * Integration part (only with TWENTY_TEST_URL and TWENTY_TEST_ADMIN_KEY, an
 * Admin API key on a local throwaway instance): the dev seeder, not Twenty's
 * prefill, created that workspace, so the test creates synthetic records with
 * prefill names, backdated into the window (REST accepts createdAt), some in
 * the trash, plus same-named controls created now. Then: --check (drift),
 * --apply, --apply again (no-op), --check (no demo drift, nothing left in the
 * trash, controls untouched). With TWENTY_TEST_ADMIN_SESSION (a signed-in
 * token) it also sets the default role and restores it afterwards; Twenty 2.60
 * refuses API keys there. Demo workflows are covered by the unit part only, so
 * the dev seeder's own workflows are never deleted.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { repoPath } from "../tools/repo-root.ts";
import {
  applyTargetAllowed, canonicalJson, compareVersions, diffWorkspace, exitCodeFor, matchDemoRecords, readOnly, workflowHash,
  type Manifest, type Snapshot,
} from "../tools/twenty/setup.ts";

// ---------- unit: matcher ----------
const WS = "2026-11-01T00:00:00.000Z";
const at = (min: number) => new Date(Date.parse(WS) + min * 60_000).toISOString();
{
  const recs = [
    { id: "a", name: "Airbnb", createdAt: at(0.01) },
    { id: "b", name: "Airbnb", createdAt: at(90) }, // same name, created later
    { id: "c", name: "Acme Pty Ltd", createdAt: at(0.01) }, // in window, not a demo name
    { id: "d", name: "airbnb", createdAt: at(1) }, // name must be exact
    { id: "e", name: "Notion", createdAt: at(9.9), deletedAt: at(20) }, // trashed, still matched
    { id: "f", name: "Figma", createdAt: at(10.5) }, // just outside
  ];
  const { matched, lookalikes } = matchDemoRecords(["Airbnb", "Notion", "Figma"], recs, WS, 10);
  assert.deepEqual(matched.map((r) => r.id), ["a", "e"]);
  assert.deepEqual(lookalikes.map((r) => r.id), ["b", "f"]);
  // A wider window is configurable.
  assert.deepEqual(matchDemoRecords(["Airbnb"], recs, WS, 120).matched.map((r) => r.id), ["a", "b"]);
  // An unparseable workspace createdAt matches nothing.
  assert.equal(matchDemoRecords(["Airbnb"], recs, "nonsense").matched.length, 0);
}

// ---------- unit: diff ----------
const NOW = new Date("2027-06-01T00:00:00Z");
const manifest: Manifest = {
  serverVersion: "2.60.3",
  featureFlags: { IS_CREATE_RECORDS_PERMISSION_ENABLED: true },
  defaultRole: "No access",
  roles: [{ label: "Owner", universalIdentifier: "r-owner" }, { label: "Harness", universalIdentifier: "r-harness" }],
  roleHolders: { owner: { role: "Owner", email: "person@acme.test" }, breakGlass: { role: "Admin", email: "admin@acme.test" } },
  app: { universalIdentifier: "app-1", minVersion: "0.1.3" },
  apiKeys: [{ name: "Harness", role: "Harness", expiresAt: "2027-06-10", rotateBy: "2027-05-01" }],
  breakGlassKeys: ["Break glass"],
  forbiddenApiKeyRoles: ["Admin", "Member", "Owner"],
  workflows: { "Notify escalation": "h1" },
  demoRecords: { windowMinutes: 10, companies: ["Airbnb"], workflows: ["Quick Lead"] },
};
const clean: Snapshot = {
  serverVersion: "v2.60.3",
  workspace: { id: "w", createdAt: WS, defaultRole: "No access", featureFlags: { IS_CREATE_RECORDS_PERMISSION_ENABLED: true } },
  roles: [
    { id: "1", label: "Owner", universalIdentifier: "r-owner", memberEmails: ["person@acme.test"] },
    { id: "2", label: "Harness", universalIdentifier: "r-harness", memberEmails: [] },
    { id: "3", label: "Admin", universalIdentifier: "r-admin", memberEmails: ["admin@acme.test"] },
    { id: "4", label: "No access", universalIdentifier: "r-none", memberEmails: [] },
  ],
  apiKeys: [{ id: "k1", name: "Harness", role: "Harness", expiresAt: "2027-12-01T00:00:00Z", revokedAt: null }],
  applications: [{ universalIdentifier: "app-1", version: "0.1.3" }],
  workflows: [{ id: "wf1", name: "Notify escalation", createdAt: at(5000), hash: "h1" }],
  demo: { companies: [{ id: "c9", name: "Airbnb", createdAt: at(5000) }] }, // later lookalike only
};
const snap = (patch: (s: Snapshot) => void): Snapshot => { const s = structuredClone(clean); patch(s); return s; };
const levels = (s: Snapshot, m = manifest) => diffWorkspace(m, s, NOW).filter((f) => f.level !== "warn");
{
  const base = { ...manifest, apiKeys: [{ name: "Harness", role: "Harness" }] };
  assert.deepEqual(levels(clean, base), [], "clean workspace has no drift");
  assert.equal(exitCodeFor(diffWorkspace(base, clean, NOW)), 0);
  assert.ok(diffWorkspace(base, clean, NOW).some((f) => f.area === "demo" && f.level === "warn"), "lookalike is a warning only");

  // Expiry warning within 14 days, rotation warning, both warnings not drift.
  const w = diffWorkspace(manifest, snap((s) => { s.apiKeys[0].expiresAt = "2027-06-10T00:00:00Z"; }), NOW);
  assert.ok(w.some((f) => f.level === "warn" && /expires 2027-06-10/.test(f.message)));
  assert.ok(w.some((f) => f.level === "warn" && /rotation/.test(f.message)));
  assert.equal(exitCodeFor(w), 0);
  assert.ok(levels(snap((s) => { s.apiKeys[0].expiresAt = "2027-05-01T00:00:00Z"; })).some((f) => /expired/.test(f.message)));

  const one = (s: Snapshot, area: string, re: RegExp, level = "drift") => {
    const f = levels(s).filter((x) => x.area === area);
    assert.ok(f.some((x) => x.level === level && re.test(x.message)), `${area} ${re}: ${JSON.stringify(f)}`);
    return exitCodeFor(diffWorkspace(manifest, s, NOW));
  };
  // Keys: forbidden role, extra key, wrong role, missing key (human), break-glass exempt.
  assert.equal(one(snap((s) => { s.apiKeys.push({ id: "k2", name: "Old", role: "Admin", expiresAt: null, revokedAt: null }); }), "apiKeys", /forbidden role Admin/), 1);
  assert.equal(one(snap((s) => { s.apiKeys.push({ id: "k2", name: "Extra", role: "Harness", expiresAt: null, revokedAt: null }); }), "apiKeys", /Extra is not in the manifest/), 1);
  one(snap((s) => { s.apiKeys[0].role = "Member"; }), "apiKeys", /holds role Member/);
  assert.equal(one(snap((s) => { s.apiKeys = []; }), "apiKeys", /not created yet/, "human"), 10);
  assert.deepEqual(levels(snap((s) => { s.apiKeys.push({ id: "k3", name: "Break glass", role: "Admin", expiresAt: null, revokedAt: null }); })).filter((f) => f.area === "apiKeys"), []);
  assert.deepEqual(levels(snap((s) => { s.apiKeys.push({ id: "k4", name: "Gone", role: "Admin", expiresAt: null, revokedAt: "2027-01-01" }); })).filter((f) => f.area === "apiKeys"), [], "revoked keys ignored");
  // Workflows: undefined, edited, missing, unreadable (human).
  one(snap((s) => { s.workflows!.push({ id: "wf2", name: "Sneaky", createdAt: at(6000), hash: "x" }); }), "workflows", /"Sneaky" is not defined/);
  one(snap((s) => { s.workflows![0].hash = "h2"; }), "workflows", /definition changed/);
  one(snap((s) => { s.workflows = []; }), "workflows", /missing/);
  assert.equal(one(snap((s) => { s.workflows = null; }), "workflows", /TWENTY_ADMIN_SESSION/, "human"), 10);
  // Demo: a record in the window (live or trashed), and a demo workflow, are drift; a demo workflow is not also "undefined".
  one(snap((s) => { s.demo.companies!.push({ id: "c1", name: "Airbnb", createdAt: at(2), deletedAt: at(30) }); }), "demo", /1 demo companies present \(1 in the trash\)/);
  const wf = levels(snap((s) => { s.workflows!.push({ id: "wf3", name: "Quick Lead", createdAt: at(1), hash: "q" }); }));
  assert.ok(wf.some((f) => f.area === "demo" && /workflows present: Quick Lead/.test(f.message)));
  assert.ok(!wf.some((f) => f.area === "workflows"), "demo workflow is reported once");
  // A later "Quick Lead" made by the person is an undefined workflow, not demo.
  assert.ok(levels(snap((s) => { s.workflows!.push({ id: "wf4", name: "Quick Lead", createdAt: at(900), hash: "q" }); })).some((f) => f.area === "workflows"));
  // Roles, default role, holders, app, flags, server.
  one(snap((s) => { s.roles = s.roles.filter((r) => r.label !== "Harness"); }), "roles", /Harness missing/);
  one(snap((s) => { s.workspace.defaultRole = "Member"; }), "defaultRole", /Member, want No access/);
  one(snap((s) => { s.roles[0].memberEmails = []; s.roles[2].memberEmails.push("person@acme.test"); }), "roleHolders", /owner holds Admin, want Owner/);
  assert.equal(one(snap((s) => { s.roles[0].memberEmails = []; }), "roleHolders", /no workspace member/, "human"), 10);
  assert.ok(diffWorkspace({ ...manifest, roleHolders: { owner: { role: "Owner", email: "owner@example.com" } } }, clean, NOW).some((f) => f.level === "human" && /fill in/.test(f.message)));
  one(snap((s) => { s.applications = []; }), "app", /not installed/, "human");
  one(snap((s) => { s.applications[0].version = "0.1.2"; }), "app", /older than 0.1.3/);
  one(snap((s) => { s.workspace.featureFlags = {}; }), "featureFlags", /operator/, "human");
  one(snap((s) => { s.serverVersion = "v2.59.9"; }), "server", /older/);
  // Drift outranks a human step.
  assert.equal(exitCodeFor([{ level: "human", area: "a", message: "" }, { level: "drift", area: "b", message: "" }]), 1);
  assert.equal(compareVersions("v2.60.10", "2.60.3"), 1);
}

// ---------- unit: guards and hash ----------
{
  const calls: string[] = [];
  const ro = readOnly(async (m, p) => { calls.push(`${m} ${p}`); return {}; });
  await ro("GET", "/rest/companies");
  await ro("POST", "/metadata", { query: "{ currentWorkspace { id } }" });
  await ro("POST", "/graphql", { query: "query($a: String) { coreWorkflows(after: $a) { edges { node { id } } } }" });
  for (const [m, p, body] of [
    ["DELETE", "/rest/companies/1", undefined], ["POST", "/rest/companies", {}], ["PATCH", "/rest/companies/1", {}],
    ["POST", "/metadata", { query: "mutation { updateWorkspace(data: {}) { id } }" }],
    ["POST", "/graphql", { query: "# hi\nmutation X { deleteCoreWorkflows(input: {coreWorkflowIds: []}) { id } }" }],
  ] as const) {
    await assert.rejects(ro(m, p, body), /read-only/);
  }
  assert.equal(calls.length, 3);

  assert.equal(applyTargetAllowed("http://127.0.0.1:2021", undefined), true);
  assert.equal(applyTargetAllowed("http://localhost:3000/", undefined), true);
  assert.equal(applyTargetAllowed("https://crm.acme.test", "https://crm.acme.test/"), true);
  assert.equal(applyTargetAllowed("https://crm.acme.test", "https://other.acme.test"), false);
  assert.equal(applyTargetAllowed("https://crm.acme.test", undefined), false);
  assert.equal(applyTargetAllowed("http://127.0.0.1.evil.test", undefined), false);

  const v = { trigger: { type: "MANUAL", settings: { outputSchema: { a: 1 } } }, steps: [{ id: "s", name: "x", position: { x: 1 } }] };
  const v2 = { steps: [{ position: { x: 9 }, name: "x", id: "s" }], trigger: { settings: { outputSchema: { b: 2 } }, type: "MANUAL" } };
  assert.equal(workflowHash(v), workflowHash(v2), "hash ignores key order, outputSchema and position");
  assert.notEqual(workflowHash(v), workflowHash({ ...v, steps: [{ id: "s", name: "y" }] }));
  assert.equal(workflowHash(null), null);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
}

// ---------- unit: template ----------
{
  const tpl = parseYaml(fs.readFileSync(repoPath("templates", "twenty", "manifest.yaml"), "utf8")) as Manifest;
  const ids = fs.readFileSync(repoPath("twenty-app", "src", "constants", "universal-identifiers.ts"), "utf8");
  assert.equal(tpl.app?.universalIdentifier, ids.match(/APPLICATION_UNIVERSAL_IDENTIFIER = '([^']+)'/)?.[1]);
  for (const r of tpl.roles ?? []) assert.ok(ids.includes(`'${r.universalIdentifier}'`), `role ${r.label} id matches the app`);
  assert.deepEqual(Object.keys(tpl.featureFlags ?? {}).sort(), ["IS_AI_CHAT_INBOX_ENABLED", "IS_CREATE_RECORDS_PERMISSION_ENABLED", "IS_CUSTOMIZABLE_SIDEBAR_ENABLED"]);
  assert.equal(tpl.defaultRole, "No access");
  assert.deepEqual(tpl.forbiddenApiKeyRoles, ["Admin", "Member", "Owner"]);
  assert.ok(Object.values(tpl.roleHolders ?? {}).every((h) => h.email.endsWith("@example.com")), "template carries no real emails");
  assert.deepEqual(tpl.demoRecords?.companies, ["Airbnb", "Anthropic", "Stripe", "Figma", "Notion"]);
  assert.equal(tpl.demoRecords?.people?.length, 5);
  assert.equal(tpl.demoRecords?.opportunities?.length, 6);
  assert.deepEqual(tpl.demoRecords?.workflows, ["Quick Lead", "Create company when adding a new person"]);
  assert.deepEqual(tpl.demoRecords?.dashboards, ["My First Dashboard"]);
}

// ---------- integration ----------
const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_ADMIN_KEY;
// Optional: a signed-in token for the break-glass account, needed by Twenty 2.60 to set the default role.
const session = process.env.TWENTY_TEST_ADMIN_SESSION ?? "";
if (!url || !key) {
  console.log("twenty-setup: unit ok; integration skipped (set TWENTY_TEST_URL and TWENTY_TEST_ADMIN_KEY)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("integration runs only against a local test instance");

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${url}${p}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(`${method} ${p} ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const meta = async (query: string, variables?: unknown) => (await api("POST", "/metadata", { query, variables })).data;
async function sessionMeta(query: string, variables?: unknown): Promise<any> {
  const res = await fetch(`${url}/metadata`, { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j: any = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}
const rows = async (kind: string, filter: string) => {
  const j = await api("GET", `/rest/${kind}?${new URLSearchParams({ filter, limit: "200" })}`);
  return Object.values(j.data)[0] as any[];
};

const ws = (await meta(`{ currentWorkspace { createdAt defaultRole { id } } getRoles { id label } }`));
const wsCreatedAt: string = ws.currentWorkspace.createdAt;
const originalDefaultRoleId: string | undefined = ws.currentWorkspace.defaultRole?.id;
const hasNoAccess = (ws.getRoles as any[]).some((r) => r.label === "No access");
const inWindow = new Date(Date.parse(wsCreatedAt) + 60_000).toISOString();

// Stripe is left out: the dev seeder made its own "Stripe" inside the window.
const demo = {
  companies: ["Airbnb", "Anthropic", "Figma", "Notion"],
  people: ["Brian Chesky", "Dario Amodei", "Patrick Collison", "Dylan Field", "Ivan Zhao"],
  opportunities: ["Platform Migration"],
  dashboards: ["My First Dashboard"],
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twenty-setup-"));
const manifestFile = path.join(tmp, "manifest.yaml");
fs.writeFileSync(manifestFile, JSON.stringify({
  workspaceUrl: url,
  ...(hasNoAccess ? { defaultRole: "No access" } : {}),
  demoRecords: { windowMinutes: 10, ...demo },
}));

const created: { kind: string; id: string }[] = [];
const create = async (kind: string, body: Record<string, unknown>) => {
  const j = await api("POST", `/rest/${kind}`, body);
  const rec = Object.values(j.data)[0] as any;
  created.push({ kind, id: rec.id });
  return rec.id as string;
};
const personBody = (full: string) => { const [firstName, lastName] = full.split(" "); return { name: { firstName, lastName } }; };

// Synthetic demo content, backdated into the window. One company and one person go to the trash.
const demoIds: string[] = [];
for (const n of demo.companies) demoIds.push(await create("companies", { name: n, createdAt: inWindow }));
for (const n of demo.people) demoIds.push(await create("people", { ...personBody(n), createdAt: inWindow }));
for (const n of demo.opportunities) demoIds.push(await create("opportunities", { name: n, createdAt: inWindow }));
for (const n of demo.dashboards) demoIds.push(await create("dashboards", { title: n, createdAt: inWindow }));
await api("DELETE", `/rest/companies/${created[3].id}?soft_delete=true`); // Notion
await api("DELETE", `/rest/people/${created[8].id}?soft_delete=true`); // Ivan Zhao
// Controls: same names, created now. They must survive.
const controlCompany = await create("companies", { name: "Airbnb" });
const controlPerson = await create("people", personBody("Brian Chesky"));

function run(mode: "--check" | "--apply") {
  const r = spawnSync(process.execPath, ["--import", "tsx", repoPath("tools", "twenty", "setup.ts"), mode, "--manifest", manifestFile], {
    env: { ...process.env, TWENTY_API_URL: url, TWENTY_ADMIN_KEY: key, TWENTY_ADMIN_SESSION: session },
    encoding: "utf8",
  });
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  return { code: r.status, out };
}
const demoDrift = (out: any) => (out.findings ?? []).filter((f: any) => f.area === "demo" && f.level === "drift");

try {
  const c1 = run("--check");
  assert.equal(c1.code, 1, JSON.stringify(c1.out));
  const d1 = demoDrift(c1.out).map((f: any) => f.message);
  assert.ok(d1.some((m: string) => /4 demo companies present \(1 in the trash\)/.test(m)), JSON.stringify(d1));
  assert.ok(d1.some((m: string) => /5 demo people present \(1 in the trash\)/.test(m)), JSON.stringify(d1));
  assert.ok(d1.some((m: string) => /1 demo opportunities present/.test(m)));
  assert.ok(d1.some((m: string) => /1 demo dashboards present/.test(m)));

  const a1 = run("--apply");
  assert.deepEqual(a1.out.errors, [], JSON.stringify(a1.out));
  assert.equal(a1.out.actions.filter((a: string) => a.startsWith("destroyed")).length, 11, JSON.stringify(a1.out.actions));
  assert.equal(a1.out.actions.filter((a: string) => /was in the trash/.test(a)).length, 2);
  assert.ok(a1.out.nextSteps.some((s: string) => /twenty app apply/.test(s)));
  if (hasNoAccess && session) assert.ok(a1.out.actions.some((a: string) => /default role set to No access/.test(a)), JSON.stringify(a1.out.actions));
  if (hasNoAccess && !session) assert.ok(a1.out.skipped.some((x: string) => /default role/.test(x)), "default role needs a session");

  const a2 = run("--apply");
  assert.deepEqual(a2.out.actions, [], `second apply is a no-op: ${JSON.stringify(a2.out.actions)}`);
  assert.deepEqual(a2.out.errors, []);

  const c2 = run("--check");
  assert.deepEqual(demoDrift(c2.out), [], JSON.stringify(c2.out.findings));
  assert.ok(c2.out.findings.some((f: any) => f.area === "demo" && f.level === "warn" && /created later/.test(f.message)), "controls reported as lookalikes");
  if (session) assert.ok(!c2.out.findings.some((f: any) => f.area === "defaultRole"), "default role applied");

  // Nothing left, live or in the trash; controls untouched.
  const trashFilter = (ids: string[]) => `and(id[in]:${JSON.stringify(ids)},deletedAt[is]:NOT_NULL)`;
  for (const kind of ["companies", "people", "opportunities", "dashboards"]) {
    assert.equal((await rows(kind, trashFilter(demoIds))).length, 0, `${kind} trash empty`);
    assert.equal((await rows(kind, `id[in]:${JSON.stringify(demoIds)}`)).length, 0, `${kind} gone`);
  }
  assert.equal((await rows("companies", `id[eq]:${controlCompany}`)).length, 1, "same-named company created later survives");
  assert.equal((await rows("people", `id[eq]:${controlPerson}`)).length, 1, "same-named person created later survives");
  console.log(`twenty-setup: unit ok; integration ok (check 1 -> apply ${a1.out.actions.length} actions -> apply no-op -> check clean of demo)`);
} finally {
  for (const { kind, id } of created) await api("DELETE", `/rest/${kind}/${id}`).catch(() => {});
  if (hasNoAccess && session && originalDefaultRoleId) {
    await sessionMeta(`mutation($id: UUID!) { updateWorkspace(data: { defaultRoleId: $id }) { id } }`, { id: originalDefaultRoleId }).catch(() => {});
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
