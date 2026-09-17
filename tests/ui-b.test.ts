#!/usr/bin/env tsx
/**
 * ui-b.test.ts — the applications board's server side (tools/ui/rows-ext-api.ts).
 *
 * The front end is vanilla ES modules with no build step, so everything that
 * can be decided on the server is decided on the server and pinned here: which
 * single button a row earns, the status moves the Tray vocabulary has no word
 * for (unpark, outcome, "I applied myself"), which submitted rows have gone
 * quiet, what happens when a letter is edited in the browser, what a retry
 * starts and refuses, and what the keyword queue recommends before it asks the
 * person anything.
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
import { fileURLToPath } from "node:url";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "ui-b");
const realRoot = path.dirname(here);
const profileDir = path.join(root, "state", "profile");
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

/**
 * The two switches every unattended send passes, plus the channels that have a
 * one-click adapter: between them they decide which lane a row is in, so every
 * test below runs against a policy the person could actually have written.
 */
function writePolicy(opts: { autopilot?: boolean; killSwitch?: boolean; channels?: string[] } = {}): void {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "submission-policy.yaml"), [
    "autopilot:",
    `  enabled: ${opts.autopilot ?? true}`,
    "  max_per_day: 5",
    "  channels:",
    ...(opts.channels ?? ["seek", "linkedin_jobs"]).map((c) => `    - ${c}`),
    `kill_switch: ${opts.killSwitch ?? false}`,
    "",
  ].join("\n"));
}

function writePackage(id: string, files: Record<string, string>): string {
  const dir = path.join(archiveDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

// Autopilot on, with both one-click channels listed: the state the person's own
// machine is in, and the state in which the lanes actually differ.
writePolicy();

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
  const duplicate = ext.actionFor({ ...row, status: "shortlisted" }, "Duplicate of LH-07526; another agency represents it");
  assert.equal(duplicate.kind, "decide", "a duplicate is a decision, not a single move");
  assert.equal(duplicate.primary, false, "neither choice is the default one");
  assert.deepEqual(duplicate.also.map((a) => a.kind), ["reject", "retry"], "both choices come down already decided");
  assert.equal(duplicate.also[0].danger, true, "a reject is the destructive weight");
  assert.equal(duplicate.also[1].post, "retry", "sending it anyway is the other choice");
});

await test("actionFor falls back to the status when the reason says nothing", () => {
  const at = (status: string) => ext.actionFor({ id: "seek-1", status, url: "https://example.test/ad" }, "package drafted");
  assert.equal(at("awaiting_approval").kind, "approve", "the attended lane is the only lane with an approval to give");
  assert.equal(at("awaiting_approval").primary, true, "Approve is the black button on a to-approve row");
  assert.equal(at("parked").kind, "unpark");
  assert.equal(at("manual_action_needed").kind, "retry");
  assert.equal(at("shortlisted").kind, "in_flight", "a queued row is being prepared, not waiting on a click");
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
  assert.equal(byId.get(approveId)!.action.kind, "in_flight",
    "a SEEK row awaiting approval is not waiting on a yes: the daily run sends it");
  assert.equal(byId.get(approveId)!.lane, "autopilot");
  assert.equal(byId.get(approveId)!.needs_you, false);
  assert.equal(byId.get(blockedId)!.title, "Solution Architect", "the rest of the row is untouched");
});

// ---------------------------------------------------------------------------
// Which lane a row is in (AGENTS.md section 2)
// ---------------------------------------------------------------------------

/** Autopilot on, both one-click channels listed: the policy the person runs. */
const ON = { autopilot_enabled: true, kill_switch: false, channels: ["seek", "linkedin_jobs"] };

