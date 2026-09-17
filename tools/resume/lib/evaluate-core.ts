/**
 * evaluate-core.ts — the deterministic resume rubric, as pure functions.
 *
 * Extracted from resume-evaluate.ts so `resume:audit` can run the same checks
 * in-process on metrics it already holds (one browser, one PDF pass). Rule ids
 * and issue messages are byte-identical to the CLI's historical output; the
 * CLI is now a thin wrapper over this module.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import YAML from "yaml";
import type { ResumeContent, ExperienceFeatured } from "../../../templates/resume/_interface.ts";
import { compareExperienceOrder } from "../../../templates/resume/_experience-order.ts";
import { getResume } from "../../resumes.ts";
import { getResumeFormat } from "../../resume-formats.ts";
import type {
  BulletLineFillMetric,
  LineUnitMetric,
  HeadingOrphanMetric,
  ExperienceStartOrphanMetric,
} from "./measure-document.ts";

export type Verdict = "pass" | "warn" | "fail";
export type Issue = { rule: string; severity: "warn" | "fail"; detail: string };

export type HeadingRule = {
  preferred_heading?: string;
  allowed_headings?: string[];
};

export type Rubric = {
  template: string;
  research_claims?: string[];
  claims_referenced?: string[];
  allowed_headings?: string[];
  page_budget?: {
    target_pages?: number;
    preferred?: number;
    preferred_max?: number;
    hard_max?: number;
    last_page_min_fill_pct?: number;
    last_page_min_fill_ratio?: number;
    last_page_min_fill_severity?: "warn" | "fail";
  };
  section_order?: string[];
  sections?: {
    required?: Record<string, HeadingRule>;
    optional?: Record<string, HeadingRule>;
    forbidden_headings?: string[];
  };
  summary?: { min_chars?: number; max_chars?: number; max_sentences?: number; candidate_narrative?: boolean };
  highlights?: {
    min?: number;
    max?: number;
    label?: string;
    presentation_unheaded?: boolean;
    presentation_max_rendered_lines?: number;
    line_fill?: BulletLineFillRule;
  };
  skills?: {
    min_blocks?: number;
    max_blocks?: number;
    max_chars_per_item?: number;
    additional_summary?: { max_chars?: number };
    min_bullets_per_block?: number;
    max_bullets_per_block?: number;
    bullets_per_block?: { min?: number; max?: number };
  };
  experience?: { min_featured?: number; max_featured?: number; max_mentions?: number };
  experiences?: {
    featured?: { min?: number; max?: number; bullets_per_featured?: { min?: number; max?: number } };
    mentioned?: { min?: number; max?: number };
  };
  bullets?: {
    min_per_featured?: number;
    max_per_featured?: number;
    max_chars?: number;
    min_quantified_ratio?: number;
    weak_starts?: string[];
    line_fill?: BulletLineFillRule;
  };
  line_units?: Record<string, LineUnitRule>;
};

export type BulletLineFillRule = {
  single_line_min_fill_pct?: number;
  single_line_target_fill_pct?: number;
  wrapped_last_line_min_fill_pct?: number;
  wrapped_last_line_target_fill_pct?: number;
  tolerance_pct?: number;
  max_lines?: number;
  severity?: "warn" | "fail";
  target_severity?: "warn" | "fail";
};

export type LineUnitRule = BulletLineFillRule & {
  desired_chars?: string;
};


export const DEFAULT_LAST_PAGE_MIN_FILL_PCT = 75;
export const DEFAULT_LINE_FILL_RULE: BulletLineFillRule = {
  wrapped_last_line_min_fill_pct: 55,
  severity: "warn",
};

export async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function readYaml<T>(file: string): Promise<T> {
  return YAML.parse(await fs.readFile(file, "utf8")) as T;
}

export async function readDocxText(file?: string): Promise<string> {
  if (!file) return "";
  const buf = await fs.readFile(file);
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

export async function readOptional(file?: string): Promise<string> {
  if (!file) return "";
  return fs.readFile(file, "utf8").catch(() => "");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/(p|div|section|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ");
}

export function checkBulletLineFill(metrics: BulletLineFillMetric[] | null, rubric: Rubric, issues: Issue[]): void {
  if (!metrics) return;
  const rules: Array<{ kind: string; rule: BulletLineFillRule | undefined }> = [
    { kind: "impact", rule: rubric.highlights?.line_fill ?? DEFAULT_LINE_FILL_RULE },
    { kind: "experience", rule: rubric.bullets?.line_fill ?? DEFAULT_LINE_FILL_RULE },
  ];
  for (const { kind, rule } of rules) {
    if (!rule) continue;
    const severity = rule.severity ?? "warn";
    const targetSeverity = rule.target_severity ?? "warn";
    const tolerance = rule.tolerance_pct ?? 0;
    const singleMin = rule.single_line_min_fill_pct !== undefined ? rule.single_line_min_fill_pct - tolerance : undefined;
    const wrappedLastMin = rule.wrapped_last_line_min_fill_pct !== undefined ? rule.wrapped_last_line_min_fill_pct - tolerance : undefined;
    const singleTarget = rule.single_line_target_fill_pct !== undefined ? rule.single_line_target_fill_pct - tolerance : undefined;
    const wrappedLastTarget = rule.wrapped_last_line_target_fill_pct !== undefined ? rule.wrapped_last_line_target_fill_pct - tolerance : undefined;
    for (const metric of metrics.filter((item) => item.kind === kind)) {
      if (rule.max_lines !== undefined && metric.lineCount > rule.max_lines) {
        addIssue(issues, severity, "bullet_line_count", `${kind} bullet renders ${metric.lineCount} lines above max ${rule.max_lines}: ${metric.text.slice(0, 100)}`);
      }
      if (metric.lineCount === 1 && singleMin !== undefined && metric.lastLineFillPct < singleMin) {
        addIssue(issues, severity, "bullet_single_line_fill", `${kind} bullet line fill ${metric.lastLineFillPct.toFixed(1)}% below min ${(rule.single_line_min_fill_pct ?? singleMin).toFixed(0)}% ±${tolerance}%: ${metric.text.slice(0, 100)}`);
      } else if (metric.lineCount === 1 && singleTarget !== undefined && metric.lastLineFillPct < singleTarget) {
        addIssue(issues, targetSeverity, "bullet_single_line_target", `${kind} bullet line fill ${metric.lastLineFillPct.toFixed(1)}% below target ${(rule.single_line_target_fill_pct ?? singleTarget).toFixed(0)}% ±${tolerance}%: ${metric.text.slice(0, 100)}`);
      }
      if (metric.lineCount > 1 && wrappedLastMin !== undefined && metric.lastLineFillPct < wrappedLastMin) {
        addIssue(issues, severity, "bullet_wrapped_last_line_fill", `${kind} bullet last-line fill ${metric.lastLineFillPct.toFixed(1)}% below min ${(rule.wrapped_last_line_min_fill_pct ?? wrappedLastMin).toFixed(0)}% ±${tolerance}%: ${metric.text.slice(0, 100)}`);
      } else if (metric.lineCount > 1 && wrappedLastTarget !== undefined && metric.lastLineFillPct < wrappedLastTarget) {
        addIssue(issues, targetSeverity, "bullet_wrapped_last_line_target", `${kind} bullet last-line fill ${metric.lastLineFillPct.toFixed(1)}% below target ${(rule.wrapped_last_line_target_fill_pct ?? wrappedLastTarget).toFixed(0)}% ±${tolerance}%: ${metric.text.slice(0, 100)}`);
      }
    }
  }
}

export function checkLineUnits(metrics: LineUnitMetric[] | null, rubric: Rubric, issues: Issue[]): void {
  if (!metrics || !rubric.line_units) return;
  for (const [kind, rule] of Object.entries(rubric.line_units)) {
    const severity = rule.severity ?? "warn";
    const targetSeverity = rule.target_severity ?? "warn";
    const tolerance = rule.tolerance_pct ?? 0;
    const singleMin = rule.single_line_min_fill_pct !== undefined ? rule.single_line_min_fill_pct - tolerance : undefined;
    const wrappedLastMin = rule.wrapped_last_line_min_fill_pct !== undefined ? rule.wrapped_last_line_min_fill_pct - tolerance : undefined;
    const singleTarget = rule.single_line_target_fill_pct !== undefined ? rule.single_line_target_fill_pct - tolerance : undefined;
    const wrappedLastTarget = rule.wrapped_last_line_target_fill_pct !== undefined ? rule.wrapped_last_line_target_fill_pct - tolerance : undefined;
    for (const metric of metrics.filter((item) => item.kind === kind)) {
      if (rule.max_lines !== undefined && metric.lineCount > rule.max_lines) {
        addIssue(issues, severity, "line_unit_line_count", `${kind} renders ${metric.lineCount} lines above max ${rule.max_lines}: ${metric.text.slice(0, 100)}`);
      }
      if (metric.lineCount === 1 && singleMin !== undefined && metric.lastLineFillPct < singleMin) {
        addIssue(issues, severity, "line_unit_single_line_fill", `${kind} line fill ${metric.lastLineFillPct.toFixed(1)}% below min ${(rule.single_line_min_fill_pct ?? singleMin).toFixed(0)}% ±${tolerance}: ${metric.text.slice(0, 100)}`);
      } else if (metric.lineCount === 1 && singleTarget !== undefined && metric.lastLineFillPct < singleTarget) {
        addIssue(issues, targetSeverity, "line_unit_single_line_target", `${kind} line fill ${metric.lastLineFillPct.toFixed(1)}% below target ${(rule.single_line_target_fill_pct ?? singleTarget).toFixed(0)}% ±${tolerance}: ${metric.text.slice(0, 100)}`);
      }
      if (metric.lineCount > 1 && wrappedLastMin !== undefined && metric.lastLineFillPct < wrappedLastMin) {
        addIssue(issues, severity, "line_unit_wrapped_last_line_fill", `${kind} last-line fill ${metric.lastLineFillPct.toFixed(1)}% below min ${(rule.wrapped_last_line_min_fill_pct ?? wrappedLastMin).toFixed(0)}% ±${tolerance}: ${metric.text.slice(0, 100)}`);
      } else if (metric.lineCount > 1 && wrappedLastTarget !== undefined && metric.lastLineFillPct < wrappedLastTarget) {
        addIssue(issues, targetSeverity, "line_unit_wrapped_last_line_target", `${kind} last-line fill ${metric.lastLineFillPct.toFixed(1)}% below target ${(rule.wrapped_last_line_target_fill_pct ?? wrappedLastTarget).toFixed(0)}% ±${tolerance}: ${metric.text.slice(0, 100)}`);
      }
    }
  }
}

export function checkOrphanSectionHeadings(metrics: HeadingOrphanMetric[] | null, issues: Issue[]): void {
  if (!metrics) return;
  for (const metric of metrics) {
    addIssue(
      issues,
      "fail",
      "section_heading_orphan",
      `section heading '${metric.heading}' is alone at the end of page ${metric.headingPage}; first content starts on page ${metric.nextPage}: ${metric.nextText}`,
    );
  }
}

export function checkOrphanExperienceStarts(metrics: ExperienceStartOrphanMetric[] | null, issues: Issue[]): void {
  if (!metrics) return;
  for (const metric of metrics) {
    addIssue(
      issues,
      "fail",
      "experience_start_orphan",
      `experience '${metric.heading}' starts at the end of page ${metric.headingPage}; first content starts on page ${metric.nextPage}: ${metric.nextText}`,
    );
  }
}

export async function applyTargetPolicy(rubric: Rubric, resumeId?: string, options: { profileId?: string | null; formatId?: string | null } = {}): Promise<Rubric> {
  if (!resumeId) return rubric;
  const resume = await getResume(resumeId, { profileId: options.profileId });
  const format = options.formatId ? await getResumeFormat(options.formatId) : null;
  const pagePolicy = {
    ...(resume?.page_policy ?? {}),
    ...(format?.page_policy ?? {}),
  };
  const contentPolicy = {
    ...(resume?.content_policy ?? {}),
    ...(format?.content_policy ?? {}),
  };
  if (!Object.keys(pagePolicy).length && !Object.keys(contentPolicy).length) return rubric;
  const merged: Rubric = {
    ...rubric,
    page_budget: {
      ...(rubric.page_budget ?? {}),
      ...pagePolicy,
    },
    experience: {
      ...(rubric.experience ?? {}),
      ...(contentPolicy.experience ?? {}),
    },
    summary: {
      ...(rubric.summary ?? {}),
      ...(contentPolicy.summary ?? {}),
    },
    highlights: {
      ...(rubric.highlights ?? {}),
      ...(contentPolicy.highlights ?? {}),
    },
    skills: {
      ...(rubric.skills ?? {}),
      ...(contentPolicy.skills ?? {}),
      bullets_per_block: {
        ...(rubric.skills?.bullets_per_block ?? {}),
        ...(contentPolicy.skills?.bullets_per_block ?? {}),
      },
    },
    experiences: {
      ...(rubric.experiences ?? {}),
      ...(contentPolicy.experiences ?? {}),
      featured: {
        ...(rubric.experiences?.featured ?? {}),
        ...(contentPolicy.experiences?.featured ?? {}),
        bullets_per_featured: {
          ...(rubric.experiences?.featured?.bullets_per_featured ?? {}),
          ...(contentPolicy.experiences?.featured?.bullets_per_featured ?? {}),
        },
      },
      mentioned: {
        ...(rubric.experiences?.mentioned ?? {}),
        ...(contentPolicy.experiences?.mentioned ?? {}),
      },
    },
    line_units: {
      ...(rubric.line_units ?? {}),
      ...(contentPolicy.line_units ?? {}),
    },
  };
  return merged;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headingPosition(text: string, headings: string[] = []): number {
  let best = -1;
  for (const heading of headings) {
    const re = new RegExp(`(^|\\n)\\s*${escapeRegex(heading)}\\s*(\\n|$)`, "i");
    const m = text.match(re);
    if (m?.index !== undefined) best = best === -1 ? m.index : Math.min(best, m.index);
    if (best === -1) {
      const loose = new RegExp(`\\b${escapeRegex(heading)}\\b`, "i");
      const looseMatch = text.match(loose);
      if (looseMatch?.index !== undefined) best = looseMatch.index;
    }
  }
  return best;
}

function sentenceCount(text: string): number {
  const matches = text.trim().match(/[.!?]+(\s|$)/g);
  return matches ? matches.length : text.trim() ? 1 : 0;
}

function allFeatured(content: ResumeContent): ExperienceFeatured[] {
  return content.experiences.filter((xp): xp is ExperienceFeatured => xp.placement === "feature");
}

function allBullets(content: ResumeContent): string[] {
  return allFeatured(content).flatMap((xp) => xp.bullets ?? []);
}

function hasQuantity(text: string): boolean {
  return /(\d|%|\$|£|€|m\b|bn\b|million|billion|weeks?|months?|years?)/i.test(text);
}

export function addIssue(issues: Issue[], severity: "warn" | "fail", rule: string, detail: string): void {
  issues.push({ rule, severity, detail });
}

export function minRounded(values: number[]): number | null {
  if (!values.length) return null;
  return Number(Math.min(...values).toFixed(1));
}

function checkRange(args: {
  issues: Issue[];
  rule: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  severity?: "warn" | "fail";
}): void {
  const severity = args.severity ?? "warn";
  if (args.min !== undefined && args.value < args.min) {
    addIssue(args.issues, severity, args.rule, `${args.label} ${args.value} below min ${args.min}`);
  }
  if (args.max !== undefined && args.value > args.max) {
    addIssue(args.issues, severity, args.rule, `${args.label} ${args.value} above max ${args.max}`);
  }
}

export async function checkResearchClaims(rubric: Rubric, issues: Issue[]): Promise<void> {
  const claimsPath = "docs/resume-research/claims.yaml";
  if (!(await exists(claimsPath))) {
    addIssue(issues, "fail", "research_claims", "docs/resume-research/claims.yaml missing");
    return;
  }
  const claimsDoc = await readYaml<{ claims?: Record<string, unknown> }>(claimsPath);
  const claims = claimsDoc.claims ?? {};
  const referenced = rubric.research_claims ?? rubric.claims_referenced ?? [];
  for (const id of referenced) {
    if (!claims[id]) addIssue(issues, "fail", "research_claims", `rubric references unknown claim '${id}'`);
  }
}

function allowedForSemantic(rubric: Rubric, semantic: string, content: ResumeContent | null): string[] {
  const fromStructured = rubric.sections?.required?.[semantic]?.allowed_headings
    ?? rubric.sections?.optional?.[semantic]?.allowed_headings;
  if (fromStructured?.length) return fromStructured;

  const allowed = rubric.allowed_headings ?? [];
  if (!allowed.length) return [];

  if (semantic === "summary") return allowed.filter((h) => /summary/i.test(h));
  if (semantic === "highlights") {
    if (rubric.highlights?.presentation_unheaded || /unheaded/i.test(rubric.highlights?.label ?? "")) return [];
    const explicit = rubric.highlights && "label" in rubric.highlights ? String(rubric.highlights.label ?? "") : "";
    return [explicit, ...allowed.filter((h) => /highlight|impact/i.test(h))].filter(Boolean);
  }
  if (semantic === "skills") return allowed.filter((h) => /skill/i.test(h));
  if (semantic === "experience") return allowed.filter((h) => /experience/i.test(h));
  if (semantic === "earlier") {
    const mentions = content?.experiences?.some((xp) => xp.placement === "mention") ?? false;
    if (!mentions) return [];
    return allowed.filter((h) => /earlier|additional/i.test(h));
  }
  return [];
}

export function checkSections(rubric: Rubric, text: string, issues: Issue[], content: ResumeContent | null): Record<string, number> {
  const positions: Record<string, number> = {};

  const semantics = rubric.sections?.required
    ? Object.keys(rubric.sections.required)
    : ["summary", content?.highlights?.length ? "highlights" : "", "skills", "experience", "earlier"].filter(Boolean);

  for (const semantic of semantics) {
    const headings = allowedForSemantic(rubric, semantic, content);
    if (!headings.length) continue;
    const pos = headingPosition(text, headings);
    positions[semantic] = pos;
    if (pos < 0) {
      addIssue(issues, "fail", "required_sections", `${semantic} missing; allowed headings: ${headings.join(", ")}`);
    }
  }
  for (const [semantic, rule] of Object.entries(rubric.sections?.optional ?? {})) {
    positions[semantic] = headingPosition(text, rule.allowed_headings ?? []);
  }
  for (const forbidden of rubric.sections?.forbidden_headings ?? []) {
    const re = new RegExp(`\\b${escapeRegex(forbidden)}\\b`, "i");
    if (re.test(text)) addIssue(issues, "fail", "forbidden_headings", `forbidden heading '${forbidden}' found`);
  }
  return positions;
}

export function checkSectionOrder(rubric: Rubric, positions: Record<string, number>, issues: Issue[]): void {
  const ordered = (rubric.section_order ?? []).filter((section) => positions[section] !== undefined && positions[section] >= 0);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (positions[curr] < positions[prev]) {
      addIssue(issues, "warn", "section_order", `${curr} appears before ${prev}`);
    }
  }
}

export function checkContent(content: ResumeContent | null, rubric: Rubric, issues: Issue[]): void {
  if (!content) return;

  const summary = content.summary ?? "";
  checkRange({
    issues,
    rule: "summary_length",
    label: "summary chars",
    value: summary.length,
    min: rubric.summary?.min_chars,
    max: rubric.summary?.max_chars,
  });
  checkRange({
    issues,
    rule: "summary_sentences",
    label: "summary sentences",
    value: sentenceCount(summary),
    max: rubric.summary?.max_sentences,
  });
  if (rubric.summary?.candidate_narrative) checkSummaryCandidateNarrative(summary, issues);

  checkRange({
    issues,
    rule: "highlight_count",
    label: "highlights",
    value: content.highlights?.length ?? 0,
    min: rubric.highlights?.min,
    max: rubric.highlights?.max,
  });

  checkRange({
    issues,
    rule: "skills_block_count",
    label: "skill blocks",
    value: content.skills?.length ?? 0,
    min: rubric.skills?.min_blocks,
    max: rubric.skills?.max_blocks,
  });
  for (const skill of content.skills ?? []) {
    checkRange({
      issues,
      rule: "skills_bullets_per_block",
      label: `skill '${skill.name}' bullets`,
      value: skill.bullets?.length ?? 0,
      min: rubric.skills?.min_bullets_per_block ?? rubric.skills?.bullets_per_block?.min,
      max: rubric.skills?.max_bullets_per_block ?? rubric.skills?.bullets_per_block?.max,
    });
    for (const item of skill.bullets ?? []) {
      if (rubric.skills?.max_chars_per_item && item.length > rubric.skills.max_chars_per_item) {
        addIssue(issues, "warn", "skill_item_length", `skill '${skill.name}' item is ${item.length} chars; max ${rubric.skills.max_chars_per_item}`);
      }
    }
  }
  checkRange({
    issues,
    rule: "additional_skills_summary_length",
    label: "additional skills summary chars",
    value: content.additional_skills_summary?.length ?? 0,
    max: rubric.skills?.additional_summary?.max_chars,
  });

  const featured = allFeatured(content);
  const mentions = content.experiences.filter((xp) => xp.placement === "mention");
  checkRange({
    issues,
    rule: "featured_experience_count",
    label: "featured experiences",
    value: featured.length,
    min: rubric.experience?.min_featured ?? rubric.experiences?.featured?.min,
    max: rubric.experience?.max_featured ?? rubric.experiences?.featured?.max,
  });
  checkRange({
    issues,
    rule: "mentioned_experience_count",
    label: "mentioned experiences",
    value: mentions.length,
    min: rubric.experiences?.mentioned?.min,
    max: rubric.experience?.max_mentions ?? rubric.experiences?.mentioned?.max,
  });

  for (const xp of featured) {
    const count = xp.bullets?.length ?? 0;
    checkRange({
      issues,
      rule: "featured_bullet_count",
      label: `${xp.title} bullets`,
      value: count,
      min: rubric.bullets?.min_per_featured ?? rubric.experiences?.featured?.bullets_per_featured?.min,
      max: rubric.bullets?.max_per_featured ?? rubric.experiences?.featured?.bullets_per_featured?.max,
      severity: count === 0 ? "fail" : "warn",
    });
    for (const bullet of xp.bullets ?? []) {
      if (rubric.bullets?.max_chars && bullet.length > rubric.bullets.max_chars) {
        addIssue(issues, "warn", "bullet_length", `${xp.title} bullet is ${bullet.length} chars; max ${rubric.bullets.max_chars}`);
      }
    }
  }

  const bullets = allBullets(content);
  const quantified = bullets.filter(hasQuantity).length;
  const ratio = bullets.length ? quantified / bullets.length : 0;
  if (rubric.bullets?.min_quantified_ratio !== undefined && ratio < rubric.bullets.min_quantified_ratio) {
    addIssue(issues, "warn", "quantified_bullet_ratio", `${(ratio * 100).toFixed(0)}% quantified; target ${(rubric.bullets.min_quantified_ratio * 100).toFixed(0)}%`);
  }

  const weakStarts = rubric.bullets?.weak_starts ?? [];
  for (const bullet of bullets) {
    const weak = weakStarts.find((prefix) => bullet.toLowerCase().startsWith(prefix.toLowerCase()));
    if (weak) addIssue(issues, "warn", "weak_bullet_starts", `bullet starts with '${weak}': ${bullet.slice(0, 90)}`);
  }
}

function checkSummaryCandidateNarrative(summary: string, issues: Issue[]): void {
  const firstSentence = (summary.match(/^[^.!?]+[.!?]?/)?.[0] ?? summary).trim();
  if (!firstSentence) return;

  const projectLed = /^(built|build|delivered|deliver|founded|found|operate|operated|created|create|launched|launch|implemented|implement|designed|design|architected|led|lead)\b/i.test(firstSentence);
  const hasCandidateIdentity = /\b(architect|engineer|operator|leader|lead|consultant|manager|director|cto|specialist|principal|senior|technologist|developer|founder)\b/i.test(firstSentence);

  if (projectLed) {
    addIssue(issues, "warn", "summary_candidate_narrative", "summary starts with project/action evidence; lead with candidate identity instead");
  } else if (!hasCandidateIdentity) {
    addIssue(issues, "warn", "summary_candidate_narrative", "summary first sentence lacks a clear candidate identity");
  }
}

/**
 * The composed array must already sit in the order a template will print it.
 * Validating against the renderer's own comparator keeps the stored order and
 * the printed date column from ever disagreeing: ongoing roles first, then
 * reverse-chronological by start date, end date only breaking a same-start tie.
 */
