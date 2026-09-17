#!/usr/bin/env tsx
/**
 * silent-failures.test.ts — the reads that decide a gate must fail loudly.
 *
 * Each block below corresponds to a `catch {}` / `.catch(() => default)` that
 * used to turn an unreadable gate-deciding file into a permissive default:
 * a corrupt classification map became `{}` (losing every prior classification),
 * a corrupt approval record became "no baseline yet", a malformed channels.yaml
 * or cv/meta.yaml became "use the hard-coded default". The contract now is:
 *
 *   missing  → may default, but the JSON report says so
 *   unreadable or malformed → nonzero exit, and the reason names the file
 *
 * Every CLI runs as a child process against a throwaway HARNESS_REPO_ROOT (the
 * pattern in tests/resume-context.test.ts), so the person's own state/ is never
 * read or written. The pipeline blocks run against a throwaway PIPELINE_DB and
 * AUDIT_DIR.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures", "silent-failures");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "silent-failures-"));

const tsx = fs.existsSync(path.join(repo, "node_modules", ".bin", "tsx"))
  ? { cmd: path.join(repo, "node_modules", ".bin", "tsx"), pre: [] as string[] }
  : { cmd: "npx", pre: ["tsx"] };

type Run = { status: number; stdout: string; stderr: string };

/** Run a tool CLI with its own fixture repo root. */
function run(tool: string, args: string[], opts: { root?: string; env?: Record<string, string> } = {}): Run {
  const r = spawnSync(tsx.cmd, [...tsx.pre, path.join(repo, tool), ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.root ? { HARNESS_REPO_ROOT: opts.root } : {}), ...(opts.env ?? {}) },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A fresh fixture repo root; `HARNESS_REPO_ROOT` makes repoPath() resolve here. */
let caseIndex = 0;
function newRoot(): string {
  const root = path.join(tmpRoot, `root-${++caseIndex}`);
  fs.mkdirSync(path.join(root, "state", "profile"), { recursive: true });
  return root;
}

function write(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const checks: string[] = [];
function ok(name: string): void {
  checks.push(name);
  console.log(`  ok  ${name}`);
}

// --- 1. merge-classifications: the canonical map -----------------------------
{
  const root = newRoot();
  const target = path.join(root, "state", "pipeline", "classifications.json");
  const source = path.join(root, "source.json");
  write(source, fs.readFileSync(path.join(fixtures, "classifications-valid.json"), "utf8"));

  // Missing target: allowed to default, but the report must say so.
  const fresh = run("tools/merge-classifications.ts", ["--target", target, source], { root });
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshReport = JSON.parse(fresh.stdout);
  assert.equal(freshReport.target_existed, false, "a defaulted-from-nothing merge must declare it");
  assert.match(String(freshReport.note), /did not exist/);
  assert.equal(freshReport.total, 1);
  ok("merge-classifications: missing canonical map defaults and says so");

  // Corrupt target: must not silently become {} and drop prior classifications.
  write(target, fs.readFileSync(path.join(fixtures, "classifications-corrupt.json"), "utf8"));
  const corrupt = run("tools/merge-classifications.ts", ["--target", target, source], { root });
  assert.notEqual(corrupt.status, 0, "a corrupt canonical map must not merge");
  assert.ok(corrupt.stderr.includes(target), `reason must name ${target}, got: ${corrupt.stderr}`);
  assert.equal(
    fs.readFileSync(target, "utf8"),
    fs.readFileSync(path.join(fixtures, "classifications-corrupt.json"), "utf8"),
    "the corrupt map must be left exactly as found, not overwritten",
  );
  ok("merge-classifications: corrupt canonical map exits nonzero and names the file");
}

// --- 2. verify-plan: --plan is required --------------------------------------
{
  const noPlan = run("tools/verify-plan.ts", []);
  assert.equal(noPlan.status, 2, `--plan absent must be a usage error, got ${noPlan.status}`);
  assert.match(noPlan.stderr, /--plan/, "usage error must name the missing flag");
  ok("verify-plan: --plan is required (exit 2), no dead default plan path");

  const src = fs.readFileSync(path.join(repo, "tools", "verify-plan.ts"), "utf8");
  assert.ok(!src.includes("DEFAULT_PLAN"), "the non-existent default plan path must be gone");
  // The synthetic-event scrub is the one cleanup that must never be swallowed:
  // its failure leaves a fake 'submitted' event in the person's real audit log.
  assert.ok(
    /failed to scrub the synthetic/.test(src) && /process\.exit\(1\)/.test(src.split("failed to scrub the synthetic")[1] ?? ""),
    "scrub failure must exit 1 naming both paths, not `catch {}`",
  );
  ok("verify-plan: synthetic-event scrub failure exits 1 instead of being swallowed");
}

// --- 3. resume-approve: the approval record ----------------------------------
{
  const root = newRoot();
  const resumeDir = path.join(root, "state", "profile", "resumes", "solution-architect");
  fs.mkdirSync(resumeDir, { recursive: true });

  // Missing: reported as missing, exit 2 (the documented "no baseline" code).
  const missing = run("tools/resume/resume-approve.ts", ["--check", "solution-architect"], { root });
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).approval_state, "missing");
  ok("resume-approve: a missing baseline reports approval_state 'missing'");

  const statusRun = run("tools/resume/resume-approve.ts", ["--status"], { root });
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.equal(JSON.parse(statusRun.stdout)[0].approval_state, "missing");
  ok("resume-approve: --status reports approval_state 'missing' per resume");

  // Corrupt: must never read as "fresh, unapproved" and be silently overwritten.
  const meta = write(path.join(resumeDir, "metadata.json"), fs.readFileSync(path.join(fixtures, "metadata-corrupt.json"), "utf8"));
  const corrupt = run("tools/resume/resume-approve.ts", ["--check", "solution-architect"], { root });
  assert.notEqual(corrupt.status, 0);
  assert.ok(corrupt.stderr.includes(meta), `reason must name ${meta}, got: ${corrupt.stderr}`);
  ok("resume-approve: corrupt approval state exits nonzero and names the file");

  const corruptApprove = run("tools/resume/resume-approve.ts", ["--resume", "solution-architect", "--skip-critic"], { root });
  assert.notEqual(corruptApprove.status, 0, "approving over a corrupt approval record must be refused");
  assert.ok(corruptApprove.stderr.includes(meta));
  ok("resume-approve: --resume refuses over a corrupt approval record");
}

