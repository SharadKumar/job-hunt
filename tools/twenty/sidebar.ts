#!/usr/bin/env tsx
/**
 * sidebar.ts — a clean workspace sidebar (plan F7, F9).
 *
 * Twenty seeds every workspace with its own sidebar items (objects, a
 * Workflows folder, a Campaigns folder). The suite keeps the standard objects
 * it uses (by default company, person, task, note), removes the rest, and puts
 * the app's section first. Only items with no owner member (workspace-wide
 * items) and not created by this app are considered; a person's own pinned
 * items are never touched.
 *
 *   tsx tools/twenty/sidebar.ts --check   # read-only; exit 0 clean, 1 drift
 *   tsx tools/twenty/sidebar.ts --apply   # remove the extras, move the section up
 *
 * Needs TWENTY_API_URL and TWENTY_ADMIN_SESSION (the attended admin's sign-in
 * token; Twenty refuses API keys for navigation changes). The standard objects
 * to keep come from SIDEBAR_KEEP (comma separated) or the default above.
 */

export type NavItem = {
  id: string;
  type: string;
  name?: string | null;
  position?: number | null;
  parentId?: string | null;
  applicationId?: string | null;
  userWorkspaceId?: string | null;
  targetObjectMetadataId?: string | null;
};

export type SidebarPlan = { remove: { id: string; label: string }[]; sectionToTop: { id: string; position: number } | null };

export const DEFAULT_KEEP = ["company", "person", "task", "note"];

/** Pure: which workspace-wide items to remove and whether the suite section must move. */
export function planSidebar(items: NavItem[], objectNames: Record<string, string>, appId: string, keep: string[] = DEFAULT_KEEP): SidebarPlan {
  const shared = items.filter((i) => !i.userWorkspaceId);
  const label = (i: NavItem) => i.name || objectNames[i.targetObjectMetadataId ?? ""] || i.type;
  const removable = new Set<string>();
  for (const i of shared) {
    if (i.applicationId === appId) continue;
    const isKeptObject = i.type === "OBJECT" && !i.parentId && keep.includes(objectNames[i.targetObjectMetadataId ?? ""] ?? "");
    if (!isKeptObject && !i.parentId) removable.add(i.id);
  }
  // Children of a removed folder go first, then the folder.
  const remove: SidebarPlan["remove"] = [];
  for (const i of shared) if (i.parentId && removable.has(i.parentId)) remove.push({ id: i.id, label: label(i) });
  for (const i of shared) if (removable.has(i.id)) remove.push({ id: i.id, label: label(i) });

  const section = shared.find((i) => i.applicationId === appId && i.type === "SECTION" && !i.parentId) ?? null;
  const others = shared.filter((i) => !i.parentId && i.id !== section?.id && !removable.has(i.id));
  const lowest = Math.min(0, ...others.map((i) => i.position ?? 0));
  const sectionToTop = section && (section.position ?? 0) >= lowest ? { id: section.id, position: lowest - 1 } : null;
  return { remove, sectionToTop };
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const { loadLocalEnv } = await import("../jev/env.ts");
  await loadLocalEnv();
  const { readFileSync } = await import("node:fs");
  const { repoPath } = await import("../repo-root.ts");
  try {
    for (const line of readFileSync(repoPath("state", "twenty", "keys.env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
  const url = (process.env.TWENTY_API_URL ?? "").replace(/\/+$/, "");
  const session = process.env.TWENTY_ADMIN_SESSION ?? "";
  if (!url || !session) { console.log(JSON.stringify({ ok: false, exit: 2, error: "needs TWENTY_API_URL and TWENTY_ADMIN_SESSION" })); return 2; }
  const { APPLICATION_UNIVERSAL_IDENTIFIER } = await import("../../twenty-app/src/constants/universal-identifiers.ts").catch(() => ({ APPLICATION_UNIVERSAL_IDENTIFIER: "" } as any));

  const gql = async (query: string, variables?: unknown) => {
    const r = await fetch(`${url}/metadata`, { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const j: any = await r.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    return j.data;
  };
  const items: NavItem[] = (await gql("{ navigationMenuItems { id type name position parentId applicationId userWorkspaceId targetObjectMetadataId } }")).navigationMenuItems;
  const objects = (await gql("{ objects(paging:{first:500}) { edges { node { id nameSingular } } } }")).objects.edges;
  const objectNames: Record<string, string> = Object.fromEntries(objects.map((e: any) => [e.node.id, e.node.nameSingular]));
  const apps = (await gql("{ findManyApplications { id universalIdentifier } }").catch(() => ({ findManyApplications: [] }))).findManyApplications ?? [];
  const appId = apps.find((a: any) => a.universalIdentifier === APPLICATION_UNIVERSAL_IDENTIFIER)?.id
    ?? items.find((i) => i.type === "SECTION" && !i.userWorkspaceId)?.applicationId ?? "";
  const keep = (process.env.SIDEBAR_KEEP ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const plan = planSidebar(items, objectNames, appId, keep.length ? keep : DEFAULT_KEEP);

  if (!apply) {
    const drift = plan.remove.length > 0 || plan.sectionToTop != null;
    console.log(JSON.stringify({ ok: !drift, exit: drift ? 1 : 0, remove: plan.remove.map((r) => r.label), sectionToTop: Boolean(plan.sectionToTop) }));
    return drift ? 1 : 0;
  }
  const done: string[] = [];
  for (const r of plan.remove) {
    await gql("mutation($id: UUID!){ deleteNavigationMenuItem(id: $id) { id } }", { id: r.id });
    done.push(`removed ${r.label}`);
  }
  if (plan.sectionToTop) {
    await gql("mutation($input: UpdateOneNavigationMenuItemInput!){ updateNavigationMenuItem(input: $input) { id position } }", { input: { id: plan.sectionToTop.id, update: { position: plan.sectionToTop.position } } });
    done.push("moved the suite section to the top");
  }
  console.log(JSON.stringify({ ok: true, exit: 0, actions: done }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.log(JSON.stringify({ ok: false, exit: 2, error: String(e?.message ?? e) })); process.exit(2); });
