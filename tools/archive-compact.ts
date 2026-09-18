#!/usr/bin/env tsx
/**
 * archive-compact.ts — shrink state/pipeline/archive/ without losing a single
 * fact about what was sent.
 *
 * Two things made the archive grow to ~110 MB across 143 packages:
 *
 *   1. A baseline-mode package copied the approved baseline CV set into the
 *      package dir (docx + pdf, sometimes md, html, composition.json and the
 *      page PNGs) — about 1.2 MB per package of bytes that are identical to
 *      state/profile/resumes/<id>/ and provably so. A reference plus the
 *      sha256 of the referenced file carries the same evidence: it still says
 *      exactly which artefact was sent, and the gate can still verify it.
 *   2. Playwright confirmation screenshots are full-page PNGs, ~1.3 MB each.
 *      A JPEG at half scale and quality 60 is still perfectly readable as
 *      "this is the SEEK confirmation page", at roughly a twentieth the size.
 *
 * What is NEVER touched: a tailored package's CV (those bytes exist nowhere
 * else), cover-letter.md, jd.md, confirmation.txt, letter-critic.json,
 * keyword-plan.json, or any file whose content is not byte-identical to a file
 * that still lives in the approved baseline directory.
 *
 * A package's CV is converted to a reference only when the package docx
 * hashes equal to an *approved* baseline docx. A metadata claim of
 * `mode: baseline` alone is not enough (the baseline may have been re-rendered
 * since the send, in which case the package copy is the only record of what
 * actually went out and must stay).
 *
 * CLI:
 *   npm run archive:compact -- [--apply] [--archive <dir>] [--baselines <dir>]
 *
 * Dry run by default; prints one JSON object either way. Idempotent: a second
 * run over a compacted archive reports zeros.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { exists, readJsonIfExists } from "./lib/fs.ts";
import { sha256 } from "./lib/hash.ts";
import { parseArgs } from "./lib/args.ts";
import { repoPath, repoRoot } from "./repo-root.ts";

/** Package files that are the package's own record and are never candidates for removal. */
const PACKAGE_OWN_FILES = new Set([
  "metadata.json",
  "cover-letter.md",
  "jd.md",
  "confirmation.txt",
  "letter-critic.json",
  "keyword-plan.json",
  "screening-answers.json",
]);

/** Scratch files beside the archive that no tool reads. */
const SCRATCH_PATTERNS = [
  /^classification-batch-.*\.json$/,
  /^classification-enriched-.*\.json$/,
  /^classification-sharepoint-example\.json$/,
];

const SCREENSHOT_RE = /-(success|error)\.png$/i;
const SCREENSHOT_MIN_BYTES = 300 * 1024;

export type CompactSummary = {
  dry_run: boolean;
  packages: number;
  converted_to_ref: number;
  screenshots_reencoded: number;
  scratch_removed: number;
  bytes_reclaimable_or_reclaimed: number;
  details?: string[];
};

type BaselineEntry = {
  resumeId: string;
  dir: string;
  /** Repo-relative path to the approved docx. */
  ref: string;
  pdfRef: string | null;
  approvedHash: string;
  /** sha256 → repo-relative path, for every file in the baseline dir. */
  bySha: Map<string, string>;
};

/** Repo-relative form of an absolute path, when it is inside the repo. */
function relToRepo(absolute: string): string {
  const rel = path.relative(repoRoot(), absolute);
  return rel.startsWith("..") ? absolute : rel;
}

async function sha256File(file: string): Promise<string> {
  return sha256(await fs.readFile(file));
}

/**
 * Index every approved baseline by the sha256 of each file in its directory.
 * Only approved baselines whose content_hash still equals approved_hash are
 * indexed: a stale baseline is not something a package may be pointed at.
 */