// --- 4. market-lens-audit: a fail-shaped report must exit nonzero ------------
{
  const root = newRoot();
  const orgPath = write(path.join(root, "org.yaml"), fs.readFileSync(path.join(fixtures, "market-lens-org.yaml"), "utf8"));
  const assignPath = write(path.join(root, "assign.yaml"), "resumes:\n  - id: silent-failure-lens\n");
  const cvPath = write(path.join(root, "cv-source.md"), "# CV\n\nDelivered nothing relevant to the lens.\n");
  const args = (confirmations: string) => [
    "--resume", "silent-failure-lens",
    "--profile-resumes", assignPath,
    "--org-resume-types", orgPath,
    "--cv-source", cvPath,
    "--confirmations", confirmations,
  ];

  const blocking = write(path.join(root, "blocking.yaml"), fs.readFileSync(path.join(fixtures, "market-confirmations-blocking.yaml"), "utf8"));
  const blocked = run("tools/resume/market-lens-audit.ts", args(blocking), { root });
  assert.equal(blocked.status, 1, `source_update_required must exit 1, got ${blocked.status}: ${blocked.stderr}`);
  const blockedReport = JSON.parse(blocked.stdout);
  assert.equal(blockedReport.verdict, "fail");
  assert.equal(blockedReport.source_update_required.length, 1);
  assert.match(blocked.stderr, /require a cv-source\.md update/);
  ok("market-lens-audit: source_update_required exits 1 with the report intact");

  const clean = write(path.join(root, "clean.yaml"), "confirmations: []\n");
  const passed = run("tools/resume/market-lens-audit.ts", args(clean), { root });
  assert.equal(passed.status, 0, passed.stderr);
  const passedReport = JSON.parse(passed.stdout);
  assert.equal(passedReport.verdict, "pass");
  assert.ok(
    passedReport.confirmation_needed.length > 0,
    "gaps alone stay non-fatal: an unanswered proof question is a question for the person, not a broken state",
  );
  ok("market-lens-audit: unanswered gaps alone stay exit 0");
}

// --- 5. onboarding: profile.md and channels.yaml -----------------------------
{
  const root = newRoot();
  write(path.join(root, "state", "profile", "cv-source.md"), "# CV\n\nSomething.\n");

  const bothMissing = run("tools/onboarding.ts", ["context"], { root });
  assert.equal(bothMissing.status, 0, bothMissing.stderr);
  assert.match(bothMissing.stdout, /profile\.md missing/, "a missing profile.md must be stated, not inferred from silence");
  assert.match(bothMissing.stdout, /channels\.yaml missing/);
  ok("onboarding: missing profile.md / channels.yaml are noted in the output");

  write(path.join(root, "state", "profile", "profile.md"), "## Day rate\n$1400/day inc super.\n");
  const channels = write(path.join(root, "state", "profile", "channels.yaml"), fs.readFileSync(path.join(fixtures, "channels-corrupt.yaml"), "utf8"));
  const corrupt = run("tools/onboarding.ts", ["context"], { root });
  assert.notEqual(corrupt.status, 0, "malformed channels.yaml must not yield a context blob with no channel ids");
  assert.ok(corrupt.stderr.includes(channels), `reason must name ${channels}, got: ${corrupt.stderr}`);
  ok("onboarding: malformed channels.yaml exits nonzero and names the file");
}

