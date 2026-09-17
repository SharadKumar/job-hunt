/**
 * Profile report model: everything the report knows before a byte of HTML is
 * written: the profile, its positionings and their artefacts, the resume
 * templates, the raw source files and the team matrix.
 *
 * Split out of `tools/profile-report.ts`, which stays the CLI entry and
 * re-exports the public surface.
 */

import { exists } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadProfile, resolveLocale, type ProfileFrontmatter } from "../profile.ts";
import { resolveProfileContext, type ProfileContext } from "../profile-context.ts";
import { loadResolvedResumes, type ResolvedResume } from "../resumes.ts";
import { discoverProfiles, loadMetadataStatus, type ProfileRef } from "../profile-team.ts";
import type { ResumeContent } from "../../templates/resume/_interface.ts";
import { loadComposition } from "../resume/lib/composition-io.ts";
import { repoPath, repoRoot } from "../repo-root.ts";

export type RawFile = {
  label: string;
  path: string;
  exists: boolean;
  content: string | null;
};

export type GeneratedReportContent = {
  profile_overview?: string;
  team_overview?: string;
  resume_notes?: Record<string, {
    narrative?: string;
    risks?: string[];
    next_actions?: string[];
  }>;
  profile_notes?: Record<string, string>;
};

export type ArtefactSet = {
  docx: string | null;
  pdf: string | null;
  html: string | null;
  md: string | null;
  composition_json: string | null;
  provenance_json: string | null;
  pngs: string[];
};

export type ResumeReport = {
  id: string;
  label: string;
  display_headline: string | null;
  active: boolean;
  source: ResolvedResume["source"];
  template: string;
  format_id: string | null;
  format_label: string | null;
  format_audience: string | null;
  format_purpose: string | null;
  should: string[];
  could: string[];
  flagged: string[];
  preferred_channels: string[];
  rate_band: unknown;
  notes: string | null;
  resume_dir: string;
  metadata_path: string;
  metadata: Record<string, unknown> | null;
  render_status: Record<string, unknown>;
  artefacts: ArtefactSet;
  composition: ResumeContent | null;
  composition_raw: string | null;
  warnings: string[];
};

export type TemplateReport = {
  id: string;
  label: string;
  description: string | null;
  design: string | null;
  page_budget: { preferred?: unknown; hard_max?: unknown; reason?: unknown } | null;
  allowed_headings: string[];
  section_order: string[];
  files: RawFile[];
  sample: {
    docx: string | null;
    pdf: string | null;
    html: string | null;
    md: string | null;
    pngs: string[];
  };
};

export type ProfileReportModel = {
  kind: "profile";
  generated_at: string;
  generated_at_label: string;
  google_sheet_url: string | null;
  out_path: string;
  profile: ProfileRef;
  context: ProfileContext;
  frontmatter: ProfileFrontmatter | null;
  generated: GeneratedReportContent;
  resumes: ResumeReport[];
  templates: TemplateReport[];
  raw_files: RawFile[];
  warnings: string[];
};

export type TeamReportModel = {
  kind: "team";
  generated_at: string;
  generated_at_label: string;
  google_sheet_url: string | null;
  out_path: string;
  generated: GeneratedReportContent;
  profiles: ProfileReportModel[];
  templates: TemplateReport[];
  team_file: RawFile;
  org_resume_types: RawFile;
  org_resume_formats: RawFile;
  matrix: Array<Record<string, unknown>>;
  warnings: string[];
};

