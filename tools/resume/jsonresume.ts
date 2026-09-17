#!/usr/bin/env tsx
/**
 * jsonresume.ts — JSON Resume (https://jsonresume.org/schema) interchange.
 *
 * Converts between the harness's canonical `ResumeContent`
 * (templates/resume/_interface.ts) and the JSON Resume v1 document shape, so a
 * composition can be handed to any JSON Resume theme / tool, and a JSON Resume
 * document from elsewhere can be pulled back in as a composition.
 *
 * MAPPING DECISIONS
 * -----------------
 * frontmatter.name/email/phone      → basics.name / basics.email / basics.phone
 * frontmatter.location.city         → basics.location.city
 * frontmatter.location.country      → basics.location.countryCode (the harness
 *                                     already stores an ISO-3166-1 alpha-2 code
 *                                     there, e.g. "AU"). basics.location.region
 *                                     is read on import when present but the
 *                                     harness has nowhere to keep it, so it is
 *                                     not round-tripped.
 * frontmatter.linkedin_url/github_url → basics.profiles[] entries with
 *                                     network "LinkedIn" / "GitHub".
 * frontmatter.citizenship           → no JSON Resume home; kept in the meta
 *                                     extension (see below).
 * headline                          → basics.label. JSON Resume's `label` is
 *                                     exactly the "role headline under the
 *                                     name" that `headline` renders as.
 * summary                           → basics.summary, verbatim.
 * highlights                        → `meta["x-my-contracting"].highlights`,
 *                                     NOT prepended to basics.summary.
 *                                     WHY: prepending is a one-way door — on
 *                                     import there is no reliable way to tell
 *                                     where the pasted bullet lines stop and
 *                                     the authored prose summary starts, so
 *                                     round-tripping would corrupt both fields.
 *                                     JSON Resume has no top-level highlights
 *                                     concept, `meta` explicitly allows
 *                                     additional properties, and the cost is
 *                                     narrow: a foreign theme renders the
 *                                     summary without the impact bullets rather
 *                                     than rendering a mangled summary.
 * experiences (feature)             → work[] with summary = the prose summary
 *                                     and highlights = bullets.
 * experiences (mention)             → work[] with summary = one_liner and NO
 *                                     highlights (a compact row has no bullet
 *                                     list). On import, absent/empty highlights
 *                                     is the placement fallback heuristic when
 *                                     the meta extension is missing.
 * experience start/end              → work.startDate / work.endDate, normalised
 *                                     to YYYY-MM. end === "current" exports as
 *                                     an omitted endDate (the JSON Resume
 *                                     convention for an ongoing role) and
 *                                     imports back as "current".
 * experience tier/date_label        → meta extension (no schema home).
 * skills[].name                     → skills[].name
 * skills[].bullets                  → skills[].keywords, comma-splitting each
 *                                     bullet ("A, B, C" → ["A","B","C"]) since
 *                                     the harness writes skill lines as comma
 *                                     lists and JSON Resume keywords are single
 *                                     terms. The per-bullet keyword counts are
 *                                     recorded in the meta extension so the
 *                                     original line grouping is restored exactly
 *                                     on import; without the extension every
 *                                     keyword set collapses to one line.
 * skills[].summary / .role          → meta extension. `level` is left unset:
 *                                     it means proficiency ("Master"), not a
 *                                     summary line, so writing a sentence there
 *                                     would be a schema abuse.
 * credentials[]                     → education[] when the string looks like a
 *                                     qualification (degree / diploma /
 *                                     university wording), else certificates[].
 *                                     A trailing year becomes endDate / date.
 *                                     The verbatim strings are ALSO kept in the
 *                                     meta extension, which is what import
 *                                     prefers; the parsed entries exist for
 *                                     foreign consumers and are the import
 *                                     fallback.
 * additional_skills_summary,
 * dropped_experiences               → meta extension.
 * resumeId                          → meta.resumeId
 * (generator)                       → meta.generator = "my-contracting"
 * bench, source_provenance,
 * market_alignment                  → INTERNAL. Never exported, never populated
 *                                     on import.
 * projects[]                        → not emitted: `ResumeContent` has no
 *                                     project concept distinct from experience,
 *                                     and synthesising one would be lossy in
 *                                     both directions. Present-but-ignored on
 *                                     import.
 *
 * The meta extension (`meta["x-my-contracting"]`) is a FIDELITY SIDECAR, not a
 * requirement: every field in it also has a lossy-but-sane derivation from the
 * standard fields, so a JSON Resume document authored elsewhere still imports.
 * Round-tripping a harness composition through export → import is lossless for
 * every field both sides carry.
 *
 * CLI
 *   tsx tools/resume/jsonresume.ts export --composition <path> [--out <path>]
 *   tsx tools/resume/jsonresume.ts import --json <path> --out <composition.json>
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadComposition, writeComposition } from "./lib/composition-io.ts";
import type {
  ExperienceItem,
  ResumeContent,
  SkillBlock,
} from "../../templates/resume/_interface.ts";

export const EXTENSION_KEY = "x-my-contracting";
export const GENERATOR = "my-contracting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonResumeProfile = { network?: string; username?: string; url?: string };

export type JsonResumeBasics = {
  name?: string;
  label?: string;
  image?: string;
  email?: string;
  phone?: string;
  url?: string;
  summary?: string;
  location?: { address?: string; postalCode?: string; city?: string; countryCode?: string; region?: string };
  profiles?: JsonResumeProfile[];
};

export type JsonResumeWork = {
  name?: string;
  location?: string;
  description?: string;
  position?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
};

export type JsonResumeSkill = { name?: string; level?: string; keywords?: string[] };

export type JsonResumeEducation = {
  institution?: string;
  url?: string;
  area?: string;
  studyType?: string;
  startDate?: string;
  endDate?: string;
  score?: string;
  courses?: string[];
};

export type JsonResumeCertificate = { name?: string; date?: string; url?: string; issuer?: string };

export type JsonResumeProject = {
  name?: string;
  description?: string;
  highlights?: string[];
  keywords?: string[];
  startDate?: string;
  endDate?: string;
  url?: string;
  roles?: string[];
  entity?: string;
  type?: string;
};

/** Harness-private fidelity sidecar carried under `meta["x-my-contracting"]`. */
export type HarnessExtension = {
  version: 1;
  citizenship?: string;
  highlights?: string[];
  additionalSkillsSummary?: string;
  droppedExperiences?: { id: string; reason: string }[];
  /** Parallel to `skills[]`. */
  skills?: { summary?: string; role?: "screener"; keywordGroups?: number[] }[];
  /** Parallel to `work[]`. */
  work?: { placement: "feature" | "mention"; tier?: number; dateLabel?: string; startRaw?: string; endRaw?: string }[];
  /** Verbatim `credentials[]`, in order. */
  credentials?: string[];
};

