#!/usr/bin/env tsx
/**
 * resume-renderer.ts — dispatcher.
 *
 * The actual rendering is done by template-specific code under
 * templates/resume/<name>/render.ts (each exports a default ResumeTemplate).
 * This file's job is:
 *   1. Resolve which template to use (from --resume → resumes.yaml.template,
 *      or --template flag, or default "classic").
 *   2. Read an already-composed ResumeContent JSON from resume-writer.
 *   3. Dynamically import the template's render.ts.
 *   4. Call the template with (content, RenderOptions).
 *   5. Return / surface the produced artefact paths.
 *
 * Each template chooses its own engine and emits whichever flavours it
 * supports. The active templates render presentation PDFs with HTML/CSS +
 * Playwright and ATS docx via the shared _ats-docx.ts renderer.
 *
 * Usage:
 *   tsx tools/resume/resume-renderer.ts --content-json <path> --template <name> --out-dir /tmp/sample
 *   tsx tools/resume/resume-renderer.ts --content-json <path> --resume <id> --template modern --flavours ats,presentation
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { getResume, DEFAULT_TEMPLATE, resumeArtefactPrefix } from "../resumes.ts";
import { defaultTeamResumeFormatId, getResumeFormat } from "../resume-formats.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { loadTemplateMeta, templateContentHash } from "../cv-templates.ts";
import type { ResumeTemplate, Flavour, RenderOptions, RenderResult, ResumeContent, ResumeRenderPolicy } from "../../templates/resume/_interface.ts";
import { writeComposition, loadComposition } from "./lib/composition-io.ts";
import { repoPath, repoRoot } from "../repo-root.ts";

const exec = promisify(execFile);

async function loadTemplate(name: string): Promise<ResumeTemplate> {
  const renderPath = path.resolve(`templates/resume/${name}/render.ts`);
  try { await fs.access(renderPath); }
  catch { throw new Error(`Template '${name}' not found at ${renderPath}. Available: ${(await listTemplates()).join(", ")}`); }
  const mod = await import(renderPath);
  if (typeof mod.default !== "function") throw new Error(`Template '${name}' render.ts does not export a default ResumeTemplate function.`);
  return mod.default as ResumeTemplate;
}

async function listTemplates(): Promise<string[]> {
  try {
    const entries = await fs.readdir(repoPath("templates/resume"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
  } catch { return []; }
}

function normalisedRelative(p: string): string {
  return path.relative(repoRoot(), path.resolve(p)).split(path.sep).join("/");
}

function isProductionOutDir(outDir: string): boolean {
  const rel = normalisedRelative(outDir);
  return rel === "state/profile/resumes"
    || rel.startsWith("state/profile/resumes/")
    || rel.startsWith("state/profiles/")
    || rel === "state/pipeline/archive"
    || rel.startsWith("state/pipeline/archive/");
}

/**
 * Refresh `metadata.json` for a baseline render. Exported so `resume-audit.ts`
 * can call it too: an audit run IS a render, and leaving metadata behind makes
 * approval status and artefact paths lie.
 */
