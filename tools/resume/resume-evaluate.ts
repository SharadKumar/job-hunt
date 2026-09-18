#!/usr/bin/env tsx
/**
 * resume-evaluate.ts — deterministic resume quality evaluator (CLI).
 *
 * This is not a replacement for resume-writer's judgement. It enforces the
 * objective pieces of the research-backed rubric after composition/rendering:
 * section labels, page budget, density, weak bullet openings, grouped skills,
 * and evidence/quantification thresholds.
 *
 * The checks live in lib/evaluate-core.ts; DOM measurement in
 * lib/measure-document.ts; PDF pagination in lib/pdf-metrics.ts. This file
 * only parses flags, gathers metrics (ONE browser launch, ONE pdftotext call)
 * and prints the historical JSON shape with the historical exit codes
 * (0 pass / 1 warn / 2 fail / 3 error).
 *
 * Prefer `npm run resume:audit` when you also need the render, page-fit
 * arithmetic, ATS lint, provenance and term-grounding in one call.
 */

import { exists, readYaml } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import type { ResumeContent } from "../../templates/resume/_interface.ts";
import { withBrowserSession, openPrintPage } from "./lib/browser-session.ts";
import { measureDocument, type DomMetrics } from "./lib/measure-document.ts";
import { measurePdfPages, lastPageFill as lastPageFillOf } from "./lib/pdf-metrics.ts";
import {
  readDocxText,
  readOptional,
  htmlToText,
  applyTargetPolicy,
  checkResearchClaims,
  evaluateContent,
  evaluateStats,
  type Rubric,
  type Issue,
} from "./lib/evaluate-core.ts";

function parseArgs(): Record<string, string> {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const template = args.template;
  if (!template) {
    console.error("Usage: tsx tools/resume/resume-evaluate.ts --template <name> [--content-json <path>] [--docx <path>] [--pdf <path>] [--md <path>]");
    process.exit(2);
  }

  const rubricPath = args.rubric ?? `templates/resume/${template}/rubric.yaml`;
  if (!(await exists(rubricPath))) {
    console.error(`Missing rubric: ${rubricPath}`);
    process.exit(2);
  }

  let rubric = await readYaml<Rubric>(rubricPath);
  const issues: Issue[] = [];
  await checkResearchClaims(rubric, issues);

  const content = args["content-json"]
    ? JSON.parse(await fs.readFile(args["content-json"], "utf8")) as ResumeContent
    : null;
  rubric = await applyTargetPolicy(rubric, args.resume ?? content?.resumeId, {
    profileId: args.profile ?? null,
    formatId: args.format ?? null,
  });

  const docxText = await readDocxText(args.docx);
  const mdText = await readOptional(args.md);
  const htmlText = htmlToText(await readOptional(args.html));
  const text = [docxText, mdText, htmlText].filter(Boolean).join("\n\n");

  // PDF pagination: one pdftotext -bbox pass gives page count + last-page fill.
  let pages: number | null = null;
  let lastPageFill: { fillPct: number; trailingBlankPct: number } | null = null;
  if (args.pdf && (await exists(args.pdf))) {
    try {
      const pdfMetrics = await measurePdfPages(args.pdf);
      pages = pdfMetrics.pageCount || null;
      lastPageFill = pages ? lastPageFillOf(pdfMetrics) : null;
    } catch {
      pages = null;
    }
  }

  // DOM metrics: one browser, one page, one evaluate.
  let dom: DomMetrics | null = null;
  if (args.html && (await exists(args.html))) {
    try {
      dom = await withBrowserSession(async (session) => {
        const page = await openPrintPage(session, args.html);
        return measureDocument(page);
      });
    } catch {
      dom = null;
    }
  }

  const strictLineUnits = args["strict-line-units"] === "true" || Boolean(args.format);
  const { verdict } = evaluateContent({
    rubric,
    content,
    text,
    pages,
    pdfSupplied: Boolean(args.pdf),
    lastPageFill,
    htmlSupplied: Boolean(args.html),
    bulletMetrics: dom?.bullets ?? null,
    lineUnitMetrics: dom?.lineUnits ?? null,
    headingOrphans: dom?.headingOrphans ?? null,
    experienceStartOrphans: dom?.experienceStartOrphans ?? null,
    strictLineUnits,
    htmlPath: args.html,
    pdfPath: args.pdf,
    issues,
  });

  const result = {
    verdict,
    template,
    rubric: rubricPath,
    issues,
    stats: evaluateStats({
      issues,
      pages,
      lastPageFill,
      bulletMetrics: dom?.bullets ?? null,
      lineUnitMetrics: dom?.lineUnits ?? null,
      headingOrphans: dom?.headingOrphans ?? null,
      experienceStartOrphans: dom?.experienceStartOrphans ?? null,
      showBullets: args["show-bullets"] === "true",
      showLineUnits: args["show-line-units"] === "true",
      showHeadingBreaks: args["show-heading-breaks"] === "true",
    }),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(verdict === "pass" ? 0 : verdict === "warn" ? 1 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
