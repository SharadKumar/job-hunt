#!/usr/bin/env tsx
/**
 * verify-plan.ts — closed-loop verifier for the harness.
 *
 * Reads the plan file, extracts every named artefact (file path or npm
 * script), confirms each exists with non-trivial content, and runs a
 * curated set of smoke checks. Returns a report.
 *
 * Usage:
 *   tsx tools/verify-plan.ts --plan <path> [--json]
 *
 * `--plan` is required. It used to default to one contributor's local
 * ~/.claude/plans/ file, which no longer exists, so every run silently
 * degraded to "plan file not found (skipping plan-derived checks)" and nobody
 * noticed the verifier had stopped looking at a plan at all.
 *
 * Exit code: 0 if all checks pass, 1 if any warn (or the synthetic-event
 * cleanup failed), 2 if any fail or the arguments are wrong.
 */

import { exists } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { repoRoot, repoPath } from "./repo-root.ts";

type Check = { id: string; verdict: "pass" | "warn" | "fail"; detail: string };

const TEMPLATE_SAMPLES = [
  { name: "classic", maxPages: 3 },
  { name: "modern", maxPages: 3 },
  { name: "minimalist", maxPages: 2 },
] as const;

async function fileSizeOk(p: string, minBytes = 50): Promise<boolean> {
  try { const s = await fs.stat(p); return s.size >= minBytes; } catch { return false; }
}

function runCmd(cmd: string, args: string[], opts: { allowExitCode1?: boolean } = {}): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args);
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      const ok = code === 0 || (opts.allowExitCode1 === true && code === 1);
      res({ ok, code: code ?? -1, stdout, stderr });
    });
    p.on("error", () => res({ ok: false, code: -1, stdout, stderr }));
  });
}

async function pdfPageCount(pdf: string): Promise<number | null> {
  const r = await runCmd("pdfinfo", [pdf]);
  if (!r.ok) return null;
  const pages = r.stdout.match(/^Pages:\s*(\d+)/m)?.[1];
  return pages ? Number(pages) : null;
}

