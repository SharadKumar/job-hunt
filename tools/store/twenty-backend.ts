/**
 * twenty-backend.ts — the RowBackend over a Twenty workspace (plan F10).
 *
 * Each pipeline row is one `opening` record:
 *   - id is uuid5(namespace, "opening:<harnessId>"), so lookups need no search;
 *   - `harnessData` holds the full row, lossless; the other fields are its
 *     display projection for the person's views;
 *   - the JD lives in `jd` (markdown), outside harnessData, as SQLite kept it
 *     in its own table;
 *   - employer is a relation to a Company found or created by name.
 *
 * Status moves are compare-and-set (PATCH filtered on id and current status,
 * proved on 2.60.3 in V4(r)). Writes are batched (60 per request, V4(q)).
 * Removal is a soft delete (Twenty trash), so it can be restored.
 *
 * Config: TWENTY_API_URL and TWENTY_API_KEY from the environment, .env.local,
 * or the private state/twenty/keys.env.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Opportunity, PipelineStatus } from "../pipeline.ts";
import type { ListFilter } from "../pipeline-store.ts";
import { repoPath } from "../repo-root.ts";
import { loadLocalEnv } from "../jev/env.ts";
import { RowMissingError, StatusChangedError, type RowBackend, type RowPatch, type RowUpsert, type Transition } from "./backend.ts";

/** Fixed namespace for record ids derived from harness ids. */
export const ID_NAMESPACE = "0f5b8f3e-6d2a-4c7e-9a41-3b8c2d1e7f60";
const BATCH = 60;

export function uuid5(name: string, namespace = ID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const openingId = (harnessId: string) => uuid5(`opening:${harnessId}`);

const up = (v?: string | null) => (v ? v.toUpperCase() : null);
const down = (v?: string | null) => (v ? v.toLowerCase() : undefined);
const micros = (n?: number | null) => (n == null ? null : Math.round(n * 1_000_000));
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : null);

/** Postgres JSON refuses NUL characters and lone UTF-16 surrogates (half an emoji); scraped text carries both. */
export function stripNul<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") as unknown as T;
  if (Array.isArray(v)) return v.map((x) => stripNul(x)) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, stripNul(x)])) as T;
  return v;
}

export function webUrl(u?: string | null): string {
  if (!u) return "";
  try { const x = new URL(u.trim()); return x.protocol === "http:" || x.protocol === "https:" ? x.toString() : ""; } catch { return ""; }
}

/** The person-facing projection of a row, plus the lossless copy. */
export function toOpening(input: Opportunity): Record<string, unknown> {
  const row = stripNul(input);
  const { description, ...rest } = row as Opportunity & { description?: string };
  const currency = row.dayRate?.currency ?? "AUD";
  const out: Record<string, unknown> = {
    id: openingId(row.id),
    harnessId: row.id,
    title: row.title,
    channel: row.channel,
    // Twenty refuses a link that is not a web address; such a value still lives in harnessData.
    url: { primaryLinkUrl: webUrl(row.url), primaryLinkLabel: "", secondaryLinks: [] },
    location: row.location ?? null,
    arrangement: up(row.workArrangement),
    applyMethod: up(row.applyMethod),
    rateMin: row.dayRate?.min != null ? { amountMicros: micros(row.dayRate.min), currencyCode: currency } : null,
    rateMax: row.dayRate?.max != null ? { amountMicros: micros(row.dayRate.max), currencyCode: currency } : null,
    postedAt: day(row.postedAt),
    closesAt: day(row.closingDate),
    status: up(row.status),
    score: row.score ?? null,
    reasons: (row.scoreReasons ?? []).join("; ") || null,
    fit: (row.classification as any)?.discipline_fit ?? null,
    redFlags: ((row.classification as any)?.red_flags ?? []).join("; ") || null,
    redFlagBlocker: Boolean((row as any).red_flag_blocker),
    userSaved: Boolean(row.userSaved),
    parkedReason: row.parkedReason ?? null,
    parkedBy: up(row.parkedBy),
    duplicateGroup: row.duplicateGroup ?? null,
    classification: row.classification ?? null,
    submittedAt: row.submittedAt ?? null,
    harnessData: rest,
  };
  // Set once by the one-time migration and kept in harnessData for life, so
  // later writes never clear it and workflows keep skipping the record.
  if ((row as any).migratedAt) out.migratedAt = (row as any).migratedAt;
  if (description !== undefined) out.jd = { markdown: description ?? "", blocknote: null };
  return out;
}

