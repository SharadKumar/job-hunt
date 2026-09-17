#!/usr/bin/env tsx
/**
 * resume-lint-ats.ts — flag MECHANICALLY-detectable ATS hazards in a rendered CV.
 *
 * Scope is deliberately narrow: this tool only checks things that are
 * unambiguous from the document structure — never anything that requires
 * judgement. It reads the .docx via mammoth and checks:
 *   - No images / icons (ATS parsers drop or choke on them)
 *   - No embedded objects / SVG
 *   - No tables (warn — ATS may flatten them badly)
 *   - Page count via pdfinfo if a sibling .pdf exists
 *   - Keyword overlap with a JD if --jd is supplied
 *
 * What this tool deliberately does NOT do: check for "required section
 * headings". Section structure is a *semantic* judgement, not a string match.
 * Templates legitimately vary — modern letter-spaces its headings ("S U M M A
 * R Y"), and a template may show a summary paragraph with no heading at all.
 * A literal regex both false-fails those and false-passes on body-text
 * coincidences (e.g. the word "skills" inside a bullet). So structural
 * soundness — is there a clear summary / grouped skills / reverse-chron
 * experience that a recruiter and an ATS can parse — is judged by the
 * resume-writer subagent's visual review of the rendered pages, not here.
 *
 * Usage:
 *   tsx tools/resume/resume-lint-ats.ts --file <docx> [--jd <txt>] [--resume <id>] [--max-pages 3]
 *
 * Output: JSON. Exit code 0=pass, 1=warn, 2=fail.
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import mammoth from "mammoth";
import { getResume } from "../resumes.ts";

const exec = promisify(execFile);

type Verdict = "pass" | "warn" | "fail";
type Issue = { rule: string; severity: "warn" | "fail"; detail: string };

async function pageCount(docxPath: string): Promise<number | null> {
  // Try to find a sibling .pdf
  const pdf = docxPath.replace(/\.docx$/, ".pdf");
  try {
    await fs.access(pdf);
    const { stdout } = await exec("pdfinfo", [pdf]);
    const m = stdout.match(/^Pages:\s+(\d+)$/m);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9+]+/)) if (t.length > 2) out.add(t);
  return out;
}

export type LintAtsResult = {
  verdict: Verdict;
  issues: Issue[];
  stats: { text_chars: number; pages: number | null; keyword_overlap_ratio: number | null };
};

/** Lint a rendered .docx for mechanical ATS hazards. Pure function of its inputs; never exits. */
export async function runLintAts(args: {
  file: string;
  jd?: string;
  resume?: string;
  profile?: string;
  maxPages?: number;
  /** Known page count (skips the pdfinfo lookup when supplied). */
  pages?: number | null;
}): Promise<LintAtsResult> {
  const { file, jd } = args;
  const inferredResume = args.resume ?? path.basename(file).match(/^resume_[^_]+_(.+)\.docx$/)?.[1];
  const configuredMax = inferredResume ? (await getResume(inferredResume, { profileId: args.profile }))?.page_policy?.hard_max : undefined;
  const maxPages = args.maxPages ?? configuredMax ?? 3;
  const buf = await fs.readFile(file);
  const text = await mammoth.extractRawText({ buffer: buf }).then((r) => r.value);
  const html = await mammoth.convertToHtml({ buffer: buf }).then((r) => r.value);

  const issues: Issue[] = [];

  if (/<img/i.test(html)) issues.push({ rule: "image_present", severity: "fail", detail: "embedded image found — ATS-hostile" });
  if (/<table/i.test(html)) {
    // Tables aren't immediately fatal but they're risky; warn if more than 0
    const count = (html.match(/<table/gi) || []).length;
    issues.push({ rule: "table_present", severity: "warn", detail: `${count} table(s) found — ATS may flatten badly` });
  }
  // Match actual HTML elements (<object>, <embed>, <svg>), not the bare words —
  // otherwise prose like "embedded GenAI" false-fails.
  if (/<(object|embed|svg)[\s/>]/i.test(html)) issues.push({ rule: "embedded_object", severity: "fail", detail: "embedded object/SVG — ATS-hostile" });

  const pages = args.pages !== undefined ? args.pages : await pageCount(file);
  if (pages !== null) {
    if (pages > maxPages) issues.push({ rule: "page_count", severity: "warn", detail: `${pages} pages exceeds max ${maxPages}` });
  }

  let keywordOverlap: number | null = null;
  if (jd) {
    const jdText = await fs.readFile(jd, "utf8");
    const jdTokens = tokenise(jdText);
    const cvTokens = tokenise(text);
    let hits = 0;
    for (const t of jdTokens) if (cvTokens.has(t)) hits += 1;
    keywordOverlap = jdTokens.size ? hits / jdTokens.size : 0;
    if (keywordOverlap < 0.15) issues.push({ rule: "low_keyword_overlap", severity: "warn", detail: `${(keywordOverlap * 100).toFixed(0)}% JD keyword overlap (target ≥ 15%)` });
  }

  let verdict: Verdict = "pass";
  if (issues.some((i) => i.severity === "fail")) verdict = "fail";
  else if (issues.length) verdict = "warn";

  return {
    verdict,
    issues,
    stats: {
      text_chars: text.length,
      pages,
      keyword_overlap_ratio: keywordOverlap,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  const file = a.file;
  if (!file) {
    console.error("Usage: tsx tools/resume/resume-lint-ats.ts --file <docx> [--jd <txt>] [--resume <id>] [--max-pages 3]");
    process.exit(2);
  }
  const result = await runLintAts({
    file,
    jd: a.jd,
    resume: a.resume,
    profile: a.profile,
    maxPages: a["max-pages"] ? Number(a["max-pages"]) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "warn" ? 1 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(3);
  });
}
