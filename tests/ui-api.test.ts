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
import { fileURLToPath } from "node:url";

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
await seed("Principal Consultant", "Ridgeline", [
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

  // The patch just wrote a `field_update: draftDir [test]` history entry. That
  // is machinery, not a reason, so the queue must still show the last thing
  // that actually happened to the row.
  const patched = (await api.getRows({ status: "manual_action_needed" }, ctx)).rows.find((r) => r.id === manualId)!;
  assert.equal(
    patched.reason,
    "letter-critic blocked: scope wording",
    "a field_update is skipped for the earlier status-change reason",
  );
  assert.ok(patched.draftDir, "and the patched field itself is surfaced");

  const detail = await api.getRowDetail(manualId, ctx);
  assert.equal(detail.reason, patched.reason, "the row detail picks the reason the same way");
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
  // Five pending rows over four terms: kafka is asked under two positionings,
  // which is one question, not two.
  const keywordRow = (resume: string, term: string, extra: string[] = []): string[] => [
    "  - kind: keyword",
    "    scope: person",
    `    resume_id: ${resume}`,
    `    signal: ${term}`,
    `    term: ${term}`,
    "    status: pending",
    ...extra,
  ];
  write("state/profile/market-confirmations.yaml", [
    "confirmations:",
    ...keywordRow("solution-architect", "event-driven architecture", [
      "    question: Have you delivered event-driven architecture?",
      "    opportunity_id: seek-abc123",
    ]),
    ...keywordRow("delivery-lead", "terraform", ["    evidence_hint: infrastructure as code on the platform build"]),
    ...keywordRow("solution-architect", "kafka"),
    ...keywordRow("delivery-lead", "kafka"),
    ...keywordRow("delivery-lead", "databricks"),
    "",
  ].join("\n"));

  // The ordering rule: count descending, then term ascending. Stable across
  // calls, so an offset means the same thing on the next page as on this one.
  const all = await api.getKeywordsPending({ all: "1" }, ctx);
  assert.deepEqual(
    all.terms.map((t) => t.term),
    ["kafka", "databricks", "event-driven architecture", "terraform"],
    "terms come back count descending, then term ascending",
  );
  assert.equal(all.pending_total, 5, "pending_total counts pending rows, not terms");
  assert.equal(all.term_total, 4);
  assert.equal(all.offset, 0);
  const kafka = all.terms.find((t) => t.term === "kafka")!;
  assert.equal(kafka.count, 2, "the same term under two positionings is one question over two rows");
  assert.deepEqual(kafka.resumes.sort(), ["delivery-lead", "solution-architect"]);
  const eda = all.terms.find((t) => t.term === "event-driven architecture")!;
  assert.deepEqual(eda.resumes, ["solution-architect"]);
  assert.equal(eda.context, "seek-abc123", "context is the opportunity the term came from");

  // Paging: the same order, a window into it. This is what stops the view from
  // showing the same four terms for ever.
  const page = await api.getKeywordsPending({ limit: 2, offset: 1 }, ctx);
  assert.deepEqual(page.terms.map((t) => t.term), ["databricks", "event-driven architecture"]);
  assert.equal(page.offset, 1);
  assert.equal(page.limit, 2);
  assert.equal(page.pending_total, 5, "a page does not shrink the backlog");
  const past = await api.getKeywordsPending({ limit: 2, offset: 40 }, ctx);
  assert.deepEqual(past.terms, [], "an offset past the end is an empty page, not an error");
  await assert.rejects(
    () => api.getKeywordsPending({ offset: -1 }, ctx),
    (error: any) => error.status === 400,
    "a negative offset is a 400",
  );

  // The search box narrows the list only. The totals stay unfiltered.
  const found = await api.getKeywordsPending({ q: "KAF" }, ctx);
  assert.deepEqual(found.terms.map((t) => t.term), ["kafka"], "q is a case-insensitive substring match on the term");
  assert.equal(found.matched_total, 1);
  assert.equal(found.pending_total, 5, "pending_total is the unfiltered count");
  assert.equal(found.term_total, 4, "term_total is the unfiltered term count");
  const nothing = await api.getKeywordsPending({ q: "no such term" }, ctx);
  assert.deepEqual(nothing.terms, []);
  assert.equal(nothing.term_total, 4);

  const recorded = await api.postKeywordsRecord({ answers: { terraform: "familiarity", "event-driven architecture": "confirm" } }, ctx);
  assert.equal(recorded.action, "record-file");
  assert.deepEqual(recorded.recorded.map((r) => r.status).sort(), ["confirmed", "familiarity"]);
  assert.match(recorded.next_step ?? "", /apply-patch/, "a confirmed term still authorises nothing");
  assert.deepEqual(recorded.unmatched, []);

  const after = await api.getKeywordsPending({ all: "1" }, ctx);
  assert.deepEqual(after.terms.map((t) => t.term), ["kafka", "databricks"], "answered terms leave the pending list");
  assert.equal(after.pending_total, 3);

  const again = await api.postKeywordsRecord({ answers: { terraform: "familiarity" } }, ctx);
  assert.deepEqual(again.recorded, [], "re-recording the same answer is a no-op");
  assert.equal(again.skipped_already_answered.length, 1);

  await assert.rejects(
    () => api.postKeywordsRecord({ answers: { terraform: "maybe" } }, ctx),
    (error: any) => error.status === 400,
    "an answer outside the four fixed answers is a 400",
  );

  const drained = await api.postKeywordsRecord({ answers: { kafka: "na", databricks: "na" } }, ctx);
  assert.equal(drained.recorded.length, 2);
  const empty = await api.getKeywordsPending({}, ctx);
  assert.equal(empty.pending_total, 0, "nothing pending once every term has an answer");
  console.log("  ✓ keyword pending, paging, search and record");
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

// ---------- resumes ----------

{
  // The Resumes screen reads what is on disk under state/profile/resumes/<id>/.
  // The fixture is a tiny invented positioning: two page images, a passing
  // critic round, an audit with one warn, and stub artefacts of a few bytes.
  const fixture = path.join(import.meta.dirname, "fixtures", "ui-resumes", "example-resume");
  const resumeDir = path.join(root, "state", "profile", "resumes", "example-resume");
  fs.cpSync(fixture, resumeDir, { recursive: true });
  // An approval is an approval of artefacts as they were: backdate the copied
  // files so the stamp does not read stale purely because cp touched them.
  const old = new Date("2026-08-15T00:00:00.000Z");
  for (const name of fs.readdirSync(resumeDir)) fs.utimesSync(path.join(resumeDir, name), old, old);

  write("state/profile/resumes.yaml", `resumes:
  - id: example-resume
    label: Example Consultant
    display_headline: Example Consultant, delivery and governance
    active: true
    template: classic
    search_keywords: [Example Consultant]
    should: [delivery ownership]
    could: [governance experience]
    flagged: [junior role]
    cover_letter_angle: Ran the programme end to end.
    rate_band: { floor: 1000, target: 1200, ceiling: 1400, currency: AUD, billing_unit: day, gst_handling: "+ GST" }
    preferred_channels: [seek]
    market_lens:
      clouds:
        - { id: example-delivery, weight: 5 }
`);
  write("state/org/keyword-clouds.yaml", `version: 1
clouds:
  - id: example-delivery
    kind: capability
    label: Example delivery
    refreshed_at: "2026-01-05"
    terms:
      - { term: delivery governance, tier: corpus }
`);

  const listed = await api.handleApi({ method: "GET", pathname: "/api/resumes" }, ctx);
  assert.equal(listed.status, 200);
  const payload = listed.body as any;
  assert.equal(typeof payload.profile.name, "string", "the response names the profile the cards belong to");
  assert.equal(payload.resumes.length, 1, "one positioning on disk is one card");

  const card = payload.resumes[0];
  assert.equal(card.id, "example-resume");
  assert.equal(card.label, "Example Consultant");
  assert.equal(card.positioning, "Example Consultant, delivery and governance", "the headline comes from resumes.yaml");
  assert.equal(card.stamp.kind, "approved", "metadata.json says approved and nothing was rebuilt after it");
  assert.match(card.stamp.text, /Approved/);

  assert.equal(card.pages.length, 2, "both page images are listed");
  assert.equal(card.pages[0].low, false);
  assert.equal(card.pages[1].fill, 62);
  assert.equal(card.pages[1].low, true, "62 percent is under the 75 percent floor the audit declares");
  for (const page of card.pages) {
    assert.match(page.src, /^api\/resumes\/example-resume\/file\/[^/]+\.png$/, "a page is served through the file route");
  }

  const ats = card.gates.find((g: any) => g.name === "ats");
  assert.equal(ats.verdict, "warn", "the gate chips carry the audit's own verdicts");
  assert.ok(card.checks.some((c: any) => c.key === "critic"), "the tick row includes the critic mark");
  assert.deepEqual(
    { verdict: card.critic.verdict, round: card.critic.round, findings_count: card.critic.findings_count },
    { verdict: "pass", round: 2, findings_count: 0 },
    "the critic line reads off <prefix>.critic.json",
  );
  assert.deepEqual(card.keywords.must_have, { surfaced: 14, total: 18 });
  assert.deepEqual(card.keywords.renderable, { surfaced: 31, total: 40 });
  assert.equal(card.clouds.length, 1);
  assert.equal(card.clouds[0].stale, true, "a cloud refreshed in January is stale in September");
  assert.match(card.files.pdf, /\/file\/.+\.pdf$/);
  assert.match(card.files.docx, /\/file\/.+\.docx$/);
  assert.match(card.files.md, /\/file\/.+\.md$/);

  // The urls the card hands out must resolve through the file route itself.
  const page = await api.handleApi({ method: "GET", pathname: `/${card.pages[0].src}` }, ctx);
  assert.equal(page.status, 200);
  assert.equal(page.headers?.["content-type"], "image/png");
  assert.equal(page.headers?.["cache-control"], "no-store", "an artefact is never cached");
  assert.ok(page.stream && fs.existsSync(page.stream), "the handler names a real file for the server to stream");

  const escape = await api.handleApi(
    { method: "GET", pathname: "/api/resumes/example-resume/file/..%2F..%2Fresumes.yaml" },
    ctx,
  );
  assert.equal(escape.status, 403, "a name that walks out of the folder is refused");

  const wrongType = await api.handleApi({ method: "GET", pathname: "/api/resumes/example-resume/file/notes.txt" }, ctx);
  assert.equal(wrongType.status, 403, "only the artefact extensions are served");

  const absent = await api.handleApi({ method: "GET", pathname: "/api/resumes/example-resume/file/missing.png" }, ctx);
  assert.equal(absent.status, 404, "a name that is not there is a 404");

  const wrongMethod = await api.handleApi({ method: "POST", pathname: `/${card.pages[0].src}` }, ctx);
  assert.equal(wrongMethod.status, 405, "the file route is read-only");
  console.log("  ✓ resumes list, page urls, traversal and extension refusals");
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

    // The artefact route sits under the same gate as every other /api route,
    // and the bytes come back as themselves rather than as JSON.
    const fileUrl = `${base}/api/resumes/example-resume/file/Fixture-Person_Example-Consultant.page-1.png`;
    const noToken = await fetch(fileUrl);
    assert.equal(noToken.status, 401, "a resume artefact is behind the token too");
    const withToken = await fetch(fileUrl, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.headers.get("content-type"), "image/png", "a page image is served as a PNG");
    assert.equal(withToken.headers.get("cache-control"), "no-store");
    assert.ok((await withToken.arrayBuffer()).byteLength > 0, "the file route streams bytes");

    const escape = await fetch(`${base}/../package.json`);
    assert.ok(escape.status === 403 || escape.status === 404, "a path that escapes the static root is refused");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("  ✓ token enforcement, static shell, 404 and traversal");
}

// ---------- policy: the two gates the UI may flip ----------

// Runs last on purpose: it replaces the fixture policy with a copy of the real
// template, which every earlier block has already read.
{
  const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/profile/submission-policy.yaml");
  const template = fs.readFileSync(templatePath, "utf8");
  // A comment line directly above the key the UI writes. If parseDocument is
  // ever swapped for a parse-and-dump, this is the line that disappears.
  const seeded = template.replace(
    "autopilot:\n  enabled: false",
    "autopilot:\n  # The UI flips this one; this comment must survive the write.\n  enabled: false",
  );
  assert.notEqual(seeded, template, "the template still has autopilot.enabled to seed");
  const policyFile = write("state/profile/submission-policy.yaml", seeded);

  const before = await api.handleApi({ method: "GET", pathname: "/api/policy" }, ctx);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, {
    autopilot_enabled: false,
    kill_switch: false,
    max_per_day: 10,
    channels: ["seek", "linkedin_jobs"],
    sheet_enabled: false,
    path: path.join("state", "profile", "submission-policy.yaml"),
  });

  const badBody = await api.handleApi({ method: "POST", pathname: "/api/policy/autopilot", body: { enabled: "yes" } }, ctx);
  assert.equal(badBody.status, 400, "only a real boolean flips a gate");
  assert.equal(fs.readFileSync(policyFile, "utf8"), seeded, "a refused request writes nothing");

  const on = await api.handleApi(
    { method: "POST", pathname: "/api/policy/autopilot", body: { enabled: true, reason: "ran three attended cycles" } },
    ctx,
  );
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { ok: true, autopilot_enabled: true });

  const kill = await api.handleApi({ method: "POST", pathname: "/api/policy/kill-switch", body: { enabled: true } }, ctx);
  assert.equal(kill.status, 200);
  assert.deepEqual(kill.body, { ok: true, kill_switch: true });

  const after = fs.readFileSync(policyFile, "utf8");
  assert.match(after, /  # The UI flips this one; this comment must survive the write\.\n  enabled: true\n/,
    "the comment above autopilot.enabled survives, and the value moved");
  assert.match(after, /^kill_switch: true +# Set true to halt every submission, attended or not\.$/m,
    "kill_switch flipped and kept its trailing comment");

  // Nothing else moved: same line count, and the only differences are the two
  // lines that were asked for.
  const beforeLines = seeded.split("\n");
  const afterLines = after.split("\n");
  assert.equal(afterLines.length, beforeLines.length, "no line was added or removed");
  const changed = beforeLines.map((line, i) => [line, afterLines[i]]).filter(([a, b]) => a !== b);
  assert.equal(changed.length, 2, `only two lines changed, got ${changed.length}`);
  assert.deepEqual(
    changed.map(([, b]) => b.replace(/ {2,}/g, "  ")),
    ["kill_switch: true  # Set true to halt every submission, attended or not.", "  enabled: true"],
    "exactly the two keys the UI was asked to flip changed, comments and all",
  );
  // Everything the UI did not touch is byte-identical, including the long
  // quoted `notes:` strings and the aligned comment columns.
  const untouched = (lines: string[]) => lines.filter((l) => !/^(kill_switch|  enabled):/.test(l)).join("\n");
  assert.equal(untouched(afterLines), untouched(beforeLines), "no other byte of the policy moved");

  const reread = await api.handleApi({ method: "GET", pathname: "/api/policy" }, ctx);
  assert.equal((reread.body as any).autopilot_enabled, true);
  assert.equal((reread.body as any).kill_switch, true);

  const events = fs.readFileSync(path.join(root, "audit", "audit-log.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((e: any) => e.event_type === "policy_change");
  assert.equal(events.length, 2, "one audit event per flip, and none for the refused request");
  assert.deepEqual(events[0].details, { key: "autopilot.enabled", from: false, to: true, reason: "ran three attended cycles" });
  assert.deepEqual(events[1].details, { key: "kill_switch", from: false, to: true, reason: null });
  assert.ok(events.every((e: any) => e.actor === "ui" && e.role_id === null && e.ts), "every flip names the UI and carries a timestamp");

  // No policy file is "nothing is switched on", and a write refuses rather
  // than conjuring a policy from a browser click.
  fs.rmSync(policyFile);
  const none = await api.handleApi({ method: "GET", pathname: "/api/policy" }, ctx);
  assert.deepEqual(none.body, {
    autopilot_enabled: false,
    kill_switch: false,
    max_per_day: null,
    channels: [],
    sheet_enabled: false,
    path: path.join("state", "profile", "submission-policy.yaml"),
  });
  const refused = await api.handleApi({ method: "POST", pathname: "/api/policy/kill-switch", body: { enabled: false } }, ctx);
  assert.equal(refused.status, 409, "with no policy file there is nothing to flip");
  assert.equal(fs.existsSync(policyFile), false, "and the file is not created");

  const wrongMethod = await api.handleApi({ method: "GET", pathname: "/api/policy/autopilot" }, ctx);
  assert.equal(wrongMethod.status, 404, "the flips are POST only");
  console.log("  \u2713 policy read, both flips, comment preservation, audit trail and the missing-file refusals");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("ui-api.test.ts: all assertions passed");
