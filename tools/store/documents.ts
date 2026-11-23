#!/usr/bin/env tsx
/**
 * documents.ts: the person's durable documents, wherever the store keeps them
 * (plan F10, documents part).
 *
 * File mode (HARNESS_STORE unset or sqlite): documents are the files under
 * state/profile/ (or state/profiles/<id>/ in team mode), exactly as before.
 *
 * Twenty mode (HARNESS_STORE=twenty): each document is a `document` record
 * with `documentRevision` children. A run materialises the current revision of
 * every document into a per-run cache, state/cache/run-<id>/profile/, laid out
 * with today's file names, so file-reading tools work unchanged from there.
 * Nothing person-facing is read from or written to state/profile/.
 *
 *   currentProfileDir()      the profile directory for this process
 *   materialise()            fetch every document into a new run cache
 *   saveDocument(kind, body) machine kinds: a new revision;
 *                            person-owned kinds: an UPDATE_DOCUMENT proposal
 *                            the person confirms in Twenty
 *   finishRun()              save what changed in the cache, then delete it
 *
 * A process that needs the profile in Twenty mode and has no run yet
 * (HARNESS_RUN_ID unset) materialises one itself and finishes it on exit, so a
 * single tool run by hand behaves like a scheduled run. Every failure throws:
 * the harness fails closed when Twenty can't be read.
 *
 * CLI (one JSON object per call):
 *   tsx tools/store/documents.ts materialise          # prints { runId, dir }
 *   tsx tools/store/documents.ts path [file]          # profile dir or a file in it
 *   tsx tools/store/documents.ts save <file> [--from <path>]
 *   tsx tools/store/documents.ts finish [--run <id>] [--keep]
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../lib/hash.ts";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../repo-root.ts";

/** This module, run as a child for the synchronous resolver. */
const SELF = fileURLToPath(import.meta.url);

/** Each document kind and its file name inside the profile directory. */
export const DOCUMENT_FILES: { kind: string; name: string; file: string }[] = [
  { kind: "PROFILE", name: "Profile", file: "profile.md" },
  { kind: "CV_SOURCE", name: "CV source", file: "cv-source.md" },
  { kind: "VOICE_RULES", name: "Voice rules", file: "voice-rules.md" },
  { kind: "VOICE_SAMPLES", name: "Voice samples", file: "voice-samples.md" },
  { kind: "SLOP_BANLIST", name: "Slop banlist", file: "slop-banlist.md" },
  { kind: "EDITORIAL_RULES", name: "Editorial rules", file: "resume-editorial-rules.md" },
  { kind: "EDITORIAL_BANS", name: "Editorial bans", file: "editorial-bans.yaml" },
  { kind: "LETTER_CRITIC_RULES", name: "Letter critic rules", file: "letter-critic-rules.yaml" },
  { kind: "SCREENING_ANSWERS", name: "Screening answers", file: "screening-answers.yaml" },
  { kind: "CHANNELS", name: "Channels", file: "channels.yaml" },
  { kind: "SCORING", name: "Scoring", file: "scoring-weights.yaml" },
  { kind: "SUBMISSION_POLICY", name: "Submission policy", file: "submission-policy.yaml" },
  { kind: "POSITIONINGS", name: "Positionings", file: "resumes.yaml" },
  { kind: "KEYWORD_CLOUDS", name: "Keyword clouds", file: "keyword-clouds.yaml" },
  { kind: "MARKET_CONFIRMATIONS", name: "Market confirmations", file: "market-confirmations.yaml" },
];

/**
 * Kinds the harness writes itself. Every other kind is the person's: the
 * harness may only propose a change to it (plan Principle 3).
 */
export const MACHINE_KINDS = new Set(["KEYWORD_CLOUDS", "MARKET_CONFIRMATIONS"]);

/** Documents of kind OTHER are materialised under their name, which must be a plain relative file path. */
const OTHER_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.[A-Za-z0-9]+$/;

export function isTwentyStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HARNESS_STORE ?? "sqlite").toLowerCase() === "twenty";
}

/** The profile directory on disk in file mode. */
export function fileProfileDir(profileId?: string | null, root = repoRoot()): string {
  return profileId ? path.join(root, "state", "profiles", profileId) : path.join(root, "state", "profile"); // scan:file-mode
}

/** state/cache/run-<id>: the run's transient cache (rebuildable, never person-facing). */
export function runCacheDir(runId: string, root = repoRoot()): string {
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return path.join(root, "state", "cache", `run-${runId}`);
}