export type JsonResumeMeta = {
  canonical?: string;
  version?: string;
  lastModified?: string;
  generator?: string;
  resumeId?: string;
  [EXTENSION_KEY]?: HarnessExtension;
} & Record<string, unknown>;

export type JsonResume = {
  $schema?: string;
  basics?: JsonResumeBasics;
  work?: JsonResumeWork[];
  education?: JsonResumeEducation[];
  certificates?: JsonResumeCertificate[];
  skills?: JsonResumeSkill[];
  projects?: JsonResumeProject[];
  meta?: JsonResumeMeta;
} & Record<string, unknown>;

export type ExportOptions = {
  /** meta.canonical — URL of the latest version of this document. */
  canonical?: string;
  /** meta.lastModified (ISO 8601). Pass a fixed value for deterministic output. */
  lastModified?: string;
  /** meta.version (semver-ish string). */
  version?: string;
  /** Emit the harness fidelity sidecar. Default true; false yields a plain,
   *  lossy-on-reimport JSON Resume document. */
  extensions?: boolean;
  /** Value for `$schema`. Default: the published v1 schema URL. */
  schemaUrl?: string;
};

export const SCHEMA_URL = "https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json";

// ---------------------------------------------------------------------------
// Light structural validation (zod — no new dependency)
// ---------------------------------------------------------------------------

