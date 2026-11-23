/**
 * records.ts: small REST helpers shared by the tools/twenty/<verb>.ts tools.
 */

import { twentyClient, twentyConfig, type TwentyConfig } from "../store/twenty-backend.ts";

export type TwentyCall = ReturnType<typeof twentyClient>["call"];

/** A REST caller for the configured workspace, or for an explicit one (tests). */
export async function connect(cfg?: TwentyConfig, fetchImpl?: typeof fetch): Promise<TwentyCall> {
  return twentyClient(cfg ?? (await twentyConfig()), fetchImpl).call;
}

/** Every record of one object that matches a REST filter, following the cursor. */
export async function listAll(call: TwentyCall, plural: string, filter?: string): Promise<Record<string, any>[]> {
  const f = filter ? `&filter=${encodeURIComponent(filter)}` : "";
  const out: Record<string, any>[] = [];
  let cursor = "";
  for (;;) {
    const j = await call("GET", `/rest/${plural}?limit=200&order_by=createdAt${f}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(j.data?.[plural] ?? []));
    const page = j.pageInfo ?? {};
    if (!page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }
  return out;
}

/** The `id[in]:[...]` filter, chunked so a URL stays short. */
export async function getByIds(call: TwentyCall, plural: string, ids: string[]): Promise<Map<string, Record<string, any>>> {
  const out = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    for (const rec of await listAll(call, plural, `id[in]:[${chunk.join(",")}]`)) out.set(rec.id, rec);
  }
  return out;
}

/** The record URL the person opens in Twenty. */
export function recordUrl(publicUrl: string, objectSingular: string, id: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/object/${objectSingular}/${id}`;
}