await test("the lane is the row's own facts first, and the two switches after", () => {
  assert.deepEqual(ext.laneFor({ channel: "seek", applyMethod: "quick_apply" }, ON),
    { lane: "autopilot", lane_reason: "seek is an autopilot channel" });

  assert.deepEqual(ext.laneFor({ channel: "linkedin_jobs", applyMethod: "easy_apply" }, ON),
    { lane: "autopilot", lane_reason: "linkedin_jobs Easy Apply" });
  const unresolved = ext.laneFor({ channel: "linkedin_jobs", applyMethod: null }, ON);
  assert.equal(unresolved.lane, "autopilot", "an unread LinkedIn ad stays in the lane the run will resolve");
  assert.match(unresolved.lane_reason, /resolved by the run/);
  const notEasy = ext.laneFor({ channel: "linkedin_jobs", applyMethod: "quick_apply" }, ON);
  assert.equal(notEasy.lane, "attended", "only Easy Apply has a LinkedIn adapter");
  assert.match(notEasy.lane_reason, /not Easy Apply/);

  const external = ext.laneFor({ channel: "linkedin_jobs", applyMethod: "external" }, ON);
  assert.equal(external.lane, "attended");
  assert.equal(external.lane_reason, "applyMethod external needs a person");
  assert.equal(ext.laneFor({ channel: "seek", applyMethod: "external" }, ON).lane, "attended",
    "an advertiser's own ATS is attended whatever channel the ad was found on");

  assert.deepEqual(ext.laneFor({ channel: "recruiter", applyMethod: "quick_apply" }, ON),
    { lane: "attended", lane_reason: "channel recruiter is attended" });

  const off = ext.laneFor({ channel: "seek", applyMethod: "quick_apply" }, { ...ON, autopilot_enabled: false });
  assert.deepEqual(off, { lane: "attended", lane_reason: "autopilot is off" });
  const killed = ext.laneFor({ channel: "seek", applyMethod: "quick_apply" }, { ...ON, kill_switch: true });
  assert.deepEqual(killed, { lane: "attended", lane_reason: "kill switch on" });

  assert.equal(ext.laneFor({ channel: "recruiter", applyMethod: null }, { ...ON, kill_switch: true }).lane_reason,
    "channel recruiter is attended",
    "a switch never explains a row that was attended before anyone touched it");
});

await test("on the autopilot lane there is nothing to approve, only something to stop", () => {
  const row = { id: "seek-2", status: "shortlisted", url: "https://example.test/ad", channel: "seek", applyMethod: "quick_apply" };
  for (const status of ["shortlisted", "drafted", "awaiting_approval", "approved", "submission_pending"]) {
    const derived = ext.actionFor({ ...row, status }, "package drafted", "autopilot");
    assert.equal(derived.kind, "in_flight", `${status} on the autopilot lane is the run's, not the person's`);
    assert.equal(derived.label, "Autopilot handles this");
    assert.equal(derived.primary, false, "there is no primary button: nothing is being asked");
    assert.equal(derived.post, null);
    assert.deepEqual(derived.also.map((a: any) => a.kind), ["hold", "reject"], "stop it, or drop it");
    assert.deepEqual(derived.also.map((a: any) => a.post), ["hold", "reject"]);
    assert.equal(derived.also[1].danger, true, "a reject carries the destructive weight");
    assert.match(derived.note ?? "", /SEEK Quick Apply adapter\. Nothing needed from you\./,
      "the note names the thing that will send it");
  }
  const linkedin = ext.actionFor({ ...row, status: "awaiting_approval", channel: "linkedin_jobs", applyMethod: "easy_apply" }, "package drafted", "autopilot");
  assert.match(linkedin.note ?? "", /LinkedIn Easy Apply adapter/);

  const blocked = ext.actionFor({ ...row, status: "manual_action_needed" }, "letter-critic block (1 fail): scope wording", "autopilot");
  assert.equal(blocked.kind, "retry", "a row the run could not finish keeps the derivations it always had");
  const asked = ext.actionFor({ ...row, status: "manual_action_needed" }, 'unknown screening question: "How many years"', "autopilot");
  assert.equal(asked.kind, "answer");
});

