#!/usr/bin/env tsx
/**
 * resume-audit.ts — render + every deterministic check in ONE process with ONE
 * browser launch and ONE PDF pass, emitting ONE compact report.
 *
 * WHY
 * ---
 * Profiled composition runs (state/journal/2026-07-27, -28) spent ~98% of wall
 * clock in model turns, and each audit cycle launched Chromium seven times
 * (render, 4× in resume-evaluate, 2× in resume-page-fill) plus pdfinfo ×2,
 * pdftotext ×2, pdftoppm ×1 — five separate commands whose outputs the writer
 * then had to reconcile by hand. This command replaces that cycle:
 *
 *   render (presentation on a shared page, ATS docx, canonical md)
 *     → measure the same open page (bullets, line units, orphans)
 *     → pdftotext -bbox once (page count, fills, per-page text hashes)
 *     → evaluate (rubric), fit arithmetic, ATS lint, provenance, term-grounding,
 *       preservation (identity / experience coverage / dates / private material)
 *     → optional PNGs (pdftoppm) + `changed_pages` vs the previous audit
 *
 * stdout: compact JSON — failing units ONLY, fit arithmetic, ranked candidate
 * edits, non-unit issues, artefact paths. Passing units are never listed.
 * `<prefix>.audit.json`: the full metrics for tools that want them.
 *
 * Exit: 0 pass / 1 warn / 2 fail (same semantics as resume:evaluate; the
 * evaluate verdict is the authority, other gates fold in as issues).
 *
 * Usage:
 *   npm run resume:audit -- --content-json <path> --resume <id> [--out-dir <dir>] [--images] [--dpi 72]
 *   npm run resume:audit -- --content-json <path> --template classic --out-dir /tmp/x
 *   flags: --profile --format --filename-prefix --flavours ats,presentation --jd <path>
 *          --keyword-plan <path> --strict-line-units true|false (default true)
 *          --full (include every measured unit in stdout) --no-composition (skip .composition.json)
 *          --auto-fit (run the deterministic fit ladder before reporting) --max-passes N (default 6)
 *          --dry-run (with --auto-fit: report the ops it WOULD apply, write nothing)
 *          --force-drops (with --auto-fit: drop even when text edits would suffice)
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeContent, ResumeSourceProvenance, ResumeTemplate, Flavour, RenderOptions, RenderResult } from "../../templates/resume/_interface.ts";
import { getResume, DEFAULT_TEMPLATE, resumeArtefactPrefix } from "../resumes.ts";
import { defaultTeamResumeFormatId, getResumeFormat } from "../resume-formats.ts";
import { openBrowserSession, closeBrowserSession, openPrintPage, type LaunchFn, type BrowserSession } from "./lib/browser-session.ts";
import { loadComposition, writeComposition } from "./lib/composition-io.ts";
import { measureDocument, type DomMetrics } from "./lib/measure-document.ts";
import { measurePdfPages, assignPages, lastPageFill, diffChangedPages, type PdfMetrics } from "./lib/pdf-metrics.ts";
import {
  loadRubric,
  checkResearchClaims,
  readDocxText,
  readOptional,
  htmlToText,
  evaluateContent,
  evaluateStats,
  failingLineUnits,
  type Issue,
  type Verdict,
} from "./lib/evaluate-core.ts";
import { resolvePagePolicy, computeFit, type FitReport } from "./lib/fit-core.ts";
import { runLintAts } from "./resume-lint-ats.ts";
import { runProvenance } from "./resume-provenance.ts";
import { pdfToImages } from "./resume-to-images.ts";
import { writeBaselineMetadataIfNeeded } from "./resume-renderer.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { runAutoFit, snapshotFromAudit, ladderPolicyFor, DEFAULT_MAX_PASSES, type AutoFitAudit } from "./resume-fit-apply.ts";
import { runTermGrounding } from "./resume-term-grounding.ts";
import { checkPreservation, type PreserveResult } from "./lib/preserve-core.ts";
import { checkEditorialBans, loadEditorialBans, type EditorialBanIssue } from "./lib/editorial-bans.ts";
import { loadProfile } from "../profile.ts";
import { applyComposition } from "./resume-keywords.ts";
import { cloudsStatus, type CloudsStatus } from "./resume-context.ts";
import { loadKeywordClouds } from "../keyword-clouds.ts";
import type { KeywordPlan } from "./keyword-lexicon.ts";

export type AuditArgs = {
  contentJson: string;
  resume?: string;
  template?: string;
  profile?: string;
  format?: string;
  outDir?: string;
  filenamePrefix?: string;
  flavours?: Flavour[];
  maxBullets?: number;
  jd?: string;
  keywordPlan?: string;
  strictLineUnits?: boolean;
  images?: boolean;
  dpi?: number;
  full?: boolean;
  writeComposition?: boolean;
  /** Ladder passes set this false so `changed_pages` still diffs the run, not the pass. */
  writeAuditJson?: boolean;
  /**
   * Run the deterministic fit ladder (tools/resume/lib/fit-ops.ts) before
   * reporting, re-auditing in this same browser session, ≤ maxPasses passes.
   */
  autoFit?: boolean;
  maxPasses?: number;
  /**
   * Plan the ladder without landing it: every render goes to a scratch
   * directory, and the real composition, provenance, artefacts and audit.json
   * are left exactly as they were. The compact report carries
   * `auto_fit.dry_run` and `auto_fit.planned_ops`.
   */
  dryRun?: boolean;
  /**
   * Let the ladder drop content even when the fit report's own ragged tails
   * would have recovered the deficit with text edits. Off by default: the
   * ladder is text-first.
   */
  forceDrops?: boolean;
  /** Reuse an already-open session (auto-fit passes, fit-apply --auto). */
  session?: BrowserSession;
  /** Test hook: injectable browser launch. */
  launch?: LaunchFn;
};

