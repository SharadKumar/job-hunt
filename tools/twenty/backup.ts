#!/usr/bin/env tsx
/**
 * backup.ts: an encrypted, off-site backup of the Twenty workspace.
 *
 * The server is run by an operator, so this is an API export, not a database
 * dump:
 *   1. read the object and field metadata, then every record of every active
 *      object (live and in the trash) by cursor pagination, 200 a page, paced
 *      under the instance's rate limit;
 *   2. write NDJSON lines `{object, record}` (the first line is the metadata,
 *      object "_metadata"), gzip them in memory and encrypt with `age` to the
 *      recipients in state/twenty/backup-recipient.txt;
 *   3. upload to R2 (S3 API): daily/<date>/records.ndjson.gz.age and
 *      daily/<date>/manifest.json.age, a copy under monthly/<YYYY-MM>/ on the
 *      1st, and last a plaintext daily/<date>/ok.json holding only the time and
 *      the totals;
 *   4. back up every file a FILES field points at (attachments, avatars) once,
 *      content-addressed as attachments/<fileId>.age. A key already in the
 *      bucket is skipped (HEAD); its plaintext sha256 and size travel as object
 *      metadata so the manifest lists every file without downloading it again.
 *
 * Signed download URLs are stripped from the exported records and never
 * logged. Dates are the profile's local date (BACKUP_TIMEZONE overrides).
 *
 * Without R2 credentials or the recipient file it prints `skipped` and exits 0,
 * so the schedule stays quiet until setup. Any real failure exits 1 and raises
 * one P2 escalation per day (kind "backup"); a later success resolves it.
 *
 * Usage: tsx tools/twenty/backup.ts [--dry-run] [--keep]
 *   --dry-run  export and encrypt into a temp dir, print sizes, upload nothing.
 *              With no recipient file it encrypts to a throwaway key.
 * Prints one JSON object.
 */

import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { loadTwentyEnv, uuid5 } from "../store/twenty-backend.ts";
import { repoPath } from "../repo-root.ts";
import type { TwentyCall } from "./records.ts";
import {
  ageBin, ageEncryptor, forEachLimit, localDate, pacer, pipeThrough, r2ConfigFromEnv, r2Store, redact,
  type Encrypt, type ObjectStore,
} from "./backup-io.ts";

export const TOOL = "twenty-backup";
export const TOOL_VERSION = "1";
export const PAGE = 200;
/** 1000 requests a minute is the instance limit; stay well under it. */
export const TWENTY_GAP_MS = 75;

export const METADATA_QUERY = `{ objects(paging: { first: 500 }) { edges { node {
  id nameSingular namePlural labelSingular labelPlural isActive isSystem
  fieldsList { id name label type isActive isSystem isNullable defaultValue options settings
    relation { type targetObjectMetadata { nameSingular namePlural } targetFieldMetadata { name } } }
} } } }`;

export type FieldMeta = { name: string; type: string; relation?: { type?: string; targetObjectMetadata?: { nameSingular?: string; namePlural?: string } } | null; [k: string]: unknown };
export type ObjectMeta = { nameSingular: string; namePlural: string; isActive: boolean; isSystem: boolean; fieldsList: FieldMeta[]; [k: string]: unknown };

export type FileRef = { fileId: string; extension: string | null; url: string; object: string; recordId: string; field: string };
export type FileEntry = { fileId: string; sha256: string; size: number; extension: string | null };

export type ObjectCount = { records: number; deleted: number; totalCount: number | null };

export type Manifest = {
  tool: string;
  toolVersion: string;
  format: 1;
  exportedAt: string;
  date: string;
  totalRecords: number;
  objects: Record<string, ObjectCount>;
  skippedObjects: Record<string, string>;
  attachments: FileEntry[];
  attachmentBytes: number;
  recordsSha256: string;
};

export type BackupDeps = {
  call: TwentyCall;
  /** Fetch for signed file downloads (no Twenty auth header). */
  download: (url: string) => Promise<Response>;
  encrypt: Encrypt;
  /** null in a dry run. */
  store: ObjectStore | null;
  now: Date;
  timeZone: string;
  /** Where a dry run writes its encrypted files. */
  outDir?: string;
  /** Called before each request to Twenty (records and downloads). */
  pace?: () => Promise<void>;
  concurrency?: number;
};