export function checkExperienceChronology(content: ResumeContent | null, issues: Issue[]): void {
  if (!content?.experiences?.length) return;
  const outOfOrder: string[] = [];
  for (let index = 1; index < content.experiences.length; index++) {
    const previous = content.experiences[index - 1];
    const current = content.experiences[index];
    if (compareExperienceOrder(previous, current) > 0) {
      outOfOrder.push(`${current.title}, ${current.company} (${current.start}–${current.end}) appears after ${previous.title}, ${previous.company} (${previous.start}–${previous.end})`);
    }
  }
  if (outOfOrder.length) {
    addIssue(issues, "fail", "experience_chronology", `experiences must be reverse chronological by start date, ongoing roles first: ${outOfOrder.slice(0, 4).join("; ")}`);
  }
}

/** Resolve the rubric for a template (plus per-resume / format policy overrides). */
export async function loadRubric(args: {
  template: string;
  rubricPath?: string;
  resumeId?: string | null;
  profileId?: string | null;
  formatId?: string | null;
}): Promise<{ rubric: Rubric; rubricPath: string }> {
  const rubricPath = args.rubricPath ?? path.join("templates/resume", args.template, "rubric.yaml");
  if (!(await exists(rubricPath))) throw new Error(`Missing rubric: ${rubricPath}`);
  const base = await readYaml<Rubric>(rubricPath);
  const rubric = await applyTargetPolicy(base, args.resumeId ?? undefined, {
    profileId: args.profileId ?? null,
    formatId: args.formatId ?? null,
  });
  return { rubric, rubricPath };
}