export async function indexBaselines(baselinesDir: string): Promise<{ byDocxSha: Map<string, BaselineEntry>; entries: BaselineEntry[] }> {
  const byDocxSha = new Map<string, BaselineEntry>();
  const entries: BaselineEntry[] = [];
  let dirs: string[];
  try {
    dirs = (await fs.readdir(baselinesDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name);
  } catch {
    return { byDocxSha, entries };
  }
  for (const resumeId of dirs) {
    const dir = path.join(baselinesDir, resumeId);
    const meta = await readJsonIfExists<any>(path.join(dir, "metadata.json"));
    if (!meta) continue;
    if (meta.approval_status !== "approved" || !meta.content_hash || meta.content_hash !== meta.approved_hash) continue;
    const bySha = new Map<string, string>();
    let docx: string | null = null;
    let pdf: string | null = null;
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || name === "metadata.json") continue;
      bySha.set(await sha256File(file), relToRepo(file));
      if (name.endsWith(".docx") && !docx) docx = file;
      if (name.endsWith(".pdf") && !pdf) pdf = file;
    }
    if (!docx) continue;
    const entry: BaselineEntry = {
      resumeId,
      dir,
      ref: relToRepo(docx),
      pdfRef: pdf ? relToRepo(pdf) : null,
      approvedHash: meta.approved_hash,
      bySha,
    };
    entries.push(entry);
    byDocxSha.set(await sha256File(docx), entry);
  }
  return { byDocxSha, entries };
}

/** Width and height out of a PNG's IHDR, without decoding the image. */
function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export type ReencodeResult = { png: string; jpeg: string; before: number; after: number };

/**
 * Re-encode PNG screenshots as JPEGs through Playwright's chromium (the only
 * image encoder this repo already depends on; adding sharp for 43 files is not
 * a trade anybody wants). One browser for the whole batch.
 *
 * `remove` deletes the PNG once the JPEG is on disk. Returns one row per file
 * that was actually converted; a file chromium could not render is left alone.
 */
export async function reencodeScreenshots(
  pngPaths: string[],
  opts: { scale?: number; quality?: number; remove?: boolean; browser?: Browser } = {},
): Promise<ReencodeResult[]> {
  const scale = opts.scale ?? 0.5;
  const quality = opts.quality ?? 60;
  const out: ReencodeResult[] = [];
  if (!pngPaths.length) return out;
  const browser = opts.browser ?? (await chromium.launch({ headless: true }));
  try {
    for (const png of pngPaths) {
      const buffer = await fs.readFile(png);
      const dims = pngDimensions(buffer);
      if (!dims) continue;
      const width = Math.max(1, Math.round(dims.width * scale));
      const height = Math.max(1, Math.round(dims.height * scale));
      const jpeg = png.replace(/\.png$/i, ".jpg");
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.setContent(
          `<style>html,body{margin:0;padding:0;background:#fff}img{display:block;width:${width}px;height:${height}px}</style>`
          + `<img src="data:image/png;base64,${buffer.toString("base64")}">`,
        );
        await page.screenshot({ path: jpeg, type: "jpeg", quality, fullPage: true });
      } finally {
        await page.close();
      }
      const after = (await fs.stat(jpeg)).size;
      if (opts.remove !== false) await fs.rm(png);
      out.push({ png, jpeg, before: buffer.length, after });
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
  return out;
}

/**
 * Compact one package directory. Returns what changed (or would change).
 * `apply: false` computes the same answer without writing anything.
 */
async function compactPackage(
  dir: string,
  baselines: { byDocxSha: Map<string, BaselineEntry> },
  apply: boolean,
  details: string[],
): Promise<{ convertedToRef: boolean; bytes: number; screenshots: string[] }> {
  const metaPath = path.join(dir, "metadata.json");
  const meta = await readJsonIfExists<any>(metaPath);
  const result = { convertedToRef: false, bytes: 0, screenshots: [] as string[] };
  const names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);

  // Oversized confirmation / error screenshots, whatever the package mode.
  for (const name of names) {
    if (!SCREENSHOT_RE.test(name)) continue;
    const file = path.join(dir, name);
    if ((await fs.stat(file)).size < SCREENSHOT_MIN_BYTES) continue;
    result.screenshots.push(file);
  }

  if (!meta) return result;

  const declaredMode = meta.resume?.mode ?? meta.mode ?? null;
  if (declaredMode === "tailored") return result;              // its CV exists nowhere else
  if (meta.resume?.ref && !meta.resume?.docx) return result;    // already compacted

  // Locate the package docx and prove it is byte-identical to an approved baseline.
  const declaredDocx = typeof meta.resume?.docx === "string" ? meta.resume.docx : null;
  const docxName = declaredDocx ? path.basename(declaredDocx) : names.find((n) => n.endsWith(".docx"));
  if (!docxName) return result;
  const docxPath = path.join(dir, docxName);
  if (!(await exists(docxPath))) return result;
  const docxSha = await sha256File(docxPath);
  const baseline = baselines.byDocxSha.get(docxSha);
  if (!baseline) {
    if (declaredMode === "baseline") details.push(`${path.basename(dir)}: docx does not match any approved baseline; left as a copy`);
    return result;
  }

  // Every package file whose bytes still live in the baseline dir is a duplicate.
  const removable: string[] = [];
  for (const name of names) {
    if (PACKAGE_OWN_FILES.has(name) || SCREENSHOT_RE.test(name)) continue;
    const file = path.join(dir, name);
    if (!baseline.bySha.has(await sha256File(file))) continue;
    removable.push(file);
  }
  for (const file of removable) result.bytes += (await fs.stat(file)).size;

  const nextResume = {
    ...(typeof meta.resume === "object" && meta.resume ? meta.resume : {}),
    mode: "baseline",
    ref: baseline.ref,
    pdf_ref: baseline.pdfRef,
    sha256: docxSha,
    baseline_content_hash: baseline.approvedHash,
    resume_id: baseline.resumeId,
  };
  delete nextResume.docx;
  delete nextResume.pdf;
  delete nextResume.composition;
  delete nextResume.html;
  delete nextResume.md;

  if (apply) {
    for (const file of removable) await fs.rm(file);
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, resume: nextResume }, null, 2) + "\n");
  }
  result.convertedToRef = true;
  return result;
}