export type BackupResult = {
  date: string;
  monthly: string | null;
  objects: number;
  records: number;
  deletedRecords: number;
  counts: Record<string, number>;
  skippedObjects: Record<string, string>;
  attachments: { count: number; bytes: number; encryptedBytes: number; uploaded: number; existing: number; failed: number };
  sizes: { ndjson: number; gzip: number; recordsEncrypted: number; manifestEncrypted: number };
  errors: string[];
  keys: string[];
};

export async function fetchMetadata(call: TwentyCall): Promise<ObjectMeta[]> {
  const j = await call("POST", "/metadata", { query: METADATA_QUERY });
  if (j.errors?.length) throw new Error(`Twenty metadata: ${String(j.errors[0]?.message ?? "error").slice(0, 200)}`);
  return (j.data?.objects?.edges ?? []).map((e: any) => e.node as ObjectMeta);
}

/** Drop signed URLs from FILES values in place and return the file references found. */
export function takeFiles(object: string, record: Record<string, any>, fileFields: string[]): FileRef[] {
  const refs: FileRef[] = [];
  for (const field of fileFields) {
    const v = record[field];
    if (!Array.isArray(v)) continue;
    record[field] = v.map((f: any) => {
      if (!f || typeof f !== "object") return f;
      const { url, ...rest } = f;
      if (typeof f.fileId === "string" && f.fileId) refs.push({ fileId: f.fileId, extension: f.extension ?? null, url: typeof url === "string" ? url : "", object, recordId: record.id, field });
      return rest;
    });
  }
  return refs;
}

const isForbidden = (e: unknown) => / 403:/.test(String((e as any)?.message ?? e));