export type EvaluateInput = {
  rubric: Rubric;
  content: ResumeContent | null;
  /** Concatenated rendered text (docx + md + html-as-text). Empty → section checks skipped with a warn. */
  text: string;
  /** PDF page count, or null when no PDF could be inspected. */
  pages: number | null;
  /** Whether a PDF path was supplied at all (drives the "could not inspect" warn). */
  pdfSupplied: boolean;
  lastPageFill: { fillPct: number; trailingBlankPct: number } | null;
  /** Whether an HTML path was supplied (drives the "could not inspect" warns). */
  htmlSupplied: boolean;
  bulletMetrics: BulletLineFillMetric[] | null;
  lineUnitMetrics: LineUnitMetric[] | null;
  headingOrphans: HeadingOrphanMetric[] | null;
  experienceStartOrphans: ExperienceStartOrphanMetric[] | null;
  strictLineUnits: boolean;
  /** Only used in warn messages. */
  htmlPath?: string;
  pdfPath?: string;
  /** Pre-collected issues (e.g. research-claims) to prepend, preserving historical order. */
  issues?: Issue[];
};

export type EvaluateResult = { verdict: Verdict; issues: Issue[] };

/**
 * Run every rubric check over already-gathered metrics. Issue order matches
 * the historical CLI: research claims → sections → page budget → bullet fill
 * → line units → orphans → content → chronology.
 */
