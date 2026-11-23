#!/usr/bin/env tsx
/**
 * twenty-migrate.test.ts: the one-time migration's scope, plan and idempotence.
 *
 * Unit: the scope rule (owner, Q4), the per-object readers, contact
 * minimisation (F18), the cutover guard, and a whole plan over a synthetic
 * state/ tree. Integration (TWENTY_TEST_URL and TWENTY_TEST_KEY set, local
 * test instance only): seed a temp SQLite store and synthetic files, apply,
 * expect the counts per object including uploaded attachments, then apply
 * again and expect 0 creates. Synthetic data only.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, Packer, Paragraph } from "docx";
import { cutoverRefusal, inScope, isLocalUrl, planCounts } from "../tools/twenty/migrate.ts";
import {
  applicationFields, buildPlan, confirmationRef, criticVerdict, dedupeContacts, keywordAnswer,
  minimise, personRecord, recordId, runFromSummary,
} from "../tools/twenty/migrate-plan.ts";

// ---------------------------------------------------------------- scope rule

const none = () => false;
const r = (status: string, extra: Record<string, unknown> = {}): any => ({ id: "x", status, history: [{ to: "discovered" }], ...extra });
assert.equal(inScope(r("discovered"), none).keep, true);
assert.equal(inScope(r("rejected"), none).keep, false);
assert.equal(inScope(r("rejected", { history: [{ to: "drafted" }, { to: "rejected" }] }), none).keep, true);
assert.equal(inScope(r("withdrawn", { userSaved: true }), none).keep, true);
assert.equal(inScope(r("rejected", { parkedBy: "user" }), none).keep, true);
assert.equal(inScope(r("rejected"), () => true).keep, true);

// ------------------------------------------------------------------ readers

assert.equal(criticVerdict("pass"), "PASS");
assert.equal(criticVerdict("block"), "BLOCK");
assert.equal(criticVerdict("revise"), "BLOCK");
assert.equal(criticVerdict(undefined), "PENDING");
assert.equal(confirmationRef("Quick Apply submitted.\n\nConfirmation text: Application sent\nRun: r1\n"), "Application sent");
assert.equal(confirmationRef("SEEK application confirmed on screen\nmore"), "SEEK application confirmed on screen");
assert.equal(confirmationRef("Confirmation text: (none captured)\n"), null);
assert.equal(confirmationRef(null), null);

const row: any = { id: "seek-1", title: "Architect", company: "Acme", status: "submitted", submittedAt: "2026-01-02T03:04:05.000Z" };
assert.deepEqual(applicationFields({ resume: { mode: "baseline" }, keyword_coverage: { surfaced_pct: 80 }, submittedAt: "2026-01-03T00:00:00Z" }, row, "submitted unattended (autopilot).\nConfirmation text: ok"), {
  cvMode: "BASELINE", keywordCoverage: 80, submittedAt: "2026-01-03T00:00:00.000Z", actor: "autopilot", confirmationRef: "ok",
});
assert.deepEqual(applicationFields({ mode: "tailored", keywordCoverage: { renderable_pct: 55 } }, row, null), {
  cvMode: "TAILORED", keywordCoverage: 55, submittedAt: "2026-01-02T03:04:05.000Z", actor: null, confirmationRef: null,
});
assert.deepEqual(applicationFields(null, { ...row, submittedAt: undefined }, null).cvMode, null);

assert.deepEqual(keywordAnswer("confirmed"), { answer: "CONFIRM", status: "ANSWERED" });
assert.deepEqual(keywordAnswer("declined"), { answer: "NOT_APPLICABLE", status: "ANSWERED" });
assert.deepEqual(keywordAnswer("familiarity"), { answer: "FAMILIARITY", status: "ANSWERED" });
assert.deepEqual(keywordAnswer("pending"), { answer: "PENDING", status: "OPEN" });

const summaryText = (sent: number) => [
  "# Daily summary 2026-01-05", "", "Two sent.", "", "## Sent today", "", "- 9:00 am Lead at Acme.", "",
  "## Escalations (your action)", "", "- Lead at Acme [seek-1]: blocked. Next: look.", "- Other: x. Next: y.", "",
  "## Numbers", "", "| Sent today | Autopilot sends |", "|---|---|", `| ${sent} | 1 of 5 |`, "", "Kill switch off. Generated 2026-01-05T08:00:00.000Z.", "",
].join("\n");
const run = runFromSummary("2026-01-05", summaryText(2), "M");
assert.equal(run.id, recordId("run", "summary:2026-01-05"));
assert.equal(run.record.sentCount, 2);
assert.equal(run.record.escalationCount, 2);
assert.equal(run.record.finishedAt, "2026-01-05T08:00:00.000Z");
assert.equal(run.record.kind, "DAILY");
assert.equal(run.record.migratedAt, "M");

// --------------------------------------------------------- F18 minimisation

const full = { name: "Sam Example", email: "Sam@Example.com", phone: "+61 400 000 000", linkedin_url: "http://linkedin.com/in/sam-example/?x=1", role_title: "Recruiter", company: "Agency Pty", notes: "free text" };
const min = minimise(full)!;
assert.deepEqual(min, { name: "Sam Example", roleTitle: "Recruiter", company: "Agency Pty", email: "sam@example.com", linkedinUrl: "https://www.linkedin.com/in/sam-example" });
assert.equal(minimise(null), null);
const d = dedupeContacts([
  min,
  { name: null, roleTitle: "Senior recruiter", company: null, email: null, linkedinUrl: "https://www.linkedin.com/in/sam-example" },
  { name: "Lee Example", roleTitle: null, company: null, email: "lee@example.com", linkedinUrl: null },
  { name: "No Key", roleTitle: null, company: "X", email: null, linkedinUrl: null },
]);
assert.equal(d.contacts.length, 2);
assert.equal(d.unkeyed, 1);
assert.equal(d.contacts[0].roleTitle, "Recruiter", "first value wins; merge fills only empty fields");
const pr = personRecord(min);
assert.deepEqual(Object.keys(pr.record).sort(), ["companyId", "emails", "id", "jobTitle", "linkedinLink", "name"]);
assert.equal(JSON.stringify(pr.record).includes("400 000"), false, "phone is dropped");

// ------------------------------------------------------------- cutover guard

const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-marker-"));
const marker = path.join(markerDir, "last-backup.json");
assert.equal(isLocalUrl("http://127.0.0.1:2021"), true);
assert.equal(isLocalUrl("http://localhost:3000"), true);
assert.equal(isLocalUrl("https://crm.example.com"), false);
const now = Date.parse("2026-02-01T12:00:00Z");
assert.equal(await cutoverRefusal("http://127.0.0.1:2021", false, now, marker), null);
assert.match((await cutoverRefusal("https://crm.example.com", false, now, marker))!, /confirm-cutover/);
assert.match((await cutoverRefusal("https://crm.example.com", true, now, marker))!, /no backup marker/);
fs.writeFileSync(marker, JSON.stringify({ at: "2026-01-30T12:00:00Z" }));
assert.match((await cutoverRefusal("https://crm.example.com", true, now, marker))!, /more than 24 hours/);
fs.writeFileSync(marker, JSON.stringify({ at: "2026-02-01T02:00:00Z" }));
assert.equal(await cutoverRefusal("https://crm.example.com", true, now, marker), null);
fs.rmSync(markerDir, { recursive: true, force: true });

// ---------------------------------------------------------- synthetic tree

// Twenty checks uploaded content against the extension, so the fixtures are
// real (tiny, synthetic) PNG, PDF and DOCX files.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
const DOCX = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Synthetic document")] }] }));

/**
 * A synthetic state/ tree. `tag` makes every per-run id unique (positioning,
 * keyword terms, contacts, companies) so repeated runs against one test
 * instance still see their own creates. Document kinds and run dates are
 * fixed by design, so those ids repeat across runs.
 */
