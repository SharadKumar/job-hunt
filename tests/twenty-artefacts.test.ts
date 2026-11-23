#!/usr/bin/env tsx
/**
 * twenty-artefacts.test.ts: packages, baselines and CV source files as Twenty
 * attachments (plan F5 application and positioning, F10).
 *
 * Unit (always, a fake Twenty behind a fake fetch, synthetic data only):
 *   - materialise downloads the packages of active openings only, every
 *     baseline and the CV source files into the run cache, and the letter sha
 *     check and the baseline reference check pass on the downloaded bytes;
 *   - a positioning record withdraws an approval it does not hold;
 *   - finish uploads only new or changed files (content-addressed, never
 *     twice), upserts the application, refuses to grant a baseline approval,
 *     proposes CV source and per-positioning rule changes, and writes the
 *     machine keyword-rejects document directly;
 *   - a failed upload makes finish throw, keeps the cache with its marker
 *     (never pruned), and the next materialise retries it first;
 *   - file mode paths are unchanged.
 *
 * Integration (TWENTY_TEST_URL and TWENTY_TEST_KEY, a local instance only,
 * Harness-role key): prepare a synthetic package in a run, finish, start a
 * new run, materialise, and check the bytes, the letter sha and the gate's
 * letter check.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twenty-artefacts-")));
process.env.HARNESS_REPO_ROOT = root;
delete process.env.HARNESS_RUN_ID;
delete process.env.HARNESS_PROFILE;
delete process.env.HARNESS_STORE;

const D = await import("../tools/store/documents.ts");
const P = await import("../tools/store/paths.ts");
const A = await import("../tools/store/artefacts.ts");
const { openingId, uuid5 } = await import("../tools/store/twenty-backend.ts");
const { readCurrentVerdict } = await import("../tools/letter-critic.ts");
const { verifyBaselineRef } = await import("../tools/submission-gate.ts");

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// File mode first: nothing moves.
assert.equal(P.archiveDir("row-1"), path.join(root, "state", "pipeline", "archive", "row-1"));
assert.equal(P.resolveRepoRef("state/profile/resumes/a/x.docx"), path.join(root, "state", "profile", "resumes", "a", "x.docx"));
assert.equal(P.resolveRepoRef("/abs/x.docx"), "/abs/x.docx");

// ---------------------------------------------------------------- fake Twenty

type Rec = Record<string, any>;
const BASE = "http://127.0.0.1:9999";

function fakeTwenty() {
  const db: Record<string, Rec[]> = { openings: [], applications: [], positionings: [], attachments: [], documents: [], documentRevisions: [], proposals: [] };
  const blobs = new Map<string, Buffer>();
  const log = { puts: 0, downloads: 0, posts: [] as { path: string; body: any }[] };
  const failPut = { count: 0 };
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  const value = (s: string) => (s.startsWith('"') ? JSON.parse(s) : s);
  const matches = (rec: Rec, filter: string): boolean => {
    const m = filter.match(/^and\((.*)\)$/);
    const parts = m ? m[1].split(/,(?=\w+\[)/) : [filter];
    return parts.every((p) => {
      const q = p.match(/^(\w+)\[(eq|in)\]:(.*)$/);
      if (!q) throw new Error(`fake: unsupported filter ${p}`);
      if (q[2] === "eq") return String(rec[q[1]]) === value(q[3]);
      const list = q[3].replace(/^\[|\]$/g, "").split(",").map(value);
      return list.includes(String(rec[q[1]]));
    });
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== BASE) throw new Error(`fake: request left the workspace origin: ${url.origin}`);
    if (url.pathname.startsWith("/upload/")) {
      if (failPut.count > 0) { failPut.count--; return new Response("boom", { status: 503 }); }
      log.puts++;
      blobs.set(url.pathname.slice(8), Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith("/file/files-field/")) {
      const b = blobs.get(url.pathname.split("/").pop()!);
      log.downloads++;
      return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response("missing", { status: 404 });
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/metadata") {
      if (body.query.includes("objects(")) return json(200, { data: { objects: { edges: [{ node: { nameSingular: "attachment", fieldsList: [{ id: "field-file", name: "file", type: "FILES" }] } }] } } });
      if (body.query.includes("createFileUpload")) {
        const fileId = randomUUID();
        return json(200, { data: { createFileUpload: { fileId, uploadUrl: `${BASE}/upload/${fileId}`, contentType: "application/octet-stream" } } });
      }
      if (body.query.includes("completeFileUpload")) return json(200, { data: { completeFileUpload: { id: body.variables.fileId } } });
      throw new Error("fake: unknown metadata query");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[1] === "batch") {
      for (const r of body) {
        const coll = db[parts[2]];
        const at = coll.findIndex((x) => x.id === r.id);
        if (at >= 0) coll[at] = { ...coll[at], ...r }; else coll.push({ createdAt: stamp(), ...r });
      }
      log.posts.push({ path: url.pathname, body });
      return json(200, { data: {} });
    }
    const plural = parts[1];
    const coll = db[plural];
    if (!coll) throw new Error(`fake: no collection ${plural}`);
    if (method === "GET") {
      const filter = url.searchParams.get("filter");
      return json(200, { data: { [plural]: coll.filter((r) => !filter || matches(r, filter)) }, pageInfo: { hasNextPage: false } });
    }
    if (method === "POST") {
      if (body.id && coll.some((r) => r.id === body.id)) return json(400, { messages: ["duplicate id"] });
      const rec: Rec = { id: body.id ?? randomUUID(), createdAt: stamp(), ...body };
      if (plural === "attachments") rec.file = body.file.map((f: any) => ({ ...f, url: `http://localhost:9999/file/files-field/${f.fileId}?token=t` }));
      coll.push(rec);
      log.posts.push({ path: url.pathname, body });
      const singular = plural.replace(/s$/, "");
      return json(200, { data: { [`create${singular[0].toUpperCase()}${singular.slice(1)}`]: rec } });
    }
    if (method === "PATCH") {
      const rec = coll.find((r) => r.id === parts[2]);
      if (!rec) return json(404, { messages: ["not found"] });
      Object.assign(rec, body);
      return json(200, { data: {} });
    }
    throw new Error(`fake: ${method} ${url.pathname}`);
  }) as typeof fetch;

  /** Seed an attachment with bytes, as an earlier upload or the migration would have. */
  const attach = (target: Rec, name: string, bytes: string | Buffer) => {
    const fileId = randomUUID();
    blobs.set(fileId, Buffer.from(bytes));
    db.attachments.push({ id: randomUUID(), name, createdAt: stamp(), deletedAt: null, file: [{ fileId, label: name, url: `http://localhost:9999/file/files-field/${fileId}?token=t` }], ...target });
  };
  const current = (field: string, id: string, name: string): Buffer | null => {
    const a = A.currentByName(db.attachments.filter((x) => x[field] === id)).get(name);
    return a ? blobs.get(a.file[0].fileId) ?? null : null;
  };
  return { db, blobs, log, failPut, fetchImpl, attach, current };
}