export function evaluateContent(input: EvaluateInput): EvaluateResult {
  const { rubric, content } = input;
  const issues: Issue[] = input.issues ?? [];

  if (input.text) {
    const positions = checkSections(rubric, input.text, issues, content);
    checkSectionOrder(rubric, positions, issues);
  } else {
    addIssue(issues, "warn", "rendered_text", "no docx or markdown supplied; skipped section checks");
  }

  const pages = input.pages;
  if (pages !== null) {
    const preferred = rubric.page_budget?.preferred_max ?? (rubric.page_budget as { preferred?: number } | undefined)?.preferred;
    const targetPages = rubric.page_budget?.target_pages;
    const hard = rubric.page_budget?.hard_max;
    if (hard !== undefined && pages > hard) addIssue(issues, "fail", "page_budget", `${pages} pages exceeds hard max ${hard}`);
    else if (preferred !== undefined && pages > preferred) addIssue(issues, "warn", "page_budget", `${pages} pages exceeds preferred max ${preferred}`);
    if (targetPages !== undefined && pages !== targetPages) {
      addIssue(issues, "warn", "page_target", `${pages} pages differs from target ${targetPages}`);
    }

    const explicitLastPageFill = rubric.page_budget?.last_page_min_fill_pct
      ?? (rubric.page_budget?.last_page_min_fill_ratio !== undefined ? rubric.page_budget.last_page_min_fill_ratio * 100 : undefined);
    const minLastPageFill = explicitLastPageFill ?? DEFAULT_LAST_PAGE_MIN_FILL_PCT;
    if (input.pdfSupplied && pages >= 1 && minLastPageFill !== undefined) {
      const lastPageFillStats = input.lastPageFill;
      if (!lastPageFillStats) {
        addIssue(issues, explicitLastPageFill === undefined ? "warn" : "fail", "last_page_fill", `could not inspect last-page fill for ${input.pdfPath}`);
      } else if (lastPageFillStats.fillPct < minLastPageFill) {
        const severity = rubric.page_budget?.last_page_min_fill_severity ?? (explicitLastPageFill === undefined ? "warn" : "fail");
        addIssue(
          issues,
          severity,
          "last_page_fill",
          `last page fill ${lastPageFillStats.fillPct.toFixed(1)}% below min ${minLastPageFill}% (trailing blank ${lastPageFillStats.trailingBlankPct.toFixed(1)}%)`,
        );
      }
    }
  } else if (input.pdfSupplied) {
    addIssue(issues, "warn", "page_budget", `could not inspect PDF page count: ${input.pdfPath}`);
  }

  const bulletLineFillMetrics = input.bulletMetrics;
  if (input.htmlSupplied && !bulletLineFillMetrics) {
    addIssue(issues, "warn", "bullet_line_fill", `could not inspect rendered bullet line fill: ${input.htmlPath}`);
  } else if (input.htmlSupplied && bulletLineFillMetrics && bulletLineFillMetrics.length === 0) {
    addIssue(issues, "warn", "bullet_line_fill", `no instrumented rendered bullets found in ${input.htmlPath}`);
  }
  checkBulletLineFill(bulletLineFillMetrics, rubric, issues);

  const lineUnitMetrics = input.lineUnitMetrics;
  if (input.htmlSupplied && !lineUnitMetrics) {
    addIssue(issues, "warn", "line_unit_fill", `could not inspect rendered content-unit line fill: ${input.htmlPath}`);
  } else if (input.htmlSupplied && lineUnitMetrics && lineUnitMetrics.length === 0) {
    addIssue(issues, "warn", "line_unit_fill", `no instrumented rendered content units found in ${input.htmlPath}`);
  }
  if (input.strictLineUnits) {
    checkLineUnits(lineUnitMetrics, rubric, issues);
  }

  if (input.htmlSupplied && !input.headingOrphans) {
    addIssue(issues, "warn", "section_heading_orphan", `could not inspect section heading page breaks: ${input.htmlPath}`);
  }
  checkOrphanSectionHeadings(input.headingOrphans, issues);

  if (input.htmlSupplied && !input.experienceStartOrphans) {
    addIssue(issues, "warn", "experience_start_orphan", `could not inspect experience start page breaks: ${input.htmlPath}`);
  }
  checkOrphanExperienceStarts(input.experienceStartOrphans, issues);

  checkContent(content, rubric, issues);
  checkExperienceChronology(content, issues);

  let verdict: Verdict = "pass";
  if (issues.some((issue) => issue.severity === "fail")) verdict = "fail";
  else if (issues.length) verdict = "warn";
  return { verdict, issues };
}

