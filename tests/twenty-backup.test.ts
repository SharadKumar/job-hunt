#!/usr/bin/env tsx
/**
 * twenty-backup.test.ts: the workspace backup with a fake Twenty, a fake object
 * store and a fake cipher. No network, no age binary, synthetic records only.
 *
 * Covers cursor pagination (live and trash), signed URLs stripped from the
 * export, files skipped when already in the bucket, the monthly copy on the
 * 1st, the missing-credentials skip, the per-day escalation on failure, its
 * resolution after a good run, and the R2 store's request shapes.
 */

import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attachmentKey, backupEscalationId, escalateFailure, main, runBackup, takeFiles,
} from "../tools/twenty/backup.ts";
import { pacer, r2ConfigFromEnv, r2Store, redact, type ObjectStore } from "../tools/twenty/backup-io.ts";
import { escalationRecordId } from "../tools/twenty/escalations.ts";

// --- fakes ------------------------------------------------------------------

const SIGNED = "https://files.example.test/file/abc?token=SECRET";

type Rec = Record<string, any>;
function fakeTwenty(data: Record<string, { live: Rec[]; trash?: Rec[] }>, opts: { forbidden?: string[]; system?: string[] } = {}) {
  const calls: string[] = [];
  const escalations = new Map<string, Rec>();
  const objects = Object.keys(data).map((plural) => ({
    nameSingular: plural.replace(/s$/, ""), namePlural: plural, isActive: true, isSystem: (opts.system ?? []).includes(plural),
    fieldsList: [{ name: "id", type: "UUID" }, ...(plural === "attachments" ? [{ name: "file", type: "FILES" }] : [])],
  }));
  const call = async (method: string, p: string, body?: any): Promise<any> => {
    calls.push(`${method} ${p}`);
    if (p === "/metadata") return { data: { objects: { edges: objects.map((node) => ({ node })) } } };
    const esc = p.match(/^\/rest\/escalations\/([^?]+)$/);
    if (esc && method === "GET") { if (!escalations.has(esc[1])) throw new Error(`Twenty GET /rest/escalations 404: not found`); return { data: { escalation: escalations.get(esc[1]) } }; }
    if (esc && method === "PATCH") { escalations.set(esc[1], { ...escalations.get(esc[1]), ...body }); return {}; }
    if (p === "/rest/escalations" && method === "POST") { escalations.set(body.id, body); return {}; }
    if (p.startsWith("/rest/escalations?")) return { data: { escalations: [...escalations.values()].filter((r) => r.kind === "backup" && r.status === "OPEN") } };
    const m = p.match(/^\/rest\/(\w+)\?(.*)$/);
    if (!m) throw new Error(`unexpected ${method} ${p}`);
    const [, plural, qs] = m;
    if ((opts.forbidden ?? []).includes(plural)) throw new Error(`Twenty GET /rest/${plural} 403: forbidden`);
    const q = new URLSearchParams(qs);
    const set = q.get("filter")?.includes("deletedAt") ? data[plural].trash ?? [] : data[plural].live;
    const limit = Number(q.get("limit"));
    const after = q.get("starting_after");
    const start = after ? Number(after) : 0;
    const slice = set.slice(start, start + limit).map((r) => structuredClone(r));
    const end = start + slice.length;
    return { data: { [plural]: slice }, totalCount: set.length, pageInfo: { hasNextPage: end < set.length, endCursor: String(end) } };
  };
  return { call, calls, escalations };
}

function fakeStore(existing: Record<string, Record<string, string>> = {}) {
  const objects = new Map<string, { body: Uint8Array; meta: Record<string, string> }>();
  for (const [k, meta] of Object.entries(existing)) objects.set(k, { body: new Uint8Array(), meta });
  const puts: string[] = [];
  const heads: string[] = [];
  const store: ObjectStore = {
    async head(key) { heads.push(key); return objects.get(key)?.meta ?? null; },
    async get(key) { const o = objects.get(key); return o ? Buffer.from(o.body) : null; },
    async put(key, body, o) { puts.push(key); objects.set(key, { body, meta: o?.meta ?? {} }); },
    async list() { return { keys: [...objects.keys()], prefixes: [] }; },
  };
  return { store, objects, puts, heads };
}