// ---------------------------------------------------------------- fixtures

const t = fakeTwenty();
const deps = { config: { url: BASE, key: "test-key" }, fetchImpl: t.fetchImpl, root };

const letter = "Dear team,\n\nA synthetic letter for unit tests.\n";
const critic = (text: string) => JSON.stringify({ verdict: "pass", letter_sha256: sha(text), checked_at: "2026-01-01T00:00:00Z", findings: [] });
const docx = Buffer.from("PK synthetic baseline docx bytes");
const baselineMeta = (hash: string, approvedHash: string | null, status = "approved") => JSON.stringify({ content_hash: hash, approved_hash: approvedHash, approval_status: status, approved_at: "2026-01-01T00:00:00Z", critic: { verdict: "pass" } }, null, 2) + "\n";

const hid = "seek-unit-1";
const appId = uuid5(`application:${hid}`);
t.db.openings.push({ id: openingId(hid), harnessId: hid, status: "SHORTLISTED", title: "Synthetic Architect", harnessData: { id: hid, title: "Synthetic Architect", company: "Example Pty Ltd", status: "shortlisted" } });
t.db.openings.push({ id: openingId("seek-unit-2"), harnessId: "seek-unit-2", status: "SUBMITTED", harnessData: { id: "seek-unit-2", status: "submitted" } });
const pkgMeta = JSON.stringify({ resume: { mode: "baseline", ref: "state/profile/resumes/arch/Synthetic_Architect.docx", sha256: sha(docx), baseline_content_hash: "h-arch" } });
t.attach({ targetApplicationId: appId }, "cover-letter.md", "an older letter\n");
t.attach({ targetApplicationId: appId }, "cover-letter.md", letter);
t.attach({ targetApplicationId: appId }, "letter-critic.json", critic(letter));
t.attach({ targetApplicationId: appId }, "metadata.json", pkgMeta);
t.attach({ targetApplicationId: uuid5("application:seek-unit-2") }, "cover-letter.md", "submitted elsewhere\n");

