#!/usr/bin/env tsx
/**
 * cv-to-images.ts — render a CV PDF as PNG pages for visual inspection.
 *
 * resume-writer (and other subagents) need to actually SEE the rendered CV to
 * judge layout, whitespace, balance, overflow, heading distinctiveness,
 * widowed lines, awkward breaks — visual qualities that structural text
 * checks (mammoth, grep) can't surface.
 *
 * Claude's multimodal Read supports PNG/JPG, so converting the PDF to
 * one PNG per page lets the subagent reason about each page visually.
 *
 * Engine: poppler's pdftoppm. Output is `<prefix>-1.png`,
 * `<prefix>-2.png`, etc.
 *
 * Usage:
 *   tsx tools/resume/resume-to-images.ts --pdf <path> [--out-dir <dir>] [--dpi 100]
 *
 * Returns JSON with the produced PNG paths so subagents can iterate
 * through them with Read.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd: string, args: string[]): Promise<{ ok: boolean; code: number; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => res({ ok: code === 0, code: code ?? -1, stderr }));
  });
}

export type PdfImagesResult = { pdf: string; pages: string[]; dpi: number; page_count: number };

/** Render every page of `pdf` to `<basename>-page-N.png` under outDir (default: beside the PDF). */
export async function pdfToImages(pdf: string, opts: { outDir?: string; dpi?: number } = {}): Promise<PdfImagesResult> {
  const dpi = opts.dpi ?? 100;
  const outDir = opts.outDir ?? path.dirname(pdf);
  await fs.mkdir(outDir, { recursive: true });
  const prefix = path.join(outDir, path.basename(pdf).replace(/\.pdf$/i, "-page"));
  const prefixBase = path.basename(prefix);

  for (const entry of await fs.readdir(outDir)) {
    if (entry.startsWith(prefixBase + "-") && entry.endsWith(".png")) {
      await fs.unlink(path.join(outDir, entry));
    }
  }

  // pdftoppm writes <prefix>-<N>.png for each page
  const r = await run("pdftoppm", ["-png", "-r", String(dpi), pdf, prefix]);
  if (!r.ok) throw new Error(`pdftoppm failed (${r.code}): ${r.stderr.slice(0, 200)}`);

  // Discover the produced files
  const dirEntries = await fs.readdir(outDir);
  const pages = dirEntries
    .filter((f) => f.startsWith(prefixBase + "-") && f.endsWith(".png"))
    .map((f) => path.join(outDir, f))
    .sort();
  return { pdf, pages, dpi, page_count: pages.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  const pdf = a.pdf;
  if (!pdf) {
    console.error("Usage: tsx tools/resume/resume-to-images.ts --pdf <path> [--out-dir <dir>] [--dpi 100]");
    process.exit(2);
  }
  let result: PdfImagesResult;
  try {
    result = await pdfToImages(pdf, { outDir: a["out-dir"], dpi: a.dpi ? Number(a.dpi) : undefined });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