type TermGrounding = {
  verdict: Verdict | "error";
  jd_injected: Array<{ term: string; field?: string }>;
  ungrounded_count: number;
  familiarity_framed_terms?: string[];
  unconfirmed_terms?: string[];
  allowed_by_plan?: string[];
  detail?: string;
};

type KeywordCoverage = KeywordPlan["coverage"] & {
  verdict: KeywordPlan["verdict"];
  plan_path: string;
  must_have_unsurfaced: string[];
  screener_surface: KeywordPlan["screener_surface"];
  warnings: string[];
};

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

async function loadTemplate(name: string): Promise<ResumeTemplate> {
  const renderPath = path.resolve(`templates/resume/${name}/render.ts`);
  if (!(await exists(renderPath))) throw new Error(`Template '${name}' not found at ${renderPath}`);
  const mod = await import(renderPath);
  if (typeof mod.default !== "function") throw new Error(`Template '${name}' render.ts does not export a default ResumeTemplate function.`);
  return mod.default as ResumeTemplate;
}

async function readKeywordPlan(planPath?: string): Promise<KeywordPlan | null> {
  if (!planPath) return null;
  try { return JSON.parse(await fs.readFile(planPath, "utf8")) as KeywordPlan; } catch { return null; }
}

/**
 * Term grounding runs IN-PROCESS (it used to be a `tsx` subprocess, ~250 ms of
 * the audit's `checks` phase spent booting a second TypeScript runtime). The
 * report shape is unchanged: verdict, the jd_injected/unconfirmed flag list,
 * the ungrounded count, plus the plan-driven stats. A throw here is reported as
 * an `error` verdict rather than crashing the audit.
 */