async function checkArtefacts(checks: Check[]): Promise<void> {
  const expected: string[] = [
    "CLAUDE.md", "AGENTS.md", "README.md", "package.json", "tsconfig.json",
    ".env.example", ".gitignore",
    ".claude/settings.json", ".claude/hooks/session-start.sh",
    ".codex/config.toml",
    // Skills
    ".claude/skills/daily/SKILL.md", ".claude/skills/hunt/SKILL.md",
    ".claude/skills/review-drafts/SKILL.md", ".claude/skills/submit-approved/SKILL.md",
    ".claude/skills/manual-applications/SKILL.md", ".claude/skills/pipeline/SKILL.md",
    ".claude/skills/apply/SKILL.md", ".claude/skills/follow-up/SKILL.md",
    ".claude/skills/prep-interview/SKILL.md", ".claude/skills/rate-check/SKILL.md",
    ".claude/skills/refresh-cv/SKILL.md",
    ".claude/skills/onboarding/SKILL.md", ".claude/skills/resume-strategy/SKILL.md",
    ".claude/skills/resume-render/SKILL.md", ".claude/skills/resume-review/SKILL.md",
    ".claude/skills/resume-render/references/enforce-quality-report.md",
    ".claude/skills/resume-render/references/capture-editorial-edits.md",
    "docs/resume-research/README.md", "docs/resume-research/claims.yaml",
    // Subagents
    "agents/resume-writer.md", "agents/cover-letter-writer.md",
    "agents/outreach-drafter.md", "agents/submission-runner.md",
    "agents/research.md", "agents/state-syncer.md",
    // Cover letter quality reference + templates
    ".claude/skills/apply/references/cover-letter-quality.md",
    "templates/cover-letter/classic/template.md", "templates/cover-letter/classic/example.md",
    "templates/cover-letter/README.md",
    // CV Templates
    "templates/resume/_interface.ts", "templates/resume/_docx-helpers.ts",
    // _pandoc-helpers.ts is markdown-assembly only (assembleMarkdown); no pandoc shell-out
    "templates/resume/_pandoc-helpers.ts",
    ".claude/skills/resume-render/references/quality-checks.md",
    "templates/resume/classic/render.ts", "templates/resume/classic/template.md", "templates/resume/classic/quality-checks.md", "templates/resume/classic/rubric.yaml",
    "templates/resume/modern/render.ts", "templates/resume/modern/template.md", "templates/resume/modern/quality-checks.md", "templates/resume/modern/rubric.yaml",
    "templates/resume/minimalist/render.ts", "templates/resume/minimalist/template.md", "templates/resume/minimalist/quality-checks.md", "templates/resume/minimalist/rubric.yaml",
    // Profile
    "state/profile/profile.md", "state/profile/voice-samples.md",
    "references/voice/voice-rules.md", "references/voice/slop-banlist.md",
    "state/profile/scoring-weights.yaml", "state/profile/skills-taxonomy.yaml",
    "state/profile/channels.yaml", "state/profile/screening-answers.yaml",
    "state/profile/submission-policy.yaml", "state/profile/resumes.yaml",
    // Canonical CV
    "state/profile/cv/meta.yaml", "state/profile/cv-source.md",
    // Tools
    "tools/score.ts", "tools/slop-killer.ts", "tools/voice-check.ts",
    "tools/pipeline.ts", "tools/sheets-sync.ts", "tools/audit.ts", "tools/classify-jd.ts",
    "tools/onboarding.ts", "tools/resumes.ts", "tools/rescore-pipeline.ts",
    "tools/sync-codex-agents.ts",
    "tools/cv/markdownify-cv.ts", "tools/resume/resume-renderer.ts", "tools/resume/resume-to-images.ts",
    "tools/resume/resume-lint-ats.ts", "tools/resume/resume-evaluate.ts",
    "tools/profile.ts",
    "tools/channels/_interface.ts", "tools/channels/seek.ts",
    // Channels with an adapter (see HUNT_SCRIPTS in _interface.ts)
    "tools/channels/linkedin-jobs.ts", "tools/channels/linkedin-posts.ts",
    "tools/channels/hn-who-is-hiring.ts",
    "tools/channels/seek-submit.ts",
    // Scripts
    "scripts/daily.sh", "scripts/install-launchd.sh", "scripts/login-channel.ts",
    // Symlinks (existence check is enough)
    ".agents/skills", ".claude/agents", ".codex/agents",
  ];

  // Intentionally-small files: CLAUDE.md is just `@AGENTS.md`, .env.example may be tiny.
  const tinyOk = new Set(["CLAUDE.md", ".env.example"]);
  for (const p of expected) {
    const ok = await exists(p);
    if (!ok) { checks.push({ id: `exists:${p}`, verdict: "fail", detail: "missing" }); continue; }
    const s = await fs.lstat(p);
    if (s.isSymbolicLink()) { checks.push({ id: `exists:${p}`, verdict: "pass", detail: "symlink" }); continue; }
    if (s.isDirectory()) { checks.push({ id: `exists:${p}`, verdict: "pass", detail: "dir" }); continue; }
    const minBytes = tinyOk.has(p) ? 5 : 50;
    const big = await fileSizeOk(p, minBytes);
    checks.push({ id: `exists:${p}`, verdict: big ? "pass" : "warn", detail: big ? `${s.size}B` : `tiny (${s.size}B)` });
  }
}

async function checkTemplateSamples(checks: Check[]): Promise<void> {
  for (const sample of TEMPLATE_SAMPLES) {
    const sampleDir = `templates/resume/${sample.name}/sample`;
    const contentJson = `${sampleDir}/sample-content.json`;
    const pdf = `${sampleDir}/golden.pdf`;
    const html = `${sampleDir}/golden.html`;
    const docx = `${sampleDir}/golden.docx`;
    const md = `${sampleDir}/golden.md`;
    const pages = await pdfPageCount(pdf);
    checks.push({
      id: `sample:${sample.name}:pages`,
      verdict: pages !== null && pages <= sample.maxPages ? "pass" : "fail",
      detail: pages === null ? "could not inspect sample PDF" : `${pages} page(s), max ${sample.maxPages}`,
    });

    const evaluator = await runCmd("npm", [
      "run",
      "resume:evaluate",
      "--",
      "--template",
      sample.name,
      "--content-json",
      contentJson,
      "--docx",
      docx,
      "--pdf",
      pdf,
      "--md",
      md,
      "--html",
      html,
    ]);
    const verdict = (evaluator.stdout.match(/"verdict":\s*"(pass|warn|fail)"/)?.[1]) || "?";
    checks.push({
      id: `sample:${sample.name}:rubric`,
      verdict: evaluator.ok && verdict === "pass" ? "pass" : "fail",
      detail: evaluator.ok ? `verdict=${verdict}` : `evaluator code=${evaluator.code} verdict=${verdict}`,
    });
  }
}

