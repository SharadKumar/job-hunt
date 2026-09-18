/**
 * preserve-core.ts — deterministic "nothing was silently lost or altered" gate.
 *
 * WHY
 * ---
 * Every other gate asks whether the rendered CV is *good* (fits the page, reads
 * well, cites its sources, does not inject JD vocabulary). None of them asks
 * the dumber, load-bearing question: is the composition still a faithful
 * projection of the canonical corpus? A writer that quietly drops a role,
 * shifts a date by a year, renames the candidate, or lifts a paragraph out of a
 * "not for CVs" block produces an artefact every other gate happily passes.
 *
 * This module is mechanical on purpose. It compares three things it can prove:
 *
 *   identity   composition frontmatter vs profile.md frontmatter (exact)
 *   coverage   every `### ` experience heading in cv-source.md is featured,
 *              mentioned, or explicitly dropped WITH a reason; and every
 *              composed experience traces back to such a heading (a role the
 *              .docx→md conversion left in running text instead of a heading
 *              warns, it does not fail — see `attestedInSource`)
 *
 * Matching is deliberately fuzzy in ONE direction only: identifying WHICH
 * heading a composed experience is, not whether it must be accounted for.
 * Compositions abbreviate employers ("NSW Dept. of Edu.", "OBS (a Nintex
 * Workflow company)", "Australian Professional Leagues (APL)"), so headings are
 * matched on start month plus a normalised company/title comparison. A genuine
 * drop — a source heading with no composed counterpart and no
 * `dropped_experiences` entry — still fails.
 *   fidelity   dates unchanged per experience; top-level `## ` sections that
 *              carry content are represented; nothing from a "not for CVs"
 *              block leaks into rendered text
 *
 * It makes no semantic judgement — those are the model's job (see
 * `feedback_intelligent_not_deterministic_checks`).
 *
 * SKIP semantics: the gate only applies to compositions that CLAIM to be
 * derived from the canonical corpus, i.e. ones carrying `source_provenance`,
 * with a readable cv-source and profile frontmatter. Template samples
 * (`templates/resume/<template>/sample/sample-content.json`) carry neither, so the gate
 * reports `skip` rather than failing a fixture against the repo owner's real
 * profile. A production composition that lacks provenance is already a hard
 * fail in `resume-provenance`, so nothing hides behind the skip.
 */

import type { Frontmatter, ResumeContent, ResumeSourceProvenance, ExperienceItem } from "../../../templates/resume/_interface.ts";

export type PreserveVerdict = "pass" | "warn" | "fail" | "skip";
export type PreserveIssue = { rule: string; severity: "warn" | "fail"; detail: string };

export type PreserveInput = {
  content: ResumeContent;
  provenance?: ResumeSourceProvenance | null;
  /** Raw text of `<profile-dir>/cv-source.md`. */
  cvSourceText?: string | null;
  /** Parsed YAML frontmatter of `<profile-dir>/profile.md`. */
  profileFrontmatter?: Partial<Frontmatter> | null;
};

export type PreserveStats = {
  source_experiences: number;
  featured: number;
  mentioned: number;
  dropped_with_reason: number;
  unaccounted: string[];
  unsourced: string[];
  skipped_reason?: string;
};

export type PreserveResult = {
  verdict: PreserveVerdict;
  issues: PreserveIssue[];
  stats: PreserveStats;
};

export type SourceExperience = {
  /** The full `### ` heading text, verbatim. */
  heading: string;
  title: string;
  company: string;
  /** YYYY-MM, or "" when the heading carries no parseable start. */
  start: string;
  /** YYYY-MM or "current". */
  end: string;
  line: number;
};

// ---------------------------------------------------------------------------
// normalisation helpers
// ---------------------------------------------------------------------------