async function runTermGroundingGate(args: { content: ResumeContent; profile?: string; jd?: string; plan: KeywordPlan | null; planPath?: string }): Promise<TermGrounding> {
  try {
    const ctx = resolveProfileContext(args.profile);
    const [cvSource, profileMd, jdText] = await Promise.all([
      fs.readFile(ctx.cvSourcePath, "utf8").catch(() => ""),
      fs.readFile(ctx.profileMdPath, "utf8").catch(() => ""),
      args.jd ? fs.readFile(args.jd, "utf8").catch(() => "") : Promise.resolve(""),
    ]);
    const result = runTermGrounding({ content: args.content, cvSource, profileMd, jdText, plan: args.plan, planPath: args.planPath ?? null });
    const jdInjected = result.flags
      .filter((f) => f.bucket === "jd_injected" || f.bucket === "unconfirmed_term")
      .map((f) => ({ term: f.term, field: f.field }));
    return {
      verdict: result.verdict,
      jd_injected: jdInjected.length ? jdInjected : result.stats.jd_injected_terms.map((term) => ({ term })),
      ungrounded_count: result.stats.ungrounded_terms.length,
      familiarity_framed_terms: result.stats.familiarity_framed_terms,
      unconfirmed_terms: result.stats.unconfirmed_terms,
      allowed_by_plan: result.stats.allowed_by_plan,
    };
  } catch (error) {
    return { verdict: "error", jd_injected: [], ungrounded_count: 0, detail: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

/**
 * Coverage of the supplied keyword plan against THIS composition. `applyComposition`
 * mutates the plan it is handed (surfaced_in, coverage, warnings), so it gets a
 * clone: the plan object term-grounding read stays untouched, and re-running the
 * audit never accumulates warnings on the caller's plan.
 */
function keywordCoverage(plan: KeywordPlan | null, planPath: string | undefined, content: ResumeContent): KeywordCoverage | null {
  if (!plan || !planPath) return null;
  try {
    const applied = applyComposition(structuredClone(plan), content);
    return {
      ...applied.coverage,
      verdict: applied.verdict,
      plan_path: planPath,
      must_have_unsurfaced: applied.terms.filter((t) => t.must_have && (t.status === "grounded" || t.status === "alias_grounded") && !t.surfaced_in.length).map((t) => t.jd_form),
      screener_surface: applied.screener_surface,
      warnings: applied.warnings,
    };
  } catch {
    return null;
  }
}

/**
 * Preservation gate: is the composition still a faithful projection of the
 * canonical corpus (identity, every source experience accounted for, dates
 * unchanged, no "not for CVs" material rendered)? Reports `skip` when no
 * corpus is resolvable (template samples), never `fail`. A throw is reported
 * as `skip` with the detail rather than crashing the audit.
 */
async function runPreserveGate(args: { content: ResumeContent; provenance: ResumeSourceProvenance | null; profile?: string }): Promise<PreserveResult> {
  try {
    const ctx = resolveProfileContext(args.profile);
    const [cvSourceText, profileFrontmatter] = await Promise.all([
      fs.readFile(ctx.cvSourcePath, "utf8").catch(() => ""),
      loadProfile(args.profile).catch(() => null),
    ]);
    return checkPreservation({ content: args.content, provenance: args.provenance, cvSourceText, profileFrontmatter });
  } catch (error) {
    return {
      verdict: "skip",
      issues: [],
      stats: { source_experiences: 0, featured: 0, mentioned: 0, dropped_with_reason: 0, unaccounted: [], unsourced: [], skipped_reason: String((error as Error)?.message ?? error).slice(0, 200) },
    };
  }
}

type EditorialGate = {
  verdict: Verdict | "skip";
  rules_path: string | null;
  fail_count: number;
  warn_count: number;
  issues: EditorialBanIssue[];
  detail?: string;
};

/**
 * Editorial-bans gate: the machine-readable subset of the profile's prose
 * editorial rules (`<profile-dir>/editorial-bans.yaml`). Reports `skip` when
 * the profile carries no bans file (template samples, profiles that have not
 * written one) so nothing fails against rules it never declared. A malformed
 * file is a `warn` with the parse detail, never a silent pass.
 *
 * `resumeId` selects which resume-scoped rules (`resumes` / `except_resumes`)
 * are in force, so a ban that is right for one positioning does not fire on a
 * positioning that is deliberately pitched the other way.
 */
async function runEditorialGate(args: { content: ResumeContent; profile?: string; resumeId?: string | null }): Promise<EditorialGate> {
  let rulesPath: string | null = null;
  try {
    rulesPath = path.join(resolveProfileContext(args.profile).profileDir, "editorial-bans.yaml");
    const rules = await loadEditorialBans(rulesPath);
    if (!rules) return { verdict: "skip", rules_path: rulesPath, fail_count: 0, warn_count: 0, issues: [], detail: "no editorial-bans.yaml for this profile" };
    const result = checkEditorialBans({ content: args.content, rules, resumeId: args.resumeId ?? args.content.resumeId ?? null });
    return { verdict: result.verdict, rules_path: rulesPath, fail_count: result.stats.fail_count, warn_count: result.stats.warn_count, issues: result.issues };
  } catch (error) {
    return { verdict: "warn", rules_path: rulesPath, fail_count: 0, warn_count: 0, issues: [], detail: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

type CloudsGate = {
  verdict: Verdict | "skip";
  detail?: string;
} & Partial<CloudsStatus>;

/**
 * Keyword-cloud gate: market narrative comes first. A positioning may only be
 * rendered against current keyword clouds — the shared capability, domain and
 * tooling vocabulary researched from the title outward, qualified against
 * cv-source, with the unmatched-but-important terms already put to the user.
 *
 * `skip` when there is no resolvable positioning (template samples, ad-hoc
 * `--template` audits) so nothing fails against clouds it never had.
 * `fail` when the positioning references no clouds at all.
 * `warn` when a load-bearing cloud (weight >= 4) is older than
 * CLOUD_STALE_DAYS, or carries no usable `refreshed_at`, or when the type
 * references a cloud id that does not exist — refresh via /resume-strategy
 * steps 3b + 3c.
 */
async function runCloudsGate(args: { resumeId?: string; profile?: string }): Promise<CloudsGate> {
  if (!args.resumeId) return { verdict: "skip", detail: "no --resume; keyword clouds are referenced per positioning" };
  try {
    const resume = await getResume(args.resumeId, { profileId: args.profile });
    if (!resume) return { verdict: "skip", detail: `resume '${args.resumeId}' not found` };
    const status = cloudsStatus(resume, await loadKeywordClouds());
    if (status.missing) {
      return { verdict: "fail", ...status, detail: `${args.resumeId} references no keyword clouds; run the /resume-strategy cloud refresh (steps 3b + 3c) before rendering.` };
    }
    if (status.unknown_cloud_ids.length) {
      return { verdict: "warn", ...status, detail: `${args.resumeId} references unknown cloud ids: ${status.unknown_cloud_ids.join(", ")}.` };
    }
    if (status.stale) {
      const stale = status.clouds.filter((c) => c.weight >= 4 && c.stale).map((c) => `${c.id} (${c.age_days === null ? "undated" : `${c.age_days}d`})`);
      return { verdict: "warn", ...status, detail: `${args.resumeId} has stale load-bearing clouds: ${stale.join(", ")} (limit ${status.stale_after_days} days); run the /resume-strategy cloud refresh.` };
    }
    return { verdict: "pass", ...status };
  } catch (error) {
    return { verdict: "warn", detail: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

/**
 * Chars one FULL rendered line of this unit holds, from the DOM's per-line
 * measurement: the widest measured line when the unit wraps, else the single
 * line scaled up by its fill. Lets a writer size a replacement without a
 * render (`chars_per_line * 0.9` .. `chars_per_line`).
 */
function charsPerFullLine(u: { charsPerRenderedLine: number[]; lastLineFillPct: number; charCount: number; lineCount: number }): number | null {
  if (u.lineCount > 1) {
    const full = u.charsPerRenderedLine.slice(0, -1).filter((n) => n > 0);
    if (full.length) return Math.round(Math.max(...full));
  }
  if (u.lineCount === 1 && u.lastLineFillPct > 0) return Math.round(u.charCount / (u.lastLineFillPct / 100));
  return null;
}

function verdictRank(v: Verdict | "error"): number {
  return v === "fail" ? 2 : v === "warn" ? 1 : v === "error" ? 1 : 0;
}

/** One audit pass: render, measure, check, report. Does not run the fit ladder. */
export async function runAuditOnce(args: AuditArgs) {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const mark = (key: string, since: number) => { timings[key] = Date.now() - since; return Date.now(); };

  // ---- resolve --------------------------------------------------------
  // loadComposition accepts both shapes: a `<prefix>.provenance.json` sidecar
  // beside the composition, or the older inline `source_provenance` field.
  const loaded = await loadComposition(args.contentJson);
  const content = loaded.content;
  let templateName: string;
  let formatId: string | null = args.format ?? null;
  if (args.resume) {
    const resume = await getResume(args.resume, { profileId: args.profile });
    if (!resume) throw new Error(`Resume '${args.resume}' not found.`);
    formatId = formatId ?? resume.format_id ?? (args.profile ? await defaultTeamResumeFormatId() : null);
    if (!content.resumeId) content.resumeId = args.resume;
    templateName = args.template || resume.template || DEFAULT_TEMPLATE;
  } else {
    if (!args.template) throw new Error("--content-json without --resume requires --template <name>.");
    if (!content.resumeId) content.resumeId = "sample";
    templateName = args.template;
  }
  const flavours: Flavour[] = args.flavours ?? ["ats", "presentation"];
  const outDir = args.outDir ?? `state/pipeline/archive/resume-audit-${Date.now()}`;
  await fs.mkdir(outDir, { recursive: true });
  const prefix = args.filenamePrefix
    || (args.resume ? await resumeArtefactPrefix(args.resume, { profileId: args.profile }) : "sample");
  const format = await getResumeFormat(formatId);
  const strictLineUnits = args.strictLineUnits ?? true;

  const [{ rubric, rubricPath }, { policy }] = await Promise.all([
    loadRubric({ template: templateName, resumeId: args.resume ?? content.resumeId, profileId: args.profile ?? null, formatId }),
    resolvePagePolicy({ resume: args.resume, template: templateName, profile: args.profile, format: args.format }),
  ]);
  const tmpl = await loadTemplate(templateName);
  let t = mark("setup", startedAt);

  // ---- render + measure on one page ------------------------------------
  const session = args.session ?? await openBrowserSession({ launch: args.launch });
  let result: RenderResult;
  let dom: DomMetrics | null = null;
  let htmlPath: string | undefined;
  let pdfPath: string | undefined;
  try {
    const options: RenderOptions = {
      flavours,
      outDir,
      maxBullets: args.maxBullets ?? 7,
      filenamePrefix: prefix,
      renderPolicy: format?.render_policy,
      session,
    };
    result = await tmpl(content, options);
    htmlPath = result.presentation?.html;
    pdfPath = result.presentation?.pdf ?? result.ats?.pdf;
    t = mark("render", t);
    if (htmlPath) {
      // The template rendered on our page and left it on the repaired document.
      // If a template ignored the session, navigate ourselves.
      let onDocument = false;
      try { onDocument = decodeURIComponent(new URL(session.page.url()).pathname) === path.resolve(htmlPath); } catch { onDocument = false; }
      if (!onDocument) await openPrintPage(session, htmlPath);
      dom = await measureDocument(session.page);
    }
    t = mark("measure", t);
  } finally {
    // A session handed in by the caller (auto-fit passes) stays open.
    if (!args.session) await closeBrowserSession(session);
  }

  // ---- artefacts: canonical md + composition ---------------------------
  const { assembleMarkdown } = await import("../../templates/resume/_pandoc-helpers.ts");
  const mdPath = path.join(outDir, `${prefix}.md`);
  await fs.writeFile(mdPath, assembleMarkdown(content, format?.render_policy));
  const compositionPath = path.join(outDir, `${prefix}.composition.json`);
  let provenanceJsonPath: string | null = null;
  if (args.writeComposition !== false) {
    // Composition WITHOUT source_provenance; the audit trail lands in the sidecar.
    provenanceJsonPath = (await writeComposition(compositionPath, content, { provenance: loaded.provenance })).provenancePath;
  }
  const docxPath = result.ats?.docx ?? result.presentation?.docx;

  // ---- pdf ground truth ---------------------------------------------------
  let pdf: PdfMetrics | null = null;
  if (pdfPath && (await exists(pdfPath))) {
    try { pdf = await measurePdfPages(pdfPath); } catch { pdf = null; }
  }
  if (dom && pdf) assignPages(dom.lineUnits, pdf.pageText);
  t = mark("pdf", t);

  // ---- checks -------------------------------------------------------------
  const issues: Issue[] = [];
  await checkResearchClaims(rubric, issues);
  const text = [await readDocxText(docxPath), await readOptional(mdPath), htmlToText(await readOptional(htmlPath))].filter(Boolean).join("\n\n");
  const pages = pdf?.pageCount || null;
  const lastFill = pdf && pages ? lastPageFill(pdf) : null;
  const evaluation = evaluateContent({
    rubric,
    content,
    text,
    pages,
    pdfSupplied: Boolean(pdfPath),
    lastPageFill: lastFill,
    htmlSupplied: Boolean(htmlPath),
    bulletMetrics: dom?.bullets ?? null,
    lineUnitMetrics: dom?.lineUnits ?? null,
    headingOrphans: dom?.headingOrphans ?? null,
    experienceStartOrphans: dom?.experienceStartOrphans ?? null,
    strictLineUnits,
    htmlPath,
    pdfPath,
    issues,
  });

  const fit: FitReport | null = dom && pdf && htmlPath && pdfPath
    ? computeFit({ units: dom.lineUnits, pages: pdf.pages, policy, rubric, templateName, resume: args.resume ?? null, html: htmlPath, pdf: pdfPath, tempRender: false })
    : null;

  const ats = docxPath && (await exists(docxPath))
    ? await runLintAts({ file: docxPath, jd: args.jd, resume: args.resume, profile: args.profile, pages })
    : null;
  const provenance = await runProvenance({ content, profile: args.profile, provenance: loaded.provenance });
  const preserve = await runPreserveGate({ content, provenance: loaded.provenance, profile: args.profile });
  const editorial = await runEditorialGate({ content, profile: args.profile, resumeId: args.resume ?? content.resumeId ?? null });
  const clouds = await runCloudsGate({ resumeId: args.resume, profile: args.profile });
  const plan = await readKeywordPlan(args.keywordPlan);
  const termGrounding = await runTermGroundingGate({ content, profile: args.profile, jd: args.jd, plan, planPath: args.keywordPlan });
  const coverage = keywordCoverage(plan, args.keywordPlan, content);
  t = mark("checks", t);

  // ---- images + changed pages ------------------------------------------------
  const auditJsonPath = path.join(outDir, `${prefix}.audit.json`);
  const previous = await fs.readFile(auditJsonPath, "utf8").then((s) => JSON.parse(s)).catch(() => null);
  const changedPages = pdf ? diffChangedPages(previous?.pages?.hashes ?? null, pdf.pageHashes) : [];
  let images: { pages: string[]; dpi: number } | null = null;
  if (args.images && pdfPath) {
    try {
      const r = await pdfToImages(pdfPath, { dpi: args.dpi ?? 72 });
      images = { pages: r.pages, dpi: r.dpi };
    } catch (e) {
      issues.push({ rule: "images", severity: "warn", detail: `could not render page images: ${(e as Error).message.slice(0, 120)}` });
    }
  }
  t = mark("images", t);
  timings.total = Date.now() - startedAt;

  // ---- verdict ---------------------------------------------------------------
  // evaluate is the authority; provenance / ATS / term-grounding fails fold in.
  // `skip` (no resolvable corpus) folds in as a pass; a preserve `fail` is an exit-2 fail.
  const gateVerdicts: Array<Verdict | "error"> = [evaluation.verdict, provenance.verdict, ats?.verdict ?? "pass", termGrounding.verdict, preserve.verdict === "skip" ? "pass" : preserve.verdict, editorial.verdict === "skip" ? "pass" : editorial.verdict, clouds.verdict === "skip" ? "pass" : clouds.verdict];
  const verdict: Verdict = gateVerdicts.some((v) => v === "fail") ? "fail" : gateVerdicts.some((v) => verdictRank(v) >= 1) ? "warn" : "pass";

  const MAX_FAILING_UNITS = 40;
  const failingUnitsAll = failingLineUnits(dom?.lineUnits ?? null, rubric, strictLineUnits);
  const failingUnits = failingUnitsAll.slice(0, MAX_FAILING_UNITS).map((u) => ({
    unit_path: u.unit_path,
    kind: u.kind,
    rule: u.rule.replace(/^line_unit_/, ""),
    severity: u.severity,
    page: u.page,
    lines: u.lines,
    last_line_fill_pct: u.last_line_fill_pct,
    ...(u.min_fill_pct !== null ? { min_fill_pct: u.min_fill_pct } : {}),
    ...(u.max_lines !== null ? { max_lines: u.max_lines } : {}),
    text: u.text.slice(0, 60),
  }));
  const unitRules = new Set(["line_unit_line_count", "line_unit_single_line_fill", "line_unit_single_line_target", "line_unit_wrapped_last_line_fill", "line_unit_wrapped_last_line_target", "bullet_line_count", "bullet_single_line_fill", "bullet_single_line_target", "bullet_wrapped_last_line_fill", "bullet_wrapped_last_line_target"]);
  const nonUnitIssues = evaluation.issues.filter((i) => !unitRules.has(i.rule));
  // Bullet-rule issues are a subset of line-unit failures (same DOM nodes); when
  // line units are not strict, surface bullet issues as units instead.
  const bulletIssues = strictLineUnits ? [] : evaluation.issues.filter((i) => i.rule.startsWith("bullet_"));

  const compact = {
    verdict,
    resume: args.resume ?? content.resumeId,
    template: templateName,
    timings_ms: timings,
    pages: pdf
      ? {
          count: pdf.pageCount,
          target: fit?.policy.target_pages ?? rubric.page_budget?.target_pages ?? null,
          hard_max: fit?.policy.hard_max ?? rubric.page_budget?.hard_max ?? null,
          fills: pdf.pages.map((p) => Number(p.fillPct.toFixed(1))),
          last_page_fill_pct: lastFill ? Number(lastFill.fillPct.toFixed(1)) : null,
          min_last_page_fill_pct: fit?.policy.last_page_min_fill_pct ?? null,
        }
      : null,
    fit: fit
      ? {
          verdict: fit.verdict,
          lines_to_remove: fit.delta.lines_to_remove,
          lines_to_add: fit.delta.lines_to_add,
          pct_per_line: fit.measured.pct_per_line,
          notes: fit.delta.notes,
          candidates: {
            ragged_tails: fit.candidates.ragged_tails_shave_to_save_a_line.slice(0, 8),
            // Where to ADD chars: single-line units under their kind's min fill.
            short_single_lines: fit.candidates.short_single_lines.slice(0, 12),
            overflow_units: fit.candidates.units_on_overflow_pages.slice(0, 8),
            fill_guidance: fit.candidates.fill_guidance,
          },
        }
      : null,
    failing_units: failingUnits,
    failing_units_total: failingUnitsAll.length,
    issues: [...nonUnitIssues, ...bulletIssues],
    gates: {
      evaluate: evaluation.verdict,
      provenance: { verdict: provenance.verdict, fail_count: provenance.stats.fail_count, missing: provenance.issues.filter((i) => i.severity === "fail").slice(0, 10).map((i) => i.detail) },
      ats: ats ? { verdict: ats.verdict, issues: ats.issues } : null,
      term_grounding: termGrounding,
      preserve: {
        verdict: preserve.verdict,
        fail_count: preserve.issues.filter((i) => i.severity === "fail").length,
        warn_count: preserve.issues.filter((i) => i.severity === "warn").length,
        issues: preserve.issues.slice(0, 10),
        stats: preserve.stats,
      },
      clouds,
      // DEPRECATED (one release): `clouds` is the gate; `lexicon` mirrors it so
      // readers mid-migration keep working.
      lexicon: clouds,
      editorial: {
        verdict: editorial.verdict,
        rules_path: editorial.rules_path,
        fail_count: editorial.fail_count,
        warn_count: editorial.warn_count,
        // Fails first: a truncated list must never hide the hard stop.
        issues: [...editorial.issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1)).slice(0, 20),
        ...(editorial.detail ? { detail: editorial.detail } : {}),
      },
    },
    ...(coverage ? { keyword_coverage: coverage } : {}),
    images: images ? { dpi: images.dpi, pages: images.pages, changed_pages: changedPages } : { dpi: null, pages: [], changed_pages: changedPages },
    artefacts: {
      pdf: pdfPath ?? null,
      html: htmlPath ?? null,
      docx: docxPath ?? null,
      md: mdPath,
      composition_json: args.writeComposition === false ? null : compositionPath,
      provenance_json: provenanceJsonPath,
      audit_json: auditJsonPath,
    },
    warnings: result.warnings ?? [],
  };

  // An audit run is a render, so the baseline's metadata.json must not go stale
  // behind it (approval status, artefact paths, page count, content hash).
  if (args.resume && args.writeComposition !== false) {
    await writeBaselineMetadataIfNeeded({
      outDir,
      resumeId: args.resume,
      profileId: args.profile,
      renderedResumesDir: resolveProfileContext(args.profile).renderedResumesDir,
      templateName,
      formatId,
      renderPolicy: format?.render_policy,
      content,
      contentJsonPath: args.contentJson,
      maxBullets: args.maxBullets ? String(args.maxBullets) : undefined,
      result: { ...result, meta: { ...(result.meta ?? {}), md_path: mdPath, composition_json_path: compositionPath, provenance_json_path: provenanceJsonPath } },
    }).catch(() => undefined);
  }

  const full = {
    ...compact,
    failing_units: failingUnitsAll,
    pages: compact.pages ? { ...compact.pages, hashes: pdf?.pageHashes ?? [] } : null,
    evaluate: { rubric: rubricPath, issues: evaluation.issues, stats: evaluateStats({ issues: evaluation.issues, pages, lastPageFill: lastFill, bulletMetrics: dom?.bullets ?? null, lineUnitMetrics: dom?.lineUnits ?? null, headingOrphans: dom?.headingOrphans ?? null, experienceStartOrphans: dom?.experienceStartOrphans ?? null, showLineUnits: true, showHeadingBreaks: true }) },
    fit_full: fit,
    line_units: dom?.lineUnits.map((u) => ({ unit_path: u.unitPath, kind: u.kind, page: u.page ?? null, lines: u.lineCount, last_line_fill_pct: Number(u.lastLineFillPct.toFixed(1)), chars: u.charCount, chars_per_line: charsPerFullLine(u), text: u.text })) ?? [],
    provenance,
    preserve,
    editorial,
    generated_at: new Date().toISOString(),
  };
  if (args.writeAuditJson !== false) await fs.writeFile(auditJsonPath, `${JSON.stringify(full, null, 2)}\n`);

  return { compact, full, verdict, outDir, prefix, compositionPath };
}

/**
 * Audit, optionally running the deterministic fit ladder first.
 *
 * With `--auto-fit` the ladder re-renders and re-measures inside THIS browser
 * session (≤6 passes, ~0.5 s each) and the reported audit is the one for the
 * final, fitted composition. Applied ops are echoed in the compact report so
 * the caller sees exactly what moved; the ladder never touches text.
 *
 * The ladder is TEXT-FIRST and PROTECTIVE. It stops with
 * `text_edits_would_suffice` (returning `auto_fit.shave_targets`) whenever
 * shaving the measured ragged tails would recover the whole deficit; it never
 * drops from a role the positioning magnifies or supports; it honours
 * `content_policy.experiences.mentioned.keep_all` and the
 * `bullets_per_featured.min` floor; and it never restores what it dropped in
 * the same run. `--force-drops` disables the text-first stop. `--dry-run` plans
 * the whole ladder against scratch renders and leaves every real artefact,
 * the composition, the provenance sidecar and audit.json untouched.
 */
export async function runAudit(args: AuditArgs): Promise<Awaited<ReturnType<typeof runAuditOnce>> & { auto_fit?: unknown }> {
  if (!args.autoFit) return runAuditOnce(args);

  const dryRun = args.dryRun === true;
  const session = args.session ?? await openBrowserSession({ launch: args.launch });
  const scratchDir = dryRun ? await fs.mkdtemp(path.join(os.tmpdir(), "resume-auto-fit-dry-")) : null;
  // In a dry run nothing the audit produces may land on the real paths, so both
  // the first pass and every ladder pass render into the scratch directory and
  // write neither the composition nor audit.json.
  const auditArgs: AuditArgs = scratchDir
    ? { ...args, outDir: scratchDir, writeComposition: false, writeAuditJson: false }
    : args;
  try {
    const first = await runAuditOnce({ ...auditArgs, session });
    const loaded = await loadComposition(args.contentJson);
    const scratch = path.join(first.outDir, `${first.prefix}.fit-candidate.json`);
    const policy = await ladderPolicyFor({ content: loaded.content, resume: args.resume, profile: args.profile });

    const audit: AutoFitAudit = async (content, provenance) => {
      await writeComposition(scratch, content, { provenance });
      const pass = await runAuditOnce({ ...auditArgs, session, contentJson: scratch, writeComposition: false, writeAuditJson: false });
      return snapshotFromAudit(pass.full);
    };

    const fitted = await runAutoFit({
      content: loaded.content,
      provenance: loaded.provenance,
      audit,
      initial: snapshotFromAudit(first.full),
      maxPasses: args.maxPasses ?? DEFAULT_MAX_PASSES,
      textFirst: !args.forceDrops,
      ...policy,
    });
    const shaveTargets = fitted.shave_targets ? { shave_targets: fitted.shave_targets } : {};

    if (dryRun) {
      await fs.rm(scratchDir!, { recursive: true, force: true }).catch(() => undefined);
      const auto_fit = {
        dry_run: true,
        planned_ops: fitted.applied,
        passes: fitted.passes,
        skipped: fitted.skipped,
        stopped_because: fitted.stopped_because,
        fit_verdicts: fitted.fit_verdicts,
        ...shaveTargets,
      };
      return { ...first, compact: Object.assign({}, first.compact, { auto_fit }), full: Object.assign({}, first.full, { auto_fit }), auto_fit };
    }

    if (!fitted.applied.length) {
      await fs.rm(scratch, { force: true }).catch(() => undefined);
      const auto_fit = { passes: 0, ops: [] as typeof fitted.applied, skipped: fitted.skipped, stopped_because: fitted.stopped_because, fit_verdicts: fitted.fit_verdicts, ...shaveTargets };
      return { ...first, compact: Object.assign({}, first.compact, { auto_fit }), full: Object.assign({}, first.full, { auto_fit }), auto_fit };
    }

    // Land the fitted composition on the real artefact paths and re-audit once
    // so every artefact (pdf, docx, md, images, audit.json) matches it.
    await writeComposition(scratch, fitted.content, { provenance: fitted.provenance });
    const final = await runAuditOnce({ ...args, session, contentJson: scratch });
    await fs.rm(scratch, { force: true }).catch(() => undefined);
    await fs.rm(scratch.replace(/\.json$/, ".provenance.json"), { force: true }).catch(() => undefined);

    const auto_fit = {
      passes: fitted.passes,
      ops: fitted.applied,
      skipped: fitted.skipped,
      stopped_because: fitted.stopped_because,
      fit_verdicts: fitted.fit_verdicts,
      fit_before: first.full.fit_full?.verdict ?? null,
      fit_after: final.full.fit_full?.verdict ?? null,
      ...shaveTargets,
    };
    return { ...final, compact: Object.assign({}, final.compact, { auto_fit }), full: Object.assign({}, final.full, { auto_fit }), auto_fit };
  } finally {
    if (!args.session) await closeBrowserSession(session);
  }
}

async function main() {
  const a = parseArgs();
  if (!a["content-json"]) {
    console.error("Usage: tsx tools/resume/resume-audit.ts --content-json <path> (--resume <id> | --template <name>) [--out-dir <dir>] [--images] [--dpi 72] [--jd <path>] [--keyword-plan <path>] [--auto-fit] [--dry-run] [--force-drops] [--full]");
    process.exit(2);
  }
  const { compact, full, verdict } = await runAudit({
    contentJson: a["content-json"],
    resume: a.resume,
    template: a.template,
    profile: a.profile,
    format: a.format,
    outDir: a["out-dir"],
    filenamePrefix: a["filename-prefix"],
    flavours: a.flavours ? a.flavours.split(",").map((s) => s.trim() as Flavour) : undefined,
    maxBullets: a["max-bullets"] ? Number(a["max-bullets"]) : undefined,
    jd: a.jd,
    keywordPlan: a["keyword-plan"],
    strictLineUnits: a["strict-line-units"] === undefined ? true : a["strict-line-units"] !== "false",
    images: a.images === "true",
    dpi: a.dpi ? Number(a.dpi) : undefined,
    full: a.full === "true",
    writeComposition: a["no-composition"] !== "true",
    autoFit: a["auto-fit"] === "true",
    maxPasses: a["max-passes"] ? Number(a["max-passes"]) : undefined,
    dryRun: a["dry-run"] === "true",
    forceDrops: a["force-drops"] === "true",
  });
  console.log(JSON.stringify(a.full === "true" ? full : compact, null, 2));
  process.exit(verdict === "pass" ? 0 : verdict === "warn" ? 1 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(3); });
}