async function checkCanonicalCV(checks: Check[]): Promise<void> {
  const sourceFile = "state/profile/cv-source.md";
  if (!(await exists(sourceFile))) {
    checks.push({ id: "cv:source_file", verdict: "fail", detail: `${sourceFile} missing — run 'npm run markdownify:cv'` });
    return;
  }
  const raw = await fs.readFile(sourceFile, "utf8");
  // Cheap structural check: must have a Professional Experience section and at
  // least 5 role headers (### lines under Experience).
  const expBlock = raw.match(/##\s+Professional\s+Experience\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i)?.[1] ?? "";
  const roleHeaders = (expBlock.match(/^###\s+/gm) ?? []).length;
  if (roleHeaders < 5) {
    checks.push({ id: "cv:roles_count", verdict: "fail", detail: `${roleHeaders} role headers in cv-source.md (expected ≥ 5)` });
  } else {
    checks.push({ id: "cv:roles_count", verdict: "pass", detail: `${roleHeaders} role headers` });
  }
}

async function checkSkillFrontmatter(checks: Check[]): Promise<void> {
  const skillDir = ".claude/skills";
  if (!(await exists(skillDir))) return;
  const entries = await fs.readdir(skillDir, { withFileTypes: true });
  for (const e of entries.filter((x) => x.isDirectory())) {
    const file = path.join(skillDir, e.name, "SKILL.md");
    if (!(await exists(file))) {
      checks.push({ id: `skill_fm:${e.name}`, verdict: "fail", detail: "no SKILL.md" });
      continue;
    }
    const txt = await fs.readFile(file, "utf8");
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      checks.push({ id: `skill_fm:${e.name}`, verdict: "fail", detail: "no frontmatter" });
      continue;
    }
    const hasName = /^name:\s*\S/m.test(fm[1]);
    const hasDesc = /^description:\s*\S/m.test(fm[1]);
    if (!hasName || !hasDesc) {
      checks.push({ id: `skill_fm:${e.name}`, verdict: "fail", detail: `name=${hasName} desc=${hasDesc}` });
    } else {
      checks.push({ id: `skill_fm:${e.name}`, verdict: "pass", detail: "name + description present" });
    }
  }
}

async function checkAgentFrontmatter(checks: Check[]): Promise<void> {
  const dir = "agents";
  if (!(await exists(dir))) return;
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith(".md")) continue;
    const txt = await fs.readFile(path.join(dir, f), "utf8");
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) { checks.push({ id: `agent_fm:${f}`, verdict: "fail", detail: "no frontmatter" }); continue; }
    const hasName = /^name:\s*\S/m.test(fm[1]);
    const hasDesc = /^description:\s*\S/m.test(fm[1]);
    checks.push({ id: `agent_fm:${f}`, verdict: hasName && hasDesc ? "pass" : "fail", detail: `name=${hasName} desc=${hasDesc}` });
  }
}

async function checkCodexAgentWrappers(checks: Check[]): Promise<void> {
  const codexDir = ".codex/agents";
  if (!(await exists(codexDir))) {
    checks.push({ id: "codex_agents:dir", verdict: "fail", detail: ".codex/agents missing" });
    return;
  }

  const before = new Map<string, string>();
  for (const file of await fs.readdir(codexDir)) {
    if (file.endsWith(".toml")) before.set(file, await fs.readFile(path.join(codexDir, file), "utf8"));
  }

  const sync = await runCmd("npm", ["run", "codex:sync-agents"]);
  if (!sync.ok) {
    checks.push({ id: "codex_agents:sync", verdict: "fail", detail: `sync failed code=${sync.code}` });
    return;
  }

  const after = new Map<string, string>();
  for (const file of await fs.readdir(codexDir)) {
    if (file.endsWith(".toml")) after.set(file, await fs.readFile(path.join(codexDir, file), "utf8"));
  }
  const names = new Set([...before.keys(), ...after.keys()]);
  const changed = [...names].filter((name) => before.get(name) !== after.get(name)).sort();
  checks.push({
    id: "codex_agents:fresh",
    verdict: changed.length === 0 ? "pass" : "fail",
    detail: changed.length === 0 ? "wrappers match agents/*.md" : `sync changed: ${changed.join(", ")}`,
  });
}

