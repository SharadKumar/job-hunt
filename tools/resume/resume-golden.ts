#!/usr/bin/env tsx
/**
 * resume-golden.ts — (re)generate a template's committed "golden" render.
 *
 * The golden is the build-time TARGET STATE: a fixed render of the frozen
 * `templates/resume/<t>/sample/sample-content.json` through the SAME code that
 * runs at runtime. Because the golden and production share the renderer, "the
 * golden looks right" ⇒ "runtime looks right". The golden PNGs are committed,
 * so any template/CSS change regenerates them and the git PNG-diff becomes the
 * visual sign-off surface — keeping the deterministic code aligned to the
 * signed-off design.
 *
 * Produces, into `templates/resume/<t>/sample/`:
 *   golden.pdf, golden.html (presentation), golden-page-N.png (one per page).
 *
 * Usage:
 *   npm run resume:design:golden -- --template modern [--dpi 130]
 *   npm run resume:design:golden -- --all
 *   npm run resume:design:golden -- --template modern --out /tmp/candidate   # compare, don't commit
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResumeContent, ResumeTemplate } from "../../templates/resume/_interface.ts";
import { repoPath } from "../repo-root.ts";

const exec = promisify(execFile);
const TEMPLATES_DIR = repoPath("templates/resume");

export async function listGoldenTemplates(): Promise<string[]> {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
}

/**
 * Render `<template>/sample/sample-content.json` through the production
 * renderer and rasterize every page.
 *
 * `outDir` defaults to the template's own `sample/` directory — that is the
 * committed golden. Pass a scratch directory (e.g. under /tmp) to produce a
 * CANDIDATE render for comparison against the committed PNGs without touching
 * them; that is how a refactor proves it is pixel-identical.
 */
export async function generateGolden(template: string, dpi: number, outDir?: string): Promise<string[]> {
  const sampleDir = path.join(TEMPLATES_DIR, template, "sample");
  const targetDir = outDir ?? sampleDir;
  const contentPath = path.join(sampleDir, "sample-content.json");
  let content: ResumeContent;
  try {
    content = JSON.parse(await fs.readFile(contentPath, "utf8")) as ResumeContent;
  } catch {
    console.error(`[golden] ${template}: no sample-content.json — skipping (add ${contentPath} to enable a golden).`);
    return [];
  }
  await fs.mkdir(targetDir, { recursive: true });

  const mod = await import(path.resolve(TEMPLATES_DIR, template, "render.ts"));
  const render: ResumeTemplate = mod.default;

  // Clear stale page PNGs so removed pages don't linger in git.
  for (const f of await fs.readdir(targetDir).catch(() => [] as string[])) {
    if (/^golden-page-\d+\.png$/.test(f)) await fs.rm(path.join(targetDir, f), { force: true });
  }

  const result = await render(content, { flavours: ["presentation"], outDir: targetDir, filenamePrefix: "golden" });
  const pdf = result.presentation?.pdf;
  if (!pdf) {
    console.error(`[golden] ${template}: template produced no presentation PDF. warnings: ${(result.warnings ?? []).join("; ")}`);
    return [];
  }

  // Rasterize every page → golden-page-N.png (the committed sign-off surface).
  await exec("pdftoppm", ["-png", "-r", String(dpi), pdf, path.join(targetDir, "golden-page")]);
  const pngs = (await fs.readdir(targetDir)).filter((f) => /^golden-page-\d+\.png$/.test(f)).sort();
  console.log(`[golden] ${template}: ${pngs.length} page(s) → ${targetDir}/golden.pdf + ${pngs.join(", ")}`);
  return pngs.map((f) => path.join(targetDir, f));
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  const dpi = a.dpi ? Number(a.dpi) : 130;
  const templates = a.all ? await listGoldenTemplates() : a.template ? [a.template] : [];
  if (!templates.length) {
    console.error("Usage: tsx tools/resume/resume-golden.ts (--template <name> | --all) [--dpi 130] [--out <dir>]");
    process.exit(2);
  }
  for (const t of templates) await generateGolden(t, dpi, a.out && a.out !== "true" ? a.out : undefined);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
