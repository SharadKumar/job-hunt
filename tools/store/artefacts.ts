/**
 * artefacts.ts: application packages, positioning baselines and the CV source
 * files as Twenty attachments (plan F5 application and positioning, F10).
 *
 * Twenty mode only. A run works on local copies in its cache
 * (state/cache/run-<id>/), laid out as file mode lays them out, so every tool
 * reads and writes the same relative paths:
 *
 *   archive/<harnessId>/<file>            the opening's package, attached to
 *                                         its `application` record
 *   profile/resumes/<resumeId>/<file>     the positioning's current CV version:
 *                                         PDF and DOCX attached to its
 *                                         `resumeVersion` record, working files
 *                                         in that record's workFiles field
 *   profile/cv/<file>                     the person's CV source files,
 *                                         attached to the CV_SOURCE document
 *
 * materialiseArtefacts() downloads the packages of openings in an active
 * state, every baseline and the CV source files, and records the sha256 of
 * every file it wrote in artefacts.json. persistArtefacts() uploads what
 * changed since then:
 *   - a package: the application record is upserted from the package files
 *     (fields as the migration maps them) and each new or changed file is
 *     uploaded as an attachment;
 *   - a baseline: a new content hash becomes a new current resume version,
 *     the same hash refreshes that version; changed PDF and DOCX files are
 *     uploaded to it. Approval never moves this way: approval fields
 *     in metadata.json are restored to what was materialised, because a
 *     baseline is approved only through the APPROVE_BASELINE decision;
 *   - a CV source file is the person's: a change becomes an UPDATE_DOCUMENT
 *     proposal carrying the new file as its attachment.
 *
 * Attachments are content addressed: an attachment's id is derived from its
 * target, name and sha256, so an unchanged file is never uploaded twice, and
 * the newest attachment of a name is the current version. Every failure
 * throws, so the caller keeps the cache and exits non-zero.
 */

import fs from "node:fs";
import path from "node:path";
import type { Opportunity } from "../pipeline.ts";
import { sha256 } from "../lib/hash.ts";

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

export type ArtefactDeps = {
  call: Call;
  /** Fetch for file bytes (download and upload PUT); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Workspace base URL: downloads are fetched from this origin only. Default: twentyConfig(). */
  baseUrl?: string;
  /** API key sent with downloads. Default: twentyConfig(). */
  key?: string;
};

/** Openings whose package a run needs on disk (the prepare and send states). */
export const ACTIVE_STATUSES = ["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending", "manual_action_needed"] as const;

/** Rendered page images and HTML are render intermediates, rebuilt on demand. */
const INTERMEDIATE = /(-page-\d+\.png|\.html?)$/i;
/** Per-positioning rule files are documents, not attachments. */
export const RESUME_RULE_FILES = new Set(["editorial-rules.md", "cover-letter-editorial-rules.md"]);
/** Approval fields of a baseline's metadata.json; only the decision path moves them. */
export const APPROVAL_FIELDS = ["approval_status", "approved_hash", "approved_at", "approved_by"] as const;

/** A baseline's CV files: the only attachments on a resume version. */
export function isCvFile(name: string): boolean {
  return /\.(pdf|docx)$/i.test(name);
}

/**
 * A baseline's working files, kept in the version's workFiles field: what the
 * gates, the critic and the approval path read back. Scratch files (rounds,
 * restores, numbered audits) stay in the run cache and are not kept.
 */
export function isWorkFile(name: string): boolean {
  if (!safeName(name) || RESUME_RULE_FILES.has(name)) return false;
  if (["metadata.json", "keyword-plan.json", "quality-report.json"].includes(name)) return true;
  return /\.(audit|composition|critic|provenance|quality-report)\.json$/.test(name) || /\.md$/.test(name);
}

/** A file of a baseline folder that Twenty keeps. */
export function isBaselineFile(name: string): boolean {
  return isCvFile(name) || isWorkFile(name);
}

export type WorkFiles = Record<string, { sha256: string; text: string }>;

