/**
 * resumes.ts — shared utilities for consuming state/profile/resumes.yaml.
 *
 * One place that knows the schema. Channel scrapers, the resume renderer,
 * the application drafter, and resume-writer all read resumes through
 * these helpers — the file format can evolve without each consumer
 * needing changes.
 *
 * Vocabulary: a "resume" in this harness is one entry in resumes.yaml —
 * a marketed positioning (e.g. solution-architect, fractional-cto) with
 * its own search keywords, cover-letter angle, rate band, and rendered
 * output baseline. The user's master CV (state/profile/cv-source.md) is
 * the SOURCE; resumes are the per-resume compositions the harness hunts
 * with and ships.
 */

import { readYamlIfExists } from "./lib/fs.ts";
import { resolveProfileContext } from "./profile-context.ts";
import { repoPath } from "./repo-root.ts";
import { loadProfile } from "./profile.ts";
import { defaultTeamResumeFormatId, getResumeFormat, type ResumeFormat } from "./resume-formats.ts";

export type RateBand = {
  floor: number;
  target: number;
  ceiling: number;
  currency: string;
  billing_unit: "day" | "hour" | "annum";
  gst_handling: string;
};

export type Resume = {
  id: string;
  label: string;
  display_headline?: string;
  active: boolean;
  resume_format?: string | null;  // optional org-level audience/purpose/section policy axis for team mode
  format_id?: string | null;
  format_label?: string | null;
  format_audience?: string | null;
  format_purpose?: string | null;
  template?: string;            // name of a template in templates/resume/<name>/; defaults to "classic"
  render_policy?: {
    show_contact_line?: boolean;
    show_experience_dates?: boolean;
  };
  page_policy?: {
    target_pages?: number;
    preferred?: number;
    preferred_max?: number;
    hard_max?: number;
    last_page_min_fill_pct?: number;
    last_page_min_fill_ratio?: number;
    last_page_min_fill_severity?: "warn" | "fail";
  };
  content_policy?: {
    summary?: { max_lines?: number; max_words?: number; max_sentences?: number };
    highlights?: { min?: number; max?: number };
    skills?: {
      min_blocks?: number;
      max_blocks?: number;
      bullets_per_block?: { min?: number; max?: number };
    };
    experiences?: {
      featured?: { min?: number; max?: number; bullets_per_featured?: { min?: number; max?: number } };
      /**
       * `keep_all: true` — full career breadth is mandatory on this
       * positioning, so the fit ladder may never bench a mention to buy back a
       * line. Compress, do not drop.
       */
      mentioned?: { min?: number; max?: number; keep_all?: boolean };
    };
    experience?: { min_featured?: number; max_featured?: number; max_mentions?: number };
    line_units?: Record<string, {
      single_line_min_fill_pct?: number;
      single_line_target_fill_pct?: number;
      wrapped_last_line_min_fill_pct?: number;
      wrapped_last_line_target_fill_pct?: number;
      tolerance_pct?: number;
      max_lines?: number;
      severity?: "warn" | "fail";
      target_severity?: "warn" | "fail";
      desired_chars?: string;
    }>;
  };
  search_keywords: string[];
  should: string[];
  could: string[];
  flagged: string[];
  cover_letter_angle: string;
  evidence_strategy?: {
    employer_signal_lens?: string[];
    magnify?: Array<{ experience?: string; evidence?: string; reason?: string; guidance?: string }>;
    support?: Array<{ experience?: string; evidence?: string; reason?: string; guidance?: string }>;
    de_emphasize?: Array<{ experience?: string; evidence?: string; reason?: string; guidance?: string }>;
  };
  rate_band: RateBand;
  preferred_channels: string[];
  notes?: string;
  market_lens?: MarketLens;
};

export const DEFAULT_TEMPLATE = "classic";

export type MarketLens = {
  research_queries?: string[];
  market_sources?: Array<{
    title?: string;
    url?: string;
    note?: string;
  }>;
  capability_map?: Array<{
    signal: string;
    category?: string;
    market_relevance?: "high" | "medium" | "low";
    cv_evidence_proximity?: "explicit" | "implicit" | "weak" | "absent";
    resume_value?: "differentiating" | "expected" | "filler";
    claim_risk?: "low" | "medium" | "high";
  }>;
  must_signal?: string[];
  keyword_aliases?: Record<string, {
    acceptable_if_source_mentions?: string[];
    requires_explicit_source?: boolean;
    guidance?: string;
  }>;
  proof_questions?: string[];
  forbidden_claims?: string[];
  /**
   * Shared keyword clouds this positioning is written against, with a weight
   * (1-5) saying how central each one is. Ids resolve against
   * `state/org/keyword-clouds.yaml` (see tools/keyword-clouds.ts).
   */
  clouds?: Array<{ id: string; weight: number; must_have_min?: number }>;
  /**
   * DEPRECATED (one release): the flat per-type keyword cloud, replaced by
   * `clouds`. Readers still accept it and warn; writers must not add it.
   */
  domain_lexicon?: DomainLexicon;
};