function makeTree(root: string, tag: string, archived: { id: string; title: string }, otherOpp: string): void {
  const put = (rel: string, text: string | Buffer) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "synthetic\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "job-hunt-career-harness" }));
  const prof = "state/profile";
  put(`${prof}/profile.md`, "---\nname: Jane Citizen\nemail: jane@example.com\nlocale:\n  timezone: Australia/Sydney\n---\n\nSynthetic profile.\n");
  put(`${prof}/cv-source.md`, "# CV source\n\nSynthetic.\n");
  put(`${prof}/voice-rules.md`, "Voice rules.\n");
  put(`${prof}/voice-samples.md`, "Samples.\n");
  put("state/org/slop-banlist.md", "- delve\n");
  put(`${prof}/resume-editorial-rules.md`, "Rules.\n");
  put(`${prof}/editorial-bans.yaml`, "bans: []\n");
  put(`${prof}/letter-critic-rules.yaml`, "rules: []\n");
  put(`${prof}/channels.yaml`, "channels: []\n");
  put(`${prof}/scoring-weights.yaml`, "weights: {}\n");
  put(`${prof}/submission-policy.yaml`, "kill_switch: true\nautopilot:\n  enabled: false\n");
  put("state/org/keyword-clouds.yaml", "clouds: {}\n");
  const resumeId = `arch-${tag}`;
  put(`${prof}/resumes.yaml`, [
    "resumes:",
    `  - id: ${resumeId}`, "    label: Synthetic Architect", "    active: true",
    "    search_keywords: [architect]", "    should: []", "    could: []", "    flagged: []",
    "    cover_letter_angle: synthetic", "    preferred_channels: []",
    "    rate_band: { floor: 1000, target: 1200, ceiling: 1400, currency: AUD, billing_unit: day, gst_handling: excl }", "",
  ].join("\n"));
  put(`${prof}/resumes/${resumeId}/metadata.json`, JSON.stringify({ approval_status: "approved", approved_at: "2026-01-01T00:00:00Z", content_hash: "abc", critic: { verdict: "pass" }, artefacts: { pdf: "/elsewhere/Synthetic_Architect.pdf", docx: "/elsewhere/Synthetic_Architect.docx" } }));
  put(`${prof}/resumes/${resumeId}/Synthetic_Architect.pdf`, pdf("baseline"));
  put(`${prof}/resumes/${resumeId}/Synthetic_Architect.docx`, DOCX);
  put(`${prof}/resumes/${resumeId}/Synthetic_Architect-page-1.png`, PNG);
  put(`${prof}/resumes/${resumeId}/editorial-rules.md`, "- synthetic positioning rule\n");
  put(`${prof}/cv/meta.yaml`, "source_file: synthetic.docx\n");
  put(`${prof}/screening-answers.yaml`, [
    "answers: {}", "unknown_questions:",
    `  - opportunity_id: ${archived.id}`, `    question: "Do you hold a synthetic licence ${tag}?"`, "    answer: null",
    `  - opportunity_id: ${archived.id}`, `    question: "Do you hold a SYNTHETIC licence ${tag}"`, "    answer: null",
    `  - opportunity_id: ${otherOpp}`, `    question: "Notice period ${tag}?"`, "    answer: Two weeks", "",
  ].join("\n"));
  put(`${prof}/market-confirmations.yaml`, [
    "confirmations:",
    `  - { resume_id: ${resumeId}, kind: keyword, scope: person, signal: "Term A ${tag}", status: pending, category: platform }`,
    `  - { resume_id: other, kind: keyword, scope: person, signal: "term a ${tag}", status: confirmed }`,
    `  - { resume_id: ${resumeId}, kind: market_signal, scope: resume, signal: "Signal B ${tag}", status: familiarity, opportunity_id: ${archived.id} }`, "",
  ].join("\n"));

  const a = `state/pipeline/archive/${archived.id}`;
  put(`${a}/cover-letter.md`, `Dear team,\n\nSynthetic letter ${tag}.\n`);
  put(`${a}/letter-critic.json`, JSON.stringify({ verdict: "pass", findings: [] }));
  put(`${a}/metadata.json`, JSON.stringify({ resume: { mode: "baseline", ref: `${prof}/resumes/${resumeId}/Synthetic_Architect.docx` }, keyword_coverage: { surfaced_pct: 75 } }));
  put(`${a}/confirmation.txt`, "Quick Apply application submitted unattended (autopilot).\n\nConfirmation text: Application sent\n");
  put(`${a}/manual-checklist.md`, "- [ ] synthetic step\n");
  put(`${a}/interview-brief.md`, "# Brief\n\nSynthetic brief.\n");
  put(`${a}/Synthetic_Tailored.pdf`, pdf("tailored"));
  put(`${a}/Synthetic_Tailored.docx`, DOCX);
  put(`${a}/Synthetic_Tailored-page-1.png`, PNG);
  put(`${a}/seek-x-success.png`, PNG);
  put(`${a}/jd.md`, "Synthetic JD.\n");

  put("state/journal/summary/2001-01-01.md", summaryText(0));
  put("state/journal/summary/2001-01-02.md", summaryText(1));
  put("state/journal/summary/notes.md", "not a summary");

  put("state/audit/contacts.jsonl", [
    JSON.stringify({ ts: "t", role_id: archived.id, contact: { name: "Sam Example", email: `sam-${tag}@example.com`, phone: "+61 400 000 000", role_title: "Recruiter", company: `Agency ${tag}` } }),
    JSON.stringify({ ts: "t", role_id: archived.id, contact: { name: "Sam Example", email: `SAM-${tag}@example.com` } }),
    "",
  ].join("\n"));
  put("state/audit/audit-log.jsonl", [
    JSON.stringify({ ts: "t", event_type: "discovered", role_id: "z", contact: null }),
    JSON.stringify({ ts: "t", event_type: "follow_up_sent_externally", role_id: "z", contact: { name: "Lee Example", linkedin_url: `https://linkedin.com/in/lee-${tag}` } }),
    JSON.stringify({ ts: "t", event_type: "follow_up_sent_externally", role_id: "z", contact: { name: "Nobody" } }),
    "",
  ].join("\n"));
}