/** JSON Resume `iso8601`: YYYY | YYYY-MM | YYYY-MM-DD. */
const ISO8601 = /^([1-2][0-9]{3}-[0-1][0-9]-[0-3][0-9]|[1-2][0-9]{3}-[0-1][0-9]|[1-2][0-9]{3})$/;
const iso8601 = z.string().regex(ISO8601, "must be YYYY, YYYY-MM or YYYY-MM-DD");

const profileSchema = z.object({ network: z.string().optional(), username: z.string().optional(), url: z.string().optional() }).passthrough();

const basicsSchema = z
  .object({
    name: z.string().optional(),
    label: z.string().optional(),
    image: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    url: z.string().optional(),
    summary: z.string().optional(),
    location: z
      .object({
        address: z.string().optional(),
        postalCode: z.string().optional(),
        city: z.string().optional(),
        countryCode: z.string().optional(),
        region: z.string().optional(),
      })
      .passthrough()
      .optional(),
    profiles: z.array(profileSchema).optional(),
  })
  .passthrough();

const workSchema = z
  .object({
    name: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    position: z.string().optional(),
    url: z.string().optional(),
    startDate: iso8601.optional(),
    endDate: iso8601.optional(),
    summary: z.string().optional(),
    highlights: z.array(z.string()).optional(),
  })
  .passthrough();

const educationSchema = z
  .object({
    institution: z.string().optional(),
    url: z.string().optional(),
    area: z.string().optional(),
    studyType: z.string().optional(),
    startDate: iso8601.optional(),
    endDate: iso8601.optional(),
    score: z.string().optional(),
    courses: z.array(z.string()).optional(),
  })
  .passthrough();

const certificateSchema = z
  .object({
    name: z.string().optional(),
    date: iso8601.optional(),
    url: z.string().optional(),
    issuer: z.string().optional(),
  })
  .passthrough();

const skillSchema = z
  .object({ name: z.string().optional(), level: z.string().optional(), keywords: z.array(z.string()).optional() })
  .passthrough();

const projectSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    highlights: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    startDate: iso8601.optional(),
    endDate: iso8601.optional(),
    url: z.string().optional(),
    roles: z.array(z.string()).optional(),
    entity: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const metaSchema = z
  .object({ canonical: z.string().optional(), version: z.string().optional(), lastModified: z.string().optional() })
  .passthrough();

export const jsonResumeSchema = z
  .object({
    $schema: z.string().optional(),
    basics: basicsSchema.optional(),
    work: z.array(workSchema).optional(),
    volunteer: z.array(z.record(z.unknown())).optional(),
    education: z.array(educationSchema).optional(),
    awards: z.array(z.record(z.unknown())).optional(),
    certificates: z.array(certificateSchema).optional(),
    publications: z.array(z.record(z.unknown())).optional(),
    skills: z.array(skillSchema).optional(),
    languages: z.array(z.record(z.unknown())).optional(),
    interests: z.array(z.record(z.unknown())).optional(),
    references: z.array(z.record(z.unknown())).optional(),
    projects: z.array(projectSchema).optional(),
    meta: metaSchema.optional(),
  })
  .passthrough();

export type ValidationResult = { ok: boolean; errors: string[] };

/** Structural check against the JSON Resume v1 shape. Every field is optional
 *  in the published schema, so this catches wrong types and malformed dates. */
