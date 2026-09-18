/**
 * fit-core.ts — the page-fit ARITHMETIC from resume-page-fill.ts, as pure
 * functions over metrics that were already measured (one browser, one PDF
 * pass). Report shape and text rendering are identical to the CLI's historical
 * output; the CLI is now a thin wrapper.
 */

import { exists } from "../../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getResume, DEFAULT_TEMPLATE } from "../../resumes.ts";
import { getResumeFormat } from "../../resume-formats.ts";
import type { LineUnitMetric } from "./measure-document.ts";
import type { PageMetric } from "./pdf-metrics.ts";

const PX_TO_PT = 0.75;
const DEFAULT_LAST_PAGE_MIN_FILL_PCT = 75;
/** Safety cap on the short-single-line list carried in the report. */
const MAX_SHORT_SINGLE_LINES = 40;

export type PagePolicy = {
  target_pages?: number;
  preferred?: number;
  preferred_max?: number;
  hard_max?: number;
  last_page_min_fill_pct?: number;
  last_page_min_fill_ratio?: number;
  last_page_min_fill_severity?: "warn" | "fail";
};

export type FitVerdict = "converged" | "over_budget" | "under_filled" | "under_pages" | "unknown";

export type RaggedTail = {
  unit_path: string;
  kind: string;
  page: number | null;
  lines: number;
  last_line_fill_pct: number;
  saves_lines: number;
  shave_chars: number;
  text: string;
};

/**
 * A single-line unit that under-fills its line: the cheapest place to ADD text.
 * The mirror image of a ragged tail — where a ragged tail says "shave these
 * chars and save a whole line", this says "grow by these chars and the line
 * stops being short" — so an under-filled page can be fixed with editing before
 * anything is restored from the bench.
 */
export type ShortSingleLine = {
  unit_path: string;
  kind: string;
  page: number | null;
  chars: number;
  fill_pct: number;
  add_chars: number;
};

export type OverflowUnit = {
  unit_path: string;
  kind: string;
  page: number | null;
  lines: number;
  saves_lines: number;
  text: string;
};

export type FitReport = {
  verdict: FitVerdict;
  template: string;
  resume: string | null;
  policy: { target_pages: number; hard_max: number; last_page_min_fill_pct: number; last_page_min_fill_severity: "warn" | "fail" };
  measured: {
    page_count: number;
    pages: Array<{ page: number; fill_pct: number; lines: number }>;
    last_page_fill_pct: number;
    line_height_pt: number;
    pct_per_line: number;
    measured_lines_per_full_page: number;
    line_units_measured: number;
    units_unaddressed: number;
    units_unlocated: number;
  };
  delta: { lines_to_remove: number; lines_to_add: number; notes: string[] };
  candidates: {
    ragged_tails_shave_to_save_a_line: RaggedTail[];
    short_single_lines: ShortSingleLine[];
    units_on_overflow_pages: OverflowUnit[];
    fill_guidance: Array<{ kind: string; desired_chars: string | null; max_lines: number | null }>;
  };
  artefacts: { html: string; pdf: string; temp_render: boolean };
};

/** Resolve the page policy: template rubric defaults, overridden by resume then format policy. */
export async function resolvePagePolicy(args: { resume?: string; template?: string; profile?: string; format?: string }): Promise<{ policy: PagePolicy; templateName: string; rubric: any }> {
  let templateName = args.template || DEFAULT_TEMPLATE;
  let policy: PagePolicy = {};

  if (args.resume) {
    const resume = await getResume(args.resume, { profileId: args.profile });
    if (resume) {
      templateName = args.template || resume.template || DEFAULT_TEMPLATE;
      policy = { ...(resume.page_policy ?? {}) };
      const formatId = args.format ?? resume.format_id ?? null;
      if (formatId) {
        const format = await getResumeFormat(formatId);
        if (format?.page_policy) policy = { ...policy, ...format.page_policy };
      }
    }
  }

  // Template rubric supplies defaults the resume policy overrides.
  let rubric: any = {};
  const rubricPath = path.resolve(`templates/resume/${templateName}/rubric.yaml`);
  if (await exists(rubricPath)) {
    rubric = YAML.parse(await fs.readFile(rubricPath, "utf8")) ?? {};
  }
  policy = { ...(rubric.page_budget ?? {}), ...policy };
  return { policy, templateName, rubric };
}

