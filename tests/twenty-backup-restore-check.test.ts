#!/usr/bin/env tsx
/**
 * twenty-backup-restore-check.test.ts: the restore check reads back what the
 * backup wrote, and catches a count mismatch, a corrupt file and a missing one.
 * Fake store, fake cipher, synthetic records. The real age round trip runs only
 * when an age binary is present.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachmentKey, runBackup, type ObjectMeta } from "../tools/twenty/backup.ts";
import { ageBin, ageDecryptor, ageEncryptor, type ObjectStore } from "../tools/twenty/backup-io.ts";
import { parseArgs, restorable, restoreOrder, runCheck } from "../tools/twenty/backup-restore-check.ts";

const MARK = Buffer.from("FAKEAGE:");
const encrypt = async (b: Uint8Array) => Buffer.concat([MARK, Buffer.from(b).reverse()]);
const decrypt = async (b: Uint8Array) => {
  const x = Buffer.from(b);
  if (!x.subarray(0, MARK.length).equals(MARK)) throw new Error("not ours");
  return Buffer.from(x.subarray(MARK.length)).reverse();
};

const objects: ObjectMeta[] = [
  { nameSingular: "company", namePlural: "companies", isActive: true, isSystem: false, fieldsList: [{ name: "id", type: "UUID" }, { name: "name", type: "TEXT" }, { name: "searchVector", type: "TS_VECTOR" }] },
  { nameSingular: "opening", namePlural: "openings", isActive: true, isSystem: false, fieldsList: [
    { name: "id", type: "UUID" }, { name: "title", type: "TEXT" },
    { name: "employer", type: "RELATION", relation: { type: "MANY_TO_ONE", targetObjectMetadata: { nameSingular: "company" } } },
    { name: "owner", type: "RELATION", relation: { type: "MANY_TO_ONE", targetObjectMetadata: { nameSingular: "workspaceMember" } } },
  ] },
  { nameSingular: "attachment", namePlural: "attachments", isActive: true, isSystem: true, fieldsList: [{ name: "id", type: "UUID" }, { name: "file", type: "FILES" }] },
];
const data: Record<string, Record<string, any>[]> = {
  companies: [{ id: "c1", name: "Acme", searchVector: "x" }, { id: "c2", name: "Globex", searchVector: "y" }],
  openings: [{ id: "o1", title: "Architect", employerId: "c1", ownerId: "m1" }],
  attachments: [1, 2, 3].map((i) => ({ id: `a${i}`, file: [{ fileId: `f${i}`, extension: ".md", url: `https://files.example.test/?f=f${i}` }] })),
};
const call = async (_m: string, p: string): Promise<any> => {
  if (p === "/metadata") return { data: { objects: { edges: objects.map((node) => ({ node })) } } };
  const m = p.match(/^\/rest\/(\w+)\?(.*)$/)!;
  const deleted = new URLSearchParams(m[2]).get("filter")?.includes("deletedAt");
  return { data: { [m[1]]: deleted ? [] : structuredClone(data[m[1]]) }, totalCount: data[m[1]].length, pageInfo: { hasNextPage: false } };
};
const blobs = new Map<string, Buffer>();
const store: ObjectStore = {
  async head(k) { return blobs.has(k) ? {} : null; },
  async get(k) { return blobs.get(k) ?? null; },
  async put(k, b) { blobs.set(k, Buffer.from(b)); },
  async list(prefix) { return { keys: [], prefixes: [...new Set([...blobs.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.split("/").slice(0, 2).join("/") + "/"))] }; },
};
const download = async (url: string) => new Response(`content of ${new URL(url).searchParams.get("f")}`);

await runBackup({ call, download, encrypt, store, now: new Date("2026-11-19T00:00:00Z"), timeZone: "UTC" });
await runBackup({ call, download, encrypt, store, now: new Date("2026-11-20T00:00:00Z"), timeZone: "UTC" });
blobs.delete("daily/2026-11-20/ok.json"); // the newest day is incomplete

// --- a good snapshot passes, and the latest complete day is chosen -------------
{
  const r = await runCheck(["--all"], { store, decrypt });
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.date, "2026-11-19");
  assert.equal(r.out.records, 6);
  assert.equal(r.out.filesChecked, 3);
}

// --- a corrupt file and a missing file are caught ---------------------------------
{
  blobs.set(attachmentKey("f1"), await encrypt(Buffer.from("tampered")));
  blobs.delete(attachmentKey("f2"));
  const r = await runCheck(["--date", "2026-11-19", "--all"], { store, decrypt });
  assert.equal(r.code, 1);
  const problems = (r.out.problems as string[]).join("\n");
  assert.match(problems, /file f1: \d+ bytes, manifest says/);
  assert.match(problems, /file f2 missing/);
}

// --- a count that differs from the manifest is caught ------------------------------
{
  const key = "daily/2026-11-19/manifest.json.age";
  const manifest = JSON.parse((await decrypt(blobs.get(key)!)).toString("utf8"));
  manifest.objects.companies.records = 3;
  blobs.set(key, await encrypt(Buffer.from(JSON.stringify(manifest))));
  const r = await runCheck(["--date", "2026-11-19", "--sample", "0"], { store, decrypt });
  assert.equal(r.code, 1);
  assert.match((r.out.problems as string[]).join("\n"), /companies: 2 records, manifest says 3/);
}

// --- restore: order, writable fields, batches with ids ------------------------------
{
  assert.deepEqual(restoreOrder([objects[1], objects[0]]).map((o) => o.namePlural), ["companies", "openings"]);
  const restored = new Set(["company", "opening"]);
  assert.deepEqual(restorable(data.openings[0], objects[1], objects[1], restored), { id: "o1", title: "Architect", employerId: "c1" }, "a key to an object not restored is dropped");
  assert.deepEqual(restorable(data.companies[0], objects[0], objects[0], restored), { id: "c1", name: "Acme" });
  const posts: { path: string; body: any[] }[] = [];
  const into = async (_m: string, p: string, b?: any): Promise<any> => {
    if (p === "/metadata") return { data: { objects: { edges: objects.map((node) => ({ node })) } } };
    posts.push({ path: p, body: b });
    return {};
  };
  // Restore the 20th, whose snapshot is untouched.
  const r = await runCheck(["--date", "2026-11-20", "--sample", "0", "--into-url", "http://localhost:3999", "--into-key", "k"], { store, decrypt, intoCall: into });
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.restored, { companies: 2, openings: 1 });
  assert.deepEqual(posts.map((p) => p.path), ["/rest/batch/companies?upsert=true", "/rest/batch/openings?upsert=true"]);
}
{
  assert.throws(() => parseArgs(["--into-url", "https://example.com", "--into-key", "k"]), /local instance/);
  assert.throws(() => parseArgs(["--into-url", "http://localhost:3000"]), /go together/);
}

// --- real age round trip, when the binary is here ---------------------------------
{
  const bin = ageBin();
  const keygen = path.join(path.dirname(bin), "age-keygen");
  if (existsSync(bin) && existsSync(keygen)) {
    const dir = mkdtempSync(path.join(tmpdir(), "age-test-"));
    const identity = path.join(dir, "key.txt");
    execFileSync(keygen, ["-o", identity], { stdio: "ignore" });
    const pub = readFileSync(identity, "utf8").match(/public key: (age1\S+)/)![1];
    const recipients = path.join(dir, "recipients.txt");
    (await import("node:fs")).writeFileSync(recipients, `# test\n${pub}\n`);
    const plain = Buffer.from("synthetic payload");
    const enc = await ageEncryptor(bin, recipients)(plain);
    assert.ok(!enc.includes(plain));
    assert.deepEqual(await ageDecryptor(bin, identity)(enc), plain);
  } else {
    console.log("twenty-backup-restore-check: age round trip skipped (no age binary)");
  }
}

console.log("twenty-backup-restore-check: ok");