async function smokeSlopKiller(checks: Check[]): Promise<void> {
  const fix = "tests/fixtures/sloppy-cover.md";
  if (!(await exists(fix))) { checks.push({ id: "smoke:slop_killer", verdict: "fail", detail: "fixture missing" }); return; }
  const r = await runCmd("npm", ["run", "slop:check", "--", "--file", fix, "--banlist", "references/voice/slop-banlist.md"], { allowExitCode1: true });
  const passedFail = /"verdict":\s*"fail"/.test(r.stdout);
  checks.push({ id: "smoke:slop_killer", verdict: passedFail ? "pass" : "fail", detail: passedFail ? "fixture flagged as fail (correct)" : `unexpected verdict (code=${r.code})` });
}

async function smokeVoiceCheck(checks: Check[]): Promise<void> {
  const fix = "tests/fixtures/cover-in-user-voice.md";
  if (!(await exists(fix))) { checks.push({ id: "smoke:voice_check", verdict: "fail", detail: "fixture missing" }); return; }
  const r = await runCmd("npm", ["run", "voice:check", "--", "--file", fix, "--kind", "cover_letter"], { allowExitCode1: true });
  const verdict = (r.stdout.match(/"verdict":\s*"(pass|warn|fail)"/)?.[1]) || "?";
  checks.push({ id: "smoke:voice_check", verdict: verdict === "fail" ? "fail" : "pass", detail: `verdict=${verdict}` });
}

async function smokeCvRender(checks: Check[]): Promise<void> {
  const out = "/tmp/verify-cv.md";
  const r = await runCmd("npm", [
    "run",
    "resume:render:raw",
    "--",
    "--content-json",
    "tests/fixtures/resume-content/senior-operator.json",
    "--template",
    "classic",
    "--flavours",
    "ats",
    "--out-md",
    out,
    "--out-dir",
    "/tmp/verify-cv-render",
    "--filename-prefix",
    "verify-cv",
  ]);
  const ok = r.ok && (await fileSizeOk(out, 500));
  checks.push({ id: "smoke:cv_render", verdict: ok ? "pass" : "fail", detail: ok ? `${out} written` : `failed code=${r.code}` });
}

async function smokeProductionRenderGuard(checks: Check[]): Promise<void> {
  const outDir = "state/profile/resumes/__verify-guard";
  const r = await runCmd("npm", ["run", "resume:render:raw", "--", "--resume", "solution-architect", "--flavours", "ats", "--out-dir", outDir]);
  checks.push({
    id: "smoke:resume_render_guard",
    verdict: r.code === 2 && /content-json|no longer loads corpus/i.test(r.stderr) ? "pass" : "fail",
    detail: r.code === 2 ? "render blocked without composed content" : `unexpected code=${r.code}`,
  });
}

async function smokeCvLintAts(checks: Check[]): Promise<void> {
  const docx = "/tmp/verify-cv.docx";
  const outDir = "/tmp/verify-cv-out";
  const rendered = `${outDir}/verify-cv.docx`;
  const r1 = await runCmd("npm", [
    "run",
    "resume:render:raw",
    "--",
    "--content-json",
    "tests/fixtures/resume-content/senior-operator.json",
    "--template",
    "classic",
    "--flavours",
    "ats,presentation",
    "--out-dir",
    outDir,
    "--filename-prefix",
    "verify-cv",
  ]);
  await runCmd("bash", ["-c", `cp ${rendered} ${docx}`]);
  if (!r1.ok || !(await exists(docx))) { checks.push({ id: "smoke:cv_lint_ats", verdict: "fail", detail: "render failed" }); return; }
  const r2 = await runCmd("npm", ["run", "resume:lint:ats", "--", "--file", docx, "--jd", "tests/fixtures/sample-jd-architect.md", "--max-pages", "3"], { allowExitCode1: true });
  const verdict = (r2.stdout.match(/"verdict":\s*"(pass|warn|fail)"/)?.[1]) || "?";
  checks.push({ id: "smoke:cv_lint_ats", verdict: verdict === "fail" ? "fail" : "pass", detail: `verdict=${verdict}` });
}

