#!/usr/bin/env tsx
/**
 * twenty-documents.test.ts: the person's documents on either store (plan F10, F22).
 *
 * Unit (always, against an in-memory fake of Twenty's REST API in a temp
 * repo): materialise writes each current revision into the run cache under
 * today's file names and fails closed; the profile resolver reads the cache
 * on the Twenty store and state/profile in file mode; saveDocument turns a
 * person-owned kind into an UPDATE_DOCUMENT proposal and a machine kind into
 * a new revision; finishRun saves what changed and deletes the cache; the
 * runtime paths and the journal follow the store.
 *
 * Integration (TWENTY_TEST_URL and TWENTY_TEST_KEY set, a local test instance
 * only, Harness-role key): seed a document, materialise, read it through the
 * resolver, save a machine revision, and propose a person-owned change.
 * Synthetic data only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twenty-documents-")));
process.env.HARNESS_REPO_ROOT = root;
delete process.env.HARNESS_RUN_ID;
delete process.env.HARNESS_PROFILE;
delete process.env.HARNESS_STORE;

const D = await import("../tools/store/documents.ts");
const { resolveProfileContext, profilePath } = await import("../tools/profile-context.ts");
const P = await import("../tools/store/paths.ts");
const R = await import("../tools/store/runs.ts");

// ---------------------------------------------------------------- fake Twenty

type Rec = Record<string, any>;
function fakeTwenty() {
  const db: Record<string, Rec[]> = { documents: [], documentRevisions: [], proposals: [], runs: [], openings: [], positionings: [], attachments: [] };
  const calls: { method: string; path: string; body?: any }[] = [];
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const matches = (rec: Rec, filter: string): boolean => {
    const m = filter.match(/^and\((.*)\)$/);
    const parts = m ? m[1].split(/,(?=\w+\[)/) : [filter];
    return parts.every((p) => {
      const q = p.match(/^(\w+)\[eq\]:(.*)$/);
      if (!q) throw new Error(`fake: unsupported filter ${p}`);
      const want = q[2].startsWith('"') ? JSON.parse(q[2]) : q[2];
      return String(rec[q[1]]) === want;
    });
  };
  let fail = false;
  const call = async (method: string, p: string, body?: any): Promise<any> => {
    calls.push({ method, path: p, body });
    if (fail) throw new Error("Twenty GET /rest/documents 503: unavailable");
    const url = new URL(p, "http://fake");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "rest" && parts[1] === "batch") {
      const plural = parts[2];
      for (const r of body) {
        const at = db[plural].findIndex((x) => x.id === r.id);
        if (at >= 0) db[plural][at] = { ...db[plural][at], ...r }; else db[plural].push({ ...r });
      }
      return { data: {} };
    }
    const plural = parts[1];
    if (method === "GET") {
      const filter = url.searchParams.get("filter");
      const rows = db[plural].filter((r) => !filter || matches(r, filter));
      return { data: { [plural]: rows }, pageInfo: { hasNextPage: false } };
    }
    if (method === "POST") {
      const rec = { id: id(), ...body };
      db[plural].push(rec);
      const singular = plural.replace(/s$/, "");
      return { data: { [`create${singular[0].toUpperCase()}${singular.slice(1)}`]: rec } };
    }
    if (method === "PATCH") {
      const rec = db[plural].find((r) => r.id === parts[2]);
      Object.assign(rec!, body);
      return { data: {} };
    }
    throw new Error(`fake: ${method} ${p}`);
  };
  const seed = (kind: string, name: string, revisions: string[], current = revisions.length) => {
    const doc = { id: id(), kind, name, currentRevision: current };
    db.documents.push(doc);
    revisions.forEach((body, i) => db.documentRevisions.push({ id: id(), documentId: doc.id, revision: i + 1, kind, body }));
    return doc;
  };
  return { db, calls, call, seed, setFail: (v: boolean) => { fail = v; } };
}

// ---------------------------------------------------------------- file mode

{
  assert.equal(D.isTwentyStore(), false);
  assert.equal(D.currentProfileDir(), path.join(root, "state", "profile"));
  assert.equal(D.currentProfileDir("alex"), path.join(root, "state", "profiles", "alex"));
  assert.equal(resolveProfileContext().cvSourcePath, path.join(root, "state", "profile", "cv-source.md"));
  assert.equal(profilePath("channels.yaml"), path.join(root, "state", "profile", "channels.yaml"));
  assert.equal(P.archiveDir("row-1"), path.join(root, "state", "pipeline", "archive", "row-1"));
  assert.equal(P.pipelineFile("approval-queue.json"), path.join(root, "state", "pipeline", "approval-queue.json"));
  assert.equal(P.journalPath("summary"), path.join(root, "state", "journal", "summary"));
  assert.equal(P.orgDocumentPath("keyword-clouds.yaml"), path.join(root, "state", "org", "keyword-clouds.yaml"));

  // saveDocument writes the file, as tools always have.
  const r = await D.saveDocument("SCREENING_ANSWERS", "answers: []\n");
  assert.equal(r.action, "written");
  assert.equal(fs.readFileSync(path.join(root, "state", "profile", "screening-answers.yaml"), "utf8"), "answers: []\n");
  const k = await D.saveDocument("KEYWORD_CLOUDS", "clouds: {}\n");
  assert.equal((k as any).path, path.join(root, "state", "org", "keyword-clouds.yaml"));

  // The journal is a file.
  const j = await R.appendJournal("# Day\n", { date: "2026-11-23" });
  assert.equal(j.file, path.join(root, "state", "journal", "2026-11-23.md"));
  assert.equal(j.runId, undefined);
}

// ---------------------------------------------------------------- document mapping

assert.equal(D.fileForDocument({ kind: "CV_SOURCE" }), "cv-source.md");
assert.equal(D.fileForDocument({ kind: "OTHER", name: "jev-policy.yaml" }), "jev-policy.yaml");
assert.equal(D.fileForDocument({ kind: "OTHER", name: "../escape.yaml" }), null);
assert.equal(D.fileForDocument({ kind: "OTHER", name: "Free text name" }), null);
assert.deepEqual(D.documentForFile("resumes.yaml"), { kind: "POSITIONINGS", name: "Positionings" });
assert.deepEqual(D.documentForFile("jev-policy.yaml"), { kind: "OTHER", name: "jev-policy.yaml" });
assert.ok(D.MACHINE_KINDS.has("KEYWORD_CLOUDS") && !D.MACHINE_KINDS.has("PROFILE"));

// ---------------------------------------------------------------- Twenty mode

process.env.HARNESS_STORE = "twenty";
{
  const t = fakeTwenty();
  t.seed("PROFILE", "Profile", ["# Profile r1\n", "# Profile r2\n"]);
  t.seed("KEYWORD_CLOUDS", "Keyword clouds", ["clouds:\n  a: [x]\n"]);
  t.seed("OTHER", "jev-policy.yaml", ["model: test\n"]);
  t.seed("OTHER", "a note without a file name", ["ignored"]);

  const m = await D.materialise({ call: t.call, runId: "unit-1" });
  assert.equal(m.dir, path.join(root, "state", "cache", "run-unit-1"));
  assert.deepEqual(m.files, ["jev-policy.yaml", "keyword-clouds.yaml", "profile.md"]);
  assert.equal(fs.readFileSync(path.join(m.profileDir, "profile.md"), "utf8"), "# Profile r2\n", "the current revision, not the first");

  // Nothing in state/profile; the resolver reads the cache.
  process.env.HARNESS_RUN_ID = "unit-1";
  assert.equal(fs.existsSync(path.join(root, "state", "profile", "profile.md")), false);
  assert.equal(D.currentProfileDir(), m.profileDir);
  assert.equal(D.currentProfileDir("ignored-team-id"), m.profileDir);
  const ctx = resolveProfileContext();
  assert.equal(ctx.profileMdPath, path.join(m.profileDir, "profile.md"));
  assert.equal(fs.readFileSync(ctx.profileMdPath, "utf8"), "# Profile r2\n");
  assert.equal(resolveProfileContext(null, { files: true }).profileDir, path.join(root, "state", "profile"), "the migration still reads the files");
  assert.equal(P.orgDocumentPath("keyword-clouds.yaml"), path.join(m.profileDir, "keyword-clouds.yaml"));
  assert.equal(P.archiveDir("row-1"), path.join(root, "state", "cache", "run-unit-1", "archive", "row-1"));
  assert.equal(P.pipelineFile("q.json"), path.join(root, "state", "cache", "pipeline", "q.json"));
  assert.equal(P.journalPath("summary"), path.join(root, "state", "logs", "journal", "summary"));

  // Person-owned kind: a proposal, and the document is untouched.
  const before = t.db.documentRevisions.length;
  const p = await D.saveDocument("PROFILE", "# Profile r3\n", { call: t.call, reason: "unit" });
  assert.equal(p.action, "proposed");
  assert.equal(t.db.documentRevisions.length, before, "no revision for a person-owned kind");
  const prop = t.db.proposals.at(-1)!;
  assert.equal(prop.proposalType, "UPDATE_DOCUMENT");
  assert.equal(prop.proposer, "HARNESS");
  assert.equal(prop.status, "PROPOSED");
  assert.deepEqual({ kind: prop.payload.kind, baseRevision: prop.payload.baseRevision, body: prop.payload.body }, { kind: "PROFILE", baseRevision: 2, body: "# Profile r3\n" });
  assert.equal(t.db.documents.find((d) => d.kind === "PROFILE")!.currentRevision, 2);

  // Machine kind: a new revision, current moves.
  const r = await D.saveDocument("KEYWORD_CLOUDS", "clouds:\n  a: [x, y]\n", { call: t.call });
  assert.deepEqual({ action: r.action, revision: (r as any).revision }, { action: "revision", revision: 2 });
  const kc = t.db.documents.find((d) => d.kind === "KEYWORD_CLOUDS")!;
  assert.equal(kc.currentRevision, 2);
  const rev2 = t.db.documentRevisions.find((x) => x.documentId === kc.id && x.revision === 2)!;
  assert.deepEqual({ base: rev2.baseRevision, body: rev2.body }, { base: 1, body: "clouds:\n  a: [x, y]\n" });

  // The same body again changes nothing.
  assert.equal((await D.saveDocument("KEYWORD_CLOUDS", "clouds:\n  a: [x, y]\n", { call: t.call })).action, "unchanged");

  // A machine kind with no document yet gets one.
  const mc = await D.saveDocument("MARKET_CONFIRMATIONS", "confirmations: []\n", { call: t.call });
  assert.deepEqual({ action: mc.action, revision: (mc as any).revision }, { action: "revision", revision: 1 });

  // finishRun: changed files are saved by ownership, unchanged ones skipped, the cache deleted.
  fs.writeFileSync(path.join(m.profileDir, "profile.md"), "# Profile edited in run\n");
  fs.writeFileSync(path.join(m.profileDir, "keyword-clouds.yaml"), "clouds:\n  b: [z]\n");
  fs.writeFileSync(path.join(m.profileDir, "channels.yaml"), "channels: {}\n");
  const proposalsBefore = t.db.proposals.length;
  const f = await D.finishRun("unit-1", { call: t.call });
  assert.deepEqual(f.saved.map((s) => [s.kind, s.action]).sort(), [["CHANNELS", "proposed"], ["KEYWORD_CLOUDS", "revision"], ["PROFILE", "proposed"]]);
  assert.equal(t.db.proposals.length, proposalsBefore + 2);
  assert.equal(fs.existsSync(m.dir), false, "the cache is deleted at run end");

  // A run id with no cache fails closed.
  assert.throws(() => D.currentProfileDir(), /no materialised cache/);
  delete process.env.HARNESS_RUN_ID;

  // Fail closed: an unreachable workspace throws and leaves no partial cache.
  t.setFail(true);
  await assert.rejects(D.materialise({ call: t.call, runId: "unit-2" }), /503/);
  assert.equal(fs.existsSync(D.runCacheDir("unit-2")), false);
  t.setFail(false);

  // A document without a body is an error, not an empty file.
  const broken = fakeTwenty();
  broken.db.documents.push({ id: "doc-x", kind: "CHANNELS", name: "Channels", currentRevision: 1 });
  await assert.rejects(D.materialise({ call: broken.call, runId: "unit-3" }), /no current revision body/);
  assert.equal(fs.existsSync(D.runCacheDir("unit-3")), false);

  // Stale caches are pruned.
  const stale = D.runCacheDir("stale-1");
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  assert.deepEqual(D.pruneStaleRuns(root), ["run-stale-1"]);

  // The journal: a local log plus the day's run record.
  const j = await R.appendJournal("## Sent unattended\n- none\n", { date: "2026-11-23", call: t.call });
  assert.equal(j.file, path.join(root, "state", "logs", "journal", "2026-11-23.md"));
  assert.equal(j.runId, await R.runRecordId("journal:DAILY:2026-11-23"));
  await R.appendJournal("## Parked\n- none\n", { date: "2026-11-23", call: t.call });
  const runs = t.db.runs.filter((x) => x.id === j.runId);
  assert.equal(runs.length, 1, "one run record per day, updated in place");
  assert.match(runs[0].summary, /Sent unattended[\s\S]*Parked/);
}

delete process.env.HARNESS_STORE;
fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- integration

const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_KEY;
if (!url || !key) {
  console.log("twenty-documents: unit ok; integration skipped (set TWENTY_TEST_URL and TWENTY_TEST_KEY)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("integration runs only against a local test instance");

const iroot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twenty-documents-itest-")));
process.env.HARNESS_REPO_ROOT = iroot;
process.env.HARNESS_STORE = "twenty";
process.env.TWENTY_API_URL = url;
process.env.TWENTY_API_KEY = key;
const { connect } = await import("../tools/twenty/records.ts");
const call = await connect({ url, key });

const tag = `itest-${Date.now()}`;
const file = `${tag}.md`;
const doc = (await call("POST", "/rest/documents", { name: file, kind: "OTHER", currentRevision: 1 })).data.createDocument;
await call("POST", "/rest/documentRevisions", { name: `${file} r1`, revision: 1, kind: "OTHER", body: `# ${tag}\n`, documentId: doc.id });

const m = await D.materialise({ call, runId: tag });
process.env.HARNESS_RUN_ID = tag;
assert.ok(m.files.includes(file), "the seeded document is materialised");
assert.equal(fs.readFileSync(profilePath(file), "utf8"), `# ${tag}\n`, "read through the resolver");
assert.equal(resolveProfileContext().profileDir, m.profileDir);

// A machine revision, then restore the original body (also a revision).
const kcFile = path.join(m.profileDir, "keyword-clouds.yaml");
const original = fs.existsSync(kcFile) ? fs.readFileSync(kcFile, "utf8") : null;
const saved = await D.saveDocument("KEYWORD_CLOUDS", `${original ?? ""}# ${tag}\n`, { call });
assert.equal(saved.action, "revision");
const kcDoc = (await call("GET", `/rest/documents/${(saved as any).documentId}`)).data.document;
assert.equal(kcDoc.currentRevision, (saved as any).revision);
if (original != null) assert.equal((await D.saveDocument("KEYWORD_CLOUDS", original, { call })).action, "revision");

// A person-owned change is a proposal, never a revision.
const proposed = await D.saveDocument("OTHER", `# ${tag} edited\n`, { call, name: file });
assert.equal(proposed.action, "proposed");
const prop = (await call("GET", `/rest/proposals/${(proposed as any).proposalId}`)).data.proposal;
assert.equal(prop.proposalType, "UPDATE_DOCUMENT");
assert.equal(prop.payload.documentId, doc.id);
const docAfter = (await call("GET", `/rest/documents/${doc.id}`)).data.document;
assert.equal(docAfter.currentRevision, 1, "the person's document is untouched");

const f = await D.finishRun(tag, { call });
assert.deepEqual(f.saved, []);
assert.equal(fs.existsSync(m.dir), false);
fs.rmSync(iroot, { recursive: true, force: true });
console.log("twenty-documents: unit and integration ok");