/** Lowercase, strip everything that is not a letter or digit. Punctuation-tolerant comparison. */
function squash(value: string | undefined | null): string {
  return (value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}

/**
 * Word-level abbreviations the corpus and the compositions disagree about.
 * "NSW Dept. of Edu." and "NSW Department of Education" are the same employer.
 */
const ABBREVIATIONS: Record<string, string> = {
  dept: "department", depts: "departments", dep: "department", dpt: "department",
  edu: "education", educ: "education",
  gov: "government", govt: "government",
  uni: "university", univ: "university",
  intl: "international", natl: "national",
  svc: "services", svcs: "services", serv: "services",
  mgmt: "management", mgt: "management",
  assoc: "association", inst: "institute",
  aust: "australia", au: "australia",
  dev: "development", tech: "technology", techs: "technology", technologies: "technology",
  sols: "solutions", consultancy: "consulting",
};

/** Dropped before comparison: articles, prepositions, legal suffixes, corporate filler. */
const NOISE_TOKENS = new Set([
  "of", "the", "and", "a", "an", "for", "at", "in", "on", "to", "by", "with",
  "pty", "ltd", "limited", "inc", "incorporated", "corp", "corporation", "llc", "plc",
  "gmbh", "llp", "co", "company", "companies", "group", "holdings", "trading", "trust",
]);

/**
 * Tokens too common to prove two employers are the same on their own. Two names
 * sharing only "department" or "bank" are not evidence of a match; they still
 * match when the whole normalised string is equal or contained.
 */
const GENERIC_COMPANY_TOKENS = new Set([
  "department", "ministry", "agency", "council", "office", "bureau", "authority", "board",
  "bank", "banking", "insurance", "pharma", "pharmaceutical", "industries", "industry",
  "services", "solutions", "consulting", "consultants", "technology", "systems", "software",
  "digital", "global", "international", "national", "australia", "australian", "partners",
  "university", "college", "school", "institute", "association", "programme", "program",
  "community", "practice", "client", "engagement", "through", "contract", "independent",
]);

/** Role words that appear in nearly every title; they cannot carry a match alone. */
const GENERIC_ROLE_TOKENS = new Set([
  "consultant", "consulting", "architect", "architecture", "manager", "management", "lead",
  "leader", "engineer", "engineering", "director", "principal", "senior", "junior", "head",
  "officer", "specialist", "analyst", "developer", "advisor", "adviser", "chief", "associate",
  "contract", "contractor", "part", "time", "parttime", "interim", "acting", "staff", "member",
]);

/**
 * Lowercase → expand `&` → drop punctuation → expand abbreviations → drop noise.
 * The unit of comparison everywhere below is this token list.
 */
function tokens(value: string | undefined | null): string[] {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => !NOISE_TOKENS.has(w));
}

/** "present" / "current" / empty all mean the same open-ended end date. */
export function normaliseDate(value: string | undefined | null): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw || raw === "present" || raw === "current" || raw === "now" || raw === "ongoing") return "current";
  const m = raw.match(/(\d{4})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  const year = raw.match(/^(\d{4})$/);
  return year ? `${year[1]}-01` : raw;
}

function wordStream(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
}

const SHINGLE = 6;

function shingles(words: string[], size = SHINGLE): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

// ---------------------------------------------------------------------------
// cv-source.md parsing
// ---------------------------------------------------------------------------

/**
 * Parse `### ` experience headings. The corpus writes them as
 *
 *   ### 2021-03 – 2021-08 — Director (Tech Consulting), Ernst & Young
 *   ### Launched 2026-02 · maintained to present — Engineer, Sideline Labs (open …)
 *
 * so: dates are the leading run up to the last long dash, and the remainder is
 * `Title, Company` once a trailing parenthetical is removed (companies carry
 * `(San Francisco, US)`-style tails that would otherwise eat the comma split).
 */
