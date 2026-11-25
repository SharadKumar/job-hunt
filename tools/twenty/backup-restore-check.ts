#!/usr/bin/env tsx
/**
 * backup-restore-check.ts: prove a workspace backup can be read back.
 *
 * Runs on the machine that holds the private key. Fetches the latest complete
 * snapshot (the newest daily/<date>/ with an ok.json) or the one named by
 * --date, decrypts it, checks that every NDJSON line parses and that the
 * record counts per object match the manifest, then decrypts a sample of the
 * backed-up files and checks each one's sha256 and size against the manifest.
 *
 * Optional: --into-url and --into-key restore the snapshot's non-system objects
 * into a disposable Twenty instance (batch create with upsert, ids preserved,
 * parents before children). Only a local instance is accepted.
 *
 * Env: R2_* as for backup.ts; AGE_IDENTITY (default ~/.config/age/job-hunt-backup.key);
 * AGE_BIN.
 *
 * Usage: tsx tools/twenty/backup-restore-check.ts [--date YYYY-MM-DD] [--sample N | --all]
 *          [--into-url http://localhost:PORT --into-key KEY [--objects a,b]]
 * Prints one JSON object. Exit 1 when any check fails.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadTwentyEnv, twentyClient } from "../store/twenty-backend.ts";
import { ageBin, ageDecryptor, forEachLimit, r2ConfigFromEnv, r2Store, redact, type Decrypt, type ObjectStore } from "./backup-io.ts";
import { attachmentKey, dailyPrefix, type Manifest, type ObjectMeta } from "./backup.ts";
import type { TwentyCall } from "./records.ts";

export type CheckArgs = { date: string; sample: number; all: boolean; intoUrl: string; intoKey: string; objects: string[] };

export function parseArgs(argv: string[]): CheckArgs {
  const out: CheckArgs = { date: "", sample: 10, all: false, intoUrl: "", intoKey: "", objects: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i] ?? "";
    else if (a === "--sample") out.sample = Number(argv[++i]);
    else if (a === "--all") out.all = true;
    else if (a === "--into-url") out.intoUrl = (argv[++i] ?? "").replace(/\/+$/, "");
    else if (a === "--into-key") out.intoKey = argv[++i] ?? "";
    else if (a === "--objects") out.objects = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error(`bad --date: ${out.date}`);
  if (!Number.isInteger(out.sample) || out.sample < 0) throw new Error("--sample needs a whole number");
  if (Boolean(out.intoUrl) !== Boolean(out.intoKey)) throw new Error("--into-url and --into-key go together");
  if (out.intoUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(out.intoUrl)) throw new Error("--into-url must be a local instance (http://localhost:PORT)");
  return out;
}

/** The newest daily snapshot with an ok.json. */
export async function latestDate(store: ObjectStore): Promise<string> {
  const { prefixes } = await store.list("daily/", "/");
  const dates = prefixes.map((p) => p.match(/^daily\/(\d{4}-\d{2}-\d{2})\/$/)?.[1]).filter((d): d is string => Boolean(d)).sort().reverse();
  for (const d of dates) if (await store.head(dailyPrefix(d) + "ok.json")) return d;
  throw new Error("no complete snapshot (no daily/<date>/ok.json) in the bucket");
}

export type Snapshot = { manifest: Manifest; metadata: ObjectMeta[]; records: Map<string, Record<string, any>[]> };