const MANIFEST = "manifest.json";

export type Manifest = {
  runId: string;
  createdAt: string;
  files: Record<string, { kind: string; documentId: string; revision: number; sha256: string }>;
};

function readManifest(dir: string): Manifest | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")); } catch { return null; }
}

/** The run this process created on demand, finished when the process exits. */
let ownedRun: string | null = null;

/** Materialise synchronously in a child process (the resolver is synchronous). */
function materialiseSync(): string {
  const script = SELF;
  let out: string;
  try {
    out = execFileSync(process.execPath, [...process.execArgv, script, "materialise"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
  } catch (e: any) {
    const detail = String(e?.stdout || e?.stderr || e?.message || e).slice(0, 300);
    throw new Error(`HARNESS_STORE=twenty: could not materialise documents from Twenty (${detail.trim()})`);
  }
  const res = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  if (!res.ok || !res.runId) throw new Error(`HARNESS_STORE=twenty: materialise failed (${res.error ?? "no run id"})`);
  return res.runId;
}

/**
 * The run cache for this process in Twenty mode: HARNESS_RUN_ID's cache when
 * the caller (scripts/daily.sh) made one, else a new one made now and
 * finished when this process exits.
 */
export function currentRunDir(): string {
  let runId = process.env.HARNESS_RUN_ID;
  if (runId) {
    const dir = runCacheDir(runId);
    if (!readManifest(dir)) throw new Error(`HARNESS_RUN_ID=${runId} has no materialised cache at ${dir}; run the store's materialise step first`);
    return dir;
  }
  runId = materialiseSync();
  process.env.HARNESS_RUN_ID = runId;
  ownedRun = runId;
  process.once("exit", () => {
    if (!ownedRun) return;
    const script = SELF;
    try {
      execFileSync(process.execPath, [...process.execArgv, script, "finish", "--run", ownedRun], { stdio: "ignore", env: process.env });
    } catch {
      // The cache is transient; a failed finish leaves it for the next clean-up.
    }
  });
  return runCacheDir(runId);
}

/**
 * The profile directory every tool reads: state/profile (or
 * state/profiles/<id>) in file mode; the run cache's profile/ in Twenty mode.
 * A Twenty workspace holds one person, so the profile id is ignored there.
 */
export function currentProfileDir(profileId?: string | null): string {
  if (!isTwentyStore()) return fileProfileDir(profileId);
  return path.join(currentRunDir(), "profile");
}

// ------------------------------------------------------------ Twenty access

export type DocumentsDeps = {
  /** REST caller; defaults to the configured workspace with the Harness key. */
  call?: (method: string, path: string, body?: unknown) => Promise<any>;
  root?: string;
};

async function caller(deps: DocumentsDeps): Promise<NonNullable<DocumentsDeps["call"]>> {
  if (deps.call) return deps.call;
  const { connect } = await import("../twenty/records.ts");
  return connect();
}

async function listAll(call: NonNullable<DocumentsDeps["call"]>, plural: string, filter?: string): Promise<Record<string, any>[]> {
  const f = filter ? `&filter=${encodeURIComponent(filter)}` : "";
  const out: Record<string, any>[] = [];
  let cursor = "";
  for (;;) {
    const j = await call("GET", `/rest/${plural}?limit=200&order_by=createdAt${f}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(j?.data?.[plural] ?? []));
    const page = j?.pageInfo ?? {};
    if (!page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }
  return out;
}

/** Where a document lands in the profile directory, or null when it has no file. */
export function fileForDocument(doc: { kind?: string; name?: string }): string | null {
  const known = DOCUMENT_FILES.find((d) => d.kind === doc.kind);
  if (known) return known.file;
  if (doc.kind === "OTHER" && doc.name && OTHER_FILE.test(doc.name) && !doc.name.includes("..")) return doc.name;
  return null;
}

/** Where a document lives in file mode. Keyword clouds are shared, so they sit in state/org. */
export function fileModeDocumentPath(kind: string, name?: string, profileId?: string | null, root = repoRoot()): string {
  if (kind === "KEYWORD_CLOUDS") return path.join(root, "state", "org", "keyword-clouds.yaml");
  const file = fileForDocument({ kind, name });
  if (!file) throw new Error(`no profile file for document kind ${kind}`);
  return path.join(fileProfileDir(profileId, root), file);
}

/** The kind (and OTHER name) a profile file is stored under. */
export function documentForFile(file: string): { kind: string; name: string } {
  const rel = file.split(path.sep).join("/");
  const known = DOCUMENT_FILES.find((d) => d.file === rel);
  return known ? { kind: known.kind, name: known.name } : { kind: "OTHER", name: rel };
}

async function currentRevision(call: NonNullable<DocumentsDeps["call"]>, doc: Record<string, any>): Promise<Record<string, any> | null> {
  const revs = await listAll(call, "documentRevisions", `documentId[eq]:${doc.id}`);
  if (!revs.length) return null;
  const want = Number(doc.currentRevision);
  return revs.find((r) => Number(r.revision) === want) ?? revs.sort((a, b) => Number(b.revision) - Number(a.revision))[0];
}

/** Delete run caches older than a day: a run that died before finishing leaves one behind. */
export function pruneStaleRuns(root = repoRoot(), maxAgeMs = 24 * 3600 * 1000, now = Date.now()): string[] {
  const base = path.join(root, "state", "cache");
  const removed: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("run-")) continue;
    const p = path.join(base, e.name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); removed.push(e.name); }
    } catch { /* gone already */ }
  }
  return removed;
}

export type MaterialiseResult ={ runId: string; dir: string; profileDir: string; files: string[] };

/**
 * Fetch the current revision of every document into a new run cache. Throws
 * when Twenty can't be read or a document has no body; a partial cache is
 * removed before the error propagates.
 */
export async function materialise(opts: DocumentsDeps & { runId?: string } = {}): Promise<MaterialiseResult> {
  const root = opts.root ?? repoRoot();
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const dir = runCacheDir(runId, root);
  const profileDir = path.join(dir, "profile");
  pruneStaleRuns(root);
  try {
    const call = await caller(opts);
    const docs = await listAll(call, "documents");
    const manifest: Manifest = { runId, createdAt: new Date().toISOString(), files: {} };
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    for (const doc of docs) {
      const file = fileForDocument(doc);
      if (!file) continue;
      const rev = await currentRevision(call, doc);
      if (!rev || typeof rev.body !== "string") throw new Error(`document ${doc.kind}${doc.kind === "OTHER" ? ` ${doc.name}` : ""} has no current revision body`);
      const target = path.join(profileDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rev.body, { mode: 0o600 });
      manifest.files[file] = { kind: doc.kind, documentId: doc.id, revision: Number(rev.revision) || 0, sha256: sha256(rev.body) };
    }
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { runId, dir, profileDir, files: Object.keys(manifest.files).sort() };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export type SaveResult =
  | { action: "unchanged"; kind: string; documentId: string; revision: number }
  | { action: "revision"; kind: string; documentId: string; revision: number }
  | { action: "proposed"; kind: string; proposalId: string; documentId: string | null; baseRevision: number | null }
  | { action: "written"; kind: string; path: string };

/**
 * Save a document body.
 *
 * File mode writes the profile file, as tools always have. Twenty mode writes
 * a new revision for a machine kind, and for a person-owned kind creates an
 * UPDATE_DOCUMENT proposal carrying the body, so the person confirms it in
 * Twenty; the document itself is not touched.
 */
export async function saveDocument(
  kind: string,
  body: string,
  opts: DocumentsDeps & { name?: string; reason?: string; profileId?: string | null; twenty?: boolean } = {},
): Promise<SaveResult> {
  const name = opts.name ?? DOCUMENT_FILES.find((d) => d.kind === kind)?.name ?? kind;
  if (!(opts.twenty ?? isTwentyStore())) {
    const target = fileModeDocumentPath(kind, name, opts.profileId, opts.root);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, body);
    return { action: "written", kind, path: target };
  }
  const call = await caller(opts);
  const filter = kind === "OTHER" ? `and(kind[eq]:OTHER,name[eq]:${JSON.stringify(name)})` : `kind[eq]:${kind}`;
  const doc = (await listAll(call, "documents", filter))[0] ?? null;
  const rev = doc ? await currentRevision(call, doc) : null;
  const base = rev ? Number(rev.revision) || 0 : null;
  if (rev && rev.body === body) return { action: "unchanged", kind, documentId: doc!.id, revision: base ?? 0 };

  if (!MACHINE_KINDS.has(kind)) {
    const j = await call("POST", "/rest/proposals", {
      summary: `Update ${name}${opts.reason ? `: ${opts.reason}` : ""}`.slice(0, 250),
      proposalType: "UPDATE_DOCUMENT",
      proposer: "HARNESS",
      status: "PROPOSED",
      payload: { kind, name, documentId: doc?.id ?? null, baseRevision: base, body, reason: opts.reason ?? null },
    });
    const id = j?.data?.createProposal?.id ?? j?.data?.proposal?.id;
    if (!id) throw new Error("Twenty did not return the new proposal id");
    return { action: "proposed", kind, proposalId: id, documentId: doc?.id ?? null, baseRevision: base };
  }

  let documentId = doc?.id as string | undefined;
  if (!documentId) {
    const j = await call("POST", "/rest/documents", { name, kind, currentRevision: 0 });
    documentId = j?.data?.createDocument?.id ?? j?.data?.document?.id;
    if (!documentId) throw new Error("Twenty did not return the new document id");
  }
  const next = (base ?? 0) + 1;
  await call("POST", "/rest/documentRevisions", { name: `${name} r${next}`, revision: next, baseRevision: base, kind, body, documentId });
  await call("PATCH", `/rest/documents/${documentId}`, { currentRevision: next });
  return { action: "revision", kind, documentId, revision: next };
}

export type FinishResult = { runId: string; saved: SaveResult[]; removed: boolean };

/**
 * End a run: every cached document whose body changed (or a new file that
 * maps to a document kind) is saved through saveDocument, then the cache is
 * deleted. A save failure is reported and the cache is kept for inspection.
 */
export async function finishRun(runId: string, opts: DocumentsDeps & { keep?: boolean } = {}): Promise<FinishResult> {
  const dir = runCacheDir(runId, opts.root);
  const manifest = readManifest(dir);
  if (!manifest) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { runId, saved: [], removed: true };
  }
  const profileDir = path.join(dir, "profile");
  const saved: SaveResult[] = [];
  const candidates = new Set<string>(Object.keys(manifest.files));
  for (const d of DOCUMENT_FILES) if (fs.existsSync(path.join(profileDir, d.file))) candidates.add(d.file);
  for (const file of [...candidates].sort()) {
    const target = path.join(profileDir, file);
    if (!fs.existsSync(target)) continue;
    const body = fs.readFileSync(target, "utf8");
    if (manifest.files[file]?.sha256 === sha256(body)) continue;
    const { kind, name } = documentForFile(file);
    saved.push(await saveDocument(kind, body, { ...opts, name, reason: `changed during run ${runId}`, twenty: true }));
  }
  if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  return { runId, saved, removed: !opts.keep };
}

// ------------------------------------------------------------------- CLI

async function cli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const out = (o: unknown) => console.log(JSON.stringify(o));
  if (cmd === "materialise") {
    if (!isTwentyStore()) { out({ ok: true, store: "sqlite", skipped: "file mode reads the profile directory directly", profileDir: fileProfileDir(process.env.HARNESS_PROFILE) }); return 0; }
    const r = await materialise();
    out({ ok: true, store: "twenty", runId: r.runId, dir: r.dir, files: r.files.length });
    return 0;
  }
  if (cmd === "path") {
    if (isTwentyStore() && !process.env.HARNESS_RUN_ID) {
      out({ ok: false, error: "HARNESS_STORE=twenty: no run cache; run `npm run -s store:materialise`, export HARNESS_RUN_ID from its output, and `npm run -s store:finish` at the end" });
      return 3;
    }
    const dir = currentProfileDir(process.env.HARNESS_PROFILE);
    out({ ok: true, path: rest[0] && !rest[0].startsWith("--") ? path.join(dir, rest[0]) : dir });
    return 0;
  }
  if (cmd === "save") {
    const file = rest[0];
    if (!file || file.startsWith("--")) { out({ ok: false, error: "usage: save <profile file> [--from <path>]" }); return 2; }
    const from = flag("--from") ?? path.join(currentProfileDir(process.env.HARNESS_PROFILE), file);
    const { kind, name } = documentForFile(file);
    const r = await saveDocument(kind, fs.readFileSync(from, "utf8"), { name, profileId: process.env.HARNESS_PROFILE, reason: flag("--reason") });
    out({ ok: true, ...r });
    return 0;
  }
  if (cmd === "finish") {
    const runId = flag("--run") ?? process.env.HARNESS_RUN_ID;
    if (!isTwentyStore() || !runId) { out({ ok: true, skipped: isTwentyStore() ? "no run" : "file mode" }); return 0; }
    const r = await finishRun(runId, { keep: rest.includes("--keep") });
    out({ ok: true, ...r });
    return 0;
  }
  out({ ok: false, error: "usage: documents.ts materialise | path [file] | save <file> [--from <path>] | finish [--run <id>] [--keep]" });
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 500) }));
    process.exit(1);
  });
}