const archId = uuid5("positioning:arch");
const devId = uuid5("positioning:dev");
t.db.positionings.push({ id: archId, harnessId: "arch", approvalStatus: "APPROVED", contentHash: "h-arch" });
t.db.positionings.push({ id: devId, harnessId: "dev", approvalStatus: "APPROVED", contentHash: "h-dev-new" });
t.attach({ targetPositioningId: archId }, "metadata.json", baselineMeta("h-arch", "h-arch"));
t.attach({ targetPositioningId: archId }, "Synthetic_Architect.docx", docx);
t.attach({ targetPositioningId: devId }, "metadata.json", baselineMeta("h-dev-new", "h-dev-old"));

const cvDoc = { id: randomUUID(), kind: "CV_SOURCE", name: "CV source", currentRevision: 1 };
t.db.documents.push(cvDoc);
t.db.documentRevisions.push({ id: randomUUID(), documentId: cvDoc.id, revision: 1, kind: "CV_SOURCE", body: "# CV source\n" });
t.attach({ targetDocumentId: cvDoc.id }, "meta.yaml", "source_file: master.docx\n");
t.attach({ targetDocumentId: cvDoc.id }, "master.docx", Buffer.from("PK synthetic source docx"));

// ---------------------------------------------------------------- materialise

process.env.HARNESS_STORE = "twenty";
const m1 = await D.materialise({ ...deps, runId: "u1" });
process.env.HARNESS_RUN_ID = "u1";
const run1 = m1.dir;
assert.deepEqual(m1.artefacts, { packages: 1, baselines: 2, cvFiles: 2, files: 8 });
assert.equal(P.archiveDir(hid), path.join(run1, "archive", hid), "packages live in the run cache");
assert.equal(fs.readFileSync(path.join(run1, "archive", hid, "cover-letter.md"), "utf8"), letter, "the newest version of a name");
assert.equal(fs.existsSync(path.join(run1, "archive", "seek-unit-2")), false, "only active openings are downloaded");
assert.deepEqual(fs.readFileSync(path.join(run1, "profile", "resumes", "arch", "Synthetic_Architect.docx")), docx);
assert.equal(fs.readFileSync(path.join(run1, "profile", "cv", "meta.yaml"), "utf8"), "source_file: master.docx\n");
const devMeta = JSON.parse(fs.readFileSync(path.join(run1, "profile", "resumes", "dev", "metadata.json"), "utf8"));
assert.deepEqual([devMeta.approval_status, devMeta.approved_hash], ["fresh", null], "the record withdraws an approval it does not hold");
const archMeta = JSON.parse(fs.readFileSync(path.join(run1, "profile", "resumes", "arch", "metadata.json"), "utf8"));
assert.equal(archMeta.approved_hash, "h-arch", "a held approval is kept");

// The gate's checks pass on downloaded bytes.
const pkgDir = P.archiveDir(hid);
assert.equal((await readCurrentVerdict(path.join(pkgDir, "letter-critic.json"), fs.readFileSync(path.join(pkgDir, "cover-letter.md"), "utf8"))).ok, true);
assert.equal(P.resolveRepoRef("state/profile/resumes/arch/Synthetic_Architect.docx"), path.join(run1, "profile", "resumes", "arch", "Synthetic_Architect.docx"));
assert.equal(P.resolveRepoRef("state/cache/run-old-1/archive/x/a.pdf"), path.join(run1, "archive", "x", "a.pdf"));
const ref = await verifyBaselineRef({ archiveDir: pkgDir, cvDocxPath: path.join(run1, "profile", "resumes", "arch", "Synthetic_Architect.docx") });
assert.equal(ref?.ok, true, ref?.detail);

