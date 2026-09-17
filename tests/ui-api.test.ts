#!/usr/bin/env tsx
/**
 * ui-api.test.ts — the local web UI's JSON contract.
 *
 * The front end is built against tools/ui/api.ts, so the handlers are called
 * directly here (no sockets) apart from the two things that only exist at the
 * HTTP layer: the bearer token and static file serving, which run against a
 * real server on port 0.
 *
 * Everything runs against a fixture repo root (HARNESS_REPO_ROOT), a throwaway
 * pipeline database (PIPELINE_DB) and a throwaway audit dir (AUDIT_DIR), so
 * the person's own state/ is never read or written.
 *
 * Run: npx tsx tests/ui-api.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-api-"));
// All three must be set before the tools are evaluated: repo-root, the pipeline
// store and audit.ts all pin their paths at import time.
process.env.HARNESS_REPO_ROOT = root;
process.env.PIPELINE_DB = path.join(root, "pipeline.db");
process.env.AUDIT_DIR = path.join(root, "audit");
delete process.env.HARNESS_PROFILE;
delete process.env.HARNESS_UI_TOKEN;

const { upsert, setStatus, patch, get } = await import("../tools/pipeline.ts");
const api = await import("../tools/ui/api.ts");
const { startUiServer, bindingError, isLocalHost } = await import("../tools/ui/server.ts");

const TZ = "Australia/Sydney";
const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const queuePath = path.join(root, "approval-queue.json");
const ctx = { queuePath, archiveDir: path.join(root, "archive"), journalDir: path.join(root, "journal") };

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
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
  // Fields go in on the insert: a later patch() appends its own
  // `field_update` history entry, which would then be the row's last reason.
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

// ---------- seed ----------

const manualId = await seed("Solution Architect", "Acme Federal", ["manual_action_needed"], {
  score: 82,
  location: "Sydney NSW",
  applyMethod: "quick_apply",
  userSaved: true,
  workArrangement: "hybrid",
  resumeId: "solution-architect",
}, "letter-critic blocked: scope wording");

const shortlistedId = await seed("Delivery Lead", "Harbour Super", ["shortlisted"], { score: 71, location: "Sydney NSW" });
const submittedId = await seed("Principal Consultant", "Ridgeline", [
  "shortlisted", "drafted", "awaiting_approval", "approved", "submitted",
], { score: 64 });
const awaitingId = await seed("Integration Architect", "Borden Rail", ["shortlisted", "drafted", "awaiting_approval"], { score: 90 });

write("state/profile/submission-policy.yaml", "kill_switch: false\nautopilot:\n  enabled: true\n  max_per_day: 10\n");

// ---------- summary ----------

{
  const summary = await api.getSummary(ctx);
  assert.equal(summary.total, 4, "every seeded row is counted");
  assert.equal(summary.counts.manual_action_needed, 1);
  assert.equal(summary.counts.awaiting_approval, 1);
  assert.equal(summary.sent_today, 1, "the row submitted just now counts as sent today");
  assert.equal(summary.autopilot_enabled, true, "autopilot.enabled is read from the profile policy");
  assert.equal(summary.kill_switch, false);
  assert.ok(summary.generated_at.endsWith("Z"));
  console.log("  ✓ summary counts, sent_today and the policy flags");
}

{
  fs.rmSync(path.join(root, "state/profile/submission-policy.yaml"));
  const summary = await api.getSummary(ctx);
  assert.equal(summary.autopilot_enabled, false, "a missing policy is autopilot off, not an error");
  assert.equal(summary.kill_switch, false);
  write("state/profile/submission-policy.yaml", "kill_switch: false\nautopilot:\n  enabled: true\n");
  console.log("  ✓ a missing submission-policy.yaml is tolerated");
}

// ---------- rows ----------

{
  const all = await api.getRows({}, ctx);
  assert.equal(all.rows.length, 4);
  assert.deepEqual(
    all.rows.map((r) => r.status),
    ["awaiting_approval", "shortlisted", "manual_action_needed", "submitted"],
    "rows come back in the Sheet's status rank, then score descending",
  );

  const filtered = await api.getRows({ status: "manual_action_needed,shortlisted" }, ctx);
  assert.deepEqual(filtered.rows.map((r) => r.id).sort(), [manualId, shortlistedId].sort(), "status is a comma list");

  const manual = filtered.rows.find((r) => r.id === manualId)!;
  assert.equal(manual.reason, "letter-critic blocked: scope wording", "reason is the last history reason");
  assert.equal(manual.applyMethod, "quick_apply");
  assert.equal(manual.userSaved, true);
  assert.equal(manual.workArrangement, "hybrid");
  assert.equal(manual.resumeId, "solution-architect");
  assert.equal(manual.location, "Sydney NSW");
  assert.ok(manual.first_seen_at && manual.updated_at, "the row carries its own timestamps");
  assert.ok(manual.first_seen_at! <= manual.updated_at!);

  const search = await api.getRows({ q: "harbour" }, ctx);
  assert.deepEqual(search.rows.map((r) => r.id), [shortlistedId], "q matches company case-insensitively");

  const limited = await api.getRows({ limit: 2 }, ctx);
  assert.equal(limited.rows.length, 2, "limit trims the list");
  console.log("  ✓ rows filter, search, order, limit and reason");
}

{
  // A parked row with no history reason falls back to notes.
  const notesId = await seed("Platform Lead", "Statewide Water", ["parked"], { notes: "interstate onsite" }, "");
  const parked = (await api.getRows({ status: "parked" }, ctx)).rows[0];
  assert.equal(parked.id, notesId);
  assert.equal(parked.reason, "interstate onsite", "no history reason falls back to the note");
  console.log("  ✓ reason falls back to notes");
}

// ---------- row detail ----------

{
  const draftDir = path.join(root, "archive", manualId);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(path.join(draftDir, "jd.md"), "# JD\nSolution Architect at Acme Federal.\n");
  fs.writeFileSync(path.join(draftDir, "cover-letter.md"), "Dear hiring team,\n\nI have led the integration work.\n");
  fs.writeFileSync(path.join(draftDir, "metadata.json"), JSON.stringify({ resume: { id: "solution-architect" } }));
  fs.writeFileSync(path.join(draftDir, "letter-critic.json"), JSON.stringify({ verdict: "block", findings: [] }));
  await patch(manualId, { draftDir }, "test");

  const detail = await api.getRowDetail(manualId, ctx);
  assert.equal(detail.row.id, manualId);
  assert.equal(detail.row.description, "JD for Solution Architect", "the full row carries the JD");
  assert.ok(detail.row.history.length >= 2, "and its history");
  assert.match(detail.package.jd!, /Solution Architect at Acme Federal/);
  assert.match(detail.package.cover_letter!, /Dear hiring team/);
  assert.deepEqual(detail.package.metadata, { resume: { id: "solution-architect" } });
  assert.deepEqual(detail.package.letter_critic, { verdict: "block", findings: [] });
  assert.equal(detail.package.confirmation, null, "an absent package file is null, not an error");

  const noPackage = await api.getRowDetail(shortlistedId, ctx);
  assert.deepEqual(noPackage.package, { jd: null, cover_letter: null, metadata: null, letter_critic: null, confirmation: null });

  await assert.rejects(
    () => api.getRowDetail("seek-nosuchrow", ctx),
    (error: any) => error.status === 404,
    "an unknown id is a 404",
  );
  console.log("  ✓ row detail reads the package files from draftDir");
}

// ---------- actions ----------

{
  const result = await api.postRowAction(manualId, { action: "retry", reason: "answer banked", edits: "shorter opener" }, ctx);
  assert.deepEqual(result, { ok: true, id: manualId, action: "retry", status_after: "approved", queued: true });

  const row = (await get(manualId))!;
  assert.equal(row.status, "approved", "retry moves a manual row to approved, exactly as the Sheet pull does");
  const last = row.history[row.history.length - 1];
  assert.equal(last.from, "manual_action_needed");
  assert.equal(last.to, "approved");
  assert.match(last.reason ?? "", /ui: retry \(answer banked\)/, "the history says who asked and why");

  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  assert.deepEqual(queue, [{ id: manualId, action: "retry", edits: "shorter opener" }], "the decision lands in the approval queue");

  const approve = await api.postRowAction(awaitingId, { action: "approve" }, ctx);
  assert.equal(approve.status_after, "awaiting_approval", "approve queues the row and moves nothing");
  assert.equal(approve.queued, true);
  const queue2 = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  assert.equal(queue2.length, 2, "a second decision is merged in, not written over the first");
  console.log("  ✓ retry and approve carry the Sheet pull's semantics");
}

{
  await assert.rejects(
    () => api.postRowAction(shortlistedId, { action: "retry" }, ctx),
    (error: any) => error.status === 409 && /invalid transition/.test(error.message),
    "an illegal transition is a 409 naming the reason",
  );
  await assert.rejects(
    () => api.postRowAction(shortlistedId, { action: "banana" }, ctx),
    (error: any) => error.status === 400 && /unknown action/.test(error.message),
    "an unknown action is a 400",
  );
  await assert.rejects(
    () => api.postRowAction("seek-nosuchrow", { action: "reject" }, ctx),
    (error: any) => error.status === 404,
    "an action on an unknown row is a 404",
  );
  const shortlisted = (await get(shortlistedId))!;
  assert.equal(shortlisted.status, "shortlisted", "a refused action leaves the row where it was");
  console.log("  ✓ invalid transition 409, unknown action 400, unknown row 404");
}

// ---------- keywords ----------

{
  write("state/profile/market-confirmations.yaml", [
    "confirmations:",
    "  - kind: keyword",
    "    scope: person",
    "    resume_id: solution-architect",
    "    signal: event-driven architecture",
    "    term: event-driven architecture",
    "    status: pending",
    "    question: Have you delivered event-driven architecture?",
    "    opportunity_id: seek-abc123",
    "  - kind: keyword",
    "    scope: person",
    "    resume_id: delivery-lead",
    "    signal: terraform",
    "    term: terraform",
    "    status: pending",
    "    evidence_hint: infrastructure as code on the platform build",
    "",
  ].join("\n"));

  const pending = await api.getKeywordsPending({ limit: 20 }, ctx);
  assert.equal(pending.pending_total, 2);
  assert.deepEqual(pending.terms.map((t) => t.term).sort(), ["event-driven architecture", "terraform"]);
  const eda = pending.terms.find((t) => t.term === "event-driven architecture")!;
  assert.deepEqual(eda.resumes, ["solution-architect"]);
  assert.equal(eda.context, "seek-abc123", "context is the opportunity the term came from");

  const recorded = await api.postKeywordsRecord({ answers: { terraform: "familiarity", "event-driven architecture": "confirm" } }, ctx);
  assert.equal(recorded.action, "record-file");
  assert.deepEqual(recorded.recorded.map((r) => r.status).sort(), ["confirmed", "familiarity"]);
  assert.match(recorded.next_step ?? "", /apply-patch/, "a confirmed term still authorises nothing");
  assert.deepEqual(recorded.unmatched, []);

  const drained = await api.getKeywordsPending({}, ctx);
  assert.equal(drained.pending_total, 0, "answered terms leave the pending list");

  const again = await api.postKeywordsRecord({ answers: { terraform: "familiarity" } }, ctx);
  assert.deepEqual(again.recorded, [], "re-recording the same answer is a no-op");
  assert.equal(again.skipped_already_answered.length, 1);

  await assert.rejects(
    () => api.postKeywordsRecord({ answers: { terraform: "maybe" } }, ctx),
    (error: any) => error.status === 400,
    "an answer outside the four fixed answers is a 400",
  );
  console.log("  ✓ keyword pending and record");
}

// ---------- journal and digest ----------

{
  const absent = await api.getJournalToday({}, ctx);
  assert.equal(absent.date, today, "the journal day is the person's day, not UTC");
  assert.equal(absent.markdown, null, "an unwritten summary is null, not an error");

  fs.mkdirSync(ctx.journalDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.journalDir, `${today}.md`), `# Daily summary ${today}\n\nTwo sent, one parked.\n`);
  const present = await api.getJournalToday({}, ctx);
  assert.match(present.markdown!, /Two sent, one parked/);

  const digest = await api.getCriticDigest({ since: "14d" }, ctx);
  assert.equal(digest.blocked, 0, "an archive with no verdicts digests to nothing");
  assert.deepEqual(digest.themes, []);
  console.log("  ✓ journal for today and the critic digest");
}

// ---------- dispatcher, token and static ----------

{
  const notFound = await api.handleApi({ method: "GET", pathname: "/api/nope" }, ctx);
  assert.equal(notFound.status, 404);
  assert.match(String((notFound.body as any).error), /no such endpoint/);

  const badAction = await api.handleApi({ method: "POST", pathname: `/api/rows/${shortlistedId}/action`, body: { action: "banana" } }, ctx);
  assert.equal(badAction.status, 400, "the dispatcher turns an ApiError into its status");
  console.log("  ✓ the dispatcher maps errors to statuses");
}

{
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("0.0.0.0"), false);
  assert.match(bindingError("0.0.0.0", null) ?? "", /HARNESS_UI_TOKEN/, "a non-local host without a token refuses to start");
  assert.equal(bindingError("0.0.0.0", "s3cret"), null, "with a token it may bind");
  assert.equal(bindingError("127.0.0.1", null), null, "local binding needs no token");

  const staticDir = path.join(root, "static");
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>harness</title>");

  const { server, port } = await startUiServer({ port: 0, host: "127.0.0.1", token: "s3cret", staticDir, ctx });
  try {
    const base = `http://127.0.0.1:${port}`;
    const unauth = await fetch(`${base}/api/summary`);
    assert.equal(unauth.status, 401, "a configured token is required on every /api request");
    assert.match((await unauth.json() as any).error, /unauthorised/);

    const authed = await fetch(`${base}/api/summary`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(authed.status, 200);
    assert.equal(authed.headers.get("cache-control"), "no-store", "nothing the UI serves is cacheable");
    assert.equal(((await authed.json()) as any).total, 5);

    const wrong = await fetch(`${base}/api/summary`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);

    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200, "the app shell needs no token");
    assert.match(shell.headers.get("content-type") ?? "", /text\/html/);

    const missing = await fetch(`${base}/app.css`);
    assert.equal(missing.status, 404, "a missing asset is a 404, not the shell");

    const escape = await fetch(`${base}/../package.json`);
    assert.ok(escape.status === 403 || escape.status === 404, "a path that escapes the static root is refused");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("  ✓ token enforcement, static shell, 404 and traversal");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("ui-api.test.ts: all assertions passed");