/** A reversible stand-in for age: a marker and the bytes reversed. */
const MARK = Buffer.from("FAKEAGE:");
const fakeEncrypt = async (b: Uint8Array) => Buffer.concat([MARK, Buffer.from(b).reverse()]);
const fakeDecrypt = (b: Uint8Array) => { const x = Buffer.from(b); assert.ok(x.subarray(0, MARK.length).equals(MARK)); return Buffer.from(x.subarray(MARK.length)).reverse(); };

const downloads: string[] = [];
const download = async (url: string) => { downloads.push(url); return new Response(Buffer.from(`bytes of ${new URL(url).searchParams.get("f")}`)); };

const companies = Array.from({ length: 450 }, (_, i) => ({ id: `c${i}`, name: `Company ${i}` }));
const attachment = (i: number) => ({ id: `a${i}`, name: `file ${i}`, file: [{ fileId: `f${i}`, label: `l${i}`, extension: ".pdf", url: `${SIGNED}&f=f${i}` }] });

// --- takeFiles strips URLs ---------------------------------------------------
{
  const rec: Rec = attachment(1);
  const refs = takeFiles("attachments", rec, ["file"]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].fileId, "f1");
  assert.equal(rec.file[0].url, undefined, "signed URL removed from the exported record");
  assert.equal(rec.file[0].label, "l1");
}

// --- pagination, trash, files, no monthly copy mid-month ------------------------
{
  const tw = fakeTwenty({
    companies: { live: companies, trash: [{ id: "cx", name: "Gone", deletedAt: "2026-11-01T00:00:00Z" }] },
    attachments: { live: [attachment(1), attachment(2), attachment(3)] },
    workflowRuns: { live: [] },
  }, { forbidden: ["workflowRuns"], system: ["workflowRuns", "attachments"] });
  const s = fakeStore({ [attachmentKey("f2")]: { sha256: "a".repeat(64), size: "42" } });
  downloads.length = 0;
  const r = await runBackup({ call: tw.call, download, encrypt: fakeEncrypt, store: s.store, now: new Date("2026-11-15T01:00:00Z"), timeZone: "UTC" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts.companies, 451, "450 live over three pages plus one in the trash");
  assert.equal(tw.calls.filter((c) => c.startsWith("GET /rest/companies?") && !c.includes("deletedAt")).length, 3, "200 a page");
  assert.equal(r.records, 453);
  assert.equal(r.deletedRecords, 1);
  assert.deepEqual(r.skippedObjects, { workflowRuns: "forbidden" });
  assert.equal(r.monthly, null);
  // f2 is already in the bucket: not downloaded, not uploaded, still listed.
  assert.equal(downloads.length, 2);
  assert.ok(!downloads.some((u) => u.includes("f=f2")));
  assert.deepEqual(s.puts.filter((k) => k.startsWith("attachments/")).sort(), [attachmentKey("f1"), attachmentKey("f3")]);
  assert.equal(r.attachments.existing, 1);
  assert.equal(r.attachments.uploaded, 2);
  assert.ok(s.objects.get(attachmentKey("f1"))!.meta.sha256.match(/^[0-9a-f]{64}$/));
  assert.deepEqual(s.puts.filter((k) => !k.startsWith("attachments/")), [
    "daily/2026-11-15/records.ndjson.gz.age", "daily/2026-11-15/manifest.json.age", "daily/2026-11-15/ok.json",
  ]);
  // The archive decrypts, parses, and carries no signed URL.
  const nd = gunzipSync(fakeDecrypt(s.objects.get("daily/2026-11-15/records.ndjson.gz.age")!.body)).toString("utf8");
  assert.ok(!nd.includes("SECRET"), "no signed URL in the archive");
  const lines = nd.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].object, "_metadata");
  assert.equal(lines.filter((l) => l.object === "companies").length, 451);
  const manifest = JSON.parse(fakeDecrypt(s.objects.get("daily/2026-11-15/manifest.json.age")!.body).toString("utf8"));
  assert.equal(manifest.totalRecords, 454);
  assert.equal(manifest.attachments.length, 3);
  assert.equal(manifest.attachments.find((a: any) => a.fileId === "f2").size, 42);
  const ok = JSON.parse(Buffer.from(s.objects.get("daily/2026-11-15/ok.json")!.body).toString("utf8"));
  assert.deepEqual(Object.keys(ok).sort(), ["attachmentBytes", "attachments", "exportedAt", "records"]);
}