export async function writeBaselineMetadataIfNeeded(args: {
  outDir: string;
  resumeId: string;
  profileId?: string | null;
  renderedResumesDir: string;
  templateName: string;
  formatId?: string | null;
  renderPolicy?: ResumeRenderPolicy;
  content: ResumeContent;
  contentJsonPath?: string;
  maxBullets?: string;
  result: RenderResult;
}): Promise<void> {
  const rel = normalisedRelative(args.outDir);
  const expectedRel = normalisedRelative(path.join(args.renderedResumesDir, args.resumeId));
  if (rel !== expectedRel) return;

  const resume = await getResume(args.resumeId, { profileId: args.profileId });
  if (!resume) return;

  const existing = await fs.readFile(path.join(args.outDir, "metadata.json"), "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => null);
  const templateMeta = await loadTemplateMeta(args.templateName);
  const templateHash = await templateContentHash(args.templateName).catch(() => null);
  const format = await getResumeFormat(args.formatId);
  const composerHash = args.contentJsonPath
    ? createHash("sha256").update(await fs.readFile(args.contentJsonPath)).digest("hex")
    : null;
  const pdfPath = args.result.presentation?.pdf ?? args.result.ats?.pdf ?? null;
  const pageCount = pdfPath ? await countPdfPages(pdfPath) : null;

  const h = createHash("sha256");
  h.update(JSON.stringify(args.content));
  h.update(`\ntemplate:${args.templateName}`);
  h.update(`\ntemplate_hash:${templateHash ?? ""}`);
  h.update(`\nformat:${args.formatId ?? ""}`);
  h.update(`\nformat_label:${format?.label ?? ""}`);
  h.update(`\nmax_bullets:${args.maxBullets ?? ""}`);
  const contentHash = h.digest("hex");

  const meta = {
    resume_id: args.resumeId,
    template: args.templateName,
    format_id: args.formatId ?? null,
    format_label: format?.label ?? null,
    format_audience: format?.audience ?? null,
    format_purpose: format?.purpose ?? null,
    render_policy: args.renderPolicy ?? null,
    template_version: templateMeta?.version ?? null,
    template_hash: templateHash,
    composer_hash: composerHash,
    last_render_at: new Date().toISOString(),
    content_hash: contentHash,
    approved_at: existing?.approved_at ?? null,
    approved_hash: existing?.approved_hash ?? null,
    // The critic stamp survives a re-render on purpose: a re-render moves the
    // composition hash on, so `resume:approve` sees the stale stamp and refuses
    // rather than silently forgetting that a review ever happened.
    critic: existing?.critic ?? null,
    approval_status: existing?.approved_hash === contentHash ? "approved" : existing?.approved_hash ? "stale" : "fresh",
    artefacts: {
      docx: args.result.ats?.docx ?? args.result.presentation?.docx ?? null,
      pdf: pdfPath,
      html: args.result.presentation?.html ?? null,
      md: (args.result.meta?.md_path as string | undefined) ?? null,
      composition_json: (args.result.meta?.composition_json_path as string | undefined) ?? null,
      provenance_json: (args.result.meta?.provenance_json_path as string | undefined) ?? null,
    },
    page_count: pageCount,
    metadata_source: "resume-renderer:content-json",
  };

  await fs.writeFile(path.join(args.outDir, "metadata.json"), JSON.stringify(meta, null, 2));
}

async function countPdfPages(pdfPath: string): Promise<number | null> {
  try {
    const { stdout } = await exec("pdfinfo", [pdfPath]);
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }

  // Resolve content source. Production path: --content-json <path> with
  // resume-writer's composed ResumeContent (paired with --resume for a resume,
  // or --template alone for template-sample renders). The dispatcher trusts
  // the composer's content verbatim — no internal corpus walking, no variant-
  // tag filtering. The atomic-experience tree was removed in the holistic-CV
  // migration (2026-05-28); callers route through resume-writer.
  let content: ResumeContent;
  let templateName: string;
  let formatId: string | null = a.format ?? null;

  if (a["content-json"]) {
    content = (await loadComposition(a["content-json"])).content;
    if (a.resume) {
      const t = await getResume(a.resume, { profileId: a.profile });
      if (!t) { console.error(`Resume '${a.resume}' not found.`); process.exit(2); }
      formatId = formatId ?? t.format_id ?? (a.profile ? await defaultTeamResumeFormatId() : null);
      // Backfill bookkeeping field if the composer left it out.
      if (!content.resumeId) content.resumeId = a.resume;
      templateName = a.template || t.template || DEFAULT_TEMPLATE;
    } else {
      if (!a.template) {
        console.error("--content-json without --resume requires --template <name>.");
        process.exit(2);
      }
      // Template samples and other profile-neutral fixtures do not bind to
      // resumes.yaml, but still need a stable resumeId for diagnostics.
      if (!content.resumeId) content.resumeId = "sample";
      templateName = a.template;
    }
    console.error(`[resume-renderer] using composed content from ${a["content-json"]} (${content.experiences?.length ?? 0} experiences, ${content.highlights?.length ?? 0} highlights)`);
  } else {
    console.error("Usage: tsx tools/resume/resume-renderer.ts --content-json <path> [--resume <id>] [--template <name>] [--flavours ats,presentation] [--out-dir <dir>]");
    console.error("");
    console.error("The renderer no longer loads corpus content itself. Route production renders through the resume-writer subagent, which composes a ResumeContent JSON and passes it via --content-json.");
    process.exit(2);
    return;
  }

  const flavours: Flavour[] = (a.flavours || "ats").split(",").map((s) => s.trim() as Flavour);
  const profileContext = resolveProfileContext(a.profile);
  const outDir = a["out-dir"] || `state/pipeline/archive/resume-render-${Date.now()}`;

  // Production guard: refuse to render to state/profile/resumes/** or
  // state/pipeline/archive/** without --content-json (resume-writer composition)
  // or --preview-debug (explicit "I know what I'm doing").
  // Reason: the default --resume loader produces bloated CVs (12-page EA
  // dumps) that bypass resume-writer's audit. We want production artefacts to
  // always flow through the resume-writer subagent via /resume-render skill.
  const looksProduction = isProductionOutDir(outDir);
  if (looksProduction && !a["content-json"] && !a["preview-debug"]) {
    console.error("Refusing to render to a production path without --content-json (resume-writer composition).");
    console.error(`  outDir: ${outDir}`);
    console.error("  For production CVs, invoke the /resume-render skill — it spawns resume-writer which composes + audits.");
    console.error("  For ad-hoc preview only, add --preview-debug to bypass this guard (artefact will NOT be audited).");
    process.exit(2);
  }

  await fs.mkdir(outDir, { recursive: true });

  // Filename convention: {Profile-Name}_{Resume-Label}.{docx|pdf}
  //   e.g. Jane-Citizen_Solution-Architect.pdf
  // Title-cased, hyphen-joined words, "_" between person and resume type, no
  // "resume" prefix. Owned centrally by resumeArtefactPrefix() in tools/resumes.ts.
  // Caller can override via --filename-prefix for ad-hoc renders.
  const prefix = a["filename-prefix"]
    || (a.resume ? await resumeArtefactPrefix(a.resume, { profileId: a.profile }) : "sample");

  const resumeLabel = a.resume ?? content.resumeId;
  console.error(`[resume-renderer] resume=${resumeLabel} template=${templateName} format=${formatId ?? "none"} flavours=[${flavours.join(",")}] out=${outDir} prefix=${prefix}`);
  const format = await getResumeFormat(formatId);
  const tmpl = await loadTemplate(templateName);
  const options: RenderOptions = {
    flavours,
    outDir,
    maxBullets: a["max-bullets"] ? Number(a["max-bullets"]) : 7,
    filenamePrefix: prefix,
    renderPolicy: format?.render_policy,
  };

  const setupCompletedAt = Date.now();
  const result: RenderResult = await tmpl(content, options);
  const templateCompletedAt = Date.now();

  // Also write the canonical markdown so the user can diff content across renders.
  if (a["out-md"] || a["write-md"] !== "false") {
    const { assembleMarkdown } = await import("../../templates/resume/_pandoc-helpers.ts");
    const md = assembleMarkdown(content, options.renderPolicy);
    const mdPath = a["out-md"] || path.join(outDir, `${prefix}.md`);
    await fs.writeFile(mdPath, md);
    result.meta = { ...(result.meta ?? {}), md_path: mdPath };
  }

  if (a["write-composition-json"] !== "false") {
    // The composition is persisted WITHOUT `source_provenance`; the ~17 KB audit
    // trail goes to `<prefix>.provenance.json` beside it. loadComposition()
    // reunites them for any consumer that needs both.
    const compositionJsonPath = path.join(outDir, `${prefix}.composition.json`);
    const written = await writeComposition(compositionJsonPath, content);
    result.meta = { ...(result.meta ?? {}), composition_json_path: written.compositionPath, provenance_json_path: written.provenancePath };
  }

  if (a.resume) {
    await writeBaselineMetadataIfNeeded({
      outDir,
      resumeId: a.resume,
      profileId: a.profile,
      renderedResumesDir: profileContext.renderedResumesDir,
      templateName,
      formatId,
      renderPolicy: options.renderPolicy,
      content,
      contentJsonPath: a["content-json"],
      maxBullets: a["max-bullets"],
      result,
    });
  }

  const completedAt = Date.now();
  const timingsMs = {
    setup: setupCompletedAt - startedAt,
    template_render: templateCompletedAt - setupCompletedAt,
    artefact_finalisation: completedAt - templateCompletedAt,
    total: completedAt - startedAt,
  };
  console.error(`[resume-renderer] timing setup=${timingsMs.setup}ms render=${timingsMs.template_render}ms finalise=${timingsMs.artefact_finalisation}ms total=${timingsMs.total}ms`);
  console.log(JSON.stringify({ template: templateName, resume: resumeLabel, timings_ms: timingsMs, ...result }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