/** The `stats` block the CLI has always printed, built from the same metrics. */
export function evaluateStats(args: {
  issues: Issue[];
  pages: number | null;
  lastPageFill: { fillPct: number; trailingBlankPct: number } | null;
  bulletMetrics: BulletLineFillMetric[] | null;
  lineUnitMetrics: LineUnitMetric[] | null;
  headingOrphans: HeadingOrphanMetric[] | null;
  experienceStartOrphans: ExperienceStartOrphanMetric[] | null;
  showBullets?: boolean;
  showLineUnits?: boolean;
  showHeadingBreaks?: boolean;
}) {
  const { issues, bulletMetrics, lineUnitMetrics, headingOrphans, experienceStartOrphans } = args;
  return {
    pages: args.pages,
    last_page_fill_pct: args.lastPageFill ? Number(args.lastPageFill.fillPct.toFixed(1)) : null,
    last_page_trailing_blank_pct: args.lastPageFill ? Number(args.lastPageFill.trailingBlankPct.toFixed(1)) : null,
    bullet_line_fill: bulletMetrics
      ? {
          count: bulletMetrics.length,
          worst_single_line_fill_pct: minRounded(bulletMetrics.filter((item) => item.lineCount === 1).map((item) => item.lastLineFillPct)),
          worst_wrapped_last_line_fill_pct: minRounded(bulletMetrics.filter((item) => item.lineCount > 1).map((item) => item.lastLineFillPct)),
          bullets: args.showBullets
            ? bulletMetrics.map((item) => ({
                kind: item.kind,
                line_count: item.lineCount,
                line_fill_pct: item.lineFillPct.map((value) => Number(value.toFixed(1))),
                last_line_fill_pct: Number(item.lastLineFillPct.toFixed(1)),
                text: item.text,
              }))
            : undefined,
        }
      : null,
    line_unit_fill: lineUnitMetrics
      ? {
          count: lineUnitMetrics.length,
          worst_single_line_fill_pct: minRounded(lineUnitMetrics.filter((item) => item.lineCount === 1).map((item) => item.lastLineFillPct)),
          worst_wrapped_last_line_fill_pct: minRounded(lineUnitMetrics.filter((item) => item.lineCount > 1).map((item) => item.lastLineFillPct)),
          units: args.showLineUnits
            ? lineUnitMetrics.map((item) => ({
                kind: item.kind,
                char_count: item.charCount,
                line_count: item.lineCount,
                line_fill_pct: item.lineFillPct.map((value) => Number(value.toFixed(1))),
                last_line_fill_pct: Number(item.lastLineFillPct.toFixed(1)),
                text: item.text,
              }))
            : undefined,
        }
      : null,
    section_heading_orphans: headingOrphans
      ? { count: headingOrphans.length, headings: args.showHeadingBreaks ? headingOrphans : undefined }
      : null,
    experience_start_orphans: experienceStartOrphans
      ? { count: experienceStartOrphans.length, starts: args.showHeadingBreaks ? experienceStartOrphans : undefined }
      : null,
    issue_count: issues.length,
    fail_count: issues.filter((issue) => issue.severity === "fail").length,
    warn_count: issues.filter((issue) => issue.severity === "warn").length,
  };
}