export async function readSnapshot(store: ObjectStore, decrypt: Decrypt, date: string): Promise<{ snapshot: Snapshot; problems: string[]; bytes: number }> {
  const problems: string[] = [];
  const mEnc = await store.get(dailyPrefix(date) + "manifest.json.age");
  const rEnc = await store.get(dailyPrefix(date) + "records.ndjson.gz.age");
  if (!mEnc || !rEnc) throw new Error(`snapshot ${date} is missing its ${!mEnc ? "manifest" : "records"}`);
  const manifest = JSON.parse((await decrypt(mEnc)).toString("utf8")) as Manifest;
  const gz = await decrypt(rEnc);
  if (manifest.recordsSha256 && createHash("sha256").update(gz).digest("hex") !== manifest.recordsSha256) problems.push("records archive sha256 differs from the manifest");
  const text = gunzipSync(gz).toString("utf8");
  const records = new Map<string, Record<string, any>[]>();
  let metadata: ObjectMeta[] = [];
  let n = 0;
  for (const line of text.split("\n")) {
    n++;
    if (!line) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { problems.push(`line ${n} does not parse`); continue; }
    if (row.object === "_metadata") { metadata = row.record?.objects ?? []; continue; }
    if (typeof row.object !== "string" || !row.record || typeof row.record !== "object") { problems.push(`line ${n} is not {object, record}`); continue; }
    const list = records.get(row.object) ?? [];
    list.push(row.record);
    records.set(row.object, list);
  }
  if (!metadata.length) problems.push("no metadata line");
  for (const [object, c] of Object.entries(manifest.objects)) {
    const got = records.get(object)?.length ?? 0;
    if (got !== c.records + c.deleted) problems.push(`${object}: ${got} records, manifest says ${c.records + c.deleted}`);
  }
  for (const object of records.keys()) if (!manifest.objects[object]) problems.push(`${object}: in the archive but not the manifest`);
  return { snapshot: { manifest, metadata, records }, problems, bytes: rEnc.length + mEnc.length };
}

export async function checkFiles(store: ObjectStore, decrypt: Decrypt, manifest: Manifest, opts: { sample: number; all: boolean; random?: () => number }): Promise<{ checked: number; problems: string[] }> {
  const pool = [...manifest.attachments];
  const random = opts.random ?? Math.random;
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const pick = opts.all ? pool : pool.slice(0, opts.sample);
  const problems: string[] = [];
  await forEachLimit(pick, 4, async (e) => {
    const enc = await store.get(attachmentKey(e.fileId));
    if (!enc) { problems.push(`file ${e.fileId} missing from the bucket`); return; }
    let plain: Buffer;
    try { plain = await decrypt(enc); } catch (err: any) { problems.push(`file ${e.fileId} does not decrypt: ${err?.message ?? err}`); return; }
    if (plain.length !== e.size) problems.push(`file ${e.fileId}: ${plain.length} bytes, manifest says ${e.size}`);
    else if (createHash("sha256").update(plain).digest("hex") !== e.sha256) problems.push(`file ${e.fileId}: sha256 differs`);
  });
  return { checked: pick.length, problems };
}

// --- restore into a disposable instance ------------------------------------------

const SKIP_TYPES = new Set(["RELATION", "MORPH_RELATION", "TS_VECTOR", "ACTOR", "POSITION"]);
const SKIP_FIELDS = new Set(["searchVector", "createdBy", "updatedBy", "position"]);

/** Parents before children, by MANY_TO_ONE relations among the chosen objects. */
export function restoreOrder(objects: ObjectMeta[]): ObjectMeta[] {
  const bySingular = new Map(objects.map((o) => [o.nameSingular, o]));
  const done = new Set<string>();
  const out: ObjectMeta[] = [];
  const visit = (o: ObjectMeta, stack: Set<string>) => {
    if (done.has(o.nameSingular) || stack.has(o.nameSingular)) return;
    stack.add(o.nameSingular);
    for (const f of o.fieldsList) {
      const target = f.type === "RELATION" && f.relation?.type === "MANY_TO_ONE" ? bySingular.get(f.relation.targetObjectMetadata?.nameSingular ?? "") : undefined;
      if (target && target !== o) visit(target, stack);
    }
    stack.delete(o.nameSingular);
    done.add(o.nameSingular);
    out.push(o);
  };
  for (const o of [...objects].sort((a, b) => a.namePlural.localeCompare(b.namePlural))) visit(o, new Set());
  return out;
}

/** The writable copy of a record for the target: scalar fields it knows, and foreign keys to restored objects. */
export function restorable(record: Record<string, any>, source: ObjectMeta, target: ObjectMeta, restored: Set<string>): Record<string, any> {
  const targetFields = new Map(target.fieldsList.map((f) => [f.name, f]));
  const out: Record<string, any> = { id: record.id };
  for (const f of source.fieldsList) {
    if (SKIP_FIELDS.has(f.name) || f.name === "id") continue;
    const t = targetFields.get(f.name);
    if (!t || t.type !== f.type) continue;
    if (f.type === "RELATION") {
      const fk = `${f.name}Id`;
      if (f.relation?.type === "MANY_TO_ONE" && restored.has(f.relation.targetObjectMetadata?.nameSingular ?? "") && fk in record) out[fk] = record[fk];
      continue;
    }
    if (SKIP_TYPES.has(f.type)) continue;
    if (f.type === "FILES") continue; // the file bytes are not in the target's storage
    if (f.name in record) out[f.name] = record[f.name];
  }
  return out;
}