export function fromOpening(rec: Record<string, any>, withDescription = false): Opportunity {
  const data = (rec.harnessData ?? {}) as Opportunity;
  const row: Opportunity = { ...data, id: data.id ?? rec.harnessId, status: (down(rec.status) ?? data.status) as PipelineStatus };
  if (withDescription) (row as any).description = rec.jd?.markdown ?? (data as any).description ?? undefined;
  return row;
}

export type TwentyConfig = { url: string; key: string };
type Config = TwentyConfig;

export async function twentyConfig(): Promise<Config> {
  await loadLocalEnv();
  try {
    const text = await fs.readFile(repoPath("state", "twenty", "keys.env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
  const url = (process.env.TWENTY_API_URL ?? "").replace(/\/+$/, "");
  const key = process.env.TWENTY_API_KEY ?? "";
  if (!url || !key) throw new Error("HARNESS_STORE=twenty needs TWENTY_API_URL and TWENTY_API_KEY (state/twenty/keys.env)");
  return { url, key };
}

/**
 * Whether repeating a request after a dropped connection or a gateway error is
 * safe: reads, updates and deletes are, and so is a create that carries its
 * own record ids (a repeat finds the record already there). A create without
 * ids is not retried, because the first attempt may have landed.
 */
export function safeToRepeat(method: string, body: unknown): boolean {
  if (method !== "POST") return true;
  const hasId = (x: unknown) => Boolean(x && typeof x === "object" && typeof (x as any).id === "string");
  return Array.isArray(body) ? body.length > 0 && body.every(hasId) : hasId(body);
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export function twentyClient(cfg: Config, fetchImpl: typeof fetch = fetch) {
  async function call(method: string, path: string, body?: unknown, attempt = 0): Promise<any> {
    const again = async (why: unknown) => {
      if (attempt >= 4 || !safeToRepeat(method, body)) throw why;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return call(method, path, body, attempt + 1);
    };
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // A dropped connection (ECONNRESET, a socket timeout) on the way to Twenty.
      return again(e);
    }
    if (RETRYABLE_STATUS.has(res.status)) return again(new Error(`Twenty ${method} ${path.split("?")[0]} ${res.status}`));
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return call(method, path, body, attempt + 1);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`Twenty ${method} ${path.split("?")[0]} ${res.status}: ${JSON.stringify(json.messages ?? json).slice(0, 200)}`);
    return json;
  }
  return { call };
}

export async function twentyBackend(opts: { config?: Config; fetchImpl?: typeof fetch } = {}): Promise<RowBackend> {
  const cfg = opts.config ?? (await twentyConfig());
  const { call } = twentyClient(cfg, opts.fetchImpl);
  const companyIds = new Map<string, string>();

  async function getRecord(id: string): Promise<Record<string, any> | null> {
    try {
      const j = await call("GET", `/rest/openings/${openingId(id)}`);
      return j.data?.opening ?? null;
    } catch (e: any) {
      if (/ 404:/.test(String(e?.message))) return null;
      throw e;
    }
  }

  async function companyFor(name?: string): Promise<string | null> {
    const key = (name ?? "").trim();
    if (!key) return null;
    const lower = key.toLowerCase();
    if (companyIds.has(lower)) return companyIds.get(lower)!;
    const id = uuid5(`company:${lower}`);
    try {
      await call("GET", `/rest/companies/${id}`);
    } catch (e: any) {
      if (!/ 404:/.test(String(e?.message))) throw e;
      await call("POST", "/rest/companies", { id, name: key });
    }
    companyIds.set(lower, id);
    return id;
  }

  async function writeMany(records: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < records.length; i += BATCH) {
      // Batch create with upsert on id: one request per 60 rows.
      await call("POST", "/rest/batch/openings?upsert=true", records.slice(i, i + BATCH));
    }
  }

  async function withEmployer(row: Opportunity): Promise<Record<string, unknown>> {
    const rec = toOpening(row);
    rec.employerId = await companyFor(row.company);
    return rec;
  }

  const backend: RowBackend = {
    name: "twenty",

    async has(id) { return (await getRecord(id)) != null; },

    async get(id, o) {
      const rec = await getRecord(id);
      return rec ? fromOpening(rec, o?.withDescription !== false) : null;
    },

    async list(filter: ListFilter = {}) {
      const parts: string[] = [];
      if (filter.status) parts.push(`status[eq]:${String(filter.status).toUpperCase()}`);
      if (filter.channel) parts.push(`channel[eq]:${filter.channel}`);
      if (filter.since) parts.push(`updatedAt[gte]:${filter.since}`);
      if (filter.firstSeenSince) parts.push(`createdAt[gte]:${filter.firstSeenSince}`);
      const f = parts.length ? `&filter=${encodeURIComponent(parts.length > 1 ? `and(${parts.join(",")})` : parts[0])}` : "";
      const out: Opportunity[] = [];
      let cursor = "";
      for (;;) {
        const j = await call("GET", `/rest/openings?limit=200&order_by=createdAt${f}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
        for (const rec of j.data?.openings ?? []) out.push(fromOpening(rec, Boolean(filter.withDescription)));
        const page = j.pageInfo ?? {};
        if (!page.hasNextPage || !page.endCursor) break;
        cursor = page.endCursor;
      }
      return out;
    },

    async ids() { return (await backend.list()).map((r) => r.id); },

    async upsert(ops: RowUpsert[]) {
      const out: Opportunity[] = [];
      const records: Record<string, unknown>[] = [];
      for (const op of ops) {
        if (op.kind === "insert") {
          records.push(await withEmployer(op.row));
          out.push(op.row);
          continue;
        }
        const current = await backend.get(op.id);
        if (!current) throw new RowMissingError(op.id);
        const merged = { ...current, ...op.fields, id: current.id, status: current.status, history: current.history } as Opportunity;
        records.push(await withEmployer(merged));
        out.push(merged);
      }
      await writeMany(records);
      return out;
    },

    async patch(entries: RowPatch[]) {
      const out: Opportunity[] = [];
      const records: Record<string, unknown>[] = [];
      for (const { id, fields, history } of entries) {
        const current = await backend.get(id);
        if (!current) throw new RowMissingError(id);
        const merged = { ...current, ...fields, id: current.id, status: current.status } as Opportunity;
        merged.history = [...(current.history ?? []), history(merged)];
        records.push(await withEmployer(merged));
        out.push(merged);
      }
      await writeMany(records);
      return out;
    },

    async transition(t: Transition) {
      const current = await backend.get(t.id);
      if (!current) throw new RowMissingError(t.id);
      if (current.status !== t.from) throw new StatusChangedError(t.id, t.from, current.status);
      const next = { ...current, ...t.extraFields, status: t.to, history: [...(current.history ?? []), t.history] } as Opportunity;
      const rec = toOpening(next);
      delete rec.id;
      const filter = encodeURIComponent(`and(id[eq]:${openingId(t.id)},status[eq]:${t.from.toUpperCase()})`);
      const j = await call("PATCH", `/rest/openings?filter=${filter}`, rec);
      const changed = j.data?.updateOpenings ?? [];
      if (!changed.length) {
        const now = await backend.get(t.id, { withDescription: false });
        if (!now) throw new RowMissingError(t.id);
        throw new StatusChangedError(t.id, t.from, now.status);
      }
      return next;
    },

    async remove(ids, history) {
      const removed: Opportunity[] = [];
      for (const id of ids) {
        const current = await backend.get(id, { withDescription: false });
        if (!current) continue;
        const entry = history(current);
        const rec = toOpening({ ...current, history: [...(current.history ?? []), entry] } as Opportunity);
        delete rec.id;
        await call("PATCH", `/rest/openings/${openingId(id)}`, rec);
        await call("DELETE", `/rest/openings/${openingId(id)}?soft_delete=true`);
        removed.push(current);
      }
      return removed;
    },

    async replaceAll() {
      throw new Error("pipeline.save (whole-set replace) is not supported on the Twenty store; use upsertMany, patchMany or remove.");
    },
  };
  return backend;
}