/** The working files of a baseline folder, for a version's workFiles field. */
export function readWorkFiles(dir: string): WorkFiles {
  const out: WorkFiles = {};
  for (const name of persistedFiles(dir).filter(isWorkFile)) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    out[name] = { sha256: sha256(text), text };
  }
  return out;
}

/** A resume version's id: one per positioning and content hash. */
export function resumeVersionKey(rid: string, contentHash: string | null | undefined): string {
  return `resumeVersion:${rid}:${contentHash || "unhashed"}`;
}

/** A single safe file name (no directories, no dot files, no traversal). */
export function safeName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 200 && !name.startsWith(".") && !/[\/\\\x00-\x1f]/.test(name) && name !== "..";
}

/** Whether a top-level file in a package or baseline folder is kept in Twenty. */
export function persistedFile(name: string): boolean {
  return safeName(name) && !INTERMEDIATE.test(name) && !RESUME_RULE_FILES.has(name);
}

/** Top-level persisted files of a folder, sorted. Subfolders are local working copies. */
function persistedFiles(dir: string): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && persistedFile(e.name) && isFile(path.join(dir, e.name))).map((e) => e.name).sort();
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function subdirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && safeName(e.name) && !e.name.startsWith("_")).map((e) => e.name).sort(); } catch { return []; }
}

// ------------------------------------------------------------------ ids

async function ids() {
  const { uuid5, openingId } = await import("./twenty-backend.ts");
  return {
    openingId,
    applicationId: (hid: string) => uuid5(`application:${hid}`),
    positioningId: (rid: string) => uuid5(`positioning:${rid}`),
    resumeVersionId: (rid: string, hash: string | null | undefined) => uuid5(resumeVersionKey(rid, hash)),
    attachmentId: (target: string, name: string, sha: string) => uuid5(`attachment:${target}:${name}:${sha}`),
    proposalId: (file: string, sha: string) => uuid5(`proposal:UPDATE_DOCUMENT:CV_SOURCE:${file}:${sha}`),
    uuid5,
  };
}

// ------------------------------------------------------------ manifest

const MANIFEST = "artefacts.json";

export type ArtefactManifest = {
  /** Run-cache-relative path → what was materialised or last uploaded. */
  files: Record<string, { sha256: string; attachmentId: string | null }>;
  /** resumeId → approval fields of its metadata.json as materialised. */
  approvals: Record<string, Record<string, unknown>>;
};

export function readArtefactManifest(runDir: string): ArtefactManifest {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(runDir, MANIFEST), "utf8"));
    return { files: m.files ?? {}, approvals: m.approvals ?? {} };
  } catch {
    return { files: {}, approvals: {} };
  }
}
function writeArtefactManifest(runDir: string, m: ArtefactManifest): void {
  fs.writeFileSync(path.join(runDir, MANIFEST), JSON.stringify(m, null, 2), { mode: 0o600 });
}

// ------------------------------------------------------------ Twenty reads

async function listAll(call: Call, plural: string, filter?: string): Promise<Record<string, any>[]> {
  const { listAll: list } = await import("../twenty/records.ts");
  return list(call, plural, filter);
}

/** Attachments of many targets, chunked so URLs stay short. */
async function attachmentsFor(call: Call, field: string, targetIds: string[]): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for (let i = 0; i < targetIds.length; i += 50) {
    const chunk = targetIds.slice(i, i + 50);
    if (chunk.length) out.push(...(await listAll(call, "attachments", `${field}[in]:[${chunk.join(",")}]`)));
  }
  return out;
}

/** The current attachment of each name: the newest one. */
export function currentByName(atts: Record<string, any>[]): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const a of atts) {
    if (a.deletedAt) continue;
    const prev = out.get(a.name);
    if (!prev || String(a.createdAt ?? "") > String(prev.createdAt ?? "") || (a.createdAt === prev.createdAt && String(a.id) > String(prev.id))) out.set(a.name, a);
  }
  return out;
}