// --- 6. markdownify-cv: cv/meta.yaml picks the source document ---------------
{
  const root = newRoot();
  const metaPath = path.join(root, "state", "profile", "cv", "meta.yaml");

  // Missing meta.yaml: the hard-coded default stands, but the report says so.
  // --dry-run still stats the source, so point at a file that does not exist
  // and assert on the fallback path the tool chose rather than on a parse.
  const missing = run("tools/cv/markdownify-cv.ts", ["--dry-run"], { root });
  assert.notEqual(missing.status, 0, "the fallback .docx does not exist in a fixture root");
  assert.match(missing.stderr, /Source not found:.*master-cv\.docx/, "the fallback source must be named");
  ok("markdownify-cv: missing cv/meta.yaml falls back to the default and names it");

  write(metaPath, fs.readFileSync(path.join(fixtures, "cv-meta-corrupt.yaml"), "utf8"));
  const corrupt = run("tools/cv/markdownify-cv.ts", ["--dry-run"], { root });
  assert.notEqual(corrupt.status, 0);
  assert.ok(corrupt.stderr.includes(metaPath), `reason must name ${metaPath}, got: ${corrupt.stderr}`);
  assert.ok(
    !/Source not found/.test(corrupt.stderr),
    "a malformed meta.yaml must stop before it can parse the fallback document",
  );
  ok("markdownify-cv: malformed cv/meta.yaml exits nonzero and names the file");

  // A readable meta.yaml picks its source_file, not the hard-coded fallback.
  write(metaPath, `source_file: ${path.join(root, "other-cv.docx")}\n`);
  const valid = run("tools/cv/markdownify-cv.ts", ["--dry-run"], { root });
  assert.notEqual(valid.status, 0, "the named .docx does not exist in the fixture root");
  assert.match(valid.stderr, /Source not found:.*other-cv\.docx/);
  ok("markdownify-cv: a readable cv/meta.yaml chooses its source_file");
}

