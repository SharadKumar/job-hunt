#!/usr/bin/env tsx

/**
 * profile-report.ts: CLI entry for the local profile and team reports.
 *
 * The implementation lives under `tools/report/`: `model.ts` gathers what is on
 * disk, `render.ts` turns it into HTML, `highlight.ts` escapes and colourises
 * the source-file panels. Everything the rest of the repo imports is
 * re-exported here so this stays the one import path.
 *
 * CLI:
 *   tsx tools/profile-report.ts (profile|team) [--profile <id|default>] [--out <path>]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfileContext } from "./profile-context.ts";
import { profileIdFromArg } from "./profile-team.ts";
import {
  buildProfileReportModel,
  buildTeamReportModel,
  loadReportTemplate,
  readGeneratedContent,
} from "./report/model.ts";
import { renderProfileReportHtml, renderTeamReportHtml } from "./report/render.ts";

export { escapeHtml } from "./report/highlight.ts";
export {
  buildProfileReportModel,
  buildTeamReportModel,
  relativeLink,
  type GeneratedReportContent,
  type ProfileReportModel,
  type TeamReportModel,
} from "./report/model.ts";
export { renderProfileReportHtml, renderTeamReportHtml } from "./report/render.ts";

type CliArgs = { cmd: string; args: Record<string, string> };

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : "profile";
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return { cmd, args };
}

async function writeReport(outPath: string, html: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html);
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs();
  if (cmd === "profile") {
    const profileId = profileIdFromArg(args.profile);
    const context = resolveProfileContext(profileId);
    // A CLI --out stays relative to the caller's cwd; the default is repo-anchored.
    const outPath = path.resolve(args.out ?? path.join(context.profileDir, "profile-report.html"));
    const generated = await readGeneratedContent(args.generated);
    const template = await loadReportTemplate(args.template);
    const model = await buildProfileReportModel(profileId, outPath, generated);
    await writeReport(outPath, renderProfileReportHtml(model, template));
    console.log(JSON.stringify({ report: outPath, profile: profileId ?? "default", resumes: model.resumes.length }, null, 2));
    return;
  }
  if (cmd === "team") {
    const outPath = args.out ?? path.join("state", "org", "team-report.html");
    const generated = await readGeneratedContent(args.generated);
    const template = await loadReportTemplate(args.template);
    const model = await buildTeamReportModel(outPath, generated);
    await writeReport(outPath, renderTeamReportHtml(model, template));
    console.log(JSON.stringify({ report: outPath, profiles: model.profiles.length, rows: model.matrix.length }, null, 2));
    return;
  }
  console.error("Usage: tsx tools/profile-report.ts (profile|team) [--profile <id|default>] [--out <path>]");
  process.exit(2);
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