export function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function computeFit(args: {
  units: LineUnitMetric[];
  pages: PageMetric[];
  policy: PagePolicy;
  rubric: any;
  templateName: string;
  resume: string | null;
  html: string;
  pdf: string;
  tempRender: boolean;
}): FitReport {
  const { pages, policy, rubric, templateName } = args;
  // Secondary-flow units (CSS-columned skills, see HtmlDesign.layout) are laid
  // out by the column algorithm, not the single page flow. Counting them would
  // corrupt the "add/remove N rendered lines" arithmetic, so the fit maths sees
  // primary-flow lines only.
  const units = args.units.filter((u) => u.flow !== "secondary");
  const pageCount = pages.length;
  const lastPage = pages[pageCount - 1];
  const targetPages = policy.target_pages ?? policy.preferred ?? policy.hard_max ?? pageCount;
  const hardMax = policy.hard_max ?? targetPages;
  const minFill = policy.last_page_min_fill_pct
    ?? (policy.last_page_min_fill_ratio !== undefined ? policy.last_page_min_fill_ratio * 100 : DEFAULT_LAST_PAGE_MIN_FILL_PCT);
  const fillSeverity = policy.last_page_min_fill_severity ?? "warn";

  // Median line height, in PDF points — the conversion factor between "fill %"
  // (what the gate measures) and "rendered lines" (what the caller can act on).
  const lineHeights = units.map((u) => u.lineHeightPx).filter((h) => h > 0).sort((a, b) => a - b);
  const medianLineHeightPx = lineHeights.length ? lineHeights[Math.floor(lineHeights.length / 2)] : 0;
  const lineHeightPt = medianLineHeightPx * PX_TO_PT;
  const pageHeightPt = lastPage?.heightPt ?? 0;
  const pctPerLine = pageHeightPt > 0 && lineHeightPt > 0 ? (lineHeightPt / pageHeightPt) * 100 : 0;

  const linesOn = (p: number) => units.filter((u) => u.page === p).reduce((sum, u) => sum + u.lineCount, 0);

  // Capacity measured, not derived. A page is not pure text — headings, date
  // rows and inter-block spacing consume height too — so dividing page height
  // by line height overstates capacity badly. Use what full pages actually hold.
  const fullPageLineCounts = pages.slice(0, -1).map((p) => linesOn(p.page)).filter((n) => n > 0).sort((a, b) => a - b);
  const measuredLinesPerPage = fullPageLineCounts.length
    ? fullPageLineCounts[Math.floor(fullPageLineCounts.length / 2)]
    : linesOn(pageCount);

  let verdict: FitVerdict = "unknown";
  let linesToRemove = 0;
  let linesToAdd = 0;
  const notes: string[] = [];

  if (pageCount > hardMax) {
    verdict = "over_budget";
    // Everything past the hard max has to go. Block-atomicity (break-inside:
    // avoid) means the true requirement is usually a little more than the raw
    // line count, because a block only moves back a page once it fits whole.
    const overflowLines = pages.slice(hardMax).reduce((sum, p) => sum + linesOn(p.page), 0);
    linesToRemove = overflowLines;
    const firstOverflowBlock = units.find((u) => (u.page ?? 0) > hardMax);
    if (firstOverflowBlock) {
      notes.push(`block-atomicity: the first unit on page ${hardMax + 1} is ${firstOverflowBlock.unitPath ?? firstOverflowBlock.kind} (${firstOverflowBlock.lineCount} lines) — budget ~${overflowLines + firstOverflowBlock.lineCount} lines of removal to be safe`);
    }
    if (pctPerLine > 0) {
      const afterFill = (pages[hardMax - 1]?.fillPct ?? 0);
      notes.push(`after trimming, page ${hardMax} sits at ${fmtPct(afterFill)} — it must stay ≥ ${minFill}% (${Math.max(0, Math.ceil((minFill - afterFill) / pctPerLine))} lines of headroom before it under-fills)`);
    }
  } else if (pageCount < targetPages) {
    verdict = "under_pages";
    if (pctPerLine > 0) {
      const pagesShort = targetPages - pageCount;
      const maxFillObserved = Math.max(...pages.map((p) => p.fillPct));
      // fill the current last page, then whole pages, then the min-fill tail
      linesToAdd = Math.ceil(Math.max(0, maxFillObserved - (lastPage?.fillPct ?? 0)) / pctPerLine)
        + (pagesShort - 1) * measuredLinesPerPage
        + Math.ceil((minFill / maxFillObserved) * measuredLinesPerPage);
    }
  } else if ((lastPage?.fillPct ?? 0) < minFill) {
    verdict = "under_filled";
    linesToAdd = pctPerLine > 0 ? Math.ceil((minFill - (lastPage?.fillPct ?? 0)) / pctPerLine) : 0;
  } else {
    verdict = "converged";
  }

  // ---- candidate moves, ranked -------------------------------------------
  // Cheapest structural win: a unit whose last line is barely filled. Shaving
  // that tail removes a whole rendered line for a few words of editing, and it
  // simultaneously fixes the line-unit raggedness rule.
  const raggedTails: RaggedTail[] = units
    .filter((u) => u.lineCount > 1 && u.lastLineFillPct < 55 && u.unitPath)
    .map((u) => ({
      unit_path: u.unitPath!,
      kind: u.kind,
      page: u.page ?? null,
      lines: u.lineCount,
      last_line_fill_pct: Number(u.lastLineFillPct.toFixed(1)),
      saves_lines: 1,
      shave_chars: Math.max(4, Math.ceil((u.lastLineFillPct / 100) * (u.charCount / u.lineCount))),
      text: u.text.slice(0, 90),
    }))
    .sort((a, b) => a.shave_chars - b.shave_chars);

  // Cheapest way to ADD a line's worth of page: a single-line unit sitting below
  // its kind's minimum fill. Resolved from the same rubric thresholds
  // `failingLineUnits` uses (min minus tolerance to detect), so the two views can
  // never disagree about which units are short.
  const lineUnitRules = (rubric.line_units ?? {}) as Record<string, { single_line_min_fill_pct?: number; tolerance_pct?: number }>;
  const shortSingleLines: ShortSingleLine[] = units
    .flatMap((u) => {
      if (u.lineCount !== 1 || !u.unitPath || u.lastLineFillPct <= 0) return [];
      const rule = lineUnitRules[u.kind];
      const min = rule?.single_line_min_fill_pct;
      if (min === undefined) return [];
      if (u.lastLineFillPct >= min - (rule.tolerance_pct ?? 0)) return [];
      // chars per FULL line, from this unit's own measured chars-per-fill ratio.
      const charsPerFullLine = u.charCount / (u.lastLineFillPct / 100);
      return [{
        unit_path: u.unitPath,
        kind: u.kind,
        page: u.page ?? null,
        chars: u.charCount,
        fill_pct: Number(u.lastLineFillPct.toFixed(1)),
        add_chars: Math.max(1, Math.ceil(charsPerFullLine * (min / 100) - u.charCount)),
      }];
    })
    .sort((a, b) => a.add_chars - b.add_chars)
    .slice(0, MAX_SHORT_SINGLE_LINES);

  // Biggest single-drop wins on the overflow pages.
  const overflowUnits: OverflowUnit[] = units
    .filter((u) => (u.page ?? 0) > hardMax && u.unitPath)
    .map((u) => ({
      unit_path: u.unitPath!,
      kind: u.kind,
      page: u.page ?? null,
      lines: u.lineCount,
      saves_lines: u.lineCount,
      text: u.text.slice(0, 90),
    }))
    .sort((a, b) => b.lines - a.lines);

  // Where to put new lines when under-filled: the rubric already states the
  // per-kind character budget, so echo it rather than making the caller guess.
  const fillGuidance = verdict === "under_filled" || verdict === "under_pages"
    ? Object.entries((rubric.line_units ?? {}) as Record<string, { desired_chars?: string; max_lines?: number }>)
        .filter(([kind]) => ["experience_bullet", "impact_bullet", "experience_summary", "earlier_one_liner"].includes(kind))
        .map(([kind, rule]) => ({ kind, desired_chars: rule.desired_chars ?? null, max_lines: rule.max_lines ?? null }))
    : [];

  return {
    verdict,
    template: templateName,
    resume: args.resume,
    policy: { target_pages: targetPages, hard_max: hardMax, last_page_min_fill_pct: minFill, last_page_min_fill_severity: fillSeverity },
    measured: {
      page_count: pageCount,
      pages: pages.map((p) => ({ page: p.page, fill_pct: Number(p.fillPct.toFixed(1)), lines: linesOn(p.page) })),
      last_page_fill_pct: Number((lastPage?.fillPct ?? 0).toFixed(1)),
      line_height_pt: Number(lineHeightPt.toFixed(2)),
      pct_per_line: Number(pctPerLine.toFixed(2)),
      measured_lines_per_full_page: measuredLinesPerPage,
      line_units_measured: units.length,
      units_unaddressed: units.filter((u) => !u.unitPath).length,
      units_unlocated: units.filter((u) => u.page === undefined).length,
    },
    delta: {
      lines_to_remove: linesToRemove,
      lines_to_add: linesToAdd,
      notes,
    },
    candidates: {
      ragged_tails_shave_to_save_a_line: raggedTails.slice(0, 12),
      short_single_lines: shortSingleLines,
      units_on_overflow_pages: overflowUnits.slice(0, 12),
      fill_guidance: fillGuidance,
    },
    artefacts: { html: args.html, pdf: args.pdf, temp_render: args.tempRender },
  };
}