/**
 * Every date form the corpus writes a heading in:
 *
 *   `2021-03 – 2021-08`                          closed range
 *   `2026-09 – present`                          open range
 *   `Launched 2026-02 · maintained to present`   prose, still open
 *   `2001 – 2003`                                bare years
 *   `2020-05`                                    start only → treated as open
 *
 * A heading that states no end is CURRENT, never "ends when it started" — the
 * old reading turned every such heading into a spurious `preserve_dates_changed`.
 */
export function parseHeadingDates(datePart: string): { start: string; end: string } {
  const months = datePart.match(/\d{4}[-/]\d{1,2}\b/g) ?? [];
  const years = datePart.match(/\b(?:19|20)\d{2}(?![-/]\d)/g) ?? [];
  const open = /\b(present|current|ongoing|now|today|to\s+date)\b/i.test(datePart);
  const start = normaliseDate(months[0] ?? years[0] ?? "") || "";
  const explicitEnd = months[1] ?? (months.length ? undefined : years[1]);
  const end = open ? "current" : explicitEnd ? normaliseDate(explicitEnd) : "current";
  return { start: start === "current" ? "" : start, end };
}

export function parseSourceExperiences(cvSourceText: string): SourceExperience[] {
  const out: SourceExperience[] = [];
  const lines = cvSourceText.split(/\r?\n/);
  let privateDepth = 0;
  let inExperienceSection = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (!heading) continue;
    const depth = heading[1].length;
    const text = heading[2];
    // A "not for CVs" subtree describes material that is deliberately excluded;
    // its `###` entries are not experiences the CV must account for.
    if (privateDepth && depth <= privateDepth) privateDepth = 0;
    if (/not\s+for\s+cvs?\b/i.test(text)) { privateDepth = depth; continue; }
    if (privateDepth) continue;
    // `### ` also groups skills ("## Skills" / "### Technology and Design"), so
    // only the experience-bearing `## ` sections contribute experiences.
    if (depth <= 2) inExperienceSection = depth === 2 && EXPERIENCE_SECTION.test(text);
    if (depth !== 3 || !inExperienceSection) continue;

    // The corpus separates the date range from the role with an em dash and
    // writes the range itself with an en dash, but be tolerant: split at the
    // LAST long-dash separator, preferring an em dash when one is present.
    const sep = text.lastIndexOf(" — ") >= 0 ? " — " : text.lastIndexOf(" – ") >= 0 ? " – " : null;
    const at = sep ? text.lastIndexOf(sep) : -1;
    const datePart = at >= 0 ? text.slice(0, at) : "";
    const rolePart = (at >= 0 ? text.slice(at + sep!.length) : text).trim();
    const { start, end } = parseHeadingDates(datePart);

    const withoutTail = rolePart.replace(/\s*\([^()]*\)\s*$/, "").replace(/[,\s]+$/, "");
    const comma = withoutTail.lastIndexOf(",");
    const title = comma > 0 ? withoutTail.slice(0, comma).trim() : withoutTail.trim();
    const company = comma > 0 ? withoutTail.slice(comma + 1).trim() : "";
    out.push({ heading: text, title, company, start, end, line: i + 1 });
  }
  return out;
}

const EXPERIENCE_SECTION = /experience|employment|practice|engagement|roles?\b/i;

type Section = { title: string; body: string; hasContent: boolean };