async function smokeTemplateSamples(checks: Check[]): Promise<void> {
  const fixture = "tests/fixtures/resume-content/senior-operator.json";
  if (!(await exists(fixture))) {
    checks.push({ id: "smoke:template_samples", verdict: "fail", detail: "fixture missing" });
    return;
  }

  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "verify-template-samples-"));
  try {
    for (const sample of TEMPLATE_SAMPLES) {
      const outDir = path.join(tmpRoot, sample.name);
      const r = await runCmd("npm", [
        "run",
        "resume:render:raw",
        "--",
        "--content-json",
        fixture,
        "--template",
        sample.name,
        "--flavours",
        "ats,presentation",
        "--out-dir",
        outDir,
        "--filename-prefix",
        "golden",
        "--write-md",
        "true",
      ]);
      const docx = path.join(outDir, "golden.docx");
      const pdf = path.join(outDir, "golden.pdf");
      const md = path.join(outDir, "golden.md");
      const pages = await pdfPageCount(pdf);
      const evaluator = await runCmd("npm", [
        "run",
        "resume:evaluate",
        "--",
        "--template",
        sample.name,
        "--content-json",
        fixture,
        "--docx",
        docx,
        "--pdf",
        pdf,
        "--md",
        md,
        "--html",
        path.join(outDir, "golden.html"),
      ]);
      const evaluatorVerdict = (evaluator.stdout.match(/"verdict":\s*"(pass|warn|fail)"/)?.[1]) || "?";
      const ok = r.ok
        && (await fileSizeOk(docx, 500))
        && (await fileSizeOk(pdf, 500))
        && (await fileSizeOk(md, 500))
        && pages !== null
        && pages <= sample.maxPages
        && evaluator.ok
        && evaluatorVerdict === "pass";
      checks.push({
        id: `smoke:template_sample:${sample.name}`,
        verdict: ok ? "pass" : "fail",
        detail: ok ? `${pages} page(s), rubric=pass` : `render code=${r.code} pages=${pages ?? "?"} rubric=${evaluatorVerdict}`,
      });
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function smokePipeline(checks: Check[]): Promise<void> {
  const r = await runCmd("npm", ["run", "pipeline", "--", "summary"]);
  if (!r.ok) { checks.push({ id: "smoke:pipeline", verdict: "fail", detail: `code=${r.code}` }); return; }
  const matches = r.stdout.match(/"total":\s*(\d+)/);
  checks.push({ id: "smoke:pipeline", verdict: matches ? "pass" : "warn", detail: matches ? `total=${matches[1]}` : "output not JSON" });
}

async function smokeSessionStartHook(checks: Check[]): Promise<void> {
  const r = await runCmd("bash", [".claude/hooks/session-start.sh"]);
  checks.push({ id: "smoke:session_start_hook", verdict: r.ok ? "pass" : "fail", detail: r.stdout.split("\n")[0] || `code=${r.code}` });
}

async function smokeAudit(checks: Check[]): Promise<void> {
  // Synthetic event with a fake-company sentinel — log it, verify dedup finds it, then clean up.
  const SENTINEL_CO = "__verify_synthetic_company__";
  const SENTINEL_TITLE = "__verify_synthetic_architect__";
  const synth = { event_type: "submitted", role_id: "verify-synthetic-1", actor: "verify-plan", channel: "test", details: { company: SENTINEL_CO, title: SENTINEL_TITLE } };
  const r1 = await runCmd("npm", ["run", "audit:log", "--", "--json", JSON.stringify(synth)]);
  if (!r1.ok) { checks.push({ id: "smoke:audit_log", verdict: "fail", detail: `log code=${r1.code}` }); return; }
  const r2 = await runCmd("npm", ["run", "audit:check-dup", "--", "--company", SENTINEL_CO, "--title", SENTINEL_TITLE, "--within-days", "60"], { allowExitCode1: true });
  const duped = /"duplicate":\s*true/.test(r2.stdout);
  checks.push({ id: "smoke:audit_log", verdict: "pass", detail: "log + dedup index write" });
  checks.push({ id: "smoke:audit_dedup", verdict: duped ? "pass" : "fail", detail: duped ? "dedup index returns prior match" : "dedup didn't find synthetic event" });

  // Clean up: remove the sentinel from the dedup index and the audit log.
  // A failure here is not cosmetic — the synthetic "submitted" event stays in
  // the person's real audit trail and the dedup index, where it will later be
  // reported as a prior application to a company that does not exist. Swallowing
  // it left the verifier printing a clean report over a polluted log.
  const logPath = repoPath("state/audit/audit-log.jsonl");
  const indexPath = repoPath("state/audit/dedup-index.json");
  try {
    if (await exists(logPath)) {
      const txt = await fs.readFile(logPath, "utf8");
      const filtered = txt.split("\n").filter((l) => l && !l.includes(SENTINEL_CO)).join("\n");
      await fs.writeFile(logPath, filtered + (filtered ? "\n" : ""));
    }
    if (await exists(indexPath)) {
      const idx = JSON.parse(await fs.readFile(indexPath, "utf8"));
      for (const k of Object.keys(idx)) if (k.includes("verify-synthetic") || k.includes(SENTINEL_CO.toLowerCase())) delete idx[k];
      await fs.writeFile(indexPath, JSON.stringify(idx, null, 2));
    }
  } catch (error: any) {
    console.error(
      `verify-plan: failed to scrub the synthetic '${SENTINEL_CO}' / verify-synthetic event from ${logPath} and ${indexPath}: ` +
        `${error?.message ?? error}. Remove the verify-synthetic entries from both files by hand before trusting the dedup index.`,
    );
    process.exit(1);
  }
}

async function smokeClassifierFallback(checks: Check[]): Promise<void> {
  // Test the regex fallback (no API key needed) so this works offline
  const obj = { title: "Senior Solutions Architect — NSW Gov", description: "6-month contract, fully remote, $1400/day inc super. Strong ServiceNow background required. ABN preferred." };
  const r = await runCmd("bash", ["-c", `echo '${JSON.stringify(obj).replace(/'/g, "'\\''")}' | tsx tools/classify-jd.ts --stdin`]);
  const ok = r.ok && /"work_arrangement":\s*"remote"/.test(r.stdout) && /"_classifier":/.test(r.stdout);
  checks.push({ id: "smoke:classifier", verdict: ok ? "pass" : "fail", detail: ok ? "classifier produced structured output" : `code=${r.code}` });
}

async function main() {
  // Every path below is repo-relative; resolve the root instead of trusting cwd
  // (this script is run headlessly and from Codex, where cwd is not the repo).
  process.chdir(repoRoot());
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  const plan = a.plan;
  if (!plan || plan === "true") {
    console.error("Usage: tsx tools/verify-plan.ts --plan <path-to-plan.md> [--json]");
    process.exit(2);
  }
  const checks: Check[] = [];

  const planExists = await exists(plan);
  checks.push({
    id: "plan:exists",
    verdict: planExists ? "pass" : "fail",
    detail: planExists ? plan : `plan file ${plan} not found; --plan must name a plan that exists`,
  });

  await checkArtefacts(checks);
  await checkTemplateSamples(checks);
  await checkCanonicalCV(checks);
  await checkSkillFrontmatter(checks);
  await checkAgentFrontmatter(checks);
  await checkCodexAgentWrappers(checks);
  await smokeSlopKiller(checks);
  await smokeVoiceCheck(checks);
  await smokeCvRender(checks);
  await smokeProductionRenderGuard(checks);
  await smokeTemplateSamples(checks);
  await smokeCvLintAts(checks);
  await smokePipeline(checks);
  await smokeSessionStartHook(checks);
  await smokeAudit(checks);
  await smokeClassifierFallback(checks);

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.verdict] += 1;

  if (a.json) {
    console.log(JSON.stringify({ counts, checks }, null, 2));
  } else {
    for (const c of checks) {
      const icon = c.verdict === "pass" ? "✓" : c.verdict === "warn" ? "!" : "✗";
      console.log(`${icon} ${c.id.padEnd(40)} ${c.detail}`);
    }
    console.log(`\nTotal: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);
  }
  process.exit(counts.fail > 0 ? 2 : counts.warn > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