export function validateJsonResume(json: unknown): ValidationResult {
  const parsed = jsonResumeSchema.safeParse(json);
  if (parsed.success) return { ok: true, errors: [] };
  const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a harness date to YYYY-MM. Returns undefined for "current",
 *  empty, or anything that is not a recognisable ISO-ish date. */
export function normaliseDate(value: string | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const ym = raw.match(/^([1-2][0-9]{3})-([0-1][0-9])/);
  if (ym) return `${ym[1]}-${ym[2]}`;
  const y = raw.match(/^([1-2][0-9]{3})$/);
  if (y) return y[1];
  return undefined;
}

function splitKeywords(bullet: string): string[] {
  return bullet
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function trimmed(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v ? v : undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
  return obj;
}

const EDUCATION_HINT =
  /\b(bachelor|bachelors|master|masters|mba|ph\.?d|doctorate|doctoral|diploma|degree|b\.?sc|m\.?sc|b\.?eng|m\.?eng|b\.?a\b|m\.?a\b|honours|honors|university|college|graduate certificate|postgraduate)\b/i;

/** Split "<qualification>, <institution>" on the LAST comma / dash separator. */
function splitCredential(text: string): { left?: string; right: string } {
  const match = text.match(/^(.*)(?:,|\s[—–-]\s)\s*([^,—–]+)$/);
  if (!match) return { right: text };
  const left = match[1].replace(/[\s,—–-]+$/, "").trim();
  const right = match[2].trim();
  if (!left || !right) return { right: text };
  return { left, right };
}

/** Peel a trailing standalone year off a credential string. */
function peelYear(text: string): { text: string; year?: string } {
  const match = text.match(/^(.*?)[\s,(–—-]*\b((?:19|20)\d{2})\)?\s*$/);
  if (!match || !match[1].trim()) return { text: text.trim() };
  return { text: match[1].replace(/[\s,(–—-]+$/, "").trim(), year: match[2] };
}

// ---------------------------------------------------------------------------
// Export: ResumeContent → JsonResume
// ---------------------------------------------------------------------------

export function toJsonResume(content: ResumeContent, opts: ExportOptions = {}): JsonResume {
  const withExtensions = opts.extensions !== false;
  const fm = content.frontmatter ?? ({} as ResumeContent["frontmatter"]);

  const profiles: JsonResumeProfile[] = [];
  if (trimmed(fm.linkedin_url)) profiles.push({ network: "LinkedIn", url: fm.linkedin_url!.trim() });
  if (trimmed(fm.github_url)) profiles.push({ network: "GitHub", url: fm.github_url!.trim() });

  const location = compact({
    city: trimmed(fm.location?.city),
    countryCode: trimmed(fm.location?.country),
  });

  const basics: JsonResumeBasics = compact({
    name: trimmed(fm.name),
    label: trimmed(content.headline),
    email: trimmed(fm.email),
    phone: trimmed(fm.phone),
    summary: trimmed(content.summary),
    location: Object.keys(location).length ? location : undefined,
    profiles: profiles.length ? profiles : undefined,
  });

  const work: JsonResumeWork[] = [];
  const workExt: NonNullable<HarnessExtension["work"]> = [];
  for (const exp of content.experiences ?? []) {
    const startDate = normaliseDate(exp.start);
    const endDate = normaliseDate(exp.end);
    const entry: JsonResumeWork = compact({
      name: trimmed(exp.company),
      position: trimmed(exp.title),
      location: trimmed(exp.location),
      startDate,
      endDate,
      summary: exp.placement === "feature" ? trimmed(exp.summary) : trimmed(exp.one_liner),
      highlights: exp.placement === "feature" && exp.bullets?.length ? [...exp.bullets] : undefined,
    });
    work.push(entry);
    workExt.push(
      compact({
        placement: exp.placement,
        tier: exp.tier,
        dateLabel: exp.date_label,
        // Only when the exported date could not carry the original verbatim.
        startRaw: startDate === undefined && (exp.start ?? "") !== "" ? exp.start : undefined,
        endRaw: endDate === undefined && (exp.end ?? "") !== "" ? exp.end : undefined,
      }) as NonNullable<HarnessExtension["work"]>[number],
    );
  }

  const skills: JsonResumeSkill[] = [];
  const skillsExt: NonNullable<HarnessExtension["skills"]> = [];
  for (const block of content.skills ?? []) {
    const groups: number[] = [];
    const keywords: string[] = [];
    for (const bullet of block.bullets ?? []) {
      const parts = splitKeywords(bullet);
      groups.push(parts.length);
      keywords.push(...parts);
    }
    skills.push(compact({ name: trimmed(block.name), keywords: keywords.length ? keywords : undefined }));
    skillsExt.push(compact({ summary: trimmed(block.summary), role: block.role, keywordGroups: groups }));
  }

  const education: JsonResumeEducation[] = [];
  const certificates: JsonResumeCertificate[] = [];
  for (const credential of content.credentials ?? []) {
    const text = (credential ?? "").trim();
    if (!text) continue;
    const { text: body, year } = peelYear(text);
    if (EDUCATION_HINT.test(body)) {
      const { left, right } = splitCredential(body);
      education.push(compact({ institution: right, area: left, endDate: year }));
    } else {
      certificates.push(compact({ name: body, date: year }));
    }
  }

  const extension: HarnessExtension = compact({
    version: 1,
    citizenship: trimmed(fm.citizenship),
    highlights: content.highlights?.length ? [...content.highlights] : undefined,
    additionalSkillsSummary: trimmed(content.additional_skills_summary),
    droppedExperiences: content.dropped_experiences?.length ? [...content.dropped_experiences] : undefined,
    skills: skillsExt.length ? skillsExt : undefined,
    work: workExt.length ? workExt : undefined,
    credentials: content.credentials?.length ? [...content.credentials] : undefined,
  });

  const meta: JsonResumeMeta = compact({
    canonical: opts.canonical,
    version: opts.version,
    lastModified: opts.lastModified,
    generator: GENERATOR,
    resumeId: trimmed(content.resumeId),
    [EXTENSION_KEY]: withExtensions ? extension : undefined,
  });

  return compact({
    $schema: opts.schemaUrl ?? SCHEMA_URL,
    basics,
    work: work.length ? work : undefined,
    education: education.length ? education : undefined,
    certificates: certificates.length ? certificates : undefined,
    skills: skills.length ? skills : undefined,
    meta,
  }) as JsonResume;
}

// ---------------------------------------------------------------------------
// Import: JsonResume → ResumeContent
// ---------------------------------------------------------------------------

function credentialFromEducation(entry: JsonResumeEducation): string {
  const head = [entry.studyType, entry.area].filter(Boolean).join(" ").trim();
  const parts = [head || undefined, trimmed(entry.institution)].filter(Boolean) as string[];
  const year = (entry.endDate ?? "").slice(0, 4);
  const text = parts.join(", ");
  return year ? [text, year].filter(Boolean).join(", ") : text;
}

function credentialFromCertificate(entry: JsonResumeCertificate): string {
  const parts = [trimmed(entry.name), trimmed(entry.issuer)].filter(Boolean) as string[];
  const year = (entry.date ?? "").slice(0, 4);
  const text = parts.join(", ");
  return year ? [text, year].filter(Boolean).join(", ") : text;
}

export function fromJsonResume(json: JsonResume): ResumeContent {
  const basics = json.basics ?? {};
  const meta = json.meta ?? {};
  const ext = (meta[EXTENSION_KEY] ?? undefined) as HarnessExtension | undefined;

  const profileUrl = (network: string): string | undefined =>
    basics.profiles?.find((p) => (p.network ?? "").toLowerCase() === network)?.url?.trim() || undefined;

  const location = compact({
    city: trimmed(basics.location?.city),
    country: trimmed(basics.location?.countryCode),
  });

  const frontmatter: ResumeContent["frontmatter"] = compact({
    name: trimmed(basics.name) ?? "",
    email: trimmed(basics.email) ?? "",
    phone: trimmed(basics.phone) ?? "",
    citizenship: trimmed(ext?.citizenship),
    location: Object.keys(location).length ? location : undefined,
    linkedin_url: profileUrl("linkedin"),
    github_url: profileUrl("github"),
  }) as ResumeContent["frontmatter"];

  const experiences: ExperienceItem[] = (json.work ?? []).map((entry, i) => {
    const hint = ext?.work?.[i];
    const placement = hint?.placement ?? ((entry.highlights?.length ?? 0) > 0 ? "feature" : "mention");
    const base = compact({
      title: trimmed(entry.position) ?? "",
      company: trimmed(entry.name) ?? "",
      location: trimmed(entry.location),
      start: hint?.startRaw ?? normaliseDate(entry.startDate) ?? "",
      end: hint?.endRaw ?? normaliseDate(entry.endDate) ?? "current",
      date_label: hint?.dateLabel,
      tier: hint?.tier,
    });
    if (placement === "mention") {
      return { ...base, placement: "mention", one_liner: entry.summary ?? "" } as ExperienceItem;
    }
    return {
      ...base,
      placement: "feature",
      summary: entry.summary ?? "",
      bullets: entry.highlights ? [...entry.highlights] : [],
    } as ExperienceItem;
  });

  const skills: SkillBlock[] = (json.skills ?? []).map((skill, i) => {
    const hint = ext?.skills?.[i];
    const keywords = skill.keywords ?? [];
    let bullets: string[];
    if (hint?.keywordGroups?.length) {
      bullets = [];
      let cursor = 0;
      for (const count of hint.keywordGroups) {
        bullets.push(keywords.slice(cursor, cursor + count).join(", "));
        cursor += count;
      }
      // Anything beyond the recorded grouping is appended rather than dropped.
      if (cursor < keywords.length) bullets.push(keywords.slice(cursor).join(", "));
    } else {
      bullets = keywords.length ? [keywords.join(", ")] : [];
    }
    return compact({
      name: trimmed(skill.name) ?? "",
      summary: trimmed(hint?.summary),
      bullets,
      role: hint?.role,
    }) as SkillBlock;
  });

  const derivedCredentials = [
    ...(json.education ?? []).map(credentialFromEducation),
    ...(json.certificates ?? []).map(credentialFromCertificate),
  ].filter(Boolean);
  const credentials = ext?.credentials?.length ? [...ext.credentials] : derivedCredentials;

  return compact({
    frontmatter,
    headline: trimmed(basics.label),
    summary: basics.summary ?? "",
    highlights: ext?.highlights ? [...ext.highlights] : [],
    skills,
    additional_skills_summary: trimmed(ext?.additionalSkillsSummary),
    credentials: credentials.length ? credentials : undefined,
    experiences,
    dropped_experiences: ext?.droppedExperiences?.length ? [...ext.droppedExperiences] : undefined,
    resumeId: trimmed(meta.resumeId) ?? "",
  }) as ResumeContent;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

const USAGE = `Usage:
  tsx tools/resume/jsonresume.ts export --composition <path> [--out <path>] [--no-extensions]
  tsx tools/resume/jsonresume.ts import --json <path> --out <composition.json>`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (command === "export") {
    if (!args.composition) {
      console.error(USAGE);
      return 2;
    }
    const { content } = await loadComposition(path.resolve(args.composition));
    const json = toJsonResume(content, {
      canonical: args.canonical,
      lastModified: args["last-modified"],
      version: args.version,
      extensions: args["no-extensions"] !== "true",
    });
    const check = validateJsonResume(json);
    if (!check.ok) {
      console.error("JSON Resume validation failed:");
      for (const err of check.errors) console.error(`  - ${err}`);
      return 1;
    }
    const text = `${JSON.stringify(json, null, 2)}\n`;
    if (args.out) {
      await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
      await fs.writeFile(path.resolve(args.out), text);
      console.log(`Wrote ${args.out} (${json.work?.length ?? 0} work, ${json.skills?.length ?? 0} skills)`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  if (command === "import") {
    if (!args.json || !args.out) {
      console.error(USAGE);
      return 2;
    }
    const raw = await fs.readFile(path.resolve(args.json), "utf8");
    const parsed = JSON.parse(raw) as JsonResume;
    const check = validateJsonResume(parsed);
    if (!check.ok) {
      console.error("Input is not a structurally valid JSON Resume document:");
      for (const err of check.errors) console.error(`  - ${err}`);
      return 1;
    }
    const content = fromJsonResume(parsed);
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    // Provenance is internal and is never reconstructed from interchange.
    await writeComposition(outPath, content, { provenance: null });
    console.log(`Wrote ${args.out} (${content.experiences.length} experiences, ${content.skills.length} skills)`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