export async function compactArchive(opts: {
  archiveDir: string;
  baselinesDir: string;
  apply: boolean;
  verbose?: boolean;
}): Promise<CompactSummary> {
  const details: string[] = [];
  const baselines = await indexBaselines(opts.baselinesDir);
  const summary: CompactSummary = {
    dry_run: !opts.apply,
    packages: 0,
    converted_to_ref: 0,
    screenshots_reencoded: 0,
    scratch_removed: 0,
    bytes_reclaimable_or_reclaimed: 0,
  };

  const packageDirs = (await fs.readdir(opts.archiveDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(opts.archiveDir, e.name))
    .sort();

  const screenshots: string[] = [];
  for (const dir of packageDirs) {
    summary.packages++;
    const r = await compactPackage(dir, baselines, opts.apply, details);
    if (r.convertedToRef) summary.converted_to_ref++;
    summary.bytes_reclaimable_or_reclaimed += r.bytes;
    screenshots.push(...r.screenshots);
  }

  if (opts.apply && screenshots.length) {
    const converted = await reencodeScreenshots(screenshots);
    summary.screenshots_reencoded = converted.length;
    for (const c of converted) summary.bytes_reclaimable_or_reclaimed += c.before - c.after;
  } else {
    summary.screenshots_reencoded = screenshots.length;
    // Dry-run estimate: a half-scale q60 JPEG lands around a twentieth of the PNG.
    for (const file of screenshots) {
      summary.bytes_reclaimable_or_reclaimed += Math.round((await fs.stat(file)).size * 0.95);
    }
  }

  // Scratch files beside the archive.
  const parent = path.dirname(opts.archiveDir);
  for (const name of await fs.readdir(parent)) {
    if (!SCRATCH_PATTERNS.some((re) => re.test(name))) continue;
    const file = path.join(parent, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    summary.scratch_removed++;
    summary.bytes_reclaimable_or_reclaimed += stat.size;
    if (opts.apply) await fs.rm(file);
  }

  if (opts.verbose && details.length) summary.details = details;
  return summary;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const archiveDir = typeof flags.archive === "string" ? path.resolve(flags.archive) : repoPath("state/pipeline/archive");
  const baselinesDir = typeof flags.baselines === "string" ? path.resolve(flags.baselines) : repoPath("state/profile/resumes");
  if (!(await exists(archiveDir))) {
    console.error(`[archive-compact] no archive directory at ${archiveDir}`);
    process.exit(2);
  }
  const summary = await compactArchive({
    archiveDir,
    baselinesDir,
    apply: flags.apply === true || flags.apply === "true",
    verbose: flags.verbose === true || flags.verbose === "true",
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[archive-compact] ERROR: ${e?.message ?? e}`); process.exit(1); });
}
