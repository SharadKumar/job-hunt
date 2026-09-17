#!/usr/bin/env tsx
/**
 * resume-page-fill.ts — deterministic page-fit estimator (CLI).
 *
 * WHY THIS EXISTS
 * ---------------
 * The page budget is a two-sided constraint: land on exactly `hard_max` pages
 * AND fill the last page to `last_page_min_fill_pct`. Measuring the current
 * state was already deterministic (resume-evaluate does it). What was NOT
 * deterministic was deciding the NEXT move — so the caller re-derived it by
 * hand, writing throwaway scripts to count lines, guess at overflow, and pick
 * something to trim. Measured on one real render: 39 ad-hoc inspection scripts,
 * ~62% of wall-clock, while every deterministic tool combined took ~6 seconds.
 *
 * This tool closes that gap. It renders, measures, and then does the ARITHMETIC:
 * how many rendered lines you are over or under, and which specific composition
 * nodes to change to get there. Output is addressed in the caller's own actuator
 * units — `experiences[3].bullets[2]`, shave ~22 chars, saves 1 line — so
 * converging is one arithmetic step instead of a bisection search.
 *
 * This is an INSTRUMENT, not a gate. It always exits 0 (unless it genuinely
 * failed to measure). `resume:evaluate` remains the pass/fail authority; this
 * tool tells you how to get there. Use --strict to make non-convergence exit 1.
 *
 * The arithmetic lives in lib/fit-core.ts; this file gathers metrics with ONE
 * browser session (render + measure on the same page) and prints the report.
 * `npm run resume:audit` includes the same fit report alongside every other
 * check, so prefer it in the composition loop.
 *
 * Usage:
 *   npm run resume:page-fill -- --content-json <path> --resume applied-ai
 *   npm run resume:page-fill -- --content-json <path> --template modern
 *   npm run resume:page-fill -- --html <rendered.html> --pdf <rendered.pdf> --resume applied-ai
 *   ... add --json for machine-readable output, --strict to exit 1 when not converged.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeContent, ResumeTemplate, RenderResult } from "../../templates/resume/_interface.ts";
import { withBrowserSession, openPrintPage, type BrowserSession } from "./lib/browser-session.ts";
import { measureDocument } from "./lib/measure-document.ts";
import { measurePdfPages, assignPages } from "./lib/pdf-metrics.ts";
import { resolvePagePolicy, computeFit, formatFitText } from "./lib/fit-core.ts";

function parseArgs(): Record<string, string> {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function renderPresentation(contentJson: string, templateName: string, outDir: string, session: BrowserSession): Promise<{ html: string; pdf: string }> {
  const content = JSON.parse(await fs.readFile(contentJson, "utf8")) as ResumeContent;
  const renderPath = path.resolve(`templates/resume/${templateName}/render.ts`);
  if (!(await exists(renderPath))) throw new Error(`Template '${templateName}' not found at ${renderPath}`);
  const mod = await import(renderPath);
  const tmpl = mod.default as ResumeTemplate;
  await fs.mkdir(outDir, { recursive: true });
  // presentation only — no docx, no md, no composition rewrite. This is a
  // throwaway measuring render, never a production artefact.
  const result: RenderResult = await tmpl(content, {
    flavours: ["presentation"],
    outDir,
    maxBullets: 99,
    filenamePrefix: "fit",
    session,
  });
  const html = result.presentation?.html;
  const pdf = result.presentation?.pdf;
  if (!html || !pdf) throw new Error(`Template '${templateName}' did not emit a presentation html+pdf (warnings: ${(result.warnings ?? []).join("; ") || "none"})`);
  return { html, pdf };
}

async function main() {
  const args = parseArgs();
  const wantJson = args.json === "true";
  const strict = args.strict === "true";

  if (!args["content-json"] && !args.html) {
    console.error("Usage: resume-page-fill --content-json <path> [--resume <id>|--template <name>] [--json] [--strict]");
    console.error("   or: resume-page-fill --html <path> --pdf <path> [--resume <id>]");
    process.exit(2);
  }

  const { policy, templateName, rubric } = await resolvePagePolicy(args);

  const report = await withBrowserSession(async (session) => {
    let html = args.html;
    let pdf = args.pdf;
    let tmpDir: string | null = null;
    if (!html || !pdf) {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-fit-"));
      const rendered = await renderPresentation(args["content-json"], templateName, tmpDir, session);
      html = rendered.html;
      pdf = rendered.pdf;
    } else {
      await openPrintPage(session, html);
    }
    // When we rendered in this session the page is already on the repaired
    // document; when the caller supplied html we navigated to it above.
    const [dom, pdfMetrics] = await Promise.all([measureDocument(session.page), measurePdfPages(pdf)]);
    const units = dom.lineUnits;
    assignPages(units, pdfMetrics.pageText);
    return computeFit({
      units,
      pages: pdfMetrics.pages,
      policy,
      rubric,
      templateName,
      resume: args.resume ?? null,
      html,
      pdf,
      tempRender: Boolean(tmpDir),
    });
  });

  if (wantJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatFitText(report));

  if (strict && report.verdict !== "converged") process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