// ---------------------------------------------------------------- finish: dedupe

const attachmentsBefore = t.db.attachments.length;
let f = await D.finishRun("u1", { ...deps, keep: true });
assert.equal(f.artefacts!.uploaded.length, 0, "nothing changed, nothing uploaded");
assert.equal(t.db.attachments.length, attachmentsBefore);
assert.equal(t.log.puts, 0);

// A redrafted letter and its verdict: two uploads and the application upserted.
const letter2 = "Dear team,\n\nA redrafted synthetic letter.\n";
fs.writeFileSync(path.join(pkgDir, "cover-letter.md"), letter2);
fs.writeFileSync(path.join(pkgDir, "letter-critic.json"), critic(letter2));
fs.writeFileSync(path.join(pkgDir, "Synthetic_Architect-page-1.png"), "render intermediate");
f = await D.finishRun("u1", { ...deps, keep: true });
assert.deepEqual(f.artefacts!.uploaded.map((u) => u.name).sort(), ["cover-letter.md", "letter-critic.json"]);
assert.deepEqual(f.artefacts!.applications, [hid]);
const app = t.db.applications.find((a) => a.id === appId)!;
assert.equal(app.letterSha, sha(letter2));
assert.equal(app.criticVerdict, "PASS");
assert.equal(app.openingId, openingId(hid));
assert.equal(app.name, "Synthetic Architect at Example Pty Ltd");
assert.equal(t.current("targetApplicationId", appId, "cover-letter.md")!.toString(), letter2);
const up = t.db.attachments.find((a) => a.name === "cover-letter.md" && a.targetApplicationId === appId && a.id === uuid5(`attachment:application:${hid}:cover-letter.md:${sha(letter2)}`));
assert.ok(up, "content-addressed attachment id");
assert.equal(t.db.attachments.some((a) => /-page-\d+\.png$/.test(a.name)), false, "page renders stay local");

// A second finish, and a fresh manifest (lost cache state): still no re-upload.
const puts = t.log.puts;
f = await D.finishRun("u1", { ...deps, keep: true });
assert.equal(f.artefacts!.uploaded.length, 0);
const manifestPath = path.join(run1, "artefacts.json");
const saved = fs.readFileSync(manifestPath, "utf8");
const mf = JSON.parse(saved);
delete mf.files[`archive/${hid}/cover-letter.md`];
fs.writeFileSync(manifestPath, JSON.stringify(mf));
f = await D.finishRun("u1", { ...deps, keep: true });
assert.equal(f.artefacts!.uploaded.length, 0, "the content id already exists as the newest version");
assert.equal(t.log.puts, puts);

// ---------------------------------------------------------------- baselines, rules, CV source

// A local approval is never uploaded: approval moves only by decision.
const devPath = path.join(run1, "profile", "resumes", "dev", "metadata.json");
fs.writeFileSync(devPath, baselineMeta("h-dev-new", "h-dev-new"));
fs.writeFileSync(path.join(run1, "profile", "resumes", "arch", "editorial-rules.md"), "- synthetic rule\n");
fs.appendFileSync(path.join(run1, "profile", "keyword-rejects.jsonl"), JSON.stringify({ term: "synthetic", rule: "unit" }) + "\n");
fs.writeFileSync(path.join(run1, "profile", "cv", "meta.yaml"), "source_file: master-v2.docx\n");
f = await D.finishRun("u1", { ...deps, keep: true });
assert.deepEqual(f.artefacts!.approvalRestored, ["dev"]);
const devUploaded = JSON.parse((t.current("targetPositioningId", devId, "metadata.json") ?? Buffer.from("{}")).toString());
assert.notEqual(devUploaded.approved_hash, "h-dev-new", "the uploaded baseline metadata grants nothing");
assert.equal(JSON.parse(fs.readFileSync(devPath, "utf8")).approval_status, "fresh");
assert.equal(t.db.positionings.find((p) => p.id === devId)!.approvalStatus, "APPROVED", "the record's approval is untouched here");

