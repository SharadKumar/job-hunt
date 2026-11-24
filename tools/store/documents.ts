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
 * The run cache also holds the application packages of active openings
 * (archive/<id>/), the positioning baselines (profile/resumes/<id>/) and the
 * CV source files (profile/cv/), downloaded from their Twenty attachments and
 * uploaded again at finish when they changed (tools/store/artefacts.ts).
 * A finish that fails leaves the cache and a finish-failed marker; the next
 * materialise retries it first, and stale-cache clean-up never deletes it.
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

import YAML from "yaml";
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
  { kind: "KEYWORD_REJECTS", name: "Keyword rejects", file: "keyword-rejects.jsonl" },
];

/**
 * Kinds the harness writes itself. Every other kind is the person's: the
 * harness may only propose a change to it (plan Principle 3).
 */
export const MACHINE_KINDS = new Set(["KEYWORD_CLOUDS", "MARKET_CONFIRMATIONS", "KEYWORD_REJECTS"]);

/**
 * The screening answers document holds the person's answers and facts and the
 * harness's own bookkeeping: questions it parked and answers it derived from
 * the CV or the person's earlier answers. A change that touches only the
 * harness's part saves directly, so a derived answer never waits for the
 * person; a change to anything the person wrote stays a proposal.
 */
export function onlyHarnessScreeningChanges(before: string, after: string): boolean {
  let a: any, b: any;
  try { a = YAML.parse(before) ?? {}; b = YAML.parse(after) ?? {}; } catch { return false; }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "unknown_questions" && !same(a[key], b[key])) return false;
  }
  const rows = (d: any) => (Array.isArray(d.unknown_questions) ? d.unknown_questions : []);
  const keyOf = (r: any) => `${r?.opportunity_id ?? ""}|${String(r?.question ?? "").trim().toLowerCase()}`;
  const after_ = new Map(rows(b).map((r: any) => [keyOf(r), r]));
  for (const r of rows(a)) {
    const personAnswered = r?.answer != null && String(r.answer).trim() !== "" && r.derived !== true;
    if (!personAnswered) continue;
    if (!same(r, after_.get(keyOf(r)))) return false; // the person's answer moved or went
  }
  return true;
}

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
      // A failed finish leaves the cache with a finish-failed marker; the next
      // materialise retries it.
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
  /** Workspace URL and key; default from the environment (twentyConfig). */
  config?: { url: string; key: string };
  /** Fetch for REST and file bytes (tests pass a fake). */
  fetchImpl?: typeof fetch;
};

async function caller(deps: DocumentsDeps): Promise<NonNullable<DocumentsDeps["call"]>> {
  if (deps.call) return deps.call;
  const { connect } = await import("../twenty/records.ts");
  return connect(deps.config, deps.fetchImpl);
}

/** What the attachment layer needs: the caller plus the origin files download from. */
async function artefactDeps(deps: DocumentsDeps, call: NonNullable<DocumentsDeps["call"]>) {
  return { call, fetchImpl: deps.fetchImpl, baseUrl: deps.config?.url, key: deps.config?.key };
}

/** Marker left in a run cache whose finish failed, so it is retried and never pruned. */
export const FINISH_FAILED = "finish-failed.json";

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
    if (fs.existsSync(path.join(p, FINISH_FAILED))) continue;
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); removed.push(e.name); }
    } catch { /* gone already */ }
  }
  return removed;
}

export type MaterialiseResult = {
  runId: string;
  dir: string;
  profileDir: string;
  files: string[];
  artefacts?: import("./artefacts.ts").MaterialiseArtefactsResult;
  retried?: { runId: string; ok: boolean; error?: string }[];
};

/**
 * Finish every run cache an earlier finish left behind, so this run starts
 * from what Twenty holds after those uploads. A retry that fails again keeps
 * its cache and is reported; it does not stop this run.
 */