const EXPECTED = { company: 1, positioning: 1, document: 16, documentRevision: 16, application: 1, screeningQuestion: 2, keywordQuestion: 2, run: 2, person: 2, note: 1, attachment: 15 };

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-unit-"));
  const tag = `u${Date.now()}`;
  const archived = { id: "seek-unit-1", title: "Architect" };
  makeTree(tmp, tag, archived, "seek-unit-out-of-scope");
  const prevRoot = process.env.HARNESS_REPO_ROOT;
  const prevAudit = process.env.AUDIT_DIR;
  process.env.HARNESS_REPO_ROOT = tmp;
  process.env.AUDIT_DIR = path.join(tmp, "state", "audit");
  const rows: any[] = [
    { id: archived.id, title: "Architect", company: "Acme", channel: "seek", status: "submitted", history: [] },
    { id: "seek-unit-2", title: "Lead", company: "Globex", channel: "seek", status: "discovered", history: [] },
  ];
  const plan = await buildPlan(rows, "2026-02-01T00:00:00.000Z");
  const counts = planCounts(rows.length, plan);
  assert.deepEqual(counts, { opening: 2, ...EXPECTED });
  assert.deepEqual(plan.skipped, { "person: no email or LinkedIn URL": 1 });

  const app = plan.applications[0].record;
  assert.equal(app.id, recordId("application", archived.id));
  assert.equal(app.criticVerdict, "PASS");
  assert.equal(app.cvMode, "BASELINE");
  assert.equal(app.actor, "autopilot");
  assert.equal(app.confirmationRef, "Application sent");
  assert.equal(typeof app.letterSha, "string");
  assert.match(String(app.manualChecklist), /synthetic step/);
  assert.deepEqual(plan.attachments.filter((x) => x.targetField === "targetApplicationId").map((x) => x.name).sort(),
    ["Synthetic_Architect.docx", "Synthetic_Tailored.docx", "Synthetic_Tailored.pdf", "confirmation.txt", "cover-letter.md", "interview-brief.md", "jd.md", "letter-critic.json", "manual-checklist.md", "metadata.json", "seek-x-success.png"]);
  assert.deepEqual(plan.attachments.filter((x) => x.targetField === "targetPositioningId").map((x) => x.name).sort(), ["Synthetic_Architect.docx", "Synthetic_Architect.pdf", "metadata.json"]);
  assert.deepEqual(plan.attachments.filter((x) => x.targetField === "targetDocumentId").map((x) => x.name), ["meta.yaml"], "the profile's cv/ files attach to CV_SOURCE");
  assert.ok(plan.documents.some((x) => x.record.kind === "OTHER" && /^resumes\/arch-[^/]+\/editorial-rules\.md$/.test(String(x.record.name))), "per-positioning rules are a document");
  assert.equal(plan.positionings[0].record.approvalStatus, "APPROVED");
  assert.equal(plan.positionings[0].record.criticVerdict, "PASS");
  assert.deepEqual(plan.positionings[0].record.rateMin, { amountMicros: 1_000_000_000, currencyCode: "AUD" });
  assert.equal(plan.documents.every((x) => x.record.migratedAt && x.record.currentRevision === 1), true);
  assert.equal(plan.documentRevisions.find((x) => x.record.kind === "SLOP_BANLIST")!.record.body, "- delve\n");
  const sq = plan.screeningQuestions;
  assert.equal(sq.filter((q) => q.record.openingId).length, 1, "only in-scope openings are linked");
  assert.equal(sq.find((q) => q.record.answer)!.record.status, "ANSWERED");
  const kq = plan.keywordQuestions;
  assert.equal(kq.find((q) => q.record.status === "OPEN")!.record.positioningId, recordId("positioning", `arch-${tag}`));
  assert.equal(kq.find((q) => q.record.answer === "FAMILIARITY")!.record.openingId !== null, true);
  assert.equal(plan.notes[0].targetOpeningId !== "", true);
  for (const p of plan.people) assert.equal("phones" in p.record, false);
  // Every app record carries migratedAt; ids are stable across plans.
  for (const list of [plan.positionings, plan.documents, plan.documentRevisions, plan.applications, plan.screeningQuestions, plan.keywordQuestions, plan.runs]) {
    for (const x of list) assert.equal(x.record.migratedAt, "2026-02-01T00:00:00.000Z");
  }
  const again = await buildPlan(rows, "later");
  assert.deepEqual(again.attachments.map((x) => x.id), plan.attachments.map((x) => x.id));
  assert.deepEqual(again.people.map((x) => x.id), plan.people.map((x) => x.id));

  if (prevRoot === undefined) delete process.env.HARNESS_REPO_ROOT; else process.env.HARNESS_REPO_ROOT = prevRoot;
  if (prevAudit === undefined) delete process.env.AUDIT_DIR; else process.env.AUDIT_DIR = prevAudit;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------- integration