const rulesProposal = t.db.proposals.find((p) => p.payload?.name === "resumes/arch/editorial-rules.md");
assert.ok(rulesProposal, "per-positioning rules are the person's: a proposal");
assert.equal(rulesProposal.proposalType, "UPDATE_DOCUMENT");
const rejects = t.db.documents.find((d) => d.kind === "KEYWORD_REJECTS");
assert.ok(rejects, "keyword rejects are a machine document");
assert.equal(t.db.documentRevisions.filter((r) => r.documentId === rejects.id).length, 1);
assert.equal(t.db.proposals.some((p) => p.payload?.kind === "KEYWORD_REJECTS"), false);

const cvProposal = t.db.proposals.find((p) => p.payload?.kind === "CV_SOURCE" && p.payload?.file === "cv/meta.yaml");
assert.ok(cvProposal, "a CV source file change is a proposal");
assert.equal(t.current("targetProposalId", cvProposal.id, "meta.yaml")!.toString(), "source_file: master-v2.docx\n");
assert.equal(t.current("targetDocumentId", cvDoc.id, "meta.yaml")!.toString(), "source_file: master.docx\n", "the CV source stays until the person confirms");
const proposalsNow = t.db.proposals.length;
f = await D.finishRun("u1", { ...deps, keep: true });
assert.equal(t.db.proposals.length, proposalsNow, "no duplicate proposals on a repeat finish");
assert.equal(f.artefacts!.uploaded.length, 0);

// A baseline re-render after approval makes the record stale.
const archDir = path.join(run1, "profile", "resumes", "arch");
fs.writeFileSync(path.join(archDir, "metadata.json"), baselineMeta("h-arch-2", "h-arch"));
fs.writeFileSync(path.join(archDir, "Synthetic_Architect.docx"), "PK re-rendered");
f = await D.finishRun("u1", { ...deps, keep: true });
assert.deepEqual(f.artefacts!.positionings, ["arch"]);
const arch = t.db.positionings.find((p) => p.id === archId)!;
assert.deepEqual([arch.approvalStatus, arch.contentHash], ["STALE", "h-arch-2"]);

f = await D.finishRun("u1", deps);
assert.equal(f.removed, true);
assert.equal(fs.existsSync(run1), false);

// ---------------------------------------------------------------- fail closed

const m2 = await D.materialise({ ...deps, runId: "u2" });
process.env.HARNESS_RUN_ID = "u2";
assert.equal(fs.readFileSync(path.join(m2.dir, "archive", hid, "cover-letter.md"), "utf8"), letter2, "the next run sees the uploaded bytes");
const letter3 = "Dear team,\n\nA third synthetic letter.\n";
fs.writeFileSync(path.join(m2.dir, "archive", hid, "cover-letter.md"), letter3);
fs.writeFileSync(path.join(m2.dir, "archive", hid, "letter-critic.json"), critic(letter3));
t.failPut.count = 1;
await assert.rejects(D.finishRun("u2", deps), /upload PUT 503/);
assert.equal(fs.existsSync(m2.dir), true, "a failed finish keeps the cache");
assert.equal(fs.existsSync(path.join(m2.dir, D.FINISH_FAILED)), true);
assert.deepEqual(D.pruneStaleRuns(root, 0, Date.now() + 1e9), [], "a cache awaiting retry is never pruned");

const m3 = await D.materialise({ ...deps, runId: "u3" });
assert.deepEqual(m3.retried, [{ runId: "u2", ok: true }]);
assert.equal(fs.existsSync(m2.dir), false, "the retried run is finished and removed");
assert.equal(fs.readFileSync(path.join(m3.dir, "archive", hid, "cover-letter.md"), "utf8"), letter3, "the retry uploaded before this run downloaded");
assert.equal((await readCurrentVerdict(path.join(m3.dir, "archive", hid, "letter-critic.json"), letter3)).ok, true);
await D.finishRun("u3", deps);

// A materialise that can't download removes its partial cache and throws.
t.blobs.clear();
await assert.rejects(D.materialise({ ...deps, runId: "u4" }), /download/);
assert.equal(fs.existsSync(D.runCacheDir("u4", root)), false);