await test("on the attended lane the person is the send, and the approval says so", () => {
  const row = { id: "rec-1", status: "awaiting_approval", url: "https://example.test/ad", channel: "recruiter", applyMethod: "unknown" };
  const approve = ext.actionFor(row, "package drafted", "attended");
  assert.equal(approve.kind, "approve");
  assert.equal(approve.label, "Approve for the next attended session");
  assert.equal(approve.post, "approve");
  assert.equal(approve.primary, true);

  for (const status of ["shortlisted", "drafted"]) {
    const derived = ext.actionFor({ ...row, status }, "package drafted", "attended");
    assert.equal(derived.kind, "in_flight", `${status} is the run's work on either lane`);
    assert.match(derived.note ?? "", /prepares the package; you send it in an attended session/);
  }

  const send = ext.actionFor({ ...row, status: "approved" }, "approved in the tray", "attended");
  assert.equal(send.kind, "attended_send");
  assert.equal(send.label, "Send in an attended session");
  assert.equal(send.post, null, "no browser click ever sends on this lane");
  assert.equal(ext.actionFor({ ...row, status: "submission_pending" }, "mid-flow", "attended").kind, "none",
    "a send already in progress is nobody's button");
});

const attendedAwaitingId = await seed("Programme Lead", "Agency Recruiters", ["shortlisted", "drafted", "awaiting_approval"], {
  channel: "recruiter", score: 71,
}, "package drafted");
const linkedinAwaitingId = await seed("Integration Architect", "Harbour Freight", ["shortlisted", "drafted", "awaiting_approval"], {
  channel: "linkedin_jobs", score: 73, applyMethod: "easy_apply",
}, "package drafted");

await test("the approval queue counts what is actually waiting on the person", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/rows", query: new URLSearchParams({ status: "awaiting_approval" }) }, ctx);
  assert.equal(result.status, 200);
  const body = result.body as any;
  const byId = new Map((body.rows as any[]).map((r) => [r.id, r]));

  const attended = byId.get(attendedAwaitingId)!;
  assert.equal(attended.lane, "attended");
  assert.equal(attended.lane_reason, "channel recruiter is attended");
  assert.equal(attended.needs_you, true, "a recruiter package goes nowhere until the person sends it");
  assert.equal(attended.action.kind, "approve");

  const linkedin = byId.get(linkedinAwaitingId)!;
  assert.equal(linkedin.lane, "autopilot");
  assert.equal(linkedin.lane_reason, "linkedin_jobs Easy Apply");
  assert.equal(linkedin.needs_you, false);
  assert.equal(byId.get(approveId)!.needs_you, false, "and neither does the SEEK one");

  assert.deepEqual(body.counts, { needs_you: 1, in_flight: 2 },
    "three rows await approval and exactly one of them is a question for the person");

  const detail = await handleApi({ method: "GET", pathname: `/api/rows/${attendedAwaitingId}` }, ctx);
  assert.equal((detail.body as any).lane, "attended", "the detail derives the same lane as the list");
  assert.equal((detail.body as any).needs_you, true);
  assert.equal((detail.body as any).action.kind, "approve");
});