/** Download one attachment's bytes from the workspace origin. */
async function download(deps: ArtefactDeps, att: Record<string, any>): Promise<Buffer> {
  const file = Array.isArray(att.file) ? att.file[0] : null;
  if (!file?.url) throw new Error(`attachment ${att.id} (${att.name}) has no file URL`);
  let { baseUrl, key } = deps;
  if (!baseUrl) ({ url: baseUrl, key } = await (await import("./twenty-backend.ts")).twentyConfig());
  const u = new URL(String(file.url), baseUrl);
  const res = await (deps.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}${u.pathname}${u.search}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw new Error(`Twenty file download ${att.name} ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------- materialise

export type MaterialiseArtefactsResult = { packages: number; baselines: number; cvFiles: number; files: number };

/**
 * Download the packages of active openings, every baseline and the CV source
 * files into the run cache. `cvSourceDocumentId` is the CV_SOURCE document, if
 * the workspace has one.
 */
export async function materialiseArtefacts(runDir: string, deps: ArtefactDeps & { cvSourceDocumentId?: string | null }): Promise<MaterialiseArtefactsResult> {
  const I = await ids();
  const manifest: ArtefactManifest = { files: {}, approvals: {} };
  const result: MaterialiseArtefactsResult = { packages: 0, baselines: 0, cvFiles: 0, files: 0 };
  const write = (rel: string, bytes: Buffer, attachmentId: string | null) => {
    const target = path.join(runDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    manifest.files[rel] = { sha256: sha256(bytes), attachmentId };
    result.files++;
  };

  // Packages of openings in an active state.
  const statuses = ACTIVE_STATUSES.map((s) => s.toUpperCase()).join(",");
  const openings = (await listAll(deps.call, "openings", `status[in]:[${statuses}]`)).filter((o) => typeof o.harnessId === "string" && safeName(o.harnessId));
  const byApp = new Map(openings.map((o) => [I.applicationId(o.harnessId), o.harnessId as string]));
  const pkgAtts = await attachmentsFor(deps.call, "targetApplicationId", [...byApp.keys()]);
  const pkgSeen = new Set<string>();
  for (const [appId, hid] of byApp) {
    const current = currentByName(pkgAtts.filter((a) => a.targetApplicationId === appId));
    for (const [name, att] of current) {
      if (!safeName(name)) continue;
      write(path.posix.join("archive", hid, name), await download(deps, att), att.id);
      pkgSeen.add(hid);
    }
  }
  result.packages = pkgSeen.size;

  // The current CV version of every positioning: the PDF and DOCX from its
  // attachments, the working files from its workFiles field.
  const positionings = new Map((await listAll(deps.call, "positionings")).filter((p) => typeof p.harnessId === "string" && safeName(p.harnessId) && !p.harnessId.startsWith("_")).map((p) => [p.id, p]));
  const versions = (await listAll(deps.call, "resumeVersions", "isCurrent[eq]:true")).filter((v) => positionings.has(v.positioningId));
  const verAtts = await attachmentsFor(deps.call, "targetResumeVersionId", versions.map((v) => v.id));
  for (const ver of versions) {
    const rid = positionings.get(ver.positioningId)!.harnessId as string;
    result.baselines++;
    for (const [name, att] of currentByName(verAtts.filter((a) => a.targetResumeVersionId === ver.id))) {
      if (!safeName(name) || !isCvFile(name)) continue;
      write(path.posix.join("profile", "resumes", rid, name), await download(deps, att), att.id);
    }
    const work: WorkFiles = ver.workFiles && typeof ver.workFiles === "object" ? ver.workFiles : {};
    for (const [name, f] of Object.entries(work)) {
      if (!isWorkFile(name) || typeof f?.text !== "string") continue;
      let bytes: Buffer = Buffer.from(f.text, "utf8");
      if (name === "metadata.json") {
        const { bytes: out, approval } = overlayApproval(bytes, ver);
        bytes = out;
        manifest.approvals[rid] = approval;
      }
      write(path.posix.join("profile", "resumes", rid, name), bytes, null);
    }
  }

  // The person's CV source files.
  if (deps.cvSourceDocumentId) {
    const current = currentByName(await attachmentsFor(deps.call, "targetDocumentId", [deps.cvSourceDocumentId]));
    for (const [name, att] of current) {
      if (!safeName(name)) continue;
      write(path.posix.join("profile", "cv", name), await download(deps, att), att.id);
      result.cvFiles++;
    }
  }

  writeArtefactManifest(runDir, manifest);
  return result;
}

/**
 * The version record can withdraw a baseline's approval, never grant it:
 * unless the record is APPROVED for the hash metadata.json says was approved,
 * the local copy is marked not approved. Unparseable metadata is left as is
 * (the gate refuses it anyway).
 */
export function overlayApproval(bytes: Buffer, pos: Record<string, any>): { bytes: Buffer; approval: Record<string, unknown> } {
  let meta: any;
  try { meta = JSON.parse(bytes.toString("utf8")); } catch { return { bytes, approval: {} }; }
  if (!meta || typeof meta !== "object") return { bytes, approval: {} };
  const approved = String(pos.approvalStatus ?? "").toUpperCase() === "APPROVED" && (!pos.contentHash || pos.contentHash === meta.approved_hash);
  let out = bytes;
  if (!approved && (meta.approval_status === "approved" || meta.approved_hash)) {
    meta.approval_status = String(pos.approvalStatus ?? "PENDING").toLowerCase() === "stale" ? "stale" : "fresh";
    meta.approved_hash = null;
    out = Buffer.from(JSON.stringify(meta, null, 2) + "\n");
  }
  const approval: Record<string, unknown> = {};
  for (const k of APPROVAL_FIELDS) if (k in meta) approval[k] = meta[k];
  return { bytes: out, approval };
}

// -------------------------------------------------------------- persist

export type PersistArtefactsResult = {
  applications: string[];
  positionings: string[];
  uploaded: { target: string; name: string; sha256: string }[];
  skipped: number;
  proposals: string[];
  approvalRestored: string[];
};

type Upload = { rel: string; name: string; path: string; targetField: string; targetId: string; targetKey: string };

/** Changed or new files of one folder, relative to the run cache. */
function changed(runDir: string, relDir: string, manifest: ArtefactManifest, filter: (name: string) => boolean = persistedFile): string[] {
  return persistedFiles(path.join(runDir, relDir)).filter(filter).filter((name) => {
    const rel = path.posix.join(relDir, name);
    return manifest.files[rel]?.sha256 !== sha256(fs.readFileSync(path.join(runDir, rel)));
  });
}

/**
 * Upload every new or changed package file, baseline file and CV source file
 * in the run cache. The manifest is updated after each upload, so a retry
 * after a failure uploads only what is still missing.
 */
export async function persistArtefacts(runDir: string, deps: ArtefactDeps): Promise<PersistArtefactsResult> {
  const I = await ids();
  const manifest = readArtefactManifest(runDir);
  const out: PersistArtefactsResult = { applications: [], positionings: [], uploaded: [], skipped: 0, proposals: [], approvalRestored: [] };
  let fieldId: string | null = null;
  const fileField = async () => {
    if (!fieldId) {
      const { attachmentFileFieldId } = await import("../twenty/files.ts");
      fieldId = await attachmentFileFieldId(deps.call);
    }
    return fieldId;
  };

  /** Upload the files of one target that differ from its current attachments. */
  const uploadAll = async (uploads: Upload[], existing: Record<string, any>[]) => {
    const { uploadAttachment } = await import("../twenty/files.ts");
    const current = currentByName(existing);
    const byId = new Map(existing.map((a) => [a.id, a]));
    for (const u of uploads) {
      const sha = sha256(fs.readFileSync(u.path));
      const contentId = I.attachmentId(u.targetKey, u.name, sha);
      const now = current.get(u.name);
      if (now && (now.id === contentId || manifest.files[u.rel]?.attachmentId === now.id && manifest.files[u.rel]?.sha256 === sha)) {
        manifest.files[u.rel] = { sha256: sha, attachmentId: now.id };
        writeArtefactManifest(runDir, manifest);
        out.skipped++;
        continue;
      }
      // Same bytes as an older version: upload again under a fresh id so it becomes the newest.
      const id = byId.has(contentId) ? I.uuid5(`attachment:${u.targetKey}:${u.name}:${sha}:${Date.now()}`) : contentId;
      await uploadAttachment(deps.call, await fileField(), { id, name: u.name, path: u.path, targetField: u.targetField, targetId: u.targetId }, deps.fetchImpl ?? fetch);
      manifest.files[u.rel] = { sha256: sha, attachmentId: id };
      writeArtefactManifest(runDir, manifest);
      out.uploaded.push({ target: u.targetKey, name: u.name, sha256: sha });
    }
  };

  // Packages.
  for (const hid of subdirs(path.join(runDir, "archive"))) {
    const relDir = path.posix.join("archive", hid);
    const names = changed(runDir, relDir, manifest);
    if (!names.length) continue;
    const dir = path.join(runDir, relDir);
    const rec = await getOne(deps.call, "openings", I.openingId(hid));
    if (!rec) throw new Error(`package ${hid} has no opening in Twenty; refusing to attach it to nothing`);
    const { fromOpening } = await import("./twenty-backend.ts");
    const { applicationRecord } = await import("../twenty/migrate-plan.ts");
    const row = fromOpening(rec) as Opportunity;
    const appId = I.applicationId(hid);
    const record = await applicationRecord(dir, { ...row, company: row.company ?? rec.employer?.name });
    await deps.call("POST", "/rest/batch/applications?upsert=true", [{ id: appId, ...record, openingId: rec.id }]);
    out.applications.push(hid);
    const existing = await attachmentsFor(deps.call, "targetApplicationId", [appId]);
    await uploadAll(names.map((name) => ({ rel: path.posix.join(relDir, name), name, path: path.join(dir, name), targetField: "targetApplicationId", targetId: appId, targetKey: `application:${hid}` })), existing);
  }

  // Baselines: a render with a new content hash is a new current version;
  // the same hash updates that version's working files and CV files.
  for (const rid of subdirs(path.join(runDir, "profile", "resumes"))) {
    const relDir = path.posix.join("profile", "resumes", rid);
    const dir = path.join(runDir, relDir);
    if (restoreApproval(path.join(dir, "metadata.json"), manifest.approvals[rid])) out.approvalRestored.push(rid);
    const names = changed(runDir, relDir, manifest, isBaselineFile);
    if (!names.length) continue;
    const posId = I.positioningId(rid);
    await upsertPositioning(deps.call, posId, rid);
    const verId = await upsertVersion(deps.call, I, posId, rid, dir);
    out.positionings.push(rid);
    for (const name of names.filter(isWorkFile)) {
      const rel = path.posix.join(relDir, name);
      manifest.files[rel] = { sha256: sha256(fs.readFileSync(path.join(runDir, rel))), attachmentId: null };
    }
    writeArtefactManifest(runDir, manifest);
    const cvNames = persistedFiles(dir).filter(isCvFile);
    const existing = await attachmentsFor(deps.call, "targetResumeVersionId", [verId]);
    await uploadAll(cvNames.map((name) => ({ rel: path.posix.join(relDir, name), name, path: path.join(dir, name), targetField: "targetResumeVersionId", targetId: verId, targetKey: `resumeVersion:${verId}` })), existing);
  }

  // CV source files: the person's, so a change is a proposal.
  const cvRel = path.posix.join("profile", "cv");
  const cvChanged = changed(runDir, cvRel, manifest, () => true);
  if (cvChanged.length) {
    const docs = await listAll(deps.call, "documents", "kind[eq]:CV_SOURCE");
    const documentId = docs[0]?.id ?? null;
    const { uploadAttachment } = await import("../twenty/files.ts");
    const { getByIds } = await import("../twenty/records.ts");
    for (const name of cvChanged) {
      const rel = path.posix.join(cvRel, name);
      const file = path.join(runDir, rel);
      const sha = sha256(fs.readFileSync(file));
      const proposalId = I.proposalId(`cv/${name}`, sha);
      const attId = I.attachmentId(`proposal:${proposalId}`, name, sha);
      if (!(await getByIds(deps.call, "proposals", [proposalId])).has(proposalId)) {
        await deps.call("POST", "/rest/proposals", {
          id: proposalId,
          summary: `Update CV source file ${name}`.slice(0, 250),
          proposalType: "UPDATE_DOCUMENT",
          proposer: "HARNESS",
          status: "PROPOSED",
          payload: { kind: "CV_SOURCE", documentId, file: `cv/${name}`, sha256: sha, attachmentId: attId, reason: "changed during a run" },
        });
      }
      if (!(await getByIds(deps.call, "attachments", [attId])).has(attId)) {
        await uploadAttachment(deps.call, await fileField(), { id: attId, name, path: file, targetField: "targetProposalId", targetId: proposalId }, deps.fetchImpl ?? fetch);
        out.uploaded.push({ target: `proposal:${proposalId}`, name, sha256: sha });
      }
      // The CV_SOURCE attachment stays as it was until the person confirms.
      manifest.files[rel] = { sha256: sha, attachmentId: manifest.files[rel]?.attachmentId ?? null };
      writeArtefactManifest(runDir, manifest);
      out.proposals.push(proposalId);
    }
  }
  return out;
}

async function getOne(call: Call, plural: string, id: string): Promise<Record<string, any> | null> {
  const { getByIds } = await import("../twenty/records.ts");
  return (await getByIds(call, plural, [id])).get(id) ?? null;
}

/**
 * A run may withdraw a baseline's approval (a re-render resets it) but never
 * grant one: when the local metadata.json claims an approval that was not
 * materialised (or a baseline new in this run claims any), its approval fields
 * are put back. Returns true when the file was restored.
 */
export function restoreApproval(metaPath: string, materialised: Record<string, unknown> | undefined): boolean {
  let meta: any;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { return false; }
  if (!meta || typeof meta !== "object") return false;
  const granted = (m: any) => Boolean(m && m.approval_status === "approved" && m.approved_hash);
  if (!granted(meta)) return false;
  if (granted(materialised) && meta.approved_hash === materialised!.approved_hash) return false;
  const want: Record<string, unknown> = materialised && Object.keys(materialised).length ? materialised : { approval_status: "fresh", approved_hash: null };
  for (const k of APPROVAL_FIELDS) {
    if (k in want) meta[k] = want[k];
    else delete meta[k];
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  return true;
}

/** A positioning record, created when a run renders a positioning Twenty does not have yet. */
async function upsertPositioning(call: Call, id: string, rid: string): Promise<void> {
  if (await getOne(call, "positionings", id)) return;
  await call("POST", "/rest/positionings", { id, name: rid, harnessId: rid });
}

/**
 * The version for this baseline's content hash. A new hash creates a new
 * current version (approval PENDING: a run never grants one) and retires the
 * previous current one; the same hash refreshes the working files and the
 * critic verdict. Returns the version id.
 */
async function upsertVersion(call: Call, I: Awaited<ReturnType<typeof ids>>, posId: string, rid: string, dir: string): Promise<string> {
  let meta: any = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")); } catch { /* none yet */ }
  const { criticVerdict } = await import("../twenty/migrate-plan.ts");
  const hash = typeof meta?.content_hash === "string" ? meta.content_hash : null;
  const id = I.resumeVersionId(rid, hash);
  const fields: Record<string, unknown> = { criticVerdict: criticVerdict(meta?.critic?.verdict), workFiles: readWorkFiles(dir) };
  const rec = await getOne(call, "resumeVersions", id);
  if (rec) {
    await call("PATCH", `/rest/resumeVersions/${id}`, { ...fields, isCurrent: true });
  } else {
    await call("POST", "/rest/resumeVersions", {
      id, name: versionName(rid, hash), kind: "BASELINE", isCurrent: true, contentHash: hash,
      renderedAt: isoOrNull(meta?.last_render_at), approvalStatus: "PENDING", positioningId: posId, ...fields,
    });
  }
  for (const v of await listAll(call, "resumeVersions", `and(positioningId[eq]:${posId},isCurrent[eq]:true)`)) {
    if (v.id !== id) await call("PATCH", `/rest/resumeVersions/${v.id}`, { isCurrent: false });
  }
  return id;
}

/** A version's display name: the positioning and the first eight hash characters. */
export function versionName(rid: string, hash: string | null | undefined): string {
  return hash ? `${rid} ${hash.slice(0, 8)}` : `${rid} (no hash)`;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