export type DomainLexiconTerm = {
  term: string;
  aliases?: string[];
  category?: "tool" | "platform" | "methodology" | "certification" | "title" | "domain" | "concept";
  /** corpus = evidenced in cv-source; preppable = familiarity only; confirm = ask the user; forbidden = never render */
  tier?: "corpus" | "preppable" | "confirm" | "forbidden";
  why?: string;
  evidence_patterns?: string[];
  jd_frequency?: number;
  source?: string;
};

export type DomainLexicon = {
  refreshed_at?: string;
  source_summary?: string;
  terms?: DomainLexiconTerm[];
};

type ResumeFile = { resumes?: Partial<Resume>[] };
type OrgResumeTypesFile = { resume_types?: Resume[]; resumes?: Resume[] };

export type ResumeLoadOptions = {
  profileId?: string | null;
  profileResumesPath?: string;
  orgResumeTypesPath?: string;
};

export type ResolvedResume = {
  resume: Resume;
  source: "profile" | "org" | "merged";
  profileResumesPath: string;
  orgResumeTypesPath: string | null;
};

const DEFAULT_RESUMES_PATH = repoPath("state/profile/resumes.yaml");
const DEFAULT_ORG_RESUME_TYPES_PATH = repoPath("state/org/resume-types.yaml");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeResume(base: Resume, override: Partial<Resume>): Resume {
  const out: Record<string, unknown> = { ...base, ...override };
  for (const key of ["evidence_strategy", "market_lens", "page_policy", "content_policy", "render_policy"]) {
    const baseValue = (base as any)[key];
    const overrideValue = (override as any)[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      out[key] = { ...baseValue, ...overrideValue };
    }
  }
  return out as Resume;
}

function applyResumeFormat(resume: Resume, format: ResumeFormat | null): Resume {
  if (!format) return resume;
  const formatted = mergeResume(resume, {
    template: format.template ?? resume.template,
    render_policy: format.render_policy,
    page_policy: format.page_policy,
    content_policy: format.content_policy,
    notes: [resume.notes, format.notes].filter(Boolean).join("\n\n") || resume.notes,
  });
  return {
    ...formatted,
    format_id: format.id,
    format_label: format.label,
    format_audience: format.audience ?? null,
    format_purpose: format.purpose ?? null,
  };
}

function isCompleteResume(entry: Partial<Resume>): entry is Resume {
  return Boolean(
    entry.id
    && entry.label
    && entry.search_keywords
    && entry.should
    && entry.could
    && entry.flagged
    && entry.cover_letter_angle
    && entry.rate_band
    && entry.preferred_channels,
  );
}

function resolveResumePaths(options: ResumeLoadOptions): { profileResumesPath: string; orgResumeTypesPath: string } {
  const context = resolveProfileContext(options.profileId);
  return {
    profileResumesPath: options.profileResumesPath ?? (
      options.profileId || process.env.HARNESS_PROFILE ? context.resumesPath : DEFAULT_RESUMES_PATH
    ),
    orgResumeTypesPath: options.orgResumeTypesPath ?? DEFAULT_ORG_RESUME_TYPES_PATH,
  };
}