// --- monthly copy on the 1st, by the local date ---------------------------------
{
  const tw = fakeTwenty({ companies: { live: companies.slice(0, 3) } });
  const s = fakeStore();
  // 14:00 UTC on 31 Oct is already 1 Nov in UTC+11.
  const r = await runBackup({ call: tw.call, download, encrypt: fakeEncrypt, store: s.store, now: new Date("2026-10-31T14:00:00Z"), timeZone: "Etc/GMT-11" });
  assert.equal(r.date, "2026-11-01");
  assert.equal(r.monthly, "monthly/2026-11/");
  assert.ok(s.puts.includes("monthly/2026-11/records.ndjson.gz.age"));
  assert.ok(s.puts.includes("monthly/2026-11/manifest.json.age"));
  assert.ok(!s.puts.includes("monthly/2026-11/ok.json"));
}

// --- a harness object the key cannot read fails the backup ----------------------
{
  const tw = fakeTwenty({ openings: { live: [] } }, { forbidden: ["openings"] });
  await assert.rejects(runBackup({ call: tw.call, download, encrypt: fakeEncrypt, store: fakeStore().store, now: new Date(), timeZone: "UTC" }), /403/);
}

// --- missing credentials or recipient: skip, exit 0, no Twenty call --------------
{
  let connected = false;
  const connect = async () => { connected = true; return fakeTwenty({}).call; };
  const a = await main([], { env: {}, connect, recipientFile: "/nonexistent/recipient.txt" });
  assert.equal(a.code, 0);
  assert.equal(a.out.ok, true);
  assert.match(String(a.out.skipped), /R2_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/);
  const env = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" };
  const b = await main([], { env, connect, recipientFile: "/nonexistent/recipient.txt" });
  assert.equal(b.code, 0);
  assert.match(String(b.out.skipped), /recipient/);
  assert.equal(connected, false);
}

// --- failure: one P2 escalation a day, closed by the next good run ---------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "backup-test-"));
  const recipientFile = path.join(dir, "recipient.txt");
  writeFileSync(recipientFile, "age1example\n");
  const env = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" };
  const tw = fakeTwenty({ companies: { live: companies.slice(0, 2) }, attachments: { live: [attachment(9)] } });
  const s = fakeStore();
  const broken = async () => { throw new Error(`connect failed for ${SIGNED}`); };
  const deps = { env, connect: async () => tw.call, store: () => s.store, encrypt: fakeEncrypt, timeZone: "UTC", recipientFile, pace: async () => {} };
  const now = new Date("2026-11-20T03:00:00Z");
  const r1 = await main([], { ...deps, now, download: broken });
  assert.equal(r1.code, 1);
  assert.equal(r1.out.ok, false);
  assert.equal(r1.out.escalated, true);
  assert.ok(!JSON.stringify(r1.out).includes("SECRET"), "signed URL redacted from the output");
  const id = backupEscalationId("2026-11-20");
  const rec = tw.escalations.get(id)!;
  assert.equal(rec.priority, "P2");
  assert.equal(rec.kind, "backup");
  assert.equal(rec.status, "OPEN");
  assert.equal(rec.dedupeKey, "backup:2026-11-20");
  assert.ok(!rec.reason.includes("SECRET"));
  assert.notEqual(id, escalationRecordId(rec.dedupeKey), "escalation sync must not treat it as one of its own and close it");
  assert.ok(!s.puts.includes("daily/2026-11-20/ok.json"), "no ok.json on a failed day");
  // Same day, fails again: no second record.
  const r2 = await main([], { ...deps, now: new Date("2026-11-20T09:00:00Z"), download: broken });
  assert.equal(r2.out.escalated, false);
  assert.equal(tw.escalations.size, 1);
  // A good run resolves it.
  const r3 = await main([], { ...deps, now: new Date("2026-11-21T03:00:00Z"), download });
  assert.equal(r3.code, 0, JSON.stringify(r3.out));
  assert.equal(r3.out.resolvedEscalations, 1);
  assert.equal(tw.escalations.get(id)!.status, "RESOLVED");
  // A failure before any export (metadata refused) escalates too.
  const failing = async (m: string, p: string, b?: any) => { if (p === "/metadata") throw new Error("Twenty POST /metadata 500: boom"); return tw.call(m, p, b); };
  const r4 = await main([], { ...deps, connect: async () => failing, now: new Date("2026-11-22T03:00:00Z"), download });
  assert.equal(r4.code, 1);
  assert.equal(r4.out.escalated, true);
  assert.ok(tw.escalations.has(backupEscalationId("2026-11-22")));
  assert.equal(await escalateFailure(tw.call, "2026-11-22", "again"), false);
}