await test("GET /api/lanes is the same derivation per channel, for the tabs", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/lanes" }, ctx);
  assert.equal(result.status, 200);
  const body = result.body as any;
  assert.equal(body.autopilot_enabled, true);
  assert.equal(body.kill_switch, false);
  assert.deepEqual(body.channels, ["seek", "linkedin_jobs"], "the policy's own list, in the policy's own order");
  assert.equal(body.lane_of.seek, "autopilot");
  assert.equal(body.lane_of.linkedin_jobs, "autopilot");
  assert.equal(body.lane_of.recruiter, "attended");
  assert.equal(body.lane_of.linkedin_posts, "attended", "a channel with no one-click adapter is named, not missing");
  assert.equal(body.reason_of.recruiter, "channel recruiter is attended");

  writePolicy({ killSwitch: true });
  const halted = await handleApi({ method: "GET", pathname: "/api/lanes" }, ctx);
  const after = halted.body as any;
  assert.equal(after.kill_switch, true);
  assert.deepEqual(Object.values(after.lane_of).filter((l) => l === "autopilot"), [],
    "with the kill switch on there is no autopilot lane today, and the tabs say so");
  assert.equal(after.reason_of.seek, "kill switch on");
  writePolicy();
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

// ---------------------------------------------------------------------------
// The action table, row by row
// ---------------------------------------------------------------------------

await test("an external row always opens the portal, whatever else the reason says", () => {
  const external = { id: "seek-9", status: "manual_action_needed", url: "https://example.test/ad", applyMethod: "external" };
  const byMethod = ext.actionFor(external, "[autopilot daily-2026-09-17] adapter failed on the review page");
  assert.equal(byMethod.kind, "portal", "applyMethod external is enough on its own");
  assert.equal(byMethod.href, "https://example.test/ad");
  assert.deepEqual(byMethod.also.map((a) => a.kind), ["mark_sent"], "the only way an external row is ever sent is by the person");

  const byReason = ext.actionFor({ ...external, applyMethod: "unknown" }, "LinkedIn ad says Apply on company website");
  assert.equal(byReason.kind, "portal", "the reason carries the same fact when applyMethod does not");
  const unknown = ext.actionFor({ ...external, applyMethod: "unknown" }, "[autopilot daily-2026-09-17] external/unknown apply method");
  assert.equal(unknown.kind, "portal");

  assert.notEqual(ext.actionFor(external, "letter-critic block (2 fail)").kind, "retry",
    "an external row never offers a retry: there is no adapter to run");
});

await test("the rest of the table: unanswered, duplicate, letter block, to approve", () => {
  const row = { id: "seek-10", status: "manual_action_needed", url: "https://example.test/ad", applyMethod: "quick_apply" };
  assert.equal(ext.actionFor(row, 'unknown screening question: "How many years"').kind, "answer");
  const dup = ext.actionFor(row, "already submitted to this advertiser within 60 days; needs a user decision");
  assert.equal(dup.kind, "decide");
  assert.deepEqual(dup.also.map((a) => a.label), ["Reject", "Retry"]);
  assert.equal(ext.actionFor(row, "letter-critic block (1 fail): scope wording").kind, "retry");
  assert.equal(ext.actionFor({ ...row, status: "awaiting_approval" }, "package drafted").kind, "approve");
});

await test("a gate refusal is not a retry: the row says what stopped it", () => {
  // The reason the gate writes, stamped onto the row by tools/autopilot-submit.ts.
  const row = { id: "seek-11", status: "manual_action_needed", url: "https://example.test/ad", channel: "seek", applyMethod: "quick_apply" };
  const refused = ext.actionFor(row,
    "[autopilot daily-2026-09-17] validation gate failed: autopilot_fit, discipline_fit is 'platform_gap' and the row is not user-saved",
    "autopilot");
  assert.equal(refused.kind, "gate_refused", "a policy refusal is its own derivation, not another retry");
  assert.equal(refused.label, "Outside the autopilot lane");
  assert.equal(refused.primary, false, "there is no primary: no button here changes a policy");
  assert.equal(refused.post, null, "and nothing posts, least of all a retry");
  assert.equal(refused.note,
    "Discipline is platform_gap and the row is not saved on SEEK. Save it on SEEK to force it through, or send it in an attended session.",
    "the note says what stopped it and what would actually move it");
  assert.deepEqual(refused.also.map((a: any) => a.kind), ["reject", "hold"], "drop it, or keep it here");
  assert.equal(refused.also[0].danger, true, "a reject carries the destructive weight");
  assert.ok(!refused.also.some((a: any) => a.post === "retry"), "no retry is offered on either lane");

  // The LinkedIn version of the same refusal names the channel it was found on.
  const linkedin = ext.actionFor({ ...row, channel: "linkedin_jobs", applyMethod: "easy_apply" },
    "validation gate failed: autopilot_fit, discipline_fit is 'adjacent' and the row is not user-saved", "autopilot");
  assert.match(linkedin.note ?? "", /Discipline is adjacent and the row is not saved on LinkedIn\./);

  // The rest of the policy gates, each in the words the person would use.
  const noteFor = (reason: string) => ext.actionFor(row, reason, "autopilot").note;
  assert.equal(noteFor("validation gate failed: baseline_resume_ref, the approved baseline has changed since the package was prepared"),
    "The baseline CV is not approved; approve it on Resumes.");
  assert.equal(noteFor("[autopilot daily-2026-09-17] autopilot daily cap reached (6/6), the rest waits for tomorrow"),
    "Daily cap reached; it runs tomorrow.");
  assert.equal(noteFor("validation gate failed: no_red_flag_blocker, opportunity is flagged red_flag_blocker"),
    "A red flag blocks it; review the classification.");
  assert.equal(ext.actionFor({ ...row, channel: "recruiter" }, "channel 'recruiter' is not on autopilot, route to manual_action_needed").note,
    "Recruiter is not on the autopilot list; send it in an attended session.");

  // A run that failed at something a rerun could fix keeps its retry.
  assert.equal(ext.actionFor(row, "letter-critic block (1 fail): scope wording", "autopilot").kind, "retry");
  assert.equal(ext.actionFor(row, 'unknown screening question: "How many years"', "autopilot").kind, "answer");
  assert.equal(ext.actionFor(row, "adapter failed on the review page", "autopilot").kind, "retry");
});

await test("a job the person saved is never refused: saving it is the order to apply", () => {
  // AGENTS.md section 2: the gate bypasses the fit gates for a saved row and
  // every run retries it, so telling them to save what they already saved
  // would be nonsense.
  const saved = {
    id: "seek-12", status: "manual_action_needed", url: "https://example.test/ad",
    channel: "seek", applyMethod: "quick_apply", userSaved: true,
  };
  const reason = "[autopilot daily-2026-09-17] validation gate failed: autopilot_fit, discipline_fit is 'platform_gap' and the row is not user-saved";
  const derived = ext.actionFor(saved, reason, "autopilot");
  assert.equal(derived.kind, "retry", "a saved row keeps the retry every run gives it");
  assert.equal(ext.gateRefusal(saved, reason), null, "and the refusal never fires on it");
  assert.ok(ext.gateRefusal({ ...saved, userSaved: false }, reason), "the same row unsaved is refused");
});

// ---------------------------------------------------------------------------
// "I applied myself"
// ---------------------------------------------------------------------------

const externalId = await seed("Principal Architect", "Workday Advertiser", ["manual_action_needed"], {
  score: 77, applyMethod: "external",
}, "[autopilot daily-2026-09-17] external ATS: acme.wd105.myworkdayjobs.com");

await test("mark-sent moves an external row to submitted and leaves the same receipt", async () => {
  const result = await handleApi({
    method: "POST",
    pathname: `/api/rows/${externalId}/mark-sent`,
    body: { confirmation: "Application 44821 received", note: "Lodged in the Workday portal, CV and letter uploaded." },
  }, ctx);
  assert.equal(result.status, 200);
  const body = result.body as any;
  assert.equal(body.status_after, "submitted");
  assert.equal(body.confirmation_ref, "Application 44821 received");

  const row = (await get(externalId))!;
  assert.equal(row.status, "submitted");
  assert.ok(row.submittedAt, "a manual send is stamped like any other");
  assert.equal((row as any).confirmationRef, "Application 44821 received");
  const last = row.history.filter((h) => h.from !== h.to).pop()!;
  assert.match(last.reason ?? "", /applied manually via example\.test/, "the history names the portal it went through");

  const receipt = fs.readFileSync(path.join(archiveDir, externalId, "confirmation.txt"), "utf8");
  assert.match(receipt, /Applied by hand via example\.test/);
  assert.match(receipt, /Application 44821 received/);
  assert.match(receipt, /Lodged in the Workday portal/, "the person's own note is part of the receipt");

  const audit = fs.readFileSync(path.join(root, "audit", "audit-log.jsonl"), "utf8");
  assert.ok(audit.split("\n").some((line) => line.includes("manual_action_completed") && line.includes(externalId)),
    "a send the person made by hand is audited like one the harness made");
});

await test("mark-sent refuses a row the state machine will not move", async () => {
  const stuck = await seed("Network Lead", "Statewide Rail", ["parked"], { score: 51 }, "interstate onsite");
  const result = await handleApi({ method: "POST", pathname: `/api/rows/${stuck}/mark-sent`, body: {} }, ctx);
  assert.equal(result.status, 409);
  assert.match(String((result.body as any).error), /invalid transition/);
  const missing = await handleApi({ method: "POST", pathname: "/api/rows/seek-nosuchrow/mark-sent", body: {} }, ctx);
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// "Write this letter again"
// ---------------------------------------------------------------------------

await test("redraft records the request on the row without moving it", async () => {
  const before = (await get(blockedId))!.status;
  const result = await handleApi({
    method: "POST",
    pathname: `/api/rows/${blockedId}/redraft`,
    body: { reason: "the second paragraph claims delivery" },
  }, ctx);
  assert.equal(result.status, 200);
  const request = (result.body as any).redraft_requested;
  assert.equal(request.reason, "the second paragraph claims delivery");
  assert.ok(request.at, "the request is stamped");

  const row = (await get(blockedId))!;
  assert.equal(row.status, before, "a redraft is not a status move");
  assert.deepEqual((row as any).redraftRequested, request, "the daily letter loop reads this field");

  const detail = await handleApi({ method: "GET", pathname: `/api/rows/${blockedId}` }, ctx);
  assert.deepEqual((detail.body as any).redraft_requested, request, "and the browser sees it beside the letter");

  const audit = fs.readFileSync(path.join(root, "audit", "audit-log.jsonl"), "utf8");
  assert.ok(audit.split("\n").some((line) => line.includes("redraft_requested") && line.includes(blockedId)));
});

// ---------------------------------------------------------------------------
// Retry now
// ---------------------------------------------------------------------------

// A stand-in for tools/autopilot-submit.ts: the real one drives a browser.
const fakeAutopilot = path.join(root, "fake-autopilot.mjs");
fs.copyFileSync(path.join(fixtures, "fake-autopilot.mjs"), fakeAutopilot);
fs.chmodSync(fakeAutopilot, 0o755);
process.env.HARNESS_AUTOPILOT_BIN = fakeAutopilot;

const retryId = await seed("Platform Architect", "Harbour Rail", ["manual_action_needed"], {
  score: 79, applyMethod: "quick_apply", userSaved: true,
}, "[autopilot daily-2026-09-17] letter-critic block (1 fail): scope wording");

await test("retry refuses anything outside the autopilot lane", async () => {
  writePolicy();
  const external = await seed("Delivery Lead", "Portal Advertiser", ["manual_action_needed"], {
    score: 72, applyMethod: "external",
  }, "[autopilot daily-2026-09-17] external ATS: careers.example.test");
  const result = await handleApi({ method: "POST", pathname: `/api/rows/${external}/retry-now`, body: {} }, ctx);
  assert.equal(result.status, 409);
  assert.match(String((result.body as any).error), /autopilot lane/);
  assert.equal((await get(external))!.status, "manual_action_needed", "a refused retry moves nothing");
});

await test("retry refuses while the kill switch is on, or autopilot is off", async () => {
  writePolicy({ killSwitch: true });
  const killed = await handleApi({ method: "POST", pathname: `/api/rows/${retryId}/retry-now`, body: {} }, ctx);
  assert.equal(killed.status, 409);
  assert.match(String((killed.body as any).error), /kill switch/);

  writePolicy({ autopilot: false });
  const off = await handleApi({ method: "POST", pathname: `/api/rows/${retryId}/retry-now`, body: {} }, ctx);
  assert.equal(off.status, 409);
  assert.match(String((off.body as any).error), /autopilot is off/);

  assert.equal((await get(retryId))!.status, "manual_action_needed", "neither refusal approved the row");
  assert.deepEqual((await handleApi({ method: "GET", pathname: "/api/jobs" }, ctx)).body, { jobs: [] },
    "and neither refusal started anything");
});

/** Poll a job the way the browser does, until it is finished or the test gives up. */
async function pollJob(jobId: string, timeoutMs = 20_000): Promise<any> {
  const started = Date.now();
  for (;;) {
    const result = await handleApi({ method: "GET", pathname: `/api/jobs/${jobId}` }, ctx);
    assert.equal(result.status, 200);
    const job = result.body as any;
    if (job.finished_at) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} never finished: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

await test("retry approves the row, starts the tool, and the job carries its output", async () => {
  writePolicy();
  process.env.FAKE_AUTOPILOT_DELAY_MS = "400";
  const started = await handleApi({ method: "POST", pathname: `/api/rows/${retryId}/retry-now`, body: {} }, ctx);
  assert.equal(started.status, 200);
  const jobId = (started.body as any).job_id;
  assert.ok(jobId, "the caller gets a job id to poll");
  assert.equal((await get(retryId))!.status, "approved", "a manual row re-enters the lane at approved");
  const moved = (await get(retryId))!.history.filter((h) => h.from !== h.to).pop()!;
  assert.match(moved.reason ?? "", /ui: retry now/);

  const second = await handleApi({ method: "POST", pathname: `/api/rows/${retryId}/retry-now`, body: {} }, ctx);
  assert.equal(second.status, 409, "one retry per row at a time");
  assert.match(String((second.body as any).error), /already running/);

  const job = await pollJob(jobId);
  delete process.env.FAKE_AUTOPILOT_DELAY_MS;
  assert.equal(job.exit_code, 0);
  assert.equal(job.row_id, retryId);
  assert.match(job.tail, /\[fake-autopilot\] starting/, "the tail is what the tool printed");
  assert.equal(job.result.outcome, "submitted", "the tool's own final JSON line is parsed for the UI");
  assert.match(job.args.join(" "), new RegExp(`--id ${retryId}`));

  const list = await handleApi({ method: "GET", pathname: "/api/jobs" }, ctx);
  assert.equal((list.body as any).jobs[0].id, jobId, "the newest run is first");
  const missing = await handleApi({ method: "GET", pathname: "/api/jobs/job-nosuch" }, ctx);
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// Letter findings, whatever the verdict file calls its fields
// ---------------------------------------------------------------------------

await test("a critic verdict written with the old field names still reads", async () => {
  const legacyId = await seed("Integration Architect", "Old Verdict Co", ["manual_action_needed"], { score: 64 }, "letter-critic block (2 fail)");
  writePackage(legacyId, {
    "cover-letter.md": "Dear hiring team,\n\nI delivered the payments migration end to end for the client.\n",
    "letter-critic.json": fs.readFileSync(path.join(fixtures, "letter-critic-legacy.json"), "utf8"),
  });
  const result = await handleApi({ method: "GET", pathname: `/api/rows/${legacyId}` }, ctx);
  assert.equal(result.status, 200);
  const findings = (result.body as any).package.letter_critic.findings;
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.deepEqual(Object.keys(finding).sort(), ["fix", "issue", "quote", "severity", "source"],
      "every finding has the five fields the browser renders");
  }
  assert.equal(findings[0].severity, "fail");
  assert.match(findings[0].quote, /payments migration/, "legacy `sentence` is the quote");
  assert.match(findings[0].issue, /scoped, not delivered/, "legacy `why` is the issue");
  assert.equal(findings[1].severity, "fail", "a finding with no severity reads as the stronger one");
  assert.match(findings[1].quote, /Twelve years/, "legacy `text` is the quote");
  assert.match(findings[1].issue, /eleven years/, "legacy `reason` is the issue");
  assert.match(findings[1].fix, /Use eleven/, "legacy `suggestion` is the fix");
  assert.equal((result.body as any).package.letter_critic.verdict, "block", "nothing else in the file is touched");
});

// ---------------------------------------------------------------------------
// The keyword queue: what the triage would say, before anyone is asked
// ---------------------------------------------------------------------------

const keywordOppId = await seed("Integration Lead", "Example Utility", ["shortlisted"], { score: 75 }, "shortlisted");

fs.mkdirSync(profileDir, { recursive: true });
fs.copyFileSync(path.join(fixtures, "cv-source.md"), path.join(profileDir, "cv-source.md"));
fs.writeFileSync(
  path.join(profileDir, "market-confirmations.yaml"),
  fs.readFileSync(path.join(fixtures, "market-confirmations.yaml"), "utf8").replaceAll("{{opportunity}}", keywordOppId),
);
// The deterministic stoplist is a framework file; the temp root needs the real one.
const stoplistDir = path.join(root, ".claude", "skills", "keyword-triage", "references");
fs.mkdirSync(stoplistDir, { recursive: true });
fs.copyFileSync(
  path.join(realRoot, ".claude", "skills", "keyword-triage", "references", "boilerplate.yaml"),
  path.join(stoplistDir, "boilerplate.yaml"),
);
writePackage(keywordOppId, {
  "keyword-plan.json": JSON.stringify({
    resume_id: "solution-architect",
    opportunity_id: keywordOppId,
    terms: [{ term: "Azure API Management", jd_form: "Azure API Management", category: "platform", must_have: true, tier: "must_have" }],
    questions: [],
  }),
});

await test("every pending term carries the triage's recommendation and the ads that asked", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/keywords/pending", query: new URLSearchParams({ all: "1" }) }, ctx);
  assert.equal(result.status, 200);
  const terms = (result.body as any).terms as any[];
  const byTerm = new Map(terms.map((t) => [t.term, t]));

  const junk = byTerm.get("Apply Now");
  assert.ok(junk, "the junk term is still listed; the person is never asked about it, not hidden from it");
  assert.equal(junk.recommendation.answer, "na", "ad furniture is a recommendation to answer not applicable");
  assert.equal(junk.recommendation.rule, "jd_boilerplate", "named by the rule that decided it");
  assert.match(junk.recommendation.note, /apply now/i);
  assert.equal(junk.must_have, false);

  const corpus = byTerm.get("Azure API Management");
  assert.equal(corpus.recommendation.answer, "confirm", "a term the corpus already carries is a confirm");
  assert.equal(corpus.recommendation.rule, "in_cv_source");
  assert.match(corpus.recommendation.note, /cv-source\.md:\d+/, "with the line that is the evidence");
  assert.equal(corpus.must_have, true, "the plan marked it must-have");
  assert.deepEqual(corpus.opportunities, [{ id: keywordOppId, title: "Integration Lead", company: "Example Utility" }],
    "the advert is named, not hashed");
  assert.equal(corpus.count, 1, "the rest of the api.ts shape is untouched");
});

await test("the triage route is the same dry run, whole", async () => {
  const result = await handleApi({ method: "GET", pathname: "/api/keywords/triage" }, ctx);
  assert.equal(result.status, 200);
  const report = result.body as any;
  assert.equal(report.dry_run, true, "reading the queue never records an answer");
  assert.equal(report.pending, 2);
  assert.equal(report.reject, 1);
  assert.equal(report.keep, 1);
  assert.equal(report.by_rule.jd_boilerplate, 1);
  assert.deepEqual(report.rejects.map((r: any) => r.term), ["Apply Now"]);
});

if (process.exitCode) {
  console.error("ui-b: FAILURES");
} else {
  console.log(`ui-b: ${passed} passed`);
}