export async function retryFailedFinishes(opts: DocumentsDeps = {}): Promise<{ runId: string; ok: boolean; error?: string }[]> {
  const base = path.join(opts.root ?? repoRoot(), "state", "cache");
  const out: { runId: string; ok: boolean; error?: string }[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("run-") || !fs.existsSync(path.join(base, e.name, FINISH_FAILED))) continue;
    const runId = e.name.slice(4);
    try {
      await finishRun(runId, opts);
      out.push({ runId, ok: true });
    } catch (err: any) {
      out.push({ runId, ok: false, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return out;
}

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
  const retried = await retryFailedFinishes({ ...opts, root });
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
    const { materialiseArtefacts } = await import("./artefacts.ts");
    const cvSource = docs.find((d) => d.kind === "CV_SOURCE");
    const artefacts = await materialiseArtefacts(dir, { ...(await artefactDeps(opts, call)), cvSourceDocumentId: cvSource?.id ?? null });
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { runId, dir, profileDir, files: Object.keys(manifest.files).sort(), artefacts, ...(retried.length ? { retried } : {}) };
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

  if (!MACHINE_KINDS.has(kind) && !(kind === "SCREENING_ANSWERS" && rev && onlyHarnessScreeningChanges(String(rev.body ?? ""), body))) {
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

export type FinishResult = {
  runId: string;
  saved: SaveResult[];
  artefacts: import("./artefacts.ts").PersistArtefactsResult | null;
  removed: boolean;
};

/** Per-positioning rule files in the cache, as profile-relative paths. */
function resumeRuleFiles(profileDir: string): string[] {
  const out: string[] = [];
  const base = path.join(profileDir, "resumes");
  let ids: string[] = [];
  try { ids = fs.readdirSync(base).sort(); } catch { return out; }
  for (const id of ids) {
    if (id.startsWith("_") || id.startsWith(".")) continue;
    for (const f of ["editorial-rules.md", "cover-letter-editorial-rules.md"]) {
      const rel = `resumes/${id}/${f}`;
      if (fileForDocument({ kind: "OTHER", name: rel }) && fs.existsSync(path.join(base, id, f))) out.push(rel);
    }
  }
  return out;
}

/**
 * End a run: changed packages, baselines and CV source files are uploaded
 * (tools/store/artefacts.ts), then every cached document whose body changed
 * (or a new file that maps to a document kind) is saved through
 * saveDocument, then the cache is deleted. Any failure throws, leaves the
 * cache with a finish-failed marker for the retry, and the CLI exits non-zero.
 * Progress is recorded as it goes, so a retry repeats only what failed.
 */
export async function finishRun(runId: string, opts: DocumentsDeps & { keep?: boolean } = {}): Promise<FinishResult> {
  const dir = runCacheDir(runId, opts.root);
  const manifest = readManifest(dir);
  if (!manifest) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { runId, saved: [], artefacts: null, removed: true };
  }
  const profileDir = path.join(dir, "profile");
  const saved: SaveResult[] = [];
  let artefacts: FinishResult["artefacts"] = null;
  try {
    const call = await caller(opts);
    const { persistArtefacts } = await import("./artefacts.ts");
    artefacts = await persistArtefacts(dir, await artefactDeps(opts, call));
    const candidates = new Set<string>(Object.keys(manifest.files));
    for (const d of DOCUMENT_FILES) if (fs.existsSync(path.join(profileDir, d.file))) candidates.add(d.file);
    for (const rel of resumeRuleFiles(profileDir)) candidates.add(rel);
    for (const file of [...candidates].sort()) {
      const target = path.join(profileDir, file);
      if (!fs.existsSync(target)) continue;
      const body = fs.readFileSync(target, "utf8");
      if (manifest.files[file]?.sha256 === sha256(body)) continue;
      const { kind, name } = documentForFile(file);
      const r = await saveDocument(kind, body, { ...opts, call, name, reason: `changed during run ${runId}`, twenty: true });
      saved.push(r);
      // Recorded at once, so a retry after a later failure does not propose it twice.
      const documentId = "documentId" in r && r.documentId ? r.documentId : manifest.files[file]?.documentId ?? "";
      const revision = "revision" in r ? r.revision : manifest.files[file]?.revision ?? 0;
      manifest.files[file] = { kind, documentId, revision, sha256: sha256(body) };
      fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    }
  } catch (e: any) {
    fs.writeFileSync(path.join(dir, FINISH_FAILED), JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e).slice(0, 500) }), { mode: 0o600 });
    throw e;
  }
  if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  else fs.rmSync(path.join(dir, FINISH_FAILED), { force: true });
  return { runId, saved, artefacts, removed: !opts.keep };
}

// ------------------------------------------------------------------- CLI

async function cli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const out = (o: unknown) => console.log(JSON.stringify(o));
  if (cmd === "materialise") {
    if (!isTwentyStore()) { out({ ok: true, store: "sqlite", skipped: "file mode reads the profile directory directly", profileDir: fileProfileDir(process.env.HARNESS_PROFILE) }); return 0; }
    const r = await materialise();
    out({ ok: true, store: "twenty", runId: r.runId, dir: r.dir, files: r.files.length, artefacts: r.artefacts, ...(r.retried ? { retried: r.retried } : {}) });
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