const DEFAULT_TEMPLATE_PATH = repoPath("templates/profile-report/report-template.html");

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function formatGeneratedAt(date: Date, frontmatter?: ProfileFrontmatter | null): string {
  const { language, timezone } = resolveLocale(frontmatter);
  const parts = new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()} ${part("timeZoneName")}`
    .replace(/\s+/g, " ")
    .trim();
}

export function formatShortDate(value: unknown, frontmatter?: ProfileFrontmatter | null): string {
  if (!value) return "Not generated";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const { language, timezone } = resolveLocale(frontmatter);
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: timezone,
  }).format(date);
}

async function readDotEnvValue(name: string): Promise<string | null> {
  if (process.env[name]) return process.env[name]!;
  const raw = await readTextIfExists(".env");
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(`${name}=`)) continue;
    return trimmed.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "") || null;
  }
  return null;
}

async function googleSheetUrl(): Promise<string | null> {
  const spreadsheetId = (await readDotEnvValue("SHEETS_SPREADSHEET_ID"))?.trim();
  if (!spreadsheetId || !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) return null;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function normaliseRel(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function relativeLink(outPath: string, resumePath: string): string {
  const rel = normaliseRel(path.relative(path.dirname(path.resolve(outPath)), path.resolve(resumePath)));
  return encodeURI(rel || path.basename(resumePath));
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function readGeneratedContent(filePath?: string): Promise<GeneratedReportContent> {
  if (!filePath) return {};
  const raw = await readTextIfExists(filePath);
  if (!raw) throw new Error(`Generated report content file not found: ${filePath}`);
  return JSON.parse(raw) as GeneratedReportContent;
}

async function rawFile(label: string, filePath: string): Promise<RawFile> {
  const content = await readTextIfExists(filePath);
  // Display the repo-relative path: paths are resolved absolutely for I/O, but
  // an absolute path in a rendered report leaks the machine's directory layout.
  const relative = path.relative(repoRoot(), filePath);
  const displayPath = relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : filePath;
  return { label, path: displayPath, exists: content !== null, content };
}

function titleCaseId(id: string): string {
  return id.split(/[-_]+/).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function loadResumeTemplates(): Promise<TemplateReport[]> {
  const root = repoPath("templates", "resume");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const templateIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name === "fonts") continue;
    if (await exists(path.join(root, entry.name, "render.ts"))) templateIds.push(entry.name);
  }

  const templates = await Promise.all(templateIds.sort().map(async (id) => {
    const templateDir = path.join(root, id);
    const rubricPath = path.join(templateDir, "rubric.yaml");
    const rubricRaw = await readTextIfExists(rubricPath);
    const rubric = rubricRaw ? (YAML.parse(rubricRaw) as Record<string, unknown>) : {};
    const pageBudget = rubric.page_budget && typeof rubric.page_budget === "object"
      ? rubric.page_budget as TemplateReport["page_budget"]
      : null;
    const sampleDir = path.join(templateDir, "sample");
    const sampleFiles = await fs.readdir(sampleDir).catch(() => [] as string[]);
    const sample = {
      docx: await exists(path.join(sampleDir, "golden.docx")) ? path.join(sampleDir, "golden.docx") : null,
      pdf: await exists(path.join(sampleDir, "golden.pdf")) ? path.join(sampleDir, "golden.pdf") : null,
      html: await exists(path.join(sampleDir, "golden.html")) ? path.join(sampleDir, "golden.html") : null,
      md: await exists(path.join(sampleDir, "golden.md")) ? path.join(sampleDir, "golden.md") : null,
      pngs: sampleFiles
        .filter((file) => /^golden-page-\d+\.png$/i.test(file))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((file) => path.join(sampleDir, file)),
    };

    return {
      id,
      label: titleCaseId(id),
      description: typeof rubric.description === "string" ? rubric.description : null,
      design: typeof rubric.template === "string" ? rubric.template : id,
      page_budget: pageBudget,
      allowed_headings: stringArray(rubric.allowed_headings),
      section_order: stringArray(rubric.section_order),
      files: await Promise.all([
        rawFile("rubric.yaml", rubricPath),
        rawFile("styles.css", path.join(templateDir, "styles.css")),
        rawFile("render.ts", path.join(templateDir, "render.ts")),
        rawFile("quality-checks.md", path.join(templateDir, "quality-checks.md")),
        rawFile("template.md", path.join(templateDir, "template.md")),
      ]),
      sample,
    };
  }));

  return templates;
}

export async function loadReportTemplate(filePath?: string): Promise<string | undefined> {
  const templatePath = filePath ?? DEFAULT_TEMPLATE_PATH;
  return readTextIfExists(templatePath).then((content) => content ?? undefined);
}

function artefactsFromMetadata(metadata: Record<string, unknown> | null): Partial<ArtefactSet> {
  const artefacts = metadata?.artefacts;
  if (!artefacts || typeof artefacts !== "object") return {};
  const value = artefacts as Record<string, unknown>;
  return {
    docx: typeof value.docx === "string" ? value.docx : null,
    pdf: typeof value.pdf === "string" ? value.pdf : null,
    html: typeof value.html === "string" ? value.html : null,
    md: typeof value.md === "string" ? value.md : null,
    composition_json: typeof value.composition_json === "string" ? value.composition_json : null,
    provenance_json: typeof value.provenance_json === "string" ? value.provenance_json : null,
  };
}

async function scanArtefacts(resumeDir: string): Promise<ArtefactSet> {
  const files = await fs.readdir(resumeDir).catch(() => [] as string[]);
  const pick = (predicate: (file: string) => boolean): string | null => {
    const found = files.find((file) => predicate(file) && !file.startsWith("."));
    return found ? path.join(resumeDir, found) : null;
  };
  return {
    docx: pick((file) => file.endsWith(".docx")),
    pdf: pick((file) => file.endsWith(".pdf")),
    html: pick((file) => file.endsWith(".html")),
    md: pick((file) => file.endsWith(".md")),
    composition_json: pick((file) => file.endsWith(".composition.json")),
    provenance_json: pick((file) => file.endsWith(".provenance.json")),
    pngs: files
      .filter((file) => /-page-\d+\.png$/.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((file) => path.join(resumeDir, file)),
  };
}

async function resolveArtefacts(resumeDir: string, metadata: Record<string, unknown> | null): Promise<ArtefactSet> {
  const scanned = await scanArtefacts(resumeDir);
  const meta = artefactsFromMetadata(metadata);
  return {
    docx: meta.docx ?? scanned.docx,
    pdf: meta.pdf ?? scanned.pdf,
    html: meta.html ?? scanned.html,
    md: meta.md ?? scanned.md,
    composition_json: meta.composition_json ?? scanned.composition_json,
    provenance_json: meta.provenance_json ?? scanned.provenance_json,
    pngs: scanned.pngs,
  };
}

export function marketGapCount(composition: ResumeContent | null, key: keyof NonNullable<ResumeContent["market_alignment"]>): number {
  const value = composition?.market_alignment?.[key];
  return Array.isArray(value) ? value.length : 0;
}

async function buildResumeReport(profile: ProfileRef, context: ProfileContext, resolved: ResolvedResume): Promise<ResumeReport> {
  const resumeDir = path.join(context.renderedResumesDir, resolved.resume.id);
  const metadataPath = path.join(resumeDir, "metadata.json");
  const metadata = await readJsonIfExists(metadataPath);
  const renderStatus = await loadMetadataStatus(profile.id, resolved.resume.id);
  const artefacts = await resolveArtefacts(resumeDir, metadata);
  const warnings: string[] = [];

  for (const [label, filePath] of Object.entries(artefacts)) {
    if (label === "pngs") continue;
    if (typeof filePath === "string" && !(await exists(filePath))) warnings.push(`Metadata references missing ${label}: ${filePath}`);
  }
  if (!metadata) warnings.push(`Missing metadata.json for resume '${resolved.resume.id}'.`);
  if (!artefacts.pdf && !artefacts.html) warnings.push(`No PDF or generated HTML preview found for resume '${resolved.resume.id}'.`);

  const compositionRaw = artefacts.composition_json ? await readTextIfExists(artefacts.composition_json) : null;
  let composition: ResumeContent | null = null;
  if (compositionRaw && artefacts.composition_json) {
    try {
      // loadComposition reunites the composition with `<prefix>.provenance.json`
      // (or the inline field on pre-sidecar artefacts) so the provenance panel
      // below sees the same shape either way.
      const loaded = await loadComposition(artefacts.composition_json);
      composition = loaded.content;
      if (loaded.provenancePath) artefacts.provenance_json = loaded.provenancePath;
    } catch {
      warnings.push(`Composition JSON could not be parsed: ${artefacts.composition_json}`);
    }
  } else {
    warnings.push(`No composition JSON found for resume '${resolved.resume.id}'.`);
  }

  return {
    id: resolved.resume.id,
    label: resolved.resume.label,
    display_headline: resolved.resume.display_headline ?? null,
    active: resolved.resume.active !== false,
    source: resolved.source,
    template: typeof metadata?.template === "string" ? metadata.template : resolved.resume.template ?? "classic",
    format_id: typeof metadata?.format_id === "string" ? metadata.format_id : resolved.resume.format_id ?? null,
    format_label: typeof metadata?.format_label === "string" ? metadata.format_label : resolved.resume.format_label ?? null,
    format_audience: typeof metadata?.format_audience === "string" ? metadata.format_audience : resolved.resume.format_audience ?? null,
    format_purpose: typeof metadata?.format_purpose === "string" ? metadata.format_purpose : resolved.resume.format_purpose ?? null,
    should: resolved.resume.should ?? [],
    could: resolved.resume.could ?? [],
    flagged: resolved.resume.flagged ?? [],
    preferred_channels: resolved.resume.preferred_channels ?? [],
    rate_band: resolved.resume.rate_band,
    notes: resolved.resume.notes ?? null,
    resume_dir: resumeDir,
    metadata_path: metadataPath,
    metadata,
    render_status: renderStatus,
    artefacts,
    composition,
    composition_raw: compositionRaw,
    warnings,
  };
}

export async function buildProfileReportModel(profileId: string | null, outPath: string, generated: GeneratedReportContent = {}): Promise<ProfileReportModel> {
  const context = resolveProfileContext(profileId);
  const profile: ProfileRef = { id: profileId, label: profileId ?? "default" };
  const warnings: string[] = [];
  const generatedAt = new Date();
  const frontmatter = await loadProfile(profileId).catch((error) => {
    warnings.push(`Could not parse profile frontmatter: ${(error as Error).message}`);
    return null;
  });
  const resolved = await loadResolvedResumes({ profileId });
  const resumes = await Promise.all(resolved.map((entry) => buildResumeReport(profile, context, entry)));

  return {
    kind: "profile",
    generated_at: generatedAt.toISOString(),
    generated_at_label: formatGeneratedAt(generatedAt, frontmatter),
    google_sheet_url: await googleSheetUrl(),
    out_path: outPath,
    profile: { id: profileId, label: frontmatter?.name ?? profile.label },
    context,
    frontmatter,
    generated,
    resumes,
    templates: await loadResumeTemplates(),
    raw_files: await Promise.all([
      rawFile("profile.md", context.profileMdPath),
      rawFile("cv-source.md", context.cvSourcePath),
      rawFile("resumes.yaml", context.resumesPath),
      rawFile("market-confirmations.yaml", context.marketConfirmationsPath),
      rawFile("voice-samples.md", context.voiceSamplesPath),
      rawFile("state/org/resume-types.yaml", repoPath("state/org/resume-types.yaml")),
      rawFile("state/org/resume-formats.yaml", repoPath("state/org/resume-formats.yaml")),
    ]),
    warnings,
  };
}

export async function buildTeamReportModel(outPath: string, generated: GeneratedReportContent = {}): Promise<TeamReportModel> {
  const teamFile = await rawFile("state/org/team.yaml", repoPath("state/org/team.yaml"));
  if (!teamFile.exists) throw new Error("team mode not configured: state/org/team.yaml not found");
  const generatedAt = new Date();
  const rootFrontmatter = await loadProfile(null).catch(() => null);

  const profiles = await discoverProfiles({ profile: "all" });
  const profileModels = await Promise.all(profiles.map((profile) => buildProfileReportModel(profile.id, outPath, generated)));
  const matrix: Array<Record<string, unknown>> = [];
  for (const profile of profiles) {
    const resolved = await loadResolvedResumes({ profileId: profile.id });
    for (const entry of resolved) {
      matrix.push({
        profile_id: profile.id ?? "default",
        profile: profile.label,
        id: entry.resume.id,
        label: entry.resume.label,
        active: entry.resume.active !== false,
        source: entry.source,
        template: entry.resume.template ?? "classic",
        format_id: entry.resume.format_id ?? null,
        format_label: entry.resume.format_label ?? null,
        market_lens: Boolean(entry.resume.market_lens),
        search_keywords: entry.resume.search_keywords?.length ?? 0,
        ...(await loadMetadataStatus(profile.id, entry.resume.id)),
      });
    }
  }

  return {
    kind: "team",
    generated_at: generatedAt.toISOString(),
    generated_at_label: formatGeneratedAt(generatedAt, rootFrontmatter),
    google_sheet_url: await googleSheetUrl(),
    out_path: outPath,
    generated,
    profiles: profileModels,
    templates: await loadResumeTemplates(),
    team_file: teamFile,
    org_resume_types: await rawFile("state/org/resume-types.yaml", repoPath("state/org/resume-types.yaml")),
    org_resume_formats: await rawFile("state/org/resume-formats.yaml", repoPath("state/org/resume-formats.yaml")),
    matrix,
    warnings: [],
  };
}