export async function loadResolvedResumes(options: ResumeLoadOptions = {}): Promise<ResolvedResume[]> {
  const { profileResumesPath, orgResumeTypesPath } = resolveResumePaths(options);
  const profileFile = await readYamlIfExists<ResumeFile>(profileResumesPath);
  const profileEntries = profileFile?.resumes ?? [];
  const orgFile = await readYamlIfExists<OrgResumeTypesFile>(orgResumeTypesPath);
  const orgTypes = orgFile ? (orgFile.resume_types ?? orgFile.resumes ?? []) : [];
  const isTeamProfile = Boolean(options.profileId);
  const teamDefaultFormatId = isTeamProfile ? await defaultTeamResumeFormatId() : null;

  const applyTeamFormat = async (resume: Resume): Promise<Resume> => {
    if (!isTeamProfile) return resume;
    const formatId = resume.resume_format === null ? null : (resume.resume_format ?? teamDefaultFormatId);
    return applyResumeFormat(resume, await getResumeFormat(formatId));
  };

  if (!orgTypes.length) {
    return Promise.all(profileEntries.map(async (entry) => {
      if (!isCompleteResume(entry)) throw new Error(`Profile resume entry '${entry.id ?? "(missing id)"}' in ${profileResumesPath} is incomplete and no org resume type pool is available.`);
      return { resume: await applyTeamFormat(entry), source: "profile", profileResumesPath, orgResumeTypesPath: null };
    }));
  }

  const orgById = new Map(orgTypes.map((resume) => [resume.id, resume]));
  return Promise.all(profileEntries.map(async (entry) => {
    if (!entry.id) throw new Error(`Profile resume entry in ${profileResumesPath} is missing 'id'.`);
    const base = orgById.get(entry.id);
    if (!base && isCompleteResume(entry)) return { resume: await applyTeamFormat(entry), source: "profile", profileResumesPath, orgResumeTypesPath };
    if (!base) throw new Error(`Profile resume assignment '${entry.id}' is not defined in ${orgResumeTypesPath}. Add it to the central resume type pool, or make the profile entry a complete individual resume definition.`);
    const merged = mergeResume(base, entry);
    return { resume: await applyTeamFormat(merged), source: Object.keys(entry).length === 1 ? "org" : "merged", profileResumesPath, orgResumeTypesPath };
  }));
}

export async function loadResumes(options: ResumeLoadOptions = {}): Promise<Resume[]> {
  return (await loadResolvedResumes(options)).map((entry) => entry.resume);
}

export async function activeResumes(options: ResumeLoadOptions = {}): Promise<Resume[]> {
  const all = await loadResumes(options);
  return all.filter((r) => r.active !== false);
}

export async function getResume(id: string, options: ResumeLoadOptions = {}): Promise<Resume | null> {
  const all = await loadResumes(options);
  return all.find((r) => r.id === id) ?? null;
}

/**
 * Normalise a string into a filename segment: preserve existing (Title) casing,
 * collapse any run of non-alphanumeric characters to a single hyphen, and trim
 * leading/trailing hyphens. Casing is preserved deliberately so intentional caps
 * survive (e.g. "ServiceNow Architect" -> "ServiceNow-Architect", not "Servicenow-...").
 */
export function fileSegment(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Canonical artefact filename prefix for a rendered resume:
 *   `{Profile-Name}_{Resume-Label}`  e.g. `Jane-Citizen_Solution-Architect`
 * Title-cased, hyphen-joined words within each segment, "_" between the person
 * and the resume type, and no "resume" prefix. Falls back to the resume id when
 * the label can't be resolved. This is the SINGLE source of the convention —
 * the renderer and any migration tooling both call it.
 */
export async function resumeArtefactPrefix(resumeId: string, options: ResumeLoadOptions = {}): Promise<string> {
  const profile = await loadProfile(options.profileId);
  const resume = await getResume(resumeId, options);
  const label = resume?.label?.trim() || resumeId;
  return `${fileSegment(profile.name)}_${fileSegment(label)}`;
}

/**
 * Union of search_keywords across active resumes that include this channel
 * in their preferred_channels (or have preferred_channels: [] meaning all).
 * Deduplicated, preserving first-seen order so the most-relevant resume's
 * keywords surface first.
 */
export async function keywordsForChannel(channelId: string, options: ResumeLoadOptions = {}): Promise<string[]> {
  const resumes = await activeResumes(options);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of resumes) {
    const usesThisChannel = !r.preferred_channels?.length || r.preferred_channels.includes(channelId);
    if (!usesThisChannel) continue;
    for (const kw of r.search_keywords ?? []) {
      const key = kw.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(kw);
      }
    }
  }
  return out;
}

/**
 * For a JD's matched_resume_id, fetch what it should match against.
 * Used by the /apply draft orchestration to pick the resume + cover-letter angle.
 */
export async function describeMatchedResume(matchedId: string | null, options: ResumeLoadOptions = {}): Promise<{ resume: Resume | null }> {
  if (!matchedId) return { resume: null };
  return { resume: await getResume(matchedId, options) };
}

/** Convenience: dump active-resume ids so verbose logs / Sheet headers can show them. */
export async function activeResumeIds(options: ResumeLoadOptions = {}): Promise<string[]> {
  return (await activeResumes(options)).map((r) => r.id);
}