const url = process.env.TWENTY_TEST_URL;
const key = process.env.TWENTY_TEST_KEY;
if (!url || !key) { console.log("twenty-migrate: unit ok; integration skipped"); process.exit(0); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-itest-"));
const db = path.join(tmp, "pipeline.db");
const env: NodeJS.ProcessEnv = { ...process.env, PIPELINE_DB: db, AUDIT_DIR: path.join(tmp, "state", "audit"), HARNESS_REPO_ROOT: tmp, TWENTY_API_URL: url, TWENTY_API_KEY: key, HARNESS_STORE: "sqlite", TMPDIR: "/tmp" };
delete env.HARNESS_PROFILE;
fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "synthetic\n");
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "job-hunt-career-harness" }));

// Seed a synthetic SQLite store: two active rows and one untouched reject.
const seedFile = path.join(tmp, "seed.mts");
fs.writeFileSync(seedFile, `
  const P = await import(${JSON.stringify(path.join(repo, "tools/pipeline.ts"))});
  const tag = "mig-" + Date.now();
  const rows = await P.upsertMany([
    { channel: "seek", url: "https://example.com/" + tag + "/1", title: "Architect", company: "Acme Pty Ltd" },
    { channel: "seek", url: "https://example.com/" + tag + "/2", title: "Lead", company: "Globex Ltd" },
    { channel: "seek", url: "https://example.com/" + tag + "/3", title: "Noise", company: "Initech" },
  ], { digest: false });
  await P.setStatus(rows[2].id, "rejected", "auto", { actor: "itest" });
  console.log(JSON.stringify(rows.map((r) => r.id)));
`);
const seed = spawnSync("npx", ["tsx", seedFile], { cwd: repo, env, encoding: "utf8" });
assert.equal(seed.status, 0, seed.stderr);
const ids: string[] = JSON.parse(seed.stdout.trim().split("\n").pop()!);
const tag = `i${Date.now()}`;
makeTree(tmp, tag, { id: ids[0], title: "Architect" }, "seek-not-in-scope");

