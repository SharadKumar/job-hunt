/**
 * backup-io.ts: the pieces the workspace backup and its restore check share.
 *
 *   - an S3-compatible object store (Cloudflare R2) signed with SigV4 through
 *     aws4fetch: head, get, put and list;
 *   - age encryption and decryption through the `age` binary (AGE_BIN, else
 *     /opt/homebrew/bin/age, else `age` on PATH);
 *   - a pacer that keeps requests under the Twenty instance's rate limit;
 *   - redaction, so a signed URL never reaches a log or an escalation.
 *
 * Config (environment, .env.local, or state/twenty/keys.env):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default
 *   job-hunt-backups), R2_ENDPOINT (optional, overrides the account endpoint).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { AwsClient } from "aws4fetch";

export const DEFAULT_BUCKET = "job-hunt-backups";

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

/** The R2 settings from the environment, or the names of the ones missing. */
export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { config: R2Config | null; missing: string[] } {
  const missing = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID) missing.unshift("R2_ACCOUNT_ID");
  if (missing.length) return { config: null, missing };
  const endpoint = (env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
  return { config: { endpoint, bucket: env.R2_BUCKET || DEFAULT_BUCKET, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! }, missing: [] };
}

export type PutOptions = { contentType?: string; meta?: Record<string, string> };

export interface ObjectStore {
  /** The object's user metadata (x-amz-meta-*, lowercased, prefix removed), or null when it does not exist. */
  head(key: string): Promise<Record<string, string> | null>;
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void>;
  /** Keys and common prefixes under a prefix (one level when delimiter is set). */
  list(prefix: string, delimiter?: string): Promise<{ keys: string[]; prefixes: string[] }>;
}

const xmlValues = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => decodeXml(m[1]));
const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** An ObjectStore over the S3 API. fetchImpl receives already-signed requests. */
export function r2Store(cfg: R2Config, fetchImpl: typeof fetch = fetch): ObjectStore {
  const aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: "auto" });
  const objectUrl = (key: string) => `${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  async function send(method: string, url: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}, attempt = 0): Promise<Response> {
    const req = await aws.sign(url, { method, body: init.body as BodyInit | undefined, headers: init.headers });
    let res: Response;
    try {
      res = await fetchImpl(req);
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return send(method, url, init, attempt + 1);
    }
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await res.arrayBuffer().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return send(method, url, init, attempt + 1);
    }
    return res;
  }
  const fail = async (what: string, key: string, res: Response) => {
    const text = await res.text().catch(() => "");
    const code = xmlValues(text, "Code")[0];
    return new Error(`R2 ${what} ${key} ${res.status}${code ? ` ${code}` : ""}`);
  };
  return {
    async head(key) {
      const res = await send("HEAD", objectUrl(key));
      if (res.status === 404) return null;
      if (!res.ok) throw await fail("HEAD", key, res);
      const meta: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (k.toLowerCase().startsWith("x-amz-meta-")) meta[k.toLowerCase().slice(11)] = v; });
      return meta;
    },
    async get(key) {
      const res = await send("GET", objectUrl(key));
      if (res.status === 404) { await res.arrayBuffer().catch(() => undefined); return null; }
      if (!res.ok) throw await fail("GET", key, res);
      return Buffer.from(await res.arrayBuffer());
    },
    async put(key, body, opts = {}) {
      const headers: Record<string, string> = { "Content-Type": opts.contentType ?? "application/octet-stream" };
      for (const [k, v] of Object.entries(opts.meta ?? {})) headers[`x-amz-meta-${k}`] = v;
      const res = await send("PUT", objectUrl(key), { body, headers });
      if (!res.ok) throw await fail("PUT", key, res);
      await res.arrayBuffer().catch(() => undefined);
    },
    async list(prefix, delimiter) {
      const keys: string[] = [];
      const prefixes: string[] = [];
      let token = "";
      for (;;) {
        const q = new URLSearchParams({ "list-type": "2", prefix });
        if (delimiter) q.set("delimiter", delimiter);
        if (token) q.set("continuation-token", token);
        const res = await send("GET", `${cfg.endpoint}/${cfg.bucket}?${q}`);
        if (!res.ok) throw await fail("LIST", prefix, res);
        const xml = await res.text();
        for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) keys.push(...xmlValues(block, "Key"));
        for (const block of xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) ?? []) prefixes.push(...xmlValues(block, "Prefix"));
        token = xmlValues(xml, "NextContinuationToken")[0] ?? "";
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !token) break;
      }
      return { keys, prefixes };
    },
  };
}

/** The age binary: AGE_BIN, else the Homebrew path, else `age` on PATH. */
export function ageBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGE_BIN) return env.AGE_BIN;
  return existsSync("/opt/homebrew/bin/age") ? "/opt/homebrew/bin/age" : "age";
}

/** Run a binary with bytes on stdin and collect stdout; stderr becomes the error text. */
export function pipeThrough(bin: string, args: string[], input: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => reject(new Error(`${bin}: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 200)}`));
    });
    child.stdin.on("error", () => { /* the close handler reports the failure */ });
    child.stdin.end(input);
  });
}

export type Encrypt = (plain: Uint8Array) => Promise<Buffer>;
export type Decrypt = (cipher: Uint8Array) => Promise<Buffer>;

/** Encrypt to every recipient listed in a recipients file (age -R). */
export const ageEncryptor = (bin: string, recipientsFile: string): Encrypt => (plain) => pipeThrough(bin, ["-R", recipientsFile], plain);
/** Decrypt with an identity file (age -d -i). */
export const ageDecryptor = (bin: string, identityFile: string): Decrypt => (cipher) => pipeThrough(bin, ["-d", "-i", identityFile], cipher);

/** A gate that spaces calls at least minGapMs apart, across concurrent callers. */
export function pacer(minGapMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let next = 0;
  let count = 0;
  const wait = async () => {
    count++;
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + minGapMs;
    if (at > now) await sleep(at - now);
  };
  return { wait, get count() { return count; } };
}

/** Remove URLs (signed download links carry tokens) from text bound for a log or a record. */
export function redact(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, "<url>");
}

/** Run fn over items with at most `limit` in flight. */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const n = i++; await fn(items[n], n); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The calendar date (YYYY-MM-DD) in a timezone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