// A package for an opening Twenty doesn't have: finish refuses.
t.db.openings.length = 0;
t.db.attachments.length = 0;
const m5 = await D.materialise({ ...deps, runId: "u5" });
fs.mkdirSync(path.join(m5.dir, "archive", "seek-ghost"), { recursive: true });
fs.writeFileSync(path.join(m5.dir, "archive", "seek-ghost", "cover-letter.md"), "x\n");
await assert.rejects(D.finishRun("u5", deps), /no opening in Twenty/);
fs.rmSync(m5.dir, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- integration

const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_KEY;
if (!url || !key) {
  console.log("twenty-artefacts: unit ok; integration skipped (set TWENTY_TEST_URL and TWENTY_TEST_KEY)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("integration runs only against a local test instance");

const iroot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twenty-artefacts-itest-")));
process.env.HARNESS_REPO_ROOT = iroot;
process.env.HARNESS_STORE = "twenty";
process.env.TWENTY_API_URL = url;
process.env.TWENTY_API_KEY = key;
delete process.env.HARNESS_RUN_ID;
const { connect } = await import("../tools/twenty/records.ts");
const call = await connect({ url, key });
const ideps = { config: { url, key }, root: iroot };

const tag = `itest-${Date.now()}`;
const ihid = `itest-pkg-${Date.now()}`;
await call("POST", "/rest/batch/openings?upsert=true", [{ id: openingId(ihid), harnessId: ihid, title: `Synthetic ${tag}`, status: "DRAFTED", harnessData: { id: ihid, title: `Synthetic ${tag}`, company: "Example Pty Ltd", status: "drafted" } }]);

// Run A: prepare the package in the run cache and finish.
const ma = await D.materialise({ ...ideps, runId: `${tag}-a` });
process.env.HARNESS_RUN_ID = `${tag}-a`;
const adir = P.archiveDir(ihid);
assert.ok(adir.startsWith(ma.dir));
fs.mkdirSync(adir, { recursive: true });
const iletter = `Dear team,\n\nSynthetic letter ${tag}.\n`;
const ipdf = Buffer.from(`%PDF-1.4 synthetic ${tag}\n`);
fs.writeFileSync(path.join(adir, "cover-letter.md"), iletter);
fs.writeFileSync(path.join(adir, "letter-critic.json"), critic(iletter));
fs.writeFileSync(path.join(adir, "Synthetic_CV.pdf"), ipdf);
const fa = await D.finishRun(`${tag}-a`, ideps);
assert.deepEqual(fa.artefacts!.uploaded.map((u) => u.name).sort(), ["Synthetic_CV.pdf", "cover-letter.md", "letter-critic.json"]);
const iapp = (await call("GET", `/rest/applications/${uuid5(`application:${ihid}`)}`)).data.application;
assert.equal(iapp.letterSha, sha(iletter));

// Run B: a new run downloads the same bytes, and the gate's letter check passes.
delete process.env.HARNESS_RUN_ID;
const mb = await D.materialise({ ...ideps, runId: `${tag}-b` });
process.env.HARNESS_RUN_ID = `${tag}-b`;
const bdir = P.archiveDir(ihid);
assert.ok(bdir.startsWith(mb.dir));
const bletter = fs.readFileSync(path.join(bdir, "cover-letter.md"), "utf8");
assert.equal(bletter, iletter);
assert.equal(sha(bletter), sha(iletter));
assert.deepEqual(fs.readFileSync(path.join(bdir, "Synthetic_CV.pdf")), ipdf);
const verdict = await readCurrentVerdict(path.join(bdir, "letter-critic.json"), bletter);
assert.equal(verdict.ok, true, verdict.detail);
const fb = await D.finishRun(`${tag}-b`, ideps);
assert.equal(fb.artefacts!.uploaded.length, 0, "unchanged files are not uploaded again");

// Clean up: move the synthetic opening out of the active states.
await call("PATCH", `/rest/openings/${openingId(ihid)}`, { status: "REJECTED" });
fs.rmSync(iroot, { recursive: true, force: true });
console.log("twenty-artefacts: unit and integration ok");
