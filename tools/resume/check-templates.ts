#!/usr/bin/env tsx
/**
 * check-templates.ts — smoke-test every active resume template sample.
 *
 * This renders each `templates/resume/<name>/sample/sample-content.json` through
 * the production renderer, then evaluates the result against that template's
 * rubric. Hard failures fail this command. Warnings are reported but allowed by
 * default because rubric target warnings are useful during resume composition;
 * pass `--strict-warnings` when preparing a visual/template release.
 *
 * Runs `resume:audit` in-process per template (one Chromium launch each)
 * instead of spawning `tsx` twice per template. The pass/fail decision is the
 * rubric evaluation only — samples carry no source provenance and no term
 * corpus, so those gates are reported but not enforced here.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAudit } from "./resume-audit.ts";
import { repoPath } from "../repo-root.ts";

const TEMPLATES_DIR = repoPath("templates/resume");

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith("--")) {
      out[argv[index].slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true";
    }
  }
  return out;
}

async function listTemplates(): Promise<string[]> {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
  const templates = [];
  for (const directory of directories) {
    try {
      await fs.access(path.join(TEMPLATES_DIR, directory, "render.ts"));
      templates.push(directory);
    } catch {}
  }
  return templates;
}

async function checkTemplate(template: string, strictWarnings: boolean): Promise<{ ok: boolean; line: string; detail?: string }> {
  const sampleDir = path.join(TEMPLATES_DIR, template, "sample");
  const contentJson = path.join(sampleDir, "sample-content.json");
  try {
    await fs.access(contentJson);
  } catch {
    return { ok: true, line: `${template}\tskipped\tno sample-content.json` };
  }

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `resume-template-${template}-`));
  let audit: Awaited<ReturnType<typeof runAudit>>;
  try {
    audit = await runAudit({
      contentJson,
      template,
      outDir,
      filenamePrefix: "sample",
      flavours: ["ats", "presentation"],
      // Historical behaviour: template smoke tests evaluate without strict line units.
      strictLineUnits: false,
      writeComposition: false,
    });
  } catch (error) {
    return { ok: false, line: `${template}\trender-fail`, detail: String((error as Error).stack ?? error) };
  }

  const evaluation = audit.full.evaluate;
  const failCount = evaluation.stats.fail_count;
  const warnCount = evaluation.stats.warn_count;
  const ok = failCount === 0 && (!strictWarnings || warnCount === 0);
  return {
    ok,
    line: `${template}\t${audit.compact.gates.evaluate}\tfail=${failCount}\twarn=${warnCount}\tpages=${evaluation.stats.pages ?? "unknown"}\t${audit.compact.timings_ms.total}ms`,
    detail: ok ? undefined : JSON.stringify({ verdict: audit.compact.gates.evaluate, issues: evaluation.issues, stats: evaluation.stats }, null, 2),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const strictWarnings = args["strict-warnings"] === "true";
  const templates = args.template ? [args.template] : await listTemplates();
  const results = [];
  for (const template of templates) {
    results.push(await checkTemplate(template, strictWarnings));
  }

  for (const result of results) console.log(result.line);
  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    for (const failure of failures) {
      if (failure.detail) console.error(`\n[${failure.line}]\n${failure.detail}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