const runMigrate = (args: string[]) => {
  const p = spawnSync("npx", ["tsx", path.join(repo, "tools/twenty/migrate.ts"), ...args], { cwd: repo, env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return JSON.parse(p.stdout.trim().split("\n").pop()!);
};

const dry = runMigrate(["--dry-run"]);
assert.equal(dry.in_scope, 2);
const { escalation: _e, ...dryObjects } = dry.objects;
assert.deepEqual(dryObjects, { opening: 2, ...EXPECTED });
assert.equal(JSON.stringify(dry).includes("Synthetic letter"), false, "dry run prints counts only");

const first = runMigrate(["--apply"]);
const res = first.results;
// Per-run unique ids: created exactly. Fixed ids (document kinds, run dates)
// may already exist from an earlier test run on the same instance.
for (const k of ["opening", "company", "positioning", "application", "screeningQuestion", "keywordQuestion", "person", "note"]) {
  assert.equal(res[k].created, k === "opening" ? 2 : (EXPECTED as any)[k], `${k} created`);
}
// The CV source file's attachment hangs off the fixed CV_SOURCE document id.
assert.equal(res.attachment.created + res.attachment.already_present, EXPECTED.attachment, "attachment planned");
assert.ok(res.attachment.created >= EXPECTED.attachment - 1, "attachment created");
for (const k of ["document", "documentRevision", "run"]) assert.equal(res[k].created + res[k].already_present, (EXPECTED as any)[k], `${k} planned`);

// Spot-check what landed: the application links its opening; files are attached.
const get = async (p: string) => (await fetch(`${url}${p}`, { headers: { Authorization: `Bearer ${key}` } })).json() as Promise<any>;
const appId = recordId("application", ids[0]);
const appRec = (await get(`/rest/applications/${appId}`)).data.application;
assert.equal(appRec.criticVerdict, "PASS");
assert.ok(appRec.migratedAt);
const atts = (await get(`/rest/attachments?filter=${encodeURIComponent(`targetApplicationId[eq]:${appId}`)}&limit=50`)).data.attachments;
assert.equal(atts.length, 11);
assert.ok(atts.every((a: any) => a.file?.[0]?.fileId));
const opening = (await get(`/rest/openings/${(await import("../tools/store/twenty-backend.ts")).openingId(ids[0])}`)).data.opening;
assert.ok(opening.migratedAt, "migrated openings carry migratedAt");

const second = runMigrate(["--apply"]);
assert.equal(second.created, 0, "second run plans 0 creates");
assert.equal(second.results.opening.already_present, 2);
assert.equal(second.results.attachment.already_present, EXPECTED.attachment);
const dry2 = runMigrate(["--dry-run", "--target"]);
assert.equal(dry2.created, 0, "a dry run against the target plans 0 creates");

// Refusals: no URL, and a non-local URL without the cutover flag and backup.
const noUrl = spawnSync("npx", ["tsx", path.join(repo, "tools/twenty/migrate.ts"), "--apply"], { cwd: repo, env: { ...env, TWENTY_API_URL: "" }, encoding: "utf8" });
assert.equal(noUrl.status, 2);
const remote = spawnSync("npx", ["tsx", path.join(repo, "tools/twenty/migrate.ts"), "--apply"], { cwd: repo, env: { ...env, TWENTY_API_URL: "https://crm.example.invalid" }, encoding: "utf8" });
assert.equal(remote.status, 2);
assert.match(remote.stdout, /confirm-cutover/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("twenty-migrate: unit and integration ok");
