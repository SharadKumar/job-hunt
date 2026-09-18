#!/usr/bin/env tsx
/**
 * markdownify-cv.ts — convert the user's master .docx CV into
 * state/profile/cv-source.md (the canonical holistic source for the harness).
 *
 * Replaces the older parse-cv.ts which split into an atomic experience/summary/
 * skill tree with per-bullet variant tags. The harness no longer needs that
 * structure — resume-writer composes positioning-specific resumes holistically
 * from cv-source.md + the positioning brief in resumes.yaml.
 *
 * Usage:
 *   tsx tools/cv/markdownify-cv.ts
 *     [--source <path-to-.docx>]   default: ~/Documents/Resume/master-cv.docx
 *     [--out <path-to-.md>]        default: state/profile/cv-source.md
 *     [--dry-run]
 *
 * The default source comes from state/profile/cv/meta.yaml (source_file) when
 * present; falls back to ~/Documents/Resume/master-cv.docx.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import mammoth from "mammoth";
import YAML from "yaml";
import { repoPath } from "../repo-root.ts";

type CliArgs = {
  source: string;
  out: string;
  dryRun: boolean;
  /** Where the default source came from, reported so a silent fallback is visible. */
  meta: string;
};

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const FALLBACK_SOURCE = "~/Documents/Resume/master-cv.docx";

/**
 * meta.yaml decides which .docx becomes cv-source.md, and cv-source.md is the
 * only evidence base for every CV and letter. The old `catch {}` meant a
 * meta.yaml with a YAML error fell back to the hard-coded path, so the harness
 * would quietly re-parse a stale or entirely different document. Missing is a
 * documented default; malformed is a stop.
 */
async function loadDefaultSource(): Promise<{ source: string; meta: string }> {
  const metaPath = repoPath("state/profile/cv/meta.yaml");
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error(`cannot read ${metaPath}: ${error?.message ?? error}`);
    return { source: expandHome(FALLBACK_SOURCE), meta: "missing, using default" };
  }
  let parsed: { source_file?: string } | null;
  try {
    parsed = YAML.parse(raw) as { source_file?: string } | null;
  } catch (error: any) {
    throw new Error(`${metaPath} is not valid YAML (${error?.message ?? error}). Repair it; falling back to ${FALLBACK_SOURCE} would parse the wrong CV.`);
  }
  if (parsed?.source_file) return { source: expandHome(parsed.source_file), meta: metaPath };
  return { source: expandHome(FALLBACK_SOURCE), meta: "no source_file, using default" };
}

async function parseArgs(argv: string[]): Promise<CliArgs> {
  let source = "";
  let out = repoPath("state/profile/cv-source.md");
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") source = expandHome(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (source) return { source, out, dryRun, meta: "not read (--source given)" };
  const resolved = await loadDefaultSource();
  return { source: resolved.source, out, dryRun, meta: resolved.meta };
}

async function docxToMarkdown(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  const result = await (mammoth as any).convertToMarkdown({ buffer: buf });
  return result.value as string;
}

/**
 * Light post-processing on mammoth's markdown:
 *   - Normalise CRLF → LF; strip trailing whitespace per line.
 *   - Strip mammoth's pre-emptive backslash escapes on punctuation that doesn't
 *     need escaping in commonmark prose (., +, -, @, #, (, ), &, !, ?, ', ").
 *   - Convert __bold __ role headers into ### headings so experiences read as
 *     sections in the resulting markdown (heuristic: lines that are entirely a
 *     single bold run, optionally followed by a date/location segment).
 *   - Drop empty bold runs ("****") that mammoth emits for empty Word runs.
 *   - Collapse 3+ consecutive blank lines to 2.
 * Bullet text and section headings already at # / ## level are preserved.
 */
function tidy(md: string): string {
  let out = md.replace(/\r\n/g, "\n");

  // Strip per-line trailing whitespace.
  out = out.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n");

  // Strip unnecessary backslash escapes on common prose punctuation.
  // Mammoth escapes pre-emptively; commonmark only needs escapes on chars that
  // would otherwise be parsed as markdown structure in that position.
  out = out.replace(/\\([.+\-@#()&!?'"=:;])/g, "$1");

  // Promote __Bold heading __– details lines into ### headings. Matches the
  // mammoth output pattern for role headers from typical AU/UK consulting CVs.
  out = out.replace(/^__\s*(.+?)\s*__\s*(?:[–\-—]\s*(.+))?$/gm, (_, title: string, rest?: string) => {
    return rest ? `### ${title.trim()} — ${rest.trim()}` : `### ${title.trim()}`;
  });

  // Drop empty bold runs.
  out = out.replace(/\*\*\*\*/g, "");

  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim() + "\n";
}

async function main() {
  const { source, out, dryRun, meta: metaSource } = await parseArgs(process.argv.slice(2));

  const stat = await fs.stat(source).catch(() => null);
  if (!stat) {
    console.error(`Source not found: ${source}`);
    process.exit(1);
  }

  const md = tidy(await docxToMarkdown(source));

  if (dryRun) {
    console.log(JSON.stringify({ source, meta: metaSource, out, bytes: md.length, dry_run: true }, null, 2));
    return;
  }

  await fs.writeFile(out, md, "utf8");

  // Update meta.yaml's parsed_at timestamp.
  const metaPath = repoPath("state/profile/cv/meta.yaml");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
    meta.parsed_at = new Date().toISOString();
    meta.source_file = source.startsWith(os.homedir())
      ? "~" + source.slice(os.homedir().length)
      : source;
    await fs.writeFile(metaPath, YAML.stringify(meta), "utf8");
  } catch (error: any) {
    // Missing meta.yaml is the documented first-run case. Anything else (a YAML
    // error, an unwritable file) means the recorded source_file no longer
    // matches what was parsed, so say so loudly rather than printing a clean report.
    if (error?.code !== "ENOENT") {
      console.error(`markdownify-cv: parsed ${source} but could not update ${metaPath}: ${error?.message ?? error}`);
      process.exit(1);
    }
    console.warn(`note: ${metaPath} is missing, so parsed_at / source_file were not recorded`);
  }

  console.log(JSON.stringify({
    source,
    meta: metaSource,
    out,
    bytes: md.length,
    parsed_at: new Date().toISOString(),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