export async function restoreInto(call: TwentyCall, snapshot: Snapshot, only: string[]): Promise<{ created: Record<string, number>; errors: string[] }> {
  const j = await call("POST", "/metadata", { query: "{ objects(paging: { first: 500 }) { edges { node { nameSingular namePlural isActive isSystem fieldsList { name type relation { type targetObjectMetadata { nameSingular } } } } } } }" });
  const target = new Map<string, ObjectMeta>((j.data?.objects?.edges ?? []).map((e: any) => [e.node.namePlural, e.node]));
  const chosen = snapshot.metadata.filter((o) => (only.length ? only.includes(o.namePlural) : !o.isSystem) && target.has(o.namePlural) && snapshot.records.has(o.namePlural));
  const restored = new Set(chosen.map((o) => o.nameSingular));
  const created: Record<string, number> = {};
  const errors: string[] = [];
  for (const o of restoreOrder(chosen)) {
    const rows = (snapshot.records.get(o.namePlural) ?? []).filter((r) => !r.deletedAt).map((r) => restorable(r, o, target.get(o.namePlural)!, restored));
    created[o.namePlural] = 0;
    for (let i = 0; i < rows.length; i += 60) {
      const batch = rows.slice(i, i + 60);
      try {
        await call("POST", `/rest/batch/${o.namePlural}?upsert=true`, batch);
        created[o.namePlural] += batch.length;
      } catch (e: any) {
        errors.push(`${o.namePlural} batch ${i / 60 + 1}: ${redact(String(e?.message ?? e)).slice(0, 200)}`);
      }
    }
  }
  return { created, errors };
}

// --- CLI ----------------------------------------------------------------------

export type CheckDeps = { store?: ObjectStore; decrypt?: Decrypt; intoCall?: TwentyCall };

export async function runCheck(argv: string[], deps: CheckDeps = {}): Promise<{ out: Record<string, unknown>; code: number }> {
  const args = parseArgs(argv);
  let store = deps.store;
  let decrypt = deps.decrypt;
  if (!store || !decrypt) {
    await loadTwentyEnv();
    const { config, missing } = r2ConfigFromEnv();
    if (!config) return { out: { ok: false, error: `R2 credentials not set (${missing.join(", ")})` }, code: 1 };
    store ??= r2Store(config);
    const identity = process.env.AGE_IDENTITY || path.join(os.homedir(), ".config", "age", "job-hunt-backup.key");
    decrypt ??= ageDecryptor(ageBin(), identity);
  }
  const date = args.date || (await latestDate(store));
  const { snapshot, problems, bytes } = await readSnapshot(store, decrypt, date);
  const files = await checkFiles(store, decrypt, snapshot.manifest, { sample: args.sample, all: args.all });
  const out: Record<string, unknown> = {
    ok: !problems.length && !files.problems.length,
    date,
    exportedAt: snapshot.manifest.exportedAt,
    records: snapshot.manifest.totalRecords,
    objects: Object.keys(snapshot.manifest.objects).length,
    encryptedBytes: bytes,
    attachments: snapshot.manifest.attachments.length,
    filesChecked: files.checked,
    problems: [...problems, ...files.problems].slice(0, 20),
  };
  if (args.intoUrl) {
    const call = deps.intoCall ?? twentyClient({ url: args.intoUrl, key: args.intoKey }).call;
    const r = await restoreInto(call, snapshot, args.objects);
    out.restored = r.created;
    if (r.errors.length) { out.restoreErrors = r.errors.slice(0, 10); out.ok = false; }
  }
  return { out, code: out.ok ? 0 : 1 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCheck(process.argv.slice(2)).then(({ out, code }) => {
    console.log(JSON.stringify(out));
    process.exit(code);
  }, (e) => {
    console.log(JSON.stringify({ ok: false, error: redact(String(e?.message ?? e)) }));
    process.exit(1);
  });
}