/**
 * Per-unit failing view for compact reports: which rendered units breached a
 * line_units / line_fill rule. Re-derives from the same thresholds as
 * checkLineUnits / checkBulletLineFill so it can never disagree with them.
 */
export type FailingUnit = {
  unit_path: string | null;
  kind: string;
  rule: string;
  severity: "warn" | "fail";
  lines: number;
  last_line_fill_pct: number;
  min_fill_pct: number | null;
  max_lines: number | null;
  page: number | null;
  text: string;
};

export function failingLineUnits(metrics: LineUnitMetric[] | null, rubric: Rubric, strictLineUnits: boolean): FailingUnit[] {
  if (!metrics || !rubric.line_units || !strictLineUnits) return [];
  const out: FailingUnit[] = [];
  for (const [kind, rule] of Object.entries(rubric.line_units)) {
    const severity = rule.severity ?? "warn";
    const targetSeverity = rule.target_severity ?? "warn";
    const tolerance = rule.tolerance_pct ?? 0;
    const singleMin = rule.single_line_min_fill_pct !== undefined ? rule.single_line_min_fill_pct - tolerance : undefined;
    const wrappedLastMin = rule.wrapped_last_line_min_fill_pct !== undefined ? rule.wrapped_last_line_min_fill_pct - tolerance : undefined;
    const singleTarget = rule.single_line_target_fill_pct !== undefined ? rule.single_line_target_fill_pct - tolerance : undefined;
    const wrappedLastTarget = rule.wrapped_last_line_target_fill_pct !== undefined ? rule.wrapped_last_line_target_fill_pct - tolerance : undefined;
    for (const metric of metrics.filter((item) => item.kind === kind)) {
      const base = {
        unit_path: metric.unitPath,
        kind,
        lines: metric.lineCount,
        last_line_fill_pct: Number(metric.lastLineFillPct.toFixed(1)),
        page: metric.page ?? null,
        text: metric.text.slice(0, 90),
      };
      if (rule.max_lines !== undefined && metric.lineCount > rule.max_lines) {
        out.push({ ...base, rule: "line_unit_line_count", severity, min_fill_pct: null, max_lines: rule.max_lines });
      }
      if (metric.lineCount === 1 && singleMin !== undefined && metric.lastLineFillPct < singleMin) {
        out.push({ ...base, rule: "line_unit_single_line_fill", severity, min_fill_pct: rule.single_line_min_fill_pct ?? singleMin, max_lines: rule.max_lines ?? null });
      } else if (metric.lineCount === 1 && singleTarget !== undefined && metric.lastLineFillPct < singleTarget) {
        out.push({ ...base, rule: "line_unit_single_line_target", severity: targetSeverity, min_fill_pct: rule.single_line_target_fill_pct ?? singleTarget, max_lines: rule.max_lines ?? null });
      }
      if (metric.lineCount > 1 && wrappedLastMin !== undefined && metric.lastLineFillPct < wrappedLastMin) {
        out.push({ ...base, rule: "line_unit_wrapped_last_line_fill", severity, min_fill_pct: rule.wrapped_last_line_min_fill_pct ?? wrappedLastMin, max_lines: rule.max_lines ?? null });
      } else if (metric.lineCount > 1 && wrappedLastTarget !== undefined && metric.lastLineFillPct < wrappedLastTarget) {
        out.push({ ...base, rule: "line_unit_wrapped_last_line_target", severity: targetSeverity, min_fill_pct: rule.wrapped_last_line_target_fill_pct ?? wrappedLastTarget, max_lines: rule.max_lines ?? null });
      }
    }
  }
  return out;
}
