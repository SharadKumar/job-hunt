#!/usr/bin/env tsx

import { exists } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadProfile, type ProfileFrontmatter } from "./profile.ts";
import { resolveProfileContext, type ProfileContext } from "./profile-context.ts";
import { loadResolvedResumes, type ResolvedResume } from "./resumes.ts";
import { discoverProfiles, loadMetadataStatus, profileIdFromArg, type ProfileRef } from "./profile-team.ts";
import type { ResumeContent } from "../templates/resume/_interface.ts";
import { loadComposition } from "./resume/lib/composition-io.ts";
import { repoPath, repoRoot } from "./repo-root.ts";

type RawFile = {
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

type ArtefactSet = {
  docx: string | null;
  pdf: string | null;
  html: string | null;
  md: string | null;
  composition_json: string | null;
  provenance_json: string | null;
  pngs: string[];
};

type ResumeReport = {
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

type TemplateReport = {
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

type ProfileReportModel = {
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

type TeamReportModel = {
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

type CliArgs = { cmd: string; args: Record<string, string> };
const DEFAULT_TEMPLATE_PATH = repoPath("templates/profile-report/report-template.html");

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : "profile";
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return { cmd, args };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attr(value: unknown): string {
  return escapeHtml(value);
}

function inferCodeLanguage(filePathOrLabel: string): string {
  const lower = filePathOrLabel.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return "";
}

function highlightJson(text: string): string {
  const tokenPattern = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let highlighted = "";
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    highlighted += escapeHtml(text.slice(lastIndex, index));

    if (match[1]) {
      const className = match[2] ? "sh-key" : "sh-string";
      highlighted += `<span class="${className}">${escapeHtml(match[1])}</span>${escapeHtml(match[2] ?? "")}`;
    } else if (match[3]) {
      highlighted += `<span class="sh-${match[3] === "null" ? "null" : "boolean"}">${escapeHtml(match[3])}</span>`;
    } else {
      highlighted += `<span class="sh-number">${escapeHtml(match[0])}</span>`;
    }

    lastIndex = index + match[0].length;
  }

  return highlighted + escapeHtml(text.slice(lastIndex));
}

function highlightYamlValue(value: string): string {
  const commentMatch = value.match(/^(\s*)(#.*)$/);
  if (commentMatch) return `${escapeHtml(commentMatch[1])}<span class="sh-comment">${escapeHtml(commentMatch[2])}</span>`;

  const inlineComment = value.match(/^(.*?)(\s+#.*)$/);
  const body = inlineComment ? inlineComment[1] : value;
  const comment = inlineComment ? inlineComment[2] : "";
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|\b(true|false|null|yes|no|on|off)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gi;
  let highlighted = "";
  let lastIndex = 0;

  for (const match of body.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    highlighted += escapeHtml(body.slice(lastIndex, index));

    if (token.startsWith("\"") || token.startsWith("'")) highlighted += `<span class="sh-string">${escapeHtml(token)}</span>`;
    else if (/^-?\d/.test(token)) highlighted += `<span class="sh-number">${escapeHtml(token)}</span>`;
    else highlighted += `<span class="${token.toLowerCase() === "null" ? "sh-null" : "sh-boolean"}">${escapeHtml(token)}</span>`;

    lastIndex = index + token.length;
  }

  highlighted += escapeHtml(body.slice(lastIndex));
  return highlighted + (comment ? `<span class="sh-comment">${escapeHtml(comment)}</span>` : "");
}

function highlightYaml(text: string): string {
  return text.split("\n").map((line) => {
    const commentMatch = line.match(/^(\s*)(#.*)$/);
    if (commentMatch) return `${escapeHtml(commentMatch[1])}<span class="sh-comment">${escapeHtml(commentMatch[2])}</span>`;

    const keyMatch = line.match(/^(\s*)(-\s+)?([A-Za-z0-9_.-]+)(\s*:\s*)(.*)$/);
    if (keyMatch) {
      const [, indent, marker = "", key, colon, value] = keyMatch;
      return `${escapeHtml(indent)}${marker ? `<span class="sh-yaml-marker">${escapeHtml(marker)}</span>` : ""}<span class="sh-key">${escapeHtml(key)}</span>${escapeHtml(colon)}${highlightYamlValue(value)}`;
    }

    const listMatch = line.match(/^(\s*-\s+)(.*)$/);
    if (listMatch) return `<span class="sh-yaml-marker">${escapeHtml(listMatch[1])}</span>${highlightYamlValue(listMatch[2])}`;

    return highlightYamlValue(line);
  }).join("\n");
}

function highlightCode(text: string, language: string): string {
  if (language === "json") return highlightJson(text);
  if (language === "yaml" || language === "yml") return highlightYaml(text);
  return escapeHtml(text);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function formatGeneratedAt(date: Date, frontmatter?: ProfileFrontmatter | null): string {
  const locale = frontmatter?.locale?.english_variant || "en-AU";
  const timeZone = frontmatter?.location?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()} ${part("timeZoneName")}`
    .replace(/\s+/g, " ")
    .trim();
}

function formatShortDate(value: unknown, frontmatter?: ProfileFrontmatter | null): string {
  if (!value) return "Not generated";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const locale = frontmatter?.locale?.english_variant || "en-AU";
  const timeZone = frontmatter?.location?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
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
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readGeneratedContent(filePath?: string): Promise<GeneratedReportContent> {
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

async function loadReportTemplate(filePath?: string): Promise<string | undefined> {
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

function countPlacement(composition: ResumeContent | null, placement: "feature" | "mention"): number {
  return composition?.experiences?.filter((experience) => experience.placement === placement).length ?? 0;
}

function marketGapCount(composition: ResumeContent | null, key: keyof NonNullable<ResumeContent["market_alignment"]>): number {
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

function statusClass(status: unknown): string {
  const s = String(status ?? "missing");
  if (s === "approved") return "good";
  if (s === "stale") return "warn";
  if (s === "fresh") return "info";
  return "bad";
}

function badge(label: string, value: unknown, className = "info"): string {
  return `<span class="badge ${attr(className)}"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`;
}

function metric(label: string, value: unknown, className = "info", note?: string): string {
  return `<div class="metric ${attr(className)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${note ? `<em>${escapeHtml(note)}</em>` : ""}
  </div>`;
}

function list(items: unknown[]): string {
  if (!items.length) return `<p class="muted">None recorded.</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function codeBlock(value: unknown, language = ""): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const resolvedLanguage = language || (typeof value === "string" ? "" : "json");
  const className = [resolvedLanguage, resolvedLanguage ? "syntax-highlight" : ""].filter(Boolean).join(" ");
  return `<pre class="${attr(className)}"><code>${highlightCode(text ?? "", resolvedLanguage)}</code></pre>`;
}

function generatedText(value: string | undefined): string {
  if (!value?.trim()) return "";
  const paragraphs = value.trim().split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  return `<div class="generated">${paragraphs}</div>`;
}

function generatedList(title: string, items: string[] | undefined): string {
  if (!items?.length) return "";
  return `<h4>${escapeHtml(title)}</h4>${list(items)}`;
}

function link(outPath: string, filePath: string | null, label: string): string {
  if (!filePath) return `<span class="missing">${escapeHtml(label)} missing</span>`;
  return `<a href="${attr(relativeLink(outPath, filePath))}">${escapeHtml(label)}</a>`;
}

function fileSizeLabel(content: string | null): string {
  if (content === null) return "missing";
  const bytes = Buffer.byteLength(content);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileDisplayName(file: RawFile): string {
  return path.basename(file.path || file.label);
}

function resumeLongName(resume: ResumeReport): string {
  return resume.composition?.headline?.trim() || resume.display_headline?.trim() || resume.label;
}

function maybeIframe(outPath: string, filePath: string | null, title: string): string {
  if (!filePath) return `<div class="empty">No ${escapeHtml(title)} available.</div>`;
  return `<iframe title="${attr(title)}" src="${attr(relativeLink(outPath, filePath))}"></iframe>`;
}

function artefactLinks(outPath: string, resume: ResumeReport): string {
  return `<div class="links">
    ${link(outPath, resume.artefacts.pdf, "PDF")}
    ${link(outPath, resume.artefacts.html, "HTML")}
    ${link(outPath, resume.artefacts.docx, "DOCX")}
    ${link(outPath, resume.artefacts.md, "Markdown")}
    ${link(outPath, resume.artefacts.composition_json, "Composition JSON")}
    ${link(outPath, resume.artefacts.provenance_json, "Provenance JSON")}
    ${link(outPath, resume.metadata ? resume.metadata_path : null, "Metadata JSON")}
  </div>`;
}

function primaryArtefactActions(outPath: string, resume: ResumeReport, compact = false): string {
  const items = [
    resume.artefacts.pdf ? `<a class="button" href="${attr(relativeLink(outPath, resume.artefacts.pdf))}" target="_blank" rel="noopener">PDF</a>` : "",
    resume.artefacts.docx ? `<a class="button" href="${attr(relativeLink(outPath, resume.artefacts.docx))}" target="_blank" rel="noopener">DOCX</a>` : "",
    resume.artefacts.html ? `<a class="button" href="${attr(relativeLink(outPath, resume.artefacts.html))}" target="_blank" rel="noopener">HTML</a>` : "",
    !compact && resume.artefacts.md ? `<a class="button subtle" href="${attr(relativeLink(outPath, resume.artefacts.md))}" target="_blank" rel="noopener">Markdown</a>` : "",
  ].filter(Boolean);
  return items.length ? `<div class="action-row">${items.join("")}</div>` : `<div class="empty">No primary resume artefacts available.</div>`;
}

function pngPreview(outPath: string, resume: ResumeReport): string {
  if (!resume.artefacts.pngs.length) return `<div class="empty">No page PNG previews found.</div>`;
  const slides: string[] = [];
  for (let index = 0; index < resume.artefacts.pngs.length; index += 2) {
    const pages = resume.artefacts.pngs.slice(index, index + 2);
    const label = pages.length === 1 ? `Page ${index + 1}` : `Pages ${index + 1}-${index + pages.length}`;
    slides.push(`<div class="png-carousel-slide" data-carousel-slide aria-label="${attr(label)}">
      ${pages.map((png, pageIndex) => {
        const pageNumber = index + pageIndex + 1;
        const src = relativeLink(outPath, png);
        const caption = `${resume.label} — Page ${pageNumber}`;
        return `<figure>
          <button type="button" class="png-lightbox-trigger" data-lightbox-src="${attr(src)}" data-lightbox-caption="${attr(caption)}" aria-label="${attr(`Open ${caption} preview`)}">
            <img src="${attr(src)}" alt="${attr(`${resume.id} page ${pageNumber}`)}">
          </button>
          <figcaption>Page ${pageNumber}</figcaption>
        </figure>`;
      }).join("")}
    </div>`);
  }
  const initialStatus = resume.artefacts.pngs.length === 1
    ? "Page 1 of 1"
    : `Pages 1-${Math.min(2, resume.artefacts.pngs.length)} of ${resume.artefacts.pngs.length}`;
  return `<div class="png-carousel" data-carousel data-carousel-label="${attr(`${resume.label} image preview`)}">
    <div class="png-carousel-toolbar">
      <div class="png-carousel-actions">
        <p class="png-carousel-status" data-carousel-status>${escapeHtml(initialStatus)}</p>
        <button type="button" class="button" data-carousel-prev>Previous</button>
        <button type="button" class="button" data-carousel-next>Next</button>
      </div>
    </div>
    <div class="png-carousel-viewport">
      <div class="png-carousel-track" data-carousel-track>
        ${slides.join("")}
      </div>
    </div>
    <div class="png-carousel-dots" aria-label="Page groups">
      ${slides.map((_, index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-carousel-goto="${index}" aria-label="Show ${attr(index * 2 + 2 > resume.artefacts.pngs.length ? `page ${index * 2 + 1}` : `pages ${index * 2 + 1}-${index * 2 + 2}`)}"></button>`).join("")}
    </div>
  </div>`;
}

function compositionSummary(resume: ResumeReport): string {
  const composition = resume.composition;
  if (!composition) return `<div class="empty">No composition summary available.</div>`;
  return `<h4>Summary</h4>
  <p>${escapeHtml(composition.summary)}</p>`;
}

function compositionHighlights(resume: ResumeReport): string {
  const highlights = resume.composition?.highlights ?? [];
  if (!highlights.length) return `<section class="snapshot-section"><h4>Highlights</h4><div class="empty">No highlights recorded in composition JSON.</div></section>`;
  return `<section class="snapshot-section snapshot-list-section">
    <h4>Highlights</h4>
    ${list(highlights)}
  </section>`;
}

function compositionSkillBlocks(resume: ResumeReport): string {
  const skills = resume.composition?.skills ?? [];
  if (!skills.length) return `<section class="snapshot-section"><h4>Skills</h4><div class="empty">No skill blocks recorded in composition JSON.</div></section>`;
  return `<section class="snapshot-section">
    <h4>Skills</h4>
    <div class="snapshot-skill-grid">
      ${skills.map((skill) => `<article class="snapshot-skill-block">
        <h5>${escapeHtml(skill.name)}${skill.summary ? ` <span>${escapeHtml(skill.summary)}</span>` : ""}</h5>
        ${list(skill.bullets)}
      </article>`).join("")}
    </div>
  </section>`;
}

function resumeHealth(resume: ResumeReport): { label: string; className: string; reasons: string[] } {
  const status = String(resume.metadata?.approval_status ?? resume.render_status.render_status ?? "missing");
  const reasons: string[] = [];
  if (status === "approved") reasons.push("Approved baseline");
  else if (status === "stale") reasons.push("Approval stale");
  else if (status === "fresh") reasons.push("Rendered but not approved");
  else reasons.push("Baseline missing");
  if (!resume.artefacts.pdf) reasons.push("PDF missing");
  if (!resume.composition?.source_provenance) reasons.push("Provenance missing");
  if (marketGapCount(resume.composition, "confirmation_needed")) reasons.push("Confirmation needed");
  if (marketGapCount(resume.composition, "open_questions")) reasons.push("Open market questions");
  return {
    label: status,
    className: statusClass(status),
    reasons,
  };
}

function provenanceSummary(resume: ResumeReport): string {
  const provenance = resume.composition?.source_provenance;
  if (!provenance) return `<div class="warning">No source_provenance recorded in composition JSON.</div>`;
  return `<div class="summary-grid">
    ${badge("CV hash", provenance.cv_source_hash?.slice(0, 12) ?? "(none)")}
    ${badge("Profile hash", provenance.profile_hash?.slice(0, 12) ?? "(none)")}
    ${badge("Unsupported claims", provenance.unsupported_claims?.length ?? 0, provenance.unsupported_claims?.length ? "bad" : "good")}
    ${badge("Summary refs", provenance.evidence?.summary?.length ?? 0)}
  </div>
  ${(provenance.unsupported_claims?.length ?? 0) > 0 ? codeBlock(provenance.unsupported_claims) : ""}`;
}

function marketSummary(resume: ResumeReport): string {
  const alignment = resume.composition?.market_alignment;
  if (!alignment) return `<div class="empty">No market_alignment recorded in composition JSON.</div>`;
  return `<div class="summary-grid">
    ${badge("Applied terms", alignment.applied_terms?.length ?? 0)}
    ${badge("Implicit terms", alignment.implicit_terms_used?.length ?? 0)}
    ${badge("Confirm needed", marketGapCount(resume.composition, "confirmation_needed"), marketGapCount(resume.composition, "confirmation_needed") ? "warn" : "good")}
    ${badge("Open questions", marketGapCount(resume.composition, "open_questions"), marketGapCount(resume.composition, "open_questions") ? "warn" : "good")}
    ${badge("Source update", marketGapCount(resume.composition, "source_update_required"), marketGapCount(resume.composition, "source_update_required") ? "warn" : "good")}
    ${badge("Missing signals", alignment.missing_signals?.length ?? 0, alignment.missing_signals?.length ? "warn" : "good")}
  </div>${codeBlock(alignment, "json")}`;
}

function resumeCard(model: ProfileReportModel, resume: ResumeReport): string {
  const status = resume.metadata?.approval_status ?? resume.render_status.render_status ?? "missing";
  const generated = model.generated.resume_notes?.[resume.id] ?? model.generated.resume_notes?.[resume.id];
  const health = resumeHealth(resume);
  return `<article class="card resume-card" id="resume-${attr(slug(resume.id))}" data-resume-card data-status="${attr(String(status))}" data-resume-text="${attr(`${resume.id} ${resume.label} ${resume.template} ${resume.preferred_channels.join(" ")}`.toLowerCase())}">
    <header>
      <div>
        <h3>${escapeHtml(resume.label)}</h3>
        <p class="muted">${escapeHtml(resumeLongName(resume))}</p>
      </div>
      <div class="badges">
        ${badge("Status", status, statusClass(status))}
        ${badge("Template", resume.template)}
        ${resume.format_label ? badge("Format", resume.format_label) : ""}
        ${badge("Source", resume.source)}
        ${badge("Active", resume.active ? "yes" : "no", resume.active ? "good" : "warn")}
      </div>
    </header>
    <div class="resume-snapshot">
      <div class="status-tile ${attr(health.className)}">
        <span>Readiness</span>
        <strong>${escapeHtml(health.label)}</strong>
        <small>${escapeHtml(health.reasons.join(" · "))}</small>
      </div>
      <div>
        ${compositionSummary(resume)}
      </div>
    </div>
    ${resume.warnings.length ? `<div class="warning">${list(resume.warnings)}</div>` : ""}
    ${generated ? `<section class="generated-block"><h4>Generated resume-specific notes</h4>${generatedText(generated.narrative)}${generatedList("Risks", generated.risks)}${generatedList("Next actions", generated.next_actions)}</section>` : ""}
    ${primaryArtefactActions(model.out_path, resume)}
    <section class="report-subsection"><h4>Artefacts</h4>${artefactLinks(model.out_path, resume)}</section>
    <details><summary>PDF preview</summary>${maybeIframe(model.out_path, resume.artefacts.pdf, `${resume.id} PDF`)}</details>
    <details><summary>Generated HTML preview</summary>${maybeIframe(model.out_path, resume.artefacts.html, `${resume.id} HTML`)}</details>
    <details><summary>Page PNG previews</summary>${pngPreview(model.out_path, resume)}</details>
    <details><summary>Resume inputs</summary>
      <h4>Should</h4>${list(resume.should)}
      <h4>Could</h4>${list(resume.could)}
      <h4>Flagged</h4>${list(resume.flagged)}
      <h4>Preferred channels</h4>${list(resume.preferred_channels)}
      <h4>Rate band</h4>${codeBlock(resume.rate_band, "json")}
      <h4>Notes</h4><p>${escapeHtml(resume.notes ?? "")}</p>
    </details>
    <details><summary>Metadata</summary>${codeBlock(resume.metadata ?? { missing: resume.metadata_path }, "json")}</details>
    <details><summary>Composition JSON</summary>${resume.composition_raw ? codeBlock(resume.composition_raw, "json") : `<div class="empty">No composition JSON available.</div>`}</details>
  </article>`;
}

function resumeSnapshotPanel(model: ProfileReportModel, resume: ResumeReport): string {
  const generated = model.generated.resume_notes?.[resume.id] ?? model.generated.resume_notes?.[resume.id];
  return `<div class="snapshot-flow">
    <section class="snapshot-section">
      ${compositionSummary(resume)}
    </section>
    ${compositionHighlights(resume)}
    ${compositionSkillBlocks(resume)}
    ${resume.warnings.length ? `<div class="warning">${list(resume.warnings)}</div>` : ""}
    ${generated ? `<section class="generated-block snapshot-section"><h4>Generated resume-specific notes</h4>${generatedText(generated.narrative)}${generatedList("Risks", generated.risks)}${generatedList("Next actions", generated.next_actions)}</section>` : ""}
  </div>`;
}

function resumePdfPreviewPanel(model: ProfileReportModel, resume: ResumeReport): string {
  return `<section class="preview-pane">
    ${maybeIframe(model.out_path, resume.artefacts.pdf, `${resume.id} PDF`)}
  </section>`;
}

function resumeImagePreviewPanel(model: ProfileReportModel, resume: ResumeReport): string {
  return `<section class="preview-pane">
    ${pngPreview(model.out_path, resume)}
  </section>`;
}

function resumePreviewsPanel(model: ProfileReportModel, resume: ResumeReport, slugged: string): string {
  return `<div class="preview-switcher">
    ${tabs([
      { id: `preview-pdf-${slugged}`, label: "PDF", html: resumePdfPreviewPanel(model, resume) },
      { id: `preview-images-${slugged}`, label: "Images", html: resumeImagePreviewPanel(model, resume) },
    ])}
  </div>`;
}

function resumeEvidencePanel(resume: ResumeReport): string {
  return `<div class="detail-flow">
    <section>
      <h4>Evidence summary</h4>
      ${provenanceSummary(resume)}
    </section>
    <section class="report-subsection">
      <h4>Honesty checks</h4>
      ${resume.composition?.source_provenance?.unsupported_claims?.length
        ? list(resume.composition.source_provenance.unsupported_claims)
        : `<p class="muted">No unsupported claims recorded in the composition audit.</p>`}
    </section>
  </div>`;
}

function resumeMarketPanel(resume: ResumeReport): string {
  return `<section>${marketSummary(resume)}</section>`;
}

function rateBandPanel(rateBand: unknown): string {
  if (!rateBand || typeof rateBand !== "object" || Array.isArray(rateBand)) {
    return `<p class="muted">No rate band recorded.</p>`;
  }

  const value = rateBand as Record<string, unknown>;
  const currency = String(value.currency ?? "AUD");
  const billingUnit = String(value.billing_unit ?? "day");
  const gstHandling = String(value.gst_handling ?? "");
  const formatRate = (amount: unknown): string => {
    if (typeof amount !== "number") return "—";
    return `${currency} ${new Intl.NumberFormat("en-AU").format(amount)}`;
  };

  const terms = [billingUnit ? `per ${billingUnit}` : "", gstHandling].filter(Boolean).join(" · ");

  return `<div class="rate-card">
    <div class="rate-card-primary">
      <span>Target</span>
      <strong>${escapeHtml(formatRate(value.target))}</strong>
      ${terms ? `<small>${escapeHtml(terms)}</small>` : ""}
    </div>
    <dl class="rate-card-range">
      <div><dt>Floor</dt><dd>${escapeHtml(formatRate(value.floor))}</dd></div>
      <div><dt>Ceiling</dt><dd>${escapeHtml(formatRate(value.ceiling))}</dd></div>
    </dl>
  </div>`;
}

function resumeStrategyPanel(resume: ResumeReport): string {
  return `<div class="strategy-grid">
    <section class="card inset-card"><h4>Should target</h4>${list(resume.should)}</section>
    <section class="card inset-card"><h4>Could target</h4>${list(resume.could)}</section>
    <section class="card inset-card"><h4>Flagged</h4>${list(resume.flagged)}</section>
    <section class="card inset-card"><h4>Preferred channels</h4>${list(resume.preferred_channels)}</section>
    <section class="card inset-card"><h4>Rate band</h4>${rateBandPanel(resume.rate_band)}</section>
    <section class="card inset-card"><h4>Notes</h4><p>${escapeHtml(resume.notes ?? "None recorded.")}</p></section>
  </div>`;
}

function resumeRawPanel(resume: ResumeReport, slugged: string): string {
  return `<div class="configuration-tabs">
    ${tabs([
      { id: `config-evidence-${slugged}`, label: "Evidence", html: resumeEvidencePanel(resume) },
      { id: `config-metadata-${slugged}`, label: "Metadata", html: codeBlock(resume.metadata ?? { missing: resume.metadata_path }, "json") },
      { id: `config-composition-${slugged}`, label: "Composition JSON", html: resume.composition_raw ? codeBlock(resume.composition_raw, "json") : `<div class="empty">No composition JSON available.</div>` },
    ])}
  </div>`;
}

function positioningDetail(model: ProfileReportModel, resume: ResumeReport, namespace = ""): string {
  const status = resume.metadata?.approval_status ?? resume.render_status.render_status ?? "missing";
  const health = resumeHealth(resume);
  const slugged = slug(resume.id);
  const idSlug = namespace ? `${namespace}-${slugged}` : slugged;
  const detailId = namespace ? `positioning-${namespace}-${slugged}` : `positioning-${slugged}`;
  const pendingAction = health.label === "approved" ? "Ready" : health.reasons[0] ?? "Review";
  return `<article class="positioning-detail" id="${attr(detailId)}" data-detail-panel ${resume === model.resumes[0] ? "" : "hidden"}>
    <header class="positioning-head">
      <div class="positioning-title-block">
        <p class="eyebrow">Resume</p>
        <div class="positioning-title-row">
          <h3>${escapeHtml(resume.label)}</h3>
          <div class="resume-header-actions">
            ${primaryArtefactActions(model.out_path, resume, true)}
          </div>
        </div>
        <p class="muted">${escapeHtml(resumeLongName(resume))}</p>
      </div>
    </header>
    <section class="resume-status-strip ${attr(health.className)}">
      <div>
        <span>Status</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      <div>
        <span>Next action</span>
        <strong>${escapeHtml(pendingAction)}</strong>
      </div>
      <div>
        <span>Generated</span>
        <strong>${escapeHtml(formatShortDate(resume.metadata?.last_render_at ?? resume.render_status.last_render_at, model.frontmatter))}</strong>
      </div>
      <div>
        <span>Template</span>
        <strong>${escapeHtml(resume.template)}</strong>
      </div>
      ${resume.format_label ? `<div>
        <span>Format</span>
        <strong>${escapeHtml(resume.format_label)}</strong>
      </div>` : ""}
      ${resume.active ? "" : `<div><span>Active</span><strong>no</strong></div>`}
    </section>
    <div class="resume-detail-tabs">${tabs([
        { id: `snapshot-${idSlug}`, label: "Overview", html: resumeSnapshotPanel(model, resume) },
        { id: `previews-${idSlug}`, label: "Previews", html: resumePreviewsPanel(model, resume, idSlug) },
        { id: `market-${idSlug}`, label: "Analysis", html: resumeMarketPanel(resume) },
        { id: `strategy-${idSlug}`, label: "Strategy", html: resumeStrategyPanel(resume) },
        { id: `raw-${idSlug}`, label: "Configuration", html: resumeRawPanel(resume, idSlug) },
      ])}</div>
  </article>`;
}

function positioningsMasterDetail(model: ProfileReportModel, namespace = ""): string {
  const rail = model.resumes.map((resume, index) => {
    const health = resumeHealth(resume);
    const status = String(resume.metadata?.approval_status ?? resume.render_status.render_status ?? "missing");
    const generatedAt = formatShortDate(resume.metadata?.last_render_at ?? resume.render_status.last_render_at, model.frontmatter);
    const target = namespace ? `positioning-${namespace}-${slug(resume.id)}` : `positioning-${slug(resume.id)}`;
    return `<button type="button" class="rail-item ${index === 0 ? "active" : ""}" data-detail-target="${attr(target)}" aria-selected="${index === 0 ? "true" : "false"}" aria-label="${attr(`${resume.label}, ${status}, ${health.reasons[0] ?? ""}`)}" title="${attr(`${status}: ${health.reasons[0] ?? ""}`)}">
      <span class="rail-status ${attr(health.className)}" aria-hidden="true"></span>
      <span class="rail-copy">
        <span class="rail-label">${escapeHtml(resume.label)}</span>
        <span class="rail-meta"><span>${escapeHtml(generatedAt)}</span><span>${escapeHtml(status)}</span></span>
      </span>
    </button>`;
  }).join("");
  return `<div class="master-detail" data-master-detail>
    <aside class="detail-rail" aria-label="Resumes">
      <div class="rail-header"><span>Resumes</span><strong>${escapeHtml(model.resumes.length)}</strong></div>
      ${rail}
    </aside>
    <section class="detail-stage">${model.resumes.map((resume) => positioningDetail(model, resume, namespace)).join("")}</section>
  </div>`;
}

function profileOverview(model: ProfileReportModel, namespace = "", openTab: string | null = "resumes"): string {
  const summary = model.generated.profile_notes?.[model.profile.id ?? "default"] ?? model.generated.profile_overview;
  return `<div class="overview-stack">
    ${summary ? `<section class="card overview-summary"><p class="eyebrow">Profile summary</p>${generatedText(summary)}</section>` : ""}
    ${model.warnings.length ? `<section class="warning">${list(model.warnings)}</section>` : ""}
    <section class="overview-resumes" aria-label="Resume overview">${resumeSummaryCards(model, namespace, openTab)}</section>
  </div>`;
}

function sourceFileDetail(file: RawFile, index: number): string {
  const displayName = fileDisplayName(file);
  const statusLabel = file.exists ? "File found" : "File missing";
  return `<article class="file-detail" id="source-file-${index}-${attr(slug(file.label))}" data-detail-panel ${index === 0 ? "" : "hidden"}>
    <header class="file-head">
      <div>
        <p class="eyebrow">Source file · ${escapeHtml(file.path)}</p>
        <h3>${escapeHtml(displayName)} <span class="file-size-inline">${escapeHtml(fileSizeLabel(file.content))}</span></h3>
      </div>
      <span class="file-status-icon ${file.exists ? "good" : "bad"}" role="img" aria-label="${attr(statusLabel)}" title="${attr(statusLabel)}">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="${file.exists ? "M6.5 11.2 3.3 8l1.1-1.1 2.1 2.1 5-5 1.1 1.1-6.1 6.1Z" : "M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2l1.1-1.1Z"}"></path>
        </svg>
      </span>
    </header>
    ${file.exists
      ? `<section class="file-preview" aria-label="${attr(`${displayName} preview`)}">${codeBlock(file.content ?? "", inferCodeLanguage(file.path || file.label))}</section>`
      : `<div class="warning">File missing: ${escapeHtml(file.path)}</div>`}
  </article>`;
}

function sourceFilesMasterDetail(model: ProfileReportModel): string {
  const rail = model.raw_files.map((file, index) => {
    const displayName = fileDisplayName(file);
    return `<button type="button" class="rail-item ${index === 0 ? "active" : ""}" data-detail-target="source-file-${index}-${attr(slug(file.label))}" aria-selected="${index === 0 ? "true" : "false"}" aria-label="${attr(`${displayName}, ${file.exists ? "found" : "missing"}, ${fileSizeLabel(file.content)}`)}" title="${attr(file.path)}">
    <span class="rail-status ${file.exists ? "good" : "bad"}" aria-hidden="true"></span>
    <span class="rail-copy">
      <span class="rail-label">${escapeHtml(displayName)}</span>
      <span class="rail-meta"><span>${escapeHtml(file.exists ? "found" : "missing")}</span><span>${escapeHtml(fileSizeLabel(file.content))}</span></span>
    </span>
    </button>`;
  }).join("");
  return `<div class="master-detail source-file-browser" data-master-detail>
    <aside class="detail-rail" aria-label="Source files">
      <div class="rail-header"><span>Source files</span></div>
      ${rail}
    </aside>
    <section class="detail-stage">${model.raw_files.map((file, index) => sourceFileDetail(file, index)).join("")}</section>
  </div>`;
}

function templateBudget(template: TemplateReport): string {
  const preferred = template.page_budget?.preferred;
  const hardMax = template.page_budget?.hard_max;
  if (preferred && hardMax) return `${preferred} preferred · ${hardMax} max`;
  if (preferred) return `${preferred} preferred`;
  if (hardMax) return `${hardMax} max`;
  return "Budget not set";
}

function templateUsage(profiles: ProfileReportModel[], templateId: string): Array<{ profile: string; resume: string }> {
  const used: Array<{ profile: string; resume: string }> = [];
  for (const profile of profiles) {
    for (const resume of profile.resumes) {
      if (resume.template === templateId) used.push({ profile: profile.profile.label, resume: resume.label });
    }
  }
  return used;
}

function templateSamplePreview(outPath: string, template: TemplateReport): string {
  const actions = [
    template.sample.pdf ? `<a class="button" href="${attr(relativeLink(outPath, template.sample.pdf))}" target="_blank" rel="noopener">PDF</a>` : "",
    template.sample.docx ? `<a class="button" href="${attr(relativeLink(outPath, template.sample.docx))}" target="_blank" rel="noopener">DOCX</a>` : "",
    template.sample.html ? `<a class="button" href="${attr(relativeLink(outPath, template.sample.html))}" target="_blank" rel="noopener">HTML</a>` : "",
    template.sample.md ? `<a class="button subtle" href="${attr(relativeLink(outPath, template.sample.md))}" target="_blank" rel="noopener">Markdown</a>` : "",
  ].filter(Boolean).join("");
  const previews = template.sample.pngs.length
    ? `<div class="template-preview-grid">${template.sample.pngs.map((png, index) => {
      const pageNumber = index + 1;
      const src = relativeLink(outPath, png);
      const caption = `${template.label} sample — Page ${pageNumber}`;
      return `<figure>
        <button type="button" class="png-lightbox-trigger" data-lightbox-src="${attr(src)}" data-lightbox-caption="${attr(caption)}" aria-label="${attr(`Open ${caption}`)}">
          <img src="${attr(src)}" alt="${attr(caption)}">
        </button>
        <figcaption>Page ${escapeHtml(pageNumber)}</figcaption>
      </figure>`;
    }).join("")}</div>`
    : `<div class="empty">No sample page previews found.</div>`;
  return `<section class="template-preview-pane">
    ${actions ? `<div class="action-row">${actions}</div>` : `<div class="empty">No sample artefacts found.</div>`}
    ${previews}
  </section>`;
}

function templateConfigTabs(template: TemplateReport): string {
  return tabs(template.files.map((file) => ({
    id: `template-config-${slug(template.id)}-${slug(file.label)}`,
    label: fileDisplayName(file),
    html: `<section class="template-config-file">
      <p class="eyebrow">Config file · ${escapeHtml(file.path)}</p>
      ${file.exists ? codeBlock(file.content ?? "", inferCodeLanguage(file.path || file.label)) : `<div class="warning">File missing: ${escapeHtml(file.path)}</div>`}
    </section>`,
  })));
}

function templateOverview(template: TemplateReport, usage: Array<{ profile: string; resume: string }>): string {
  return `<div class="template-overview">
    <div class="summary-grid">
      ${badge("Template", template.id)}
      ${badge("Page budget", templateBudget(template))}
      ${badge("Sample pages", template.sample.pngs.length)}
      ${badge("Used by", usage.length)}
    </div>
    ${template.page_budget?.reason ? `<section class="card inset-card"><h4>Budget rationale</h4><p>${escapeHtml(template.page_budget.reason)}</p></section>` : ""}
    <div class="template-info-grid">
      <section class="card inset-card"><h4>Allowed headings</h4>${template.allowed_headings.length ? list(template.allowed_headings) : `<div class="empty">No allowed headings recorded.</div>`}</section>
      <section class="card inset-card"><h4>Section order</h4>${template.section_order.length ? list(template.section_order) : `<div class="empty">No section order recorded.</div>`}</section>
      <section class="card inset-card"><h4>Used by resumes</h4>${usage.length ? list(usage.map((item) => `${item.profile} — ${item.resume}`)) : `<div class="empty">No current report resumes use this template.</div>`}</section>
    </div>
  </div>`;
}

function templatesMasterDetail(templates: TemplateReport[], outPath: string, profiles: ProfileReportModel[]): string {
  const rail = templates.map((template, index) => `<button type="button" class="rail-item ${index === 0 ? "active" : ""}" data-detail-target="template-${attr(slug(template.id))}" aria-selected="${index === 0 ? "true" : "false"}" aria-label="${attr(`${template.label}, ${templateBudget(template)}`)}" title="${attr(template.description ?? template.id)}">
    <span class="rail-status info" aria-hidden="true"></span>
    <span class="rail-copy">
      <span class="rail-label">${escapeHtml(template.label)}</span>
      <span class="rail-meta"><span>${escapeHtml(templateBudget(template))}</span></span>
    </span>
  </button>`).join("");
  const details = templates.map((template, index) => {
    const usage = templateUsage(profiles, template.id);
    return `<article class="template-detail" id="template-${attr(slug(template.id))}" data-detail-panel ${index === 0 ? "" : "hidden"}>
      <header class="positioning-head">
        <div class="positioning-title-block">
          <p class="eyebrow">Template</p>
          <h3>${escapeHtml(template.label)}</h3>
          <p class="muted">${escapeHtml(template.description ?? "No template description recorded.")}</p>
        </div>
      </header>
      ${tabs([
        { id: `template-overview-${slug(template.id)}`, label: "Overview", html: templateOverview(template, usage) },
        { id: `template-preview-${slug(template.id)}`, label: "Preview", html: templateSamplePreview(outPath, template) },
        { id: `template-config-${slug(template.id)}`, label: "Configuration", html: templateConfigTabs(template) },
      ])}
    </article>`;
  }).join("");

  return `<div class="master-detail template-browser" data-master-detail>
    <aside class="detail-rail" aria-label="Templates">
      <div class="rail-header"><span>Templates</span><strong>${escapeHtml(templates.length)}</strong></div>
      ${rail}
    </aside>
    <section class="detail-stage">${details}</section>
  </div>`;
}

function resumeControls(): string {
  return `<div class="card controls">
    <label>Search resumes <input type="search" data-resume-search placeholder="Resume, template, channel…"></label>
    <label>Status <select data-status-filter>
      <option value="">All statuses</option>
      <option value="approved">Approved</option>
      <option value="stale">Stale</option>
      <option value="fresh">Fresh</option>
      <option value="missing">Missing</option>
    </select></label>
  </div>`;
}

function resumeSummaryCards(model: ProfileReportModel, namespace = "", openTab: string | null = "resumes"): string {
  return `<div class="resume-grid">${model.resumes.map((resume) => {
    const health = resumeHealth(resume);
    const status = String(resume.metadata?.approval_status ?? resume.render_status.render_status ?? "missing");
    const headline = resumeLongName(resume);
    const generatedAt = resume.metadata?.last_render_at ?? resume.render_status.last_render_at;
    const pendingAction = health.label === "approved" ? "Ready" : health.reasons[0] ?? "Review";
    const target = namespace ? `positioning-${namespace}-${slug(resume.id)}` : `positioning-${slug(resume.id)}`;
    return `<a class="resume-mini ${attr(health.className)}" href="#${attr(target)}" data-open-detail-target="${attr(target)}"${openTab ? ` data-open-tab="${attr(openTab)}"` : ""} aria-label="Open ${attr(resume.label)} resume detail">
      <span class="resume-date">${escapeHtml(formatShortDate(generatedAt, model.frontmatter))}</span>
      <strong>${escapeHtml(resume.label)}</strong>
      <em>${escapeHtml(headline)}</em>
      <span class="resume-card-badges">
        <span class="mini-badge ${attr(statusClass(status))}">${escapeHtml(status)}</span>
        <span class="mini-badge ${attr(health.className)}">${escapeHtml(pendingAction)}</span>
      </span>
    </a>`;
  }).join("")}</div>`;
}

function tabs(tabsById: Array<{ id: string; label: string; html: string; count?: number }>): string {
  return `<div class="tab-set" data-tab-set><nav class="tabs" role="tablist">
    ${tabsById.map((tab, index) => `<button type="button" id="tab-${attr(tab.id)}" class="${index === 0 ? "active" : ""}" data-tab="${attr(tab.id)}" role="tab" aria-selected="${index === 0 ? "true" : "false"}" aria-controls="${attr(tab.id)}" tabindex="${index === 0 ? "0" : "-1"}" aria-label="${attr(typeof tab.count === "number" ? `${tab.label} ${tab.count}` : tab.label)}"><span>${escapeHtml(tab.label)}</span>${typeof tab.count === "number" ? ` <span class="tab-count">${escapeHtml(tab.count)}</span>` : ""}</button>`).join("")}
  </nav>
  ${tabsById.map((tab, index) => `<section id="${attr(tab.id)}" class="tab-panel ${index === 0 ? "active" : ""}" role="tabpanel" aria-labelledby="tab-${attr(tab.id)}"${index === 0 ? "" : " hidden"}>${tab.html}</section>`).join("")}</div>`;
}

function pageTabs(tabsById: Array<{ id: string; label: string; html: string; count?: number }>): { nav: string; panels: string } {
  return {
    nav: `<nav class="tabs page-tabs" role="tablist" data-page-tabs>
      ${tabsById.map((tab, index) => `<button type="button" id="tab-${attr(tab.id)}" class="${index === 0 ? "active" : ""}" data-tab="${attr(tab.id)}" role="tab" aria-selected="${index === 0 ? "true" : "false"}" aria-controls="${attr(tab.id)}" tabindex="${index === 0 ? "0" : "-1"}" aria-label="${attr(typeof tab.count === "number" ? `${tab.label} ${tab.count}` : tab.label)}"><span>${escapeHtml(tab.label)}</span>${typeof tab.count === "number" ? ` <span class="tab-count">${escapeHtml(tab.count)}</span>` : ""}</button>`).join("")}
    </nav>`,
    panels: tabsById.map((tab, index) => `<section id="${attr(tab.id)}" class="tab-panel ${index === 0 ? "active" : ""}" role="tabpanel" aria-labelledby="tab-${attr(tab.id)}" data-page-panel${index === 0 ? "" : " hidden"}>${tab.html}</section>`).join(""),
  };
}

function headerActions(googleSheetUrl: string | null): string {
  return googleSheetUrl ? `<a class="header-button" href="${attr(googleSheetUrl)}" target="_blank" rel="noopener">Opportunities</a>` : "";
}

function pageShell(title: string, generatedAt: string, body: string, template?: string, heading = title, kicker = "Profile Report", googleSheetUrl: string | null = null, headerTabs = ""): string {
  const actions = headerActions(googleSheetUrl);
  if (template) {
    return template
      .replaceAll("{{TITLE}}", escapeHtml(title))
      .replaceAll("{{HEADING}}", escapeHtml(heading))
      .replaceAll("{{KICKER}}", escapeHtml(kicker))
      .replaceAll("{{GENERATED_AT}}", escapeHtml(generatedAt))
      .replaceAll("{{HEADER_ACTIONS}}", actions)
      .replaceAll("{{HEADER_TABS}}", headerTabs)
      .replaceAll("{{BODY}}", body);
  }
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --bg: #f6f7f9; --panel: #fff; --text: #17202a; --muted: #667085; --line: #d0d5dd; --brand: #1d4ed8; --good: #067647; --warn: #b54708; --bad: #b42318; --info: #175cd3; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
    header.page { padding: 24px 32px; color: #fff; background: #101828; }
    header.page h1 { margin: 0 0 4px; font-size: 28px; }
    main { padding: 24px 32px 48px; }
    h2, h3, h4 { margin: 0 0 12px; }
    p { margin: 0 0 12px; }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .tabs { display: flex; flex-wrap: wrap; gap: 0; margin-bottom: 16px; position: sticky; top: 0; z-index: 2; padding: 0; border-bottom: 1px solid var(--line); background: var(--panel); }
    .tabs button { border: 0; border-bottom: 3px solid transparent; border-radius: 0; padding: 12px 14px 9px; background: transparent; color: var(--text); cursor: pointer; }
    .tabs button.active { color: var(--brand); background: var(--panel); border-bottom-color: var(--brand); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .card { margin: 0 0 18px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: 0 1px 2px rgba(16, 24, 40, .05); }
    .resume-card > header { display: flex; gap: 16px; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
    .badges, .summary-grid, .links { display: flex; flex-wrap: wrap; gap: 8px; }
    .badge { display: inline-flex; gap: 6px; align-items: baseline; padding: 4px 8px; border-radius: 6px; background: #eff4ff; color: var(--info); }
    .badge.good { background: #ecfdf3; color: var(--good); }
    .badge.warn { background: #fffaeb; color: var(--warn); }
    .badge.bad { background: #fef3f2; color: var(--bad); }
    .badge.info { background: #eff4ff; color: var(--info); }
    .muted { color: var(--muted); font-weight: 400; }
    .warning, .missing { color: var(--bad); }
    .warning { margin: 12px 0; padding: 12px; border: 1px solid #fecdca; border-radius: 10px; background: #fffbfa; }
    .empty { margin: 12px 0; padding: 12px; border: 1px dashed var(--line); border-radius: 10px; color: var(--muted); }
    details { margin-top: 12px; }
    details summary { cursor: pointer; font-weight: 700; margin-bottom: 10px; }
    iframe { width: 100%; height: 720px; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
    pre { overflow: auto; max-height: 640px; padding: 12px; border-radius: 10px; background: #101828; color: #f2f4f7; white-space: pre-wrap; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { position: sticky; top: 49px; background: #f9fafb; z-index: 1; }
    .png-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .preview-switcher { position: relative; min-width: 0; }
    .png-carousel { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 12px; }
    .png-carousel-toolbar { position: absolute; top: 0; right: 0; display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
    .png-carousel-status { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .png-carousel-actions { display: flex; align-items: center; gap: 10px; }
    .png-carousel-viewport { overflow: hidden; }
    .png-carousel-track { display: flex; transition: transform .2s ease; }
    .png-carousel-slide { display: grid; flex: 0 0 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .png-carousel-dots { display: flex; justify-content: center; gap: 6px; }
    .png-carousel-dots button { width: 24px; height: 3px; padding: 0; border: 0; border-radius: 999px; background: var(--line); }
    .png-carousel-dots button.active { background: var(--brand); }
    .png-lightbox-trigger { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
    .png-lightbox-trigger img { display: block; }
    body.lightbox-open { overflow: hidden; }
    .image-lightbox[hidden] { display: none; }
    .image-lightbox { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 24px; }
    .image-lightbox-backdrop { position: absolute; inset: 0; border: 0; background: rgba(16, 24, 40, .78); cursor: zoom-out; }
    .image-lightbox-panel { position: relative; z-index: 1; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 12px; width: min(1100px, calc(100vw - 48px)); height: min(92vh, 1280px); padding: 14px; border-radius: 14px; background: var(--panel); }
    .image-lightbox-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .image-lightbox-caption { margin: 0; color: var(--text); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .image-lightbox img { width: 100%; height: 100%; object-fit: contain; }
    figure { margin: 0; }
    img { width: 100%; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
    figcaption { margin-top: 4px; color: var(--muted); }
    @media (max-width: 800px) { main, header.page { padding-left: 16px; padding-right: 16px; } .resume-card > header { display: block; } iframe { height: 520px; } }
  </style>
</head>
<body>
  <header class="page">
    <div>${escapeHtml(kicker)}</div>
    <h1>${escapeHtml(heading)}</h1>
    <div>Generated ${escapeHtml(generatedAt)}</div>
    ${actions}
  </header>
  <main>${body}</main>
  <div class="image-lightbox" data-lightbox role="dialog" aria-modal="true" aria-label="Resume page preview" hidden>
    <button type="button" class="image-lightbox-backdrop" data-lightbox-close aria-label="Close preview"></button>
    <div class="image-lightbox-panel">
      <div class="image-lightbox-head">
        <p class="image-lightbox-caption" data-lightbox-caption></p>
        <button type="button" data-lightbox-close>Close</button>
      </div>
      <img data-lightbox-image src="" alt="">
    </div>
  </div>
  <script>
    document.querySelectorAll(".tabs button").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.getAttribute("data-tab");
        document.querySelectorAll(".tabs button").forEach((item) => {
          const active = item === button;
          item.classList.toggle("active", active);
          item.setAttribute("aria-selected", String(active));
          item.setAttribute("tabindex", active ? "0" : "-1");
        });
        document.querySelectorAll(".tab-panel").forEach((panel) => {
          const active = panel.id === tab;
          panel.classList.toggle("active", active);
          panel.toggleAttribute("hidden", !active);
        });
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = [...document.querySelectorAll(".tabs button")];
        const index = buttons.indexOf(button);
        const nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : event.key === "ArrowRight"
              ? (index + 1) % buttons.length
              : (index - 1 + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[nextIndex].focus();
        buttons[nextIndex].click();
      });
    });
    document.querySelectorAll("[data-carousel]").forEach((carousel) => {
      const track = carousel.querySelector("[data-carousel-track]");
      const slides = [...carousel.querySelectorAll("[data-carousel-slide]")];
      const previous = carousel.querySelector("[data-carousel-prev]");
      const next = carousel.querySelector("[data-carousel-next]");
      const status = carousel.querySelector("[data-carousel-status]");
      const dots = [...carousel.querySelectorAll("[data-carousel-goto]")];
      const totalPages = slides.reduce((count, slide) => count + slide.querySelectorAll("figure").length, 0);
      let current = 0;
      function setCarousel(index) {
        current = Math.max(0, Math.min(index, slides.length - 1));
        if (track) track.style.transform = \`translateX(\${-current * 100}%)\`;
        dots.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === current));
        if (previous) previous.disabled = current === 0;
        if (next) next.disabled = current === slides.length - 1;
        if (status) {
          const start = current * 2 + 1;
          const end = Math.min(start + (slides[current]?.querySelectorAll("figure").length || 1) - 1, totalPages);
          status.textContent = start === end ? \`Page \${start} of \${totalPages}\` : \`Pages \${start}-\${end} of \${totalPages}\`;
        }
      }
      previous?.addEventListener("click", () => setCarousel(current - 1));
      next?.addEventListener("click", () => setCarousel(current + 1));
      dots.forEach((dot) => dot.addEventListener("click", () => setCarousel(Number(dot.getAttribute("data-carousel-goto") || "0"))));
      setCarousel(0);
    });
    const lightbox = document.querySelector("[data-lightbox]");
    const lightboxImage = lightbox?.querySelector("[data-lightbox-image]");
    const lightboxCaption = lightbox?.querySelector("[data-lightbox-caption]");
    let lightboxReturnTarget = null;
    function closeLightbox() {
      if (!lightbox || lightbox.hasAttribute("hidden")) return;
      lightbox.setAttribute("hidden", "");
      document.body.classList.remove("lightbox-open");
      if (lightboxImage) {
        lightboxImage.setAttribute("src", "");
        lightboxImage.setAttribute("alt", "");
      }
      lightboxReturnTarget?.focus?.();
      lightboxReturnTarget = null;
    }
    document.querySelectorAll("[data-lightbox-src]").forEach((trigger) => {
      trigger.addEventListener("click", () => {
        if (!lightbox || !lightboxImage || !lightboxCaption) return;
        const src = trigger.getAttribute("data-lightbox-src") || "";
        const caption = trigger.getAttribute("data-lightbox-caption") || "Resume page preview";
        lightboxReturnTarget = trigger;
        lightboxImage.setAttribute("src", src);
        lightboxImage.setAttribute("alt", caption);
        lightboxCaption.textContent = caption;
        lightbox.removeAttribute("hidden");
        document.body.classList.add("lightbox-open");
        lightbox.querySelector("[data-lightbox-close]")?.focus();
      });
    });
    lightbox?.querySelectorAll("[data-lightbox-close]").forEach((control) => control.addEventListener("click", closeLightbox));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeLightbox();
    });
  </script>
</body>
</html>`;
}

export function renderProfileReportHtml(model: ProfileReportModel, template?: string): string {
  const topTabs = pageTabs([
    { id: "overview", label: "Overview", html: profileOverview(model) },
    { id: "resumes", label: "Resumes", count: model.resumes.length, html: positioningsMasterDetail(model) },
    { id: "source-files", label: "Source Files", html: sourceFilesMasterDetail(model) },
    { id: "templates", label: "Templates", count: model.templates.length, html: templatesMasterDetail(model.templates, model.out_path, [model]) },
  ]);
  return pageShell(`Profile Report — ${model.profile.label}`, model.generated_at_label, topTabs.panels, template, model.profile.label, "Profile Report", model.google_sheet_url, topTabs.nav);
}

function matrixTable(model: TeamReportModel): string {
  const rows = model.matrix.map((row) => `<tr>
    <td>${escapeHtml(row.profile)}</td>
    <td>${escapeHtml(row.id)}</td>
    <td>${escapeHtml(row.label)}</td>
    <td>${escapeHtml(row.template)}</td>
    <td>${escapeHtml(row.format_label ?? "")}</td>
    <td>${escapeHtml(row.render_status)}</td>
    <td>${escapeHtml(row.active)}</td>
    <td>${escapeHtml(row.source)}</td>
    <td>${escapeHtml(row.last_render_at)}</td>
  </tr>`).join("");
  return `<div class="card"><table><thead><tr><th>Profile</th><th>Resume</th><th>Label</th><th>Template</th><th>Format</th><th>Status</th><th>Active</th><th>Source</th><th>Last render</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function profileNamespace(profile: ProfileReportModel): string {
  return `profile-${slug(profile.profile.id ?? "default")}`;
}

function teamProfileHealth(profile: ProfileReportModel): { label: string; className: string; reasons: string[] } {
  const health = profile.resumes.map((resume) => resumeHealth(resume));
  const stale = health.filter((item) => item.label === "stale").length;
  const missing = health.filter((item) => item.label === "missing").length;
  const fresh = health.filter((item) => item.label === "fresh").length;
  const approved = health.filter((item) => item.label === "approved").length;

  if (missing) return { label: "missing", className: "bad", reasons: [`${missing} missing`] };
  if (stale) return { label: "stale", className: "warn", reasons: [`${stale} stale`, `${approved} approved`] };
  if (fresh) return { label: "fresh", className: "info", reasons: [`${fresh} fresh`, `${approved} approved`] };
  return { label: "approved", className: "good", reasons: [`${approved} approved`] };
}

function profileLatestRender(profile: ProfileReportModel): unknown {
  const timestamps = profile.resumes
    .map((resume) => resume.metadata?.last_render_at ?? resume.render_status.last_render_at)
    .filter(Boolean)
    .map((value) => new Date(String(value)).getTime())
    .filter((value) => Number.isFinite(value));
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function teamProfileCards(model: TeamReportModel): string {
  return `<div class="resume-grid team-profile-grid">${model.profiles.map((profile) => {
    const health = teamProfileHealth(profile);
    const namespace = profileNamespace(profile);
    const latestRender = profileLatestRender(profile);
    return `<a class="resume-mini ${attr(health.className)}" href="#team-profile-${attr(namespace)}" data-open-detail-target="team-profile-${attr(namespace)}" data-open-tab="profiles" aria-label="Open ${attr(profile.profile.label)} profile detail">
      <span class="resume-date">${escapeHtml(formatShortDate(latestRender, profile.frontmatter))}</span>
      <strong>${escapeHtml(profile.profile.label)}</strong>
      <em>${escapeHtml(profile.resumes.length)} resumes</em>
      <span class="resume-card-badges">
        <span class="mini-badge ${attr(health.className)}">${escapeHtml(health.label)}</span>
        <span class="mini-badge info">${escapeHtml(health.reasons.join(" · "))}</span>
      </span>
    </a>`;
  }).join("")}</div>`;
}

function teamOverview(model: TeamReportModel): string {
  const profileCount = model.profiles.length;
  const resumeCount = model.matrix.length;
  const approved = model.matrix.filter((row) => row.render_status === "approved").length;
  const stale = model.matrix.filter((row) => row.render_status === "stale").length;
  const missing = model.matrix.filter((row) => row.render_status === "missing").length;
  return `<div class="overview-stack">
    ${model.generated.team_overview ? `<section class="card overview-summary"><p class="eyebrow">Bench summary</p>${generatedText(model.generated.team_overview)}</section>` : ""}
    <section class="team-stat-strip" aria-label="Bench health">
      ${metric("Profiles", profileCount)}
      ${metric("Resumes", resumeCount)}
      ${metric("Approved", approved, "good")}
      ${metric("Stale", stale, stale ? "warn" : "good")}
      ${metric("Missing", missing, missing ? "bad" : "good")}
    </section>
    <section class="overview-resumes" aria-label="Profiles">${teamProfileCards(model)}</section>
  </div>`;
}

function resumeCoverage(model: TeamReportModel): string {
  const coverage = new Map<string, { label: string; profiles: string[] }>();
  for (const row of model.matrix) {
    const id = String(row.id);
    const entry = coverage.get(id) ?? { label: String(row.label ?? id), profiles: [] };
    entry.profiles.push(String(row.profile));
    coverage.set(id, entry);
  }
  const rows = [...coverage.entries()].map(([id, entry]) => `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(entry.label)}</td><td>${escapeHtml(entry.profiles.join(", "))}</td><td>${entry.profiles.length}</td></tr>`).join("");
  return `<div class="card"><table><thead><tr><th>Resume</th><th>Label</th><th>Profiles</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function coverageMatrix(model: TeamReportModel): string {
  const resumeIds = [...new Map(model.matrix.map((row) => [String(row.id), String(row.label ?? row.id)])).entries()];
  const profileIds = model.profiles.map((profile) => profile.profile.id ?? "default");
  const byProfileAndResume = new Map(model.matrix.map((row) => [`${String(row.profile_id)}:${String(row.id)}`, row]));
  const rows = model.profiles.map((profile, index) => {
    const profileId = profileIds[index];
    return `<tr>
    <th scope="row"><span class="coverage-profile-cell"><strong>${escapeHtml(profile.profile.label)}</strong><span>${escapeHtml(profileId)}</span></span></th>
    ${resumeIds.map(([resumeId]) => {
      const row = byProfileAndResume.get(`${profileId}:${resumeId}`);
      if (!row) return `<td><span class="coverage-empty">—</span></td>`;
      const status = String(row.render_status ?? "missing");
      return `<td><span class="coverage-result-cell">
        <span class="coverage-status ${attr(statusClass(status))}">${escapeHtml(status)}</span>
        <small>${escapeHtml(formatShortDate(row.last_render_at, profile.frontmatter))}</small>
      </span></td>`;
    }).join("")}
  </tr>`;
  }).join("");

  return `<div class="coverage-table-wrap">
    <table class="coverage-table">
      <thead><tr><th>Profile</th>${resumeIds.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function teamProfilesMasterDetail(model: TeamReportModel): string {
  const rail = model.profiles.map((profile, index) => {
    const health = teamProfileHealth(profile);
    const namespace = profileNamespace(profile);
    const childRail = profile.resumes.map((resume) => {
      const resumeStatus = String(resume.metadata?.approval_status ?? resume.render_status.render_status ?? "missing");
      const resumeHealthState = resumeHealth(resume);
      const generatedAt = formatShortDate(resume.metadata?.last_render_at ?? resume.render_status.last_render_at, profile.frontmatter);
      return `<button type="button" class="rail-item rail-child-item" data-detail-target="positioning-${attr(namespace)}-${attr(slug(resume.id))}" data-profile-owner="${attr(namespace)}" aria-selected="false" aria-label="${attr(`${profile.profile.label}, ${resume.label}, ${resumeStatus}`)}" title="${attr(`${resumeStatus}: ${resumeHealthState.reasons[0] ?? ""}`)}">
          <span class="rail-status ${attr(resumeHealthState.className)}" aria-hidden="true"></span>
          <span class="rail-copy">
            <span class="rail-label">${escapeHtml(resume.label)}</span>
            <span class="rail-meta"><span>${escapeHtml(generatedAt)}</span><span>${escapeHtml(resumeStatus)}</span></span>
          </span>
        </button>`;
    }).join("");
    return `<div class="rail-group ${index === 0 ? "expanded" : ""}" data-rail-group="${attr(namespace)}">
      <button type="button" class="rail-item profile-rail-item ${index === 0 ? "active" : ""}" data-detail-target="team-profile-${attr(namespace)}" data-profile-target="${attr(namespace)}" aria-selected="${index === 0 ? "true" : "false"}" aria-expanded="${index === 0 ? "true" : "false"}" aria-label="${attr(`${profile.profile.label}, ${health.label}`)}" title="${attr(health.reasons.join(" · "))}">
      <span class="rail-status ${attr(health.className)}" aria-hidden="true"></span>
      <span class="rail-copy">
        <span class="rail-label">${escapeHtml(profile.profile.label)}</span>
        <span class="rail-meta"><span>${escapeHtml(profile.resumes.length)} resumes</span><span>${escapeHtml(health.label)}</span></span>
      </span>
      </button>
      <div class="rail-children" role="group" aria-label="${attr(`${profile.profile.label} resumes`)}">${childRail}</div>
    </div>`;
  }).join("");

  const details = model.profiles.map((profile, index) => {
    const namespace = profileNamespace(profile);
    const health = teamProfileHealth(profile);
    const profilePanel = `<article class="profile-detail" id="team-profile-${attr(namespace)}" data-detail-panel ${index === 0 ? "" : "hidden"}>
      <header class="positioning-head team-profile-head">
        <div class="positioning-title-block">
          <p class="eyebrow">Profile</p>
          <h3>${escapeHtml(profile.profile.label)}</h3>
          <p class="muted">${escapeHtml(profile.resumes.length)} resumes · ${escapeHtml(health.reasons.join(" · "))}</p>
        </div>
      </header>
      ${profileOverview(profile, namespace, null)}
    </article>`;
    return `${profilePanel}${profile.resumes.map((resume) => positioningDetail(profile, resume, namespace)).join("")}`;
  }).join("");

  return `<div class="master-detail team-profile-browser" data-master-detail>
    <aside class="detail-rail" aria-label="Profiles">
      <div class="rail-header"><span>Profiles</span><strong>${escapeHtml(model.profiles.length)}</strong></div>
      ${rail}
    </aside>
    <section class="detail-stage">${details}</section>
  </div>`;
}

function teamConfiguration(model: TeamReportModel): string {
  const files = [model.team_file, model.org_resume_types, model.org_resume_formats];
  const rail = files.map((file, index) => {
    const displayName = fileDisplayName(file);
    return `<button type="button" class="rail-item ${index === 0 ? "active" : ""}" data-detail-target="source-file-${index}-${attr(slug(file.label))}" aria-selected="${index === 0 ? "true" : "false"}" aria-label="${attr(`${displayName}, ${file.exists ? "found" : "missing"}, ${fileSizeLabel(file.content)}`)}" title="${attr(file.path)}">
      <span class="rail-status ${file.exists ? "good" : "bad"}" aria-hidden="true"></span>
      <span class="rail-copy">
        <span class="rail-label">${escapeHtml(displayName)}</span>
        <span class="rail-meta"><span>${escapeHtml(file.exists ? "found" : "missing")}</span><span>${escapeHtml(fileSizeLabel(file.content))}</span></span>
      </span>
    </button>`;
  }).join("");
  return `<div class="master-detail source-file-browser" data-master-detail>
    <aside class="detail-rail" aria-label="Configuration files">
      <div class="rail-header"><span>Source Files</span></div>
      ${rail}
    </aside>
    <section class="detail-stage">${files.map((file, index) => sourceFileDetail(file, index)).join("")}</section>
  </div>`;
}

export function renderTeamReportHtml(model: TeamReportModel, template?: string): string {
  const topTabs = pageTabs([
    { id: "bench", label: "Bench", html: teamOverview(model) },
    { id: "coverage", label: "Coverage", html: coverageMatrix(model) },
    { id: "profiles", label: "Profiles", count: model.profiles.length, html: teamProfilesMasterDetail(model) },
    { id: "configuration", label: "Configuration", html: teamConfiguration(model) },
    { id: "templates", label: "Templates", count: model.templates.length, html: templatesMasterDetail(model.templates, model.out_path, model.profiles) },
  ]);
  return pageShell("Team Report", model.generated_at_label, topTabs.panels, template, "Team", "Profile Report", null, topTabs.nav);
}

async function writeReport(outPath: string, html: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html);
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs();
  if (cmd === "profile") {
    const profileId = profileIdFromArg(args.profile);
    const context = resolveProfileContext(profileId);
    // A CLI --out stays relative to the caller's cwd; the default is repo-anchored.
    const outPath = path.resolve(args.out ?? path.join(context.profileDir, "profile-report.html"));
    const generated = await readGeneratedContent(args.generated);
    const template = await loadReportTemplate(args.template);
    const model = await buildProfileReportModel(profileId, outPath, generated);
    await writeReport(outPath, renderProfileReportHtml(model, template));
    console.log(JSON.stringify({ report: outPath, profile: profileId ?? "default", resumes: model.resumes.length }, null, 2));
    return;
  }
  if (cmd === "team") {
    const outPath = args.out ?? path.join("state", "org", "team-report.html");
    const generated = await readGeneratedContent(args.generated);
    const template = await loadReportTemplate(args.template);
    const model = await buildTeamReportModel(outPath, generated);
    await writeReport(outPath, renderTeamReportHtml(model, template));
    console.log(JSON.stringify({ report: outPath, profiles: model.profiles.length, rows: model.matrix.length }, null, 2));
    return;
  }
  console.error("Usage: tsx tools/profile-report.ts (profile|team) [--profile <id|default>] [--out <path>]");
  process.exit(2);
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