// --- 7. dedup-pipeline: merges leave an audit trail, not a silent delete -----
{
  const dbRoot = path.join(tmpRoot, "dedup");
  fs.mkdirSync(dbRoot, { recursive: true });
  const env = {
    PIPELINE_DB: path.join(dbRoot, "pipeline.db"),
    AUDIT_DIR: path.join(dbRoot, "audit"),
  };

  // Set both BEFORE the first import of pipeline.ts: it pulls in audit.ts,
  // which pins AUDIT_DIR at module load. Importing first sent every audit event
  // in this file to the real state/audit/audit-log.jsonl.
  process.env.PIPELINE_DB = env.PIPELINE_DB;
  process.env.AUDIT_DIR = env.AUDIT_DIR;

  const { upsert, opportunityIdFor } = await import("../tools/pipeline.ts");
  const { canonicaliseUrl } = await import("../tools/url-canonical.ts");

  // Two rows for the same SEEK job: one already canonical, one with tracking
  // parameters that canonicalise onto the first.
  const canonicalUrl = "https://www.seek.com.au/job/77777777";
  const noisyUrl = `${canonicalUrl}?type=standard&tracking=abc`;
  assert.equal(canonicaliseUrl("seek", noisyUrl), canonicalUrl, "fixture relies on these two urls collapsing");
  const survivorId = opportunityIdFor("seek", canonicalUrl);
  const loserId = opportunityIdFor("seek", noisyUrl);
  assert.notEqual(survivorId, loserId);

  await upsert({ channel: "seek", url: canonicalUrl, title: "Solution Architect", company: "Acme", description: "canonical row" });
  await upsert({ channel: "seek", url: noisyUrl, title: "Solution Architect", company: "Acme", description: "duplicate row", score: 82 });

  const dry = run("tools/dedup-pipeline.ts", ["--dry-run"], { env });
  assert.equal(dry.status, 0, dry.stderr);
  const dryReport = JSON.parse(dry.stdout);
  assert.equal(dryReport.collapsed, 1);
  assert.equal(dryReport.dry_run, true);

  const real = run("tools/dedup-pipeline.ts", [], { env });
  assert.equal(real.status, 0, real.stderr);

  const { get, list } = await import("../tools/pipeline.ts");
  const survivor = await get(survivorId);
  assert.ok(survivor, "the canonical row must survive");
  assert.equal(await get(loserId), null, "the collapsed duplicate must be gone");
  assert.ok(
    survivor!.history.some((h) => (h.reason ?? "").includes("merged_from") && (h.reason ?? "").includes(loserId)),
    `survivor history must record merged_from ${loserId}: ${JSON.stringify(survivor!.history)}`,
  );
  assert.equal(survivor!.score, 82, "richer fields are carried onto the survivor");
  assert.equal((await list()).length, 1);

  const auditLines = fs.readFileSync(path.join(env.AUDIT_DIR, "audit-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const removal = auditLines.find((e) => e.role_id === loserId && e.details?.removed === true);
  assert.ok(removal, "the removed duplicate must leave an audit event");
  assert.equal(removal.actor, "dedup-pipeline");
  assert.match(String(removal.details.reason), new RegExp(`merged into ${survivorId}`));
  ok("dedup-pipeline: survivor keeps merged_from history, loser is removed with an audit event");

  // Idempotent: a second pass has nothing to collapse.
  const again = JSON.parse(run("tools/dedup-pipeline.ts", ["--dry-run"], { env }).stdout);
  assert.equal(again.collapsed, 0);
  assert.equal(again.buckets.length, 0);
  ok("dedup-pipeline: a second pass is a no-op");
}

// --- 8. readJdTitle reads the pipeline store, not a renamed JSON file --------
{
  const dbRoot = path.join(tmpRoot, "jdtitle");
  fs.mkdirSync(dbRoot, { recursive: true });
  process.env.PIPELINE_DB = path.join(dbRoot, "pipeline.db");
  // AUDIT_DIR was pinned by the first import of audit.ts above; this only keeps
  // any child process spawned from here pointed at the same throwaway dir.
  process.env.AUDIT_DIR = path.join(dbRoot, "audit");
  const { useStore } = await import("../tools/pipeline-store.ts");
  useStore(path.join(dbRoot, "pipeline.db"));

  const { upsert } = await import("../tools/pipeline.ts");
  const row = await upsert({
    channel: "seek",
    url: "https://www.seek.com.au/job/12121212",
    title: "Principal Integration Architect",
    company: "Buyer Pty Ltd",
  });

  const { readJdTitle } = await import("../tools/resume/resume-keywords.ts");
  assert.equal(await readJdTitle(row.id, "# Some other heading\n"), "Principal Integration Architect");
  ok("readJdTitle: resolves the advertised title from the pipeline store");

  // An id the harness never ingested still falls through to the JD heading.
  assert.equal(await readJdTitle("seek-does-not-exist", "# Delivery Lead — NSW Gov\n"), "Delivery Lead");
  ok("readJdTitle: an unknown id falls through to the JD heading");
}

// --- 8b. lexicon-mine reads the store by default, --pipeline still works -----
{
  const dbRoot = path.join(tmpRoot, "lexicon");
  fs.mkdirSync(dbRoot, { recursive: true });
  process.env.PIPELINE_DB = path.join(dbRoot, "pipeline.db");
  // AUDIT_DIR was pinned by the first import of audit.ts above; this only keeps
  // any child process spawned from here pointed at the same throwaway dir.
  process.env.AUDIT_DIR = path.join(dbRoot, "audit");
  const { useStore } = await import("../tools/pipeline-store.ts");
  useStore(path.join(dbRoot, "pipeline.db"));

  const filler = "The successful candidate will join our team in a contract position based in the city office. ".repeat(6);
  const { upsert } = await import("../tools/pipeline.ts");
  await upsert({
    channel: "seek",
    url: "https://www.seek.com.au/job/34343434",
    title: "Solution Architect",
    company: "Acme",
    description: `Solution Architect\n${filler}\nMust have: Azure integration services.`,
  });

  const { collectCorpus } = await import("../tools/resume/lexicon-mine.ts");
  const fromStore = await collectCorpus({
    resumeId: "solution-architect",
    searchKeywords: ["Solution Architect"],
    archiveDir: path.join(dbRoot, "archive"),
    classificationsPath: path.join(dbRoot, "classifications.json"),
  });
  assert.equal(fromStore.matchingRows, 1, "the default corpus must come from the pipeline store, not a renamed JSON file");
  ok("lexicon-mine: default corpus comes from the pipeline store");

  const jsonPath = write(path.join(dbRoot, "explicit.json"), JSON.stringify([
    { id: "manual-1", title: "Solution Architect", description: `Solution Architect\n${filler}` },
    { id: "manual-2", title: "Solution Architect", description: `Solution Architect\n${filler}` },
  ]));
  const fromJson = await collectCorpus({
    resumeId: "solution-architect",
    searchKeywords: ["Solution Architect"],
    pipelinePath: jsonPath,
    archiveDir: path.join(dbRoot, "archive"),
    classificationsPath: path.join(dbRoot, "classifications.json"),
  });
  assert.equal(fromJson.matchingRows, 2, "--pipeline <json> must keep working for fixtures");
  ok("lexicon-mine: an explicit --pipeline <json> still overrides the store");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${checks.length} check(s) passed`);
