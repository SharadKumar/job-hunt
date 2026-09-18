/**
 * profile.ts — shared utilities for reading state/profile/profile.md frontmatter.
 *
 * One place that knows the profile schema. The CV renderer uses this for the
 * filename prefix; other consumers (sheets-sync, classify-jd) can add as
 * needed. Keeps the YAML parsing in one spot.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import { resolveProfileContext } from "./profile-context.ts";
import { repoPath } from "./repo-root.ts";

export type ProfileFrontmatter = {
  name: string;
  email: string;
  phone?: string;
  citizenship?: string;
  location?: { city?: string; country?: string; timezone?: string };
  locale?: { english_variant?: string; date_format?: string; timezone?: string; language?: string; currency?: string };
  cv_source_dir?: string;
  linkedin_url?: string;
  github_url?: string;
};

const DEFAULT_PROFILE_PATH = repoPath("state/profile/profile.md");

/** Timezone, BCP-47 language tag and currency for everything user-facing. */
export type ResolvedLocale = { timezone: string; language: string; currency: string };

/**
 * Applied when profile.md carries no `locale` block, or an incomplete one.
 * These are the values the harness used before the block existed, so an
 * untouched profile behaves exactly as it did.
 */
export const LOCALE_DEFAULTS: ResolvedLocale = Object.freeze({
  timezone: "Australia/Sydney",
  language: "en-AU",
  currency: "AUD",
});

/**
 * Resolve the locale from already-parsed frontmatter. `locale.timezone` wins,
 * then the long-standing `location.timezone`, then the default; `locale.language`
 * falls back to `locale.english_variant` before the default.
 */
export function resolveLocale(frontmatter?: ProfileFrontmatter | null): ResolvedLocale {
  const locale = frontmatter?.locale;
  return {
    timezone: locale?.timezone || frontmatter?.location?.timezone || LOCALE_DEFAULTS.timezone,
    language: locale?.language || locale?.english_variant || LOCALE_DEFAULTS.language,
    currency: locale?.currency || LOCALE_DEFAULTS.currency,
  };
}

/**
 * Read profile.md and resolve its locale. An unreadable or absent profile is not
 * an error here: the defaults are returned, so a tool that only needs a date
 * format still runs on a fresh clone.
 */
export async function loadLocale(profileId?: string | null): Promise<ResolvedLocale> {
  try {
    return resolveLocale(await loadProfile(profileId));
  } catch {
    return { ...LOCALE_DEFAULTS };
  }
}

/** Read profile.md and parse YAML frontmatter. Throws if the file or frontmatter is malformed. */
export async function loadProfile(profileId?: string | null): Promise<ProfileFrontmatter> {
  const profilePath = profileId || process.env.HARNESS_PROFILE
    ? resolveProfileContext(profileId).profileMdPath
    : DEFAULT_PROFILE_PATH;
  const raw = await fs.readFile(profilePath, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`No YAML frontmatter found in ${profilePath}`);
  const parsed = YAML.parse(m[1]);
  if (!parsed?.name) throw new Error(`profile.md frontmatter missing 'name' field`);
  return parsed as ProfileFrontmatter;
}

/**
 * Slugify a profile name for use in filenames. Lowercase, hyphen-joined,
 * non-alphanumerics stripped. Example: "Jane Citizen" → "jane-citizen".
 *
 * The CV renderer uses this for per-resume output filenames:
 *   resume_{profile-slug}_{resume-id}.{docx|pdf}
 */
export function slugifyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Convenience: load profile and return the filename-safe slug. */
export async function profileSlug(profileId?: string | null): Promise<string> {
  const p = await loadProfile(profileId);
  return slugifyName(p.name);
}
