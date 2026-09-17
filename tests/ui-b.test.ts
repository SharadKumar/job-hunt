#!/usr/bin/env tsx
/**
 * ui-b.test.ts — the applications board's server side (tools/ui/rows-ext-api.ts).
 *
 * The front end is vanilla ES modules with no build step, so everything that
 * can be decided on the server is decided on the server and pinned here: which
 * single button a row earns, the two status moves the Tray vocabulary has no
 * word for, which submitted rows have gone quiet, and what happens when a
 * letter is edited in the browser.
 *
 * Everything runs against a fixture repo root (HARNESS_REPO_ROOT), a throwaway
 * pipeline database (PIPELINE_DB) and a throwaway audit dir (AUDIT_DIR), so
 * the person's own state/ is never read or written.
 *
 * Run: npx tsx tests/ui-b.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-b-"));
// All three must be set before the tools are evaluated: repo-root, the pipeline
// store and audit.ts all pin their paths at import time.
process.env.HARNESS_REPO_ROOT = root;
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
delete process.env.HARNESS_PROFILE;
delete process.env.HARNESS_UI_TOKEN;

const { upsert, setStatus, patch, get } = await import("../tools/pipeline.ts");
const ext = await import("../tools/ui/rows-ext-api.ts");
const { handleApi } = await import("../tools/ui/api.ts");

const archiveDir = path.join(root, "archive");
const outreachDir = path.join(root, "outreach");
const ctx = { archiveDir, queuePath: path.join(root, "queue.json") };
const DAY_MS = 24 * 60 * 60 * 1000;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

let n = 0;
async function seed(
  title: string,
  company: string,
  statuses: string[],
  fields: Record<string, unknown> = {},
  reason = "test",
): Promise<string> {
  n += 1;
  const row = await upsert({
    channel: "seek",
    url: `https://example.test/job/${n}`,
    title,
    company,
    description: `JD for ${title}`,
    status: "discovered",
    ...fields,
  });
  for (const status of statuses) await setStatus(row.id, status as never, reason);
  return row.id;
}

function writePackage(id: string, files: Record<string, string>): string {
  const dir = path.join(archiveDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

console.log("ui applications board (package b)");

// ---------------------------------------------------------------------------
// The one contextual action a row earns
// ---------------------------------------------------------------------------

await test("actionFor reads the run's own reason before the row's status", () => {
  const row = { id: "seek-1", status: "manual_action_needed", url: "https://example.test/ad" };
  assert.equal(ext.actionFor(row, "[autopilot daily-2026-09-16] unknown screening question: \"How many years\"").kind, "answer");
  assert.equal(ext.actionFor(row, "[autopilot daily-2026-09-16] external ATS: rba.wd105.myworkdayjobs.com").kind, "portal");
  assert.equal(
    ext.actionFor(row, "[autopilot daily-2026-09-16] external ATS: rba.wd105.myworkdayjobs.com").href,
    "https://example.test/ad",
    "a portal action carries the advert to open",
  );
  assert.equal(ext.actionFor(row, "letter-critic block (2 fail): scope wording").kind, "retry");
  assert.equal(ext.actionFor(row, "letter-critic block (2 fail): scope wording").post, "retry");
  const duplicate = ext.actionFor({ ...row, status: "shortlisted" }, "Duplicate of DISR LH-07526; another agency represents it");
  assert.equal(duplicate.kind, "reject");
  assert.equal(duplicate.danger, true, "a reject is the destructive weight");
});

await test("actionFor falls back to the status when the reason says nothing", () => {
  const at = (status: string) => ext.actionFor({ id: "seek-1", status, url: "https://example.test/ad" }, "package drafted");
  assert.equal(at("awaiting_approval").kind, "approve");
  assert.equal(at("awaiting_approval").primary, true, "Approve is the black button on a to-approve row");
  assert.equal(at("parked").kind, "unpark");
  assert.equal(at("manual_action_needed").kind, "retry");
  assert.equal(at("shortlisted").kind, "none");
});

await test("a sent row offers nothing, and a reply offers the next rung", () => {
  const at = (status: string) => ext.actionFor({ id: "seek-1", status, url: "https://example.test/ad" }, "SEEK success page confirmed");
  assert.equal(at("submitted").kind, "none", "a sent row is done; there is no button for it");
  assert.equal(at("rejected").kind, "none");
  assert.equal(at("withdrawn").kind, "none");
  assert.equal(at("won").kind, "none");
  assert.deepEqual([at("responded").outcome, at("interview").outcome, at("offered").outcome],
    ["interview", "offered", "won"], "a response walks one rung at a time");
});

// ---------------------------------------------------------------------------
// GET /api/rows carries the action
// ---------------------------------------------------------------------------

const blockedId = await seed("Solution Architect", "Acme Federal", ["manual_action_needed"], {
  score: 82, location: "Sydney NSW", applyMethod: "quick_apply", userSaved: true,
}, "[autopilot daily-2026-09-16] letter-critic block (1 fail): scope wording");

const parkedId = await seed("Platform Lead", "Statewide Water", ["parked"], { score: 61 }, "interstate onsite");
const approveId = await seed("Delivery Manager", "Harbour Digital", ["shortlisted", "drafted", "awaiting_approval"], { score: 74 }, "package drafted");

await test("GET /api/rows returns the derived action beside every row", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/rows", query: new URLSearchParams({ status: "manual_action_needed,parked,awaiting_approval" }) }, ctx);
  assert.equal(result.status, 200);
  const rows = (result.body as any).rows as any[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(blockedId)!.action.kind, "retry");
  assert.equal(byId.get(parkedId)!.action.kind, "unpark");
  assert.equal(byId.get(approveId)!.action.kind, "approve");
  assert.equal(byId.get(blockedId)!.title, "Solution Architect", "the rest of the row is untouched");
});

// ---------------------------------------------------------------------------
// unpark and outcome
// ---------------------------------------------------------------------------

await test("unpark moves a parked row back into the apply queue, with its reason", async () => {
  const result = await handleApi({ method: "POST", pathname: `/api/rows/${parkedId}/unpark`, body: { reason: "the ad says remote" } }, ctx);
  assert.equal(result.status, 200);
  assert.equal((result.body as any).status_after, "shortlisted");
  const row = (await get(parkedId))!;
  const last = row.history[row.history.length - 1];
  assert.equal(last.from, "parked");
  assert.equal(last.to, "shortlisted");
  assert.match(last.reason ?? "", /ui: unpark \(the ad says remote\)/, "the history says who asked and why");
});

await test("unpark refuses a row that is not parked", async () => {
  const result = await handleApi({ method: "POST", pathname: `/api/rows/${blockedId}/unpark`, body: {} }, ctx);
  assert.equal(result.status, 409, "the state machine refuses it and the API says so");
  assert.match(String((result.body as any).error), /invalid transition/);
});

const sentId = await seed("Integration Lead", "Port Authority", ["shortlisted", "drafted", "awaiting_approval", "approved", "submitted"], { score: 70 }, "sent");

await test("outcome walks a submitted row along the response ladder", async () => {
  const responded = await handleApi({ method: "POST", pathname: `/api/rows/${sentId}/outcome`, body: { status: "responded", note: "recruiter called" } }, ctx);
  assert.equal(responded.status, 200);
  assert.equal((responded.body as any).status_after, "responded");
  const interview = await handleApi({ method: "POST", pathname: `/api/rows/${sentId}/outcome`, body: { status: "interview" } }, ctx);
  assert.equal((interview.body as any).status_after, "interview");
  const row = (await get(sentId))!;
  assert.ok(row.responseAt, "a response stamps the row");
  const reasons = row.history.map((h) => h.reason ?? "");
  assert.ok(reasons.some((r) => /ui: responded \(recruiter called\)/.test(r)), "the note reaches the history");
  assert.ok(reasons.some((r) => /ui: interview/.test(r)));
});

await test("outcome refuses a status that is not an outcome, and an illegal move", async () => {
  const bad = await handleApi({ method: "POST", pathname: `/api/rows/${sentId}/outcome`, body: { status: "submitted" } }, ctx);
  assert.equal(bad.status, 400);
  assert.match(String((bad.body as any).error), /status must be one of/);
  const illegal = await handleApi({ method: "POST", pathname: `/api/rows/${blockedId}/outcome`, body: { status: "won" } }, ctx);
  assert.equal(illegal.status, 409);
});

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

const staleId = await seed("Data Platform Lead", "Quiet Recruiters", ["shortlisted", "drafted", "awaiting_approval", "approved", "submitted"], { score: 66 }, "sent");
const freshId = await seed("Cloud Architect", "Loud Recruiters", ["shortlisted", "drafted", "awaiting_approval", "approved", "submitted"], { score: 68 }, "sent");

await patch(staleId, { submittedAt: new Date(Date.now() - 21 * DAY_MS).toISOString() }, "test");
await patch(freshId, { submittedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() }, "test");
writePackage(staleId, { "follow-up.md": "Hi, following up on the Data Platform Lead application.\n" });

await test("followups are the submitted rows that have gone quiet, with their nudge", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/followups", query: new URLSearchParams({ days: "7" }) }, ctx);
  assert.equal(result.status, 200);
  const body = result.body as any;
  assert.equal(body.days, 7);
  const ids = body.rows.map((r: any) => r.id);
  assert.ok(ids.includes(staleId), "a three week old submission is due a nudge");
  assert.ok(!ids.includes(freshId), "a two day old submission is not");
  assert.ok(!ids.includes(sentId), "a row that has already replied is not chased");
  const stale = body.rows.find((r: any) => r.id === staleId);
  assert.equal(stale.days_since, 21);
  assert.match(stale.nudge, /following up on the Data Platform Lead/, "the draft in the package comes back with the row");
});

await test("a nudge in the outreach tray counts too, and no nudge is null", async () => {
  fs.mkdirSync(path.join(outreachDir, freshId), { recursive: true });
  fs.writeFileSync(path.join(outreachDir, freshId, "follow-up-dm.md"), "Quick nudge on the Cloud Architect role.\n");
  const wide = await handleApi({ method: "GET", pathname: "/api/followups", query: new URLSearchParams({ days: "1" }) }, ctx);
  const rows = (wide.body as any).rows as any[];
  const fresh = rows.find((r) => r.id === freshId);
  assert.match(fresh.nudge, /Quick nudge on the Cloud Architect/, "the outreach tray is read as well as the package");
  const bare = rows.find((r) => r.id === staleId);
  assert.ok(bare, "the older row is still there at a shorter window");
  const none = rows.find((r) => r.nudge === null);
  assert.ok(none === undefined || none.nudge === null, "a row with no draft carries null rather than an empty string");
});

await test("days must be a number", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/followups", query: new URLSearchParams({ days: "soon" }) }, ctx);
  assert.equal(result.status, 400);
});

// ---------------------------------------------------------------------------
// Editing a letter
// ---------------------------------------------------------------------------

writePackage(blockedId, {
  "cover-letter.md": "Dear hiring team,\n\nI led the integration work.\n",
  "jd.md": "# JD\nSolution Architect at Acme Federal.\n",
});

await test("a sent row's letter is not editable", async () => {
  const result = await handleApi({ method: "POST", pathname: `/api/rows/${sentId}/letter`, body: { text: "Too late." } }, ctx);
  assert.equal(result.status, 409);
  assert.match(String((result.body as any).error), /not editable/);
});

await test("saving a letter writes the package file and returns the pre-check findings", async () => {
  const text = "Dear hiring team,\n\nI led the integration work — end to end.\n";
  const result = await handleApi({ method: "POST", pathname: `/api/rows/${blockedId}/letter`, body: { text } }, ctx);
  assert.equal(result.status, 200);
  const body = result.body as any;
  const onDisk = fs.readFileSync(path.join(archiveDir, blockedId, "cover-letter.md"), "utf8");
  assert.match(onDisk, /end to end/, "the edited letter is the letter in the package");
  assert.equal(body.words, 12, "the saved letter is counted as it will be sent");
  assert.equal(body.critic_stale, true, "the stored verdict was for the old bytes and says so");
  assert.equal(body.findings.length, 1, "the em dash is caught without a model");
  assert.equal(body.findings[0].severity, "fail");
  assert.match(body.findings[0].issue, /em or en dash/);
  const audit = fs.readFileSync(path.join(root, "audit", "audit-log.jsonl"), "utf8");
  assert.match(audit, /letter_edited/, "the edit is audited");
});

await test("an empty letter is refused and an unknown row is a 404", async () => {
  const empty = await handleApi({ method: "POST", pathname: `/api/rows/${blockedId}/letter`, body: { text: "   " } }, ctx);
  assert.equal(empty.status, 400);
  const missing = await handleApi({ method: "POST", pathname: "/api/rows/seek-nosuchrow/letter", body: { text: "hello" } }, ctx);
  assert.equal(missing.status, 404);
});

await test("the row detail finds a package the row never recorded a draftDir for", async () => {
  const result = await handleApi({ method: "GET", pathname: `/api/rows/${blockedId}` }, ctx);
  assert.equal(result.status, 200);
  const body = result.body as any;
  assert.match(body.package.cover_letter, /Dear hiring team/, "the archive folder named after the row is the fallback");
  assert.match(body.package.jd, /Solution Architect at Acme Federal/);
  assert.ok(body.package_files.includes("cover-letter.md"), "the detail lists what is in the package");
  assert.equal(body.action.kind, "retry", "the detail derives the same action as the list");
});

if (process.exitCode) {
  console.error("ui-b: FAILURES");
} else {
  console.log(`ui-b: ${passed} passed`);
}