// --- dry run writes encrypted files locally and uploads nothing ------------------
{
  const tw = fakeTwenty({ companies: { live: companies.slice(0, 5) } });
  let storeMade = false;
  const r = await main(["--dry-run", "--keep"], { env: {}, connect: async () => tw.call, store: () => { storeMade = true; return null; }, encrypt: fakeEncrypt, timeZone: "UTC", recipientFile: "/nonexistent", download, pace: async () => {}, now: new Date("2026-11-15T00:00:00Z") });
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(storeMade, false);
  assert.equal(r.out.uploaded, 0);
  assert.ok((r.out.sizes as any).recordsEncrypted > 0);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(path.join(String(r.out.dir), "daily/2026-11-15/records.ndjson.gz.age")));
}

// --- R2 store: signed requests, paths, metadata, list ----------------------------
{
  assert.deepEqual(r2ConfigFromEnv({}).missing, ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  const { config } = r2ConfigFromEnv({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" });
  assert.equal(config!.endpoint, "https://acct.r2.cloudflarestorage.com");
  assert.equal(config!.bucket, "job-hunt-backups");
  const seen: { method: string; url: string; auth: string | null; meta: string | null }[] = [];
  const fakeFetch = (async (req: Request) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.get("authorization"), meta: req.headers.get("x-amz-meta-sha256") });
    if (req.method === "HEAD") return req.url.endsWith("/missing.age") ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { "x-amz-meta-sha256": "abc", "x-amz-meta-size": "7" } });
    if (req.method === "GET" && req.url.includes("list-type=2")) {
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>daily/2026-11-20/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>daily/2026-11-21/</Prefix></CommonPrefixes></ListBucketResult>");
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const store = r2Store(config!, fakeFetch);
  assert.equal(await store.head("attachments/missing.age"), null);
  assert.deepEqual(await store.head("attachments/there.age"), { sha256: "abc", size: "7" });
  await store.put("attachments/x.age", Buffer.from("hi"), { meta: { sha256: "def" } });
  const put = seen.find((s) => s.method === "PUT")!;
  assert.equal(put.url, "https://acct.r2.cloudflarestorage.com/job-hunt-backups/attachments/x.age");
  assert.match(put.auth ?? "", /^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/auto\/s3\/aws4_request/);
  assert.equal(put.meta, "def");
  assert.deepEqual((await store.list("daily/", "/")).prefixes, ["daily/2026-11-20/", "daily/2026-11-21/"]);
}

// --- helpers -------------------------------------------------------------------
{
  assert.equal(redact(`GET ${SIGNED} failed`), "GET <url> failed");
  const slept: number[] = [];
  const p = pacer(100, async (ms) => { slept.push(ms); });
  await p.wait(); await p.wait(); await p.wait();
  assert.equal(p.count, 3);
  assert.equal(slept.length, 2, "the first call goes at once, the rest wait their turn");
}

console.log("twenty-backup: ok");