/** Every record of one object matching an optional filter, page by page. */
async function* pages(call: TwentyCall, plural: string, filter: string | null, pace: () => Promise<void>): AsyncGenerator<{ records: Record<string, any>[]; totalCount: number | null }> {
  const f = filter ? `&filter=${encodeURIComponent(filter)}` : "";
  let cursor = "";
  for (;;) {
    await pace();
    const j = await call("GET", `/rest/${plural}?limit=${PAGE}&order_by=createdAt${f}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    yield { records: j.data?.[plural] ?? [], totalCount: typeof j.totalCount === "number" ? j.totalCount : null };
    const page = j.pageInfo ?? {};
    if (!page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export const dailyPrefix = (date: string) => `daily/${date}/`;
export const monthlyPrefix = (date: string) => `monthly/${date.slice(0, 7)}/`;
export const attachmentKey = (fileId: string) => `attachments/${fileId}.age`;

export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const pace = deps.pace ?? (async () => {});
  const date = localDate(deps.now, deps.timeZone);
  const monthly = date.endsWith("-01") ? monthlyPrefix(date) : null;
  const errors: string[] = [];

  await pace();
  const meta = (await fetchMetadata(deps.call)).filter((o) => o.isActive).sort((a, b) => a.namePlural.localeCompare(b.namePlural));

  // NDJSON through gzip, held in memory: plaintext never touches the disk.
  const gzip = createGzip({ level: 9 });
  const gzChunks: Buffer[] = [];
  gzip.on("data", (c: Buffer) => gzChunks.push(c));
  const gzDone = new Promise<void>((resolve, reject) => { gzip.on("end", resolve); gzip.on("error", reject); });
  let ndjsonBytes = 0;
  const write = async (line: string) => {
    const b = Buffer.from(line + "\n", "utf8");
    ndjsonBytes += b.length;
    if (!gzip.write(b)) await new Promise((r) => gzip.once("drain", r));
  };

  await write(JSON.stringify({ object: "_metadata", record: { exportedAt: deps.now.toISOString(), objects: meta } }));

  const objects: Record<string, ObjectCount> = {};
  const skippedObjects: Record<string, string> = {};
  const files = new Map<string, FileRef>();
  for (const o of meta) {
    const fileFields = o.fieldsList.filter((f) => f.type === "FILES").map((f) => f.name);
    const count: ObjectCount = { records: 0, deleted: 0, totalCount: null };
    try {
      for (const [filter, key] of [[null, "records"], ["deletedAt[is]:NOT_NULL", "deleted"]] as const) {
        for await (const page of pages(deps.call, o.namePlural, filter, pace)) {
          if (filter === null && count.totalCount === null) count.totalCount = page.totalCount;
          for (const record of page.records) {
            for (const ref of takeFiles(o.namePlural, record, fileFields)) if (!files.has(ref.fileId)) files.set(ref.fileId, ref);
            await write(JSON.stringify({ object: o.namePlural, record }));
            count[key]++;
          }
        }
      }
    } catch (e) {
      // The harness key cannot read some of Twenty's own system objects; that
      // is expected. A harness object it cannot read is a failed backup.
      if (isForbidden(e) && o.isSystem && count.records === 0) { skippedObjects[o.namePlural] = "forbidden"; continue; }
      throw e;
    }
    objects[o.namePlural] = count;
  }
  gzip.end();
  await gzDone;
  const gz = Buffer.concat(gzChunks);

  // Files: back up each one once.
  const entries: FileEntry[] = [];
  let uploaded = 0, existing = 0, encryptedBytes = 0;
  await forEachLimit([...files.values()], deps.concurrency ?? 4, async (ref) => {
    try {
      const key = attachmentKey(ref.fileId);
      if (deps.store) {
        const head = await deps.store.head(key);
        if (head && head.sha256 && head.size) {
          entries.push({ fileId: ref.fileId, sha256: head.sha256, size: Number(head.size), extension: ref.extension });
          existing++;
          return;
        }
      }
      const bytes = await downloadFile(deps, ref, pace);
      const entry: FileEntry = { fileId: ref.fileId, sha256: sha256(bytes), size: bytes.length, extension: ref.extension };
      const enc = await deps.encrypt(bytes);
      encryptedBytes += enc.length;
      if (deps.store) {
        await deps.store.put(key, enc, { meta: { sha256: entry.sha256, size: String(entry.size) } });
        uploaded++;
      }
      entries.push(entry);
    } catch (e: any) {
      errors.push(redact(`file ${ref.fileId}: ${e?.message ?? e}`).slice(0, 300));
    }
  });
  entries.sort((a, b) => a.fileId.localeCompare(b.fileId));

  const totalRecords = Object.values(objects).reduce((n, c) => n + c.records + c.deleted, 0);
  const manifest: Manifest = {
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    format: 1,
    exportedAt: deps.now.toISOString(),
    date,
    totalRecords,
    objects,
    skippedObjects,
    attachments: entries,
    attachmentBytes: entries.reduce((n, e) => n + e.size, 0),
    recordsSha256: sha256(gz),
  };
  const recordsEnc = await deps.encrypt(gz);
  const manifestEnc = await deps.encrypt(Buffer.from(JSON.stringify(manifest), "utf8"));
  const ok = { exportedAt: manifest.exportedAt, records: totalRecords, attachments: entries.length, attachmentBytes: manifest.attachmentBytes };

  const keys: string[] = [];
  const outputs: [string, Uint8Array, string][] = [
    ["records.ndjson.gz.age", recordsEnc, "application/octet-stream"],
    ["manifest.json.age", manifestEnc, "application/octet-stream"],
  ];
  if (deps.store) {
    for (const prefix of [dailyPrefix(date), ...(monthly ? [monthly] : [])]) {
      for (const [name, body, type] of outputs) { await deps.store.put(prefix + name, body, { contentType: type }); keys.push(prefix + name); }
    }
    // ok.json is written last and only when nothing failed: its presence says the day is complete.
    if (!errors.length) {
      await deps.store.put(dailyPrefix(date) + "ok.json", Buffer.from(JSON.stringify(ok), "utf8"), { contentType: "application/json" });
      keys.push(dailyPrefix(date) + "ok.json");
    }
  } else if (deps.outDir) {
    const dir = path.join(deps.outDir, dailyPrefix(date));
    await fs.mkdir(dir, { recursive: true });
    for (const [name, body] of outputs) await fs.writeFile(path.join(dir, name), body);
    await fs.writeFile(path.join(dir, "ok.json"), JSON.stringify(ok));
  }

  return {
    date,
    monthly,
    objects: Object.keys(objects).length,
    records: Object.values(objects).reduce((n, c) => n + c.records, 0),
    deletedRecords: Object.values(objects).reduce((n, c) => n + c.deleted, 0),
    counts: Object.fromEntries(Object.entries(objects).filter(([, c]) => c.records + c.deleted > 0).map(([k, c]) => [k, c.records + c.deleted])),
    skippedObjects,
    attachments: { count: entries.length, bytes: manifest.attachmentBytes, encryptedBytes, uploaded, existing, failed: files.size - entries.length },
    sizes: { ndjson: ndjsonBytes, gzip: gz.length, recordsEncrypted: recordsEnc.length, manifestEncrypted: manifestEnc.length },
    errors,
    keys,
  };
}

/** Download a file by its signed URL; an expired link is refreshed once from its record. */
async function downloadFile(deps: BackupDeps, ref: FileRef, pace: () => Promise<void>): Promise<Buffer> {
  let url = ref.url;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (url) {
      await pace();
      const res = await deps.download(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      await res.arrayBuffer().catch(() => undefined);
      if (![401, 403, 404].includes(res.status) || attempt > 0) throw new Error(`download ${res.status}`);
    }
    await pace();
    const j = await deps.call("GET", `/rest/${ref.object}/${ref.recordId}`);
    const rec = Object.values(j.data ?? {})[0] as Record<string, any> | undefined;
    const fresh = (rec?.[ref.field] ?? []).find((f: any) => f?.fileId === ref.fileId)?.url;
    if (!fresh) throw new Error("no download link on the record");
    url = fresh;
  }
  throw new Error("download failed");
}

// --- escalation ---------------------------------------------------------------

export const backupEscalationKey = (date: string) => `backup:${date}`;
/**
 * Not escalationRecordId(dedupeKey): escalation sync closes any record whose id
 * is derived that way once the run's summary stops listing it, and the summary
 * never lists a backup failure. This record stays open until a backup succeeds
 * or the person closes it.
 */
export const backupEscalationId = (date: string) => uuid5(`backup-escalation:${date}`);

/** Raise the day's backup failure once. Returns whether a record was created. */
export async function escalateFailure(call: TwentyCall, date: string, error: string, notifyMemberId: string | null = null): Promise<boolean> {
  const id = backupEscalationId(date);
  try {
    await call("GET", `/rest/escalations/${id}`);
    return false;
  } catch (e: any) {
    if (!/ 404:/.test(String(e?.message))) throw e;
  }
  await call("POST", "/rest/escalations", {
    id,
    name: `Workspace backup failed on ${date}`,
    kind: "backup",
    priority: "P2",
    dedupeKey: backupEscalationKey(date),
    reason: redact(error).slice(0, 500),
    action: "Read the backup log under state/logs/backup, fix the cause, then run npm run twenty:backup",
    status: "OPEN",
    notifyMemberId,
  });
  return true;
}

/** Close open backup escalations after a good backup. */
export async function resolveEscalations(call: TwentyCall, now: Date): Promise<number> {
  const j = await call("GET", `/rest/escalations?limit=${PAGE}&filter=${encodeURIComponent("and(kind[eq]:backup,status[eq]:OPEN)")}`);
  const open: Record<string, any>[] = j.data?.escalations ?? [];
  for (const r of open) await call("PATCH", `/rest/escalations/${r.id}`, { status: "RESOLVED", resolvedAt: now.toISOString(), reason: `${r.reason ?? ""} Resolved: a later backup succeeded.`.trim().slice(0, 500) });
  return open.length;
}

// --- CLI ----------------------------------------------------------------------

export const recipientPath = () => repoPath("state", "twenty", "backup-recipient.txt");

export type MainDeps = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  connect?: () => Promise<TwentyCall>;
  store?: (env: NodeJS.ProcessEnv) => ObjectStore | null;
  encrypt?: Encrypt;
  download?: (url: string) => Promise<Response>;
  timeZone?: string;
  recipientFile?: string;
  tmpDir?: string;
  pace?: () => Promise<void>;
};

async function timeZoneFor(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.BACKUP_TIMEZONE) return env.BACKUP_TIMEZONE;
  const { loadLocale } = await import("../profile.ts");
  return (await loadLocale()).timezone;
}

/** The whole tool, injectable. Returns the JSON to print and the exit code. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<{ out: Record<string, unknown>; code: number }> {
  const dryRun = argv.includes("--dry-run");
  const keep = argv.includes("--keep");
  for (const a of argv) if (a !== "--dry-run" && a !== "--keep") return { out: { ok: false, error: `unknown argument: ${a}` }, code: 2 };
  if (!deps.env) await loadTwentyEnv();
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const recipientFile = deps.recipientFile ?? recipientPath();
  const hasRecipient = existsSync(recipientFile);

  if (!dryRun) {
    const { missing } = r2ConfigFromEnv(env);
    if (missing.length) return { out: { ok: true, skipped: `R2 credentials not set (${missing.join(", ")})` }, code: 0 };
    if (!hasRecipient) return { out: { ok: true, skipped: "no backup recipient (state/twenty/backup-recipient.txt)" }, code: 0 };
  }

  const started = Date.now();
  let call: TwentyCall | null = null;
  let date = "";
  let tmp: string | null = null;
  try {
    const timeZone = deps.timeZone ?? (await timeZoneFor(env));
    date = localDate(now, timeZone);
    call = await (deps.connect ?? (async () => (await import("./records.ts")).connect()))();
    let encrypt = deps.encrypt;
    let recipient = "file";
    if (dryRun) tmp = await fs.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), "twenty-backup-"));
    if (!encrypt) {
      const bin = ageBin(env);
      let file = recipientFile;
      if (!hasRecipient) {
        // Dry run only: a throwaway key so the sizes are real.
        const keygen = path.join(path.dirname(bin), "age-keygen");
        const out = (await pipeThrough(existsSync(keygen) ? keygen : "age-keygen", [], new Uint8Array())).toString("utf8");
        const pub = out.match(/^# public key: (age1\S+)/m)?.[1] ?? out.match(/^(age1\S+)/m)?.[1];
        if (!pub) throw new Error("age-keygen gave no public key");
        file = path.join(tmp!, "ephemeral-recipient.txt");
        await fs.writeFile(file, pub + "\n");
        recipient = "ephemeral";
      }
      encrypt = ageEncryptor(bin, file);
    }
    const store = dryRun ? null : (deps.store ?? ((e) => r2Store(r2ConfigFromEnv(e).config!)))(env);
    const gate = pacer(TWENTY_GAP_MS);
    const result = await runBackup({
      call,
      download: deps.download ?? ((url) => fetch(url, { signal: AbortSignal.timeout(60_000) })),
      encrypt,
      store,
      now,
      timeZone,
      outDir: tmp ?? undefined,
      pace: deps.pace ?? gate.wait,
    });
    const { keys, errors, ...rest } = result;
    const durationMs = Date.now() - started;
    if (errors.length) {
      const error = `${errors.length} file${errors.length === 1 ? "" : "s"} not backed up; first: ${errors[0]}`;
      const escalated = dryRun ? false : await escalateFailure(call, date, error, env.TWENTY_OWNER_MEMBER_ID || null).catch(() => false);
      return { out: { ok: false, dryRun, ...rest, error, errors: errors.slice(0, 5), escalated, durationMs }, code: 1 };
    }
    const resolved = dryRun ? 0 : await resolveEscalations(call, now).catch(() => 0);
    const out: Record<string, unknown> = { ok: true, dryRun, ...rest, uploaded: keys.length, resolvedEscalations: resolved, durationMs };
    if (dryRun) { out.recipient = recipient; if (keep) out.dir = tmp; }
    return { out, code: 0 };
  } catch (e: any) {
    const error = redact(String(e?.message ?? e)).slice(0, 500);
    let escalated = false;
    if (call && !dryRun) escalated = await escalateFailure(call, date || localDate(now, "UTC"), error, env.TWENTY_OWNER_MEMBER_ID || null).catch(() => false);
    return { out: { ok: false, dryRun, error, escalated }, code: 1 };
  } finally {
    if (tmp && !keep) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(({ out, code }) => {
    console.log(JSON.stringify(out));
    process.exit(code);
  }, (e) => {
    console.log(JSON.stringify({ ok: false, error: redact(String(e?.message ?? e)) }));
    process.exit(1);
  });
}
