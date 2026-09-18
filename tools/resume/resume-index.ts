#!/usr/bin/env tsx
/**
 * resume-index.ts — build a browsable HTML index of everything under
 * `state/profile/resumes/`.
 *
 * One self-contained page (inline CSS, vanilla JS, no CDN and no framework): a
 * binder of CVs. Index tabs down the left edge, one per positioning, and an
 * open spread beside them: the printed brief on the left page, the PDF in the
 * browser's own viewer on the right. Every value comes from state files,
 * nothing personal is hardcoded here. The design plan sits above the CSS
 * further down.
 *
 * Data sources per resume folder:
 *   - resumes.yaml            (via tools/resumes.ts): label, active, template, page_policy
 *   - metadata.json           approval status / approved_at / hashes
 *   - <prefix>.audit.json     verdict, page fills, gates, keyword coverage, timings
 *   - keyword-plan.json       coverage + open questions
 *   - <prefix>.composition.json / .provenance.json  featured/mentioned/dropped, unsupported claims
 *
 * CLI:
 *   tsx tools/resume/resume-index.ts [--profile <id>] [--out <path>]
 */


import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeResumeIndex } from "./index/render.ts";

// The implementation lives under `index/`: `model.ts` reads state off disk,
// `vocabulary.ts` chooses the words, `render.ts` (with `css.ts` and
// `script.ts`) emits the page. Everything they export is re-exported here so
// this file stays the one import path callers and tests need.
export * from "./index/model.ts";
export * from "./index/vocabulary.ts";
export * from "./index/render.ts";

/* -------------------------------------------------------------------- cli */

function parseArgs(argv: string[]): { profile?: string; out?: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [flag, inline] = token.slice(2).split("=", 2);
    args[flag] = inline ?? argv[++i] ?? "";
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profileId = args.profile && args.profile !== "default" ? args.profile : null;
  const model = await writeResumeIndex({ profileId, outPath: args.out ? path.resolve(args.out) : undefined });
  console.log(JSON.stringify({
    index: model.outPath,
    resumes: model.cards.length,
    active: model.cards.filter((c) => c.active).length,
  }, null, 2));
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