/** The human-readable rendering the CLI prints without --json. */
export function formatFitText(report: FitReport): string {
  const { policy, measured, delta, candidates } = report;
  const L: string[] = [];
  L.push(`PAGE FIT — ${report.resume ?? "(no resume)"} / ${report.template}`);
  L.push(`policy: target ${policy.target_pages}p, hard_max ${policy.hard_max}p, last page ≥ ${policy.last_page_min_fill_pct}% (${policy.last_page_min_fill_severity})`);
  L.push("");
  L.push(`pages: ${measured.page_count}   ${measured.pages.map((p) => `p${p.page} ${fmtPct(p.fill_pct)} (${p.lines}L)`).join("  ")}`);
  L.push(`scale: 1 rendered line ≈ ${measured.pct_per_line.toFixed(2)}% of a page; a full page holds ~${measured.measured_lines_per_full_page} lines (measured)`);
  L.push("");
  L.push(`VERDICT: ${report.verdict.toUpperCase()}`);
  if (delta.lines_to_remove) L.push(`  remove ≈ ${delta.lines_to_remove} rendered lines`);
  if (delta.lines_to_add) L.push(`  add ≈ ${delta.lines_to_add} rendered lines`);
  for (const n of delta.notes) L.push(`  note: ${n}`);
  const raggedTails = candidates.ragged_tails_shave_to_save_a_line;
  if (raggedTails.length) {
    L.push("");
    L.push("CHEAPEST TRIMS — shave the ragged tail, save a whole line:");
    L.push(`  ${"shave".padStart(6)} ${"tail".padStart(6)}  ${"lines".padStart(5)}  ${"page".padStart(4)}  unit`);
    for (const c of raggedTails.slice(0, 8)) {
      L.push(`  ${String(`~${c.shave_chars}ch`).padStart(6)} ${fmtPct(c.last_line_fill_pct).padStart(6)}  ${String(c.lines).padStart(5)}  ${String(c.page ?? "?").padStart(4)}  ${c.unit_path}`);
      L.push(`         ${c.text}`);
    }
  }
  const overflowUnits = candidates.units_on_overflow_pages;
  if (overflowUnits.length) {
    L.push("");
    L.push(`UNITS PAST THE ${policy.hard_max}-PAGE BUDGET (drop or relocate):`);
    for (const c of overflowUnits.slice(0, 8)) {
      L.push(`  p${c.page}  ${String(c.lines)}L  ${c.unit_path}`);
      L.push(`         ${c.text}`);
    }
  }
  if (candidates.fill_guidance.length) {
    L.push("");
    L.push("FILL BUDGET per unit kind (from the template rubric):");
    for (const g of candidates.fill_guidance) L.push(`  ${g.kind}${g.max_lines ? ` (max ${g.max_lines}L)` : ""}: ${g.desired_chars ?? "—"}`);
  }
  L.push("");
  L.push(`measured ${measured.line_units_measured} line units (${measured.units_unaddressed} without a composition path, ${measured.units_unlocated} not located on a page)`);
  L.push(`html: ${report.artefacts.html}`);
  L.push(`pdf : ${report.artefacts.pdf}`);
  return L.join("\n");
}