/** Top-level `## ` sections with the text that follows them (subheadings included). */
export function parseSourceSections(cvSourceText: string): Section[] {
  const lines = cvSourceText.split(/\r?\n/);
  const out: Section[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(?!#)(.*\S)\s*$/);
    if (h2) {
      if (current) out.push(finishSection(current));
      current = { title: h2[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(finishSection(current));
  return out;
}

function finishSection(section: { title: string; body: string[] }): Section {
  const body = section.body.join("\n");
  const hasContent = section.body.some((l) => l.trim().length > 0);
  return { title: section.title, body, hasContent };
}

/** Text under any heading whose title contains "not for CVs", to the next same-or-higher heading. */
export function parsePrivateBlocks(cvSourceText: string): { privateText: string; publicText: string } {
  const lines = cvSourceText.split(/\r?\n/);
  const priv: string[] = [];
  const pub: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) {
      const d = heading[1].length;
      if (depth && d <= depth) depth = 0;
      if (/not\s+for\s+cvs?\b/i.test(heading[2])) { depth = d; priv.push(line); continue; }
    }
    (depth ? priv : pub).push(line);
  }
  return { privateText: priv.join("\n"), publicText: pub.join("\n") };
}

// ---------------------------------------------------------------------------
// composition helpers
// ---------------------------------------------------------------------------

function experienceLabel(exp: ExperienceItem): string {
  return `${exp.title} @ ${exp.company} (${exp.start}–${exp.end})`;
}

/** Every string the composition can render. Bench and provenance are excluded — they are not rendered. */
export function renderedStrings(content: ResumeContent): string[] {
  const out: string[] = [];
  if (content.headline) out.push(content.headline);
  if (content.summary) out.push(content.summary);
  out.push(...(content.highlights ?? []));
  out.push(...(content.credentials ?? []));
  if (content.additional_skills_summary) out.push(content.additional_skills_summary);
  for (const block of content.skills ?? []) {
    out.push(block.name);
    if (block.summary) out.push(block.summary);
    out.push(...(block.bullets ?? []));
  }
  for (const exp of content.experiences ?? []) {
    out.push(exp.title, exp.company);
    if (exp.placement === "feature") { out.push(exp.summary ?? ""); out.push(...(exp.bullets ?? [])); }
    else out.push(exp.one_liner ?? "");
  }
  return out.filter(Boolean);
}

const SECTION_TARGETS: Array<{ match: RegExp; key: string; present: (c: ResumeContent) => boolean }> = [
  { match: /summary|profile\b/i, key: "summary", present: (c) => Boolean(c.summary?.trim()) },
  { match: /highlight|achievement/i, key: "highlights", present: (c) => (c.highlights ?? []).length > 0 },
  { match: /skill|competenc/i, key: "skills", present: (c) => (c.skills ?? []).length > 0 },
  { match: /education|certification|credential|qualification/i, key: "credentials", present: (c) => (c.credentials ?? []).length > 0 },
  { match: /experience|employment|practice/i, key: "experiences", present: (c) => (c.experiences ?? []).length > 0 },
];

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

export function checkPreservation(input: PreserveInput): PreserveResult {
  const { content } = input;
  const cvSourceText = input.cvSourceText ?? "";
  const fm = input.profileFrontmatter ?? null;
  const issues: PreserveIssue[] = [];
  const stats: PreserveStats = { source_experiences: 0, featured: 0, mentioned: 0, dropped_with_reason: 0, unaccounted: [], unsourced: [] };

  const skipped =
    !input.provenance ? "composition carries no source_provenance (template sample or preview render)"
    : !cvSourceText.trim() ? "cv-source.md is empty or unreadable"
    : !fm ? "profile.md frontmatter is unreadable"
    : null;
  if (skipped) {
    stats.skipped_reason = skipped;
    return { verdict: "skip", issues, stats };
  }

  // (a) identity block --------------------------------------------------------
  checkIdentity(content.frontmatter, fm!, issues);

  // parse source -------------------------------------------------------------
  const sourceExperiences = parseSourceExperiences(cvSourceText);
  stats.source_experiences = sourceExperiences.length;
  const composed = content.experiences ?? [];
  stats.featured = composed.filter((e) => e.placement === "feature").length;
  stats.mentioned = composed.filter((e) => e.placement === "mention").length;

  // (b) + (c) + (e) coverage and dates ---------------------------------------
  const matches = matchExperiences(composed, sourceExperiences);
  const matchedSource = new Set<SourceExperience>(matches.values());
  for (const exp of composed) {
    const match = matches.get(exp);
    if (!match) {
      if (attestedInSource(exp, cvSourceText)) {
        issues.push({
          severity: "warn",
          rule: "preserve_experience_heading_missing",
          detail: `composed experience matches no '### ' cv-source heading but its title and start year appear in the corpus body: ${experienceLabel(exp)}`,
        });
        continue;
      }
      stats.unsourced.push(experienceLabel(exp));
      issues.push({
        severity: "fail",
        rule: "preserve_experience_unsourced",
        detail: `composed experience has no matching cv-source block: ${experienceLabel(exp)}`,
      });
      continue;
    }
    // (e) dates must not drift for a matched experience.
    const start = normaliseDate(exp.start);
    const end = normaliseDate(exp.end);
    if (match.start && start !== match.start) {
      issues.push({
        severity: "fail",
        rule: "preserve_dates_changed",
        detail: `${experienceLabel(exp)}: start ${start || "(none)"} differs from cv-source ${match.start} (line ${match.line})`,
      });
    }
    if (match.end && end !== match.end) {
      issues.push({
        severity: "fail",
        rule: "preserve_dates_changed",
        detail: `${experienceLabel(exp)}: end ${end || "(none)"} differs from cv-source ${match.end} (line ${match.line})`,
      });
    }
  }

  const dropped = content.dropped_experiences ?? [];
  for (const source of sourceExperiences) {
    if (matchedSource.has(source)) continue;
    const drop = findDrop(dropped, source);
    if (drop && drop.reason?.trim()) { stats.dropped_with_reason += 1; continue; }
    stats.unaccounted.push(source.heading);
    issues.push({
      severity: "fail",
      rule: drop ? "preserve_dropped_without_reason" : "preserve_experience_unaccounted",
      detail: drop
        ? `cv-source experience dropped without a reason: '${source.heading}' (line ${source.line})`
        : `cv-source experience is neither featured, mentioned, nor in dropped_experiences: '${source.heading}' (line ${source.line})`,
    });
  }

  // (d) section representation (warn) ----------------------------------------
  for (const section of parseSourceSections(cvSourceText)) {
    if (!section.hasContent) continue;
    const target = SECTION_TARGETS.find((t) => t.match.test(section.title));
    if (!target) continue;
    if (!target.present(content)) {
      issues.push({
        severity: "warn",
        rule: "preserve_section_unrepresented",
        detail: `cv-source section '${section.title}' has content but composition '${target.key}' is empty`,
      });
    }
  }

  // (f) private material must never render -----------------------------------
  const { privateText, publicText } = parsePrivateBlocks(cvSourceText);
  if (privateText.trim()) {
    const publicShingles = shingles(wordStream(publicText));
    const rendered = shingles(wordStream(renderedStrings(content).join("\n")));
    const leaked: string[] = [];
    for (const shingle of shingles(wordStream(privateText))) {
      if (publicShingles.has(shingle)) continue; // also said in public material; not a leak
      if (rendered.has(shingle)) leaked.push(shingle);
    }
    for (const shingle of leaked.slice(0, 5)) {
      issues.push({
        severity: "fail",
        rule: "preserve_private_material_rendered",
        detail: `text under a 'not for CVs' heading appears in rendered content: "${shingle}"`,
      });
    }
    if (leaked.length > 5) {
      issues.push({
        severity: "fail",
        rule: "preserve_private_material_rendered",
        detail: `${leaked.length - 5} further 'not for CVs' passages appear in rendered content`,
      });
    }
  }

  const verdict: PreserveVerdict = issues.some((i) => i.severity === "fail") ? "fail" : issues.length ? "warn" : "pass";
  return { verdict, issues, stats };
}

function checkIdentity(composed: Frontmatter | undefined, profile: Partial<Frontmatter>, issues: PreserveIssue[]): void {
  const compare = (field: string, expected: unknown, actual: unknown) => {
    if (expected === undefined || expected === null || expected === "") return;
    const want = String(expected).trim();
    const got = actual === undefined || actual === null ? "" : String(actual).trim();
    if (want !== got) {
      issues.push({
        severity: "fail",
        rule: "preserve_identity_changed",
        detail: `frontmatter.${field} is '${got || "(missing)"}' but profile.md says '${want}'`,
      });
    }
  };
  const c = composed ?? ({} as Frontmatter);
  compare("name", profile.name, c.name);
  compare("email", profile.email, c.email);
  compare("phone", profile.phone, c.phone);
  compare("citizenship", profile.citizenship, c.citizenship);
  compare("location.city", profile.location?.city, c.location?.city);
  compare("location.country", profile.location?.country, c.location?.country);
  compare("linkedin_url", profile.linkedin_url, c.linkedin_url);
}

/** The alternative readings of a company name: whole, without parentheticals, each parenthetical. */
function companyForms(value: string): string[][] {
  const raw = value ?? "";
  const parenthetical = [...raw.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const stripped = raw.replace(/\([^()]*\)/g, " ");
  // "Scentre Group – Owner of Westfields" style tails are a second reading too.
  const beforeDash = raw.split(/\s[–—-]\s/)[0];
  return [stripped, raw, beforeDash, ...parenthetical].map(tokens).filter((t) => t.length > 0);
}

function initials(parts: string[]): string {
  return parts.map((p) => p[0]).join("");
}

function distinctive(list: string[], generic: Set<string>): string[] {
  return list.filter((w) => w.length >= 4 && !generic.has(w));
}

/**
 * Two token readings name the same employer when they are equal, when one
 * normalised string contains the other, when they share at least one
 * distinctive token, or when one side is the other's acronym ("APL" for
 * "Australian Professional Leagues").
 */
function formsMatch(x: string[], y: string[]): boolean {
  if (!x.length || !y.length) return false;
  const jx = x.join("");
  const jy = y.join("");
  if (jx === jy) return true;
  const [short, long] = jx.length <= jy.length ? [jx, jy] : [jy, jx];
  if (short.length >= 4 && long.includes(short)) return true;
  const overlap = distinctive(x, GENERIC_COMPANY_TOKENS).filter((w) => y.includes(w));
  if (overlap.length) return true;
  if (x.length === 1 && x[0].length >= 2 && x[0].length <= 6 && x[0] === initials(y)) return true;
  if (y.length === 1 && y[0].length >= 2 && y[0].length <= 6 && y[0] === initials(x)) return true;
  return false;
}

/** Company match across every reading of both names (abbreviations expanded, suffixes dropped). */
function companyMatches(a: string, b: string): boolean {
  const A = companyForms(a);
  const B = companyForms(b);
  return A.some((x) => B.some((y) => formsMatch(x, y)));
}

function titleSimilar(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.length || !y.length) return false;
  const jx = x.join("");
  const jy = y.join("");
  if (jx === jy) return true;
  const [short, long] = jx.length <= jy.length ? [jx, jy] : [jy, jx];
  if (short.length >= 5 && long.includes(short)) return true;
  // Two shared words, or one when one side is a single word ("Engineer").
  // Never one shared word out of many: "Microsoft 365 Consultant" and
  // "Microsoft MVP for SharePoint Server" are different roles.
  const shared = x.filter((w) => y.includes(w));
  return shared.length >= Math.min(2, x.length, y.length) && distinctive(shared, GENERIC_ROLE_TOKENS).length >= 1;
}

/**
 * Assign each composed experience to at most one cv-source heading.
 *
 * The key is the START DATE (YYYY-MM) plus a fuzzy company match; the fallbacks
 * exist so that a *date* drift is reported as a date change rather than
 * masquerading as an unsourced experience, and so that corpus headings carrying
 * no company at all (awards written as `### <dates> — <title>,`) still match.
 * Tiers run globally — every experience is offered the strongest evidence
 * before any of them falls back — and a source is consumed once matched, so two
 * spells at one employer can never collapse onto the same heading.
 */
function matchExperiences(composed: ExperienceItem[], sources: SourceExperience[]): Map<ExperienceItem, SourceExperience> {
  const out = new Map<ExperienceItem, SourceExperience>();
  const used = new Set<SourceExperience>();
  const startOf = new Map<ExperienceItem, string>(composed.map((e) => [e, normaliseDate(e.start)]));

  const tiers: Array<(exp: ExperienceItem, free: SourceExperience[]) => SourceExperience | undefined> = [
    // 1. the key: same start month AND the same employer.
    (exp, free) => free.find((s) => s.start && s.start === startOf.get(exp) && companyMatches(s.company, exp.company)),
    // 2. same start month AND the same role (company renamed, or absent in the corpus heading).
    (exp, free) => free.find((s) => s.start && s.start === startOf.get(exp) && titleSimilar(s.title, exp.title)),
    // 3. same employer AND the same role — the dates then get reported as drifted.
    (exp, free) => free.find((s) => companyMatches(s.company, exp.company) && titleSimilar(s.title, exp.title)),
    // 4. unambiguous single candidate on either key alone.
    (exp, free) => onlyOne(free.filter((s) => s.start && s.start === startOf.get(exp))),
    (exp, free) => onlyOne(free.filter((s) => companyMatches(s.company, exp.company))),
  ];

  for (const tier of tiers) {
    for (const exp of composed) {
      if (out.has(exp)) continue;
      const hit = tier(exp, sources.filter((s) => !used.has(s)));
      if (hit) { out.set(exp, hit); used.add(hit); }
    }
  }
  return out;
}

function onlyOne<T>(list: T[]): T | undefined {
  return list.length === 1 ? list[0] : undefined;
}

/**
 * A composed experience with no matching heading may still be attested in the
 * corpus body — the .docx→markdown conversion mangles some roles into running
 * text instead of a `### ` heading. Requiring the title AND the start year to
 * appear verbatim keeps this from excusing an invented role.
 */
function attestedInSource(exp: ExperienceItem, cvSourceText: string): boolean {
  const body = squash(cvSourceText);
  const title = squash(exp.title);
  if (title.length < 6 || !body.includes(title)) return false;
  const year = normaliseDate(exp.start).slice(0, 4);
  return /^\d{4}$/.test(year) && cvSourceText.includes(year);
}

/**
 * `dropped_experiences[].id` is free-form (`title|company|start|end`, a heading,
 * a slug like `microsoft-mvp`). Score every entry against the source heading and
 * take the best; generic role words ("consultant", "architect") and generic
 * employer words ("department", "bank") score nothing, so
 * `microsoft-365-consultant-abbvie` cannot excuse dropping the Microsoft MVP row.
 */
function dropScore(id: string | undefined, source: SourceExperience): number {
  if (!id?.trim()) return 0;
  const key = tokens(id);
  if (!key.length) return 0;
  let score = 0;
  if (source.company && companyMatches(id, source.company)) score += 2;
  if (titleSimilar(id, source.title)) score += 2;
  const sourceTokens = [...tokens(source.title), ...tokens(source.company)];
  score += distinctive(key.filter((w) => sourceTokens.includes(w)), GENERIC_ROLE_TOKENS)
    .filter((w) => !GENERIC_COMPANY_TOKENS.has(w)).length;
  for (const date of [source.start, source.end]) {
    const year = date?.slice(0, 4);
    if (year && /^\d{4}$/.test(year) && key.includes(year)) score += 1;
  }
  return score;
}

const DROP_MATCH_THRESHOLD = 2;

function findDrop(dropped: { id: string; reason: string }[], source: SourceExperience): { id: string; reason: string } | null {
  let best: { id: string; reason: string } | null = null;
  let bestScore = 0;
  for (const drop of dropped) {
    const score = dropScore(drop.id, source);
    if (score > bestScore) { best = drop; bestScore = score; }
  }
  return bestScore >= DROP_MATCH_THRESHOLD ? best : null;
}
