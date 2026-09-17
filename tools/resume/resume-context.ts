#!/usr/bin/env tsx
/**
 * resume-context.ts — one compact JSON brief for resume-writer.
 *
 *   npm run resume:context -- --resume <id> [--profile <id>] [--template <name>] [--format <id>]
 *                                [--full-rules] [--pretty] [--out <path>]
 *
 * Merges everything the writer previously read from six files (resumes.yaml,
 * resume-types.yaml, resume-formats, template rubric, editorial rules, voice
 * bans, market confirmations, declared quality-check ids, baseline metadata)
 * into a 4-6 KB brief. Editorial rules are truncated per bullet unless
 * --full-rules is passed; the brief always carries the file paths so the
 * writer can read the source when a rule needs its full context.
 *
 * Read-only. Never hardcodes personal detail: everything comes from state/.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DEFAULT_TEMPLATE, getResume, type Resume } from "../resumes.ts";
import { LEXICON_STALE_DAYS, lexiconAgeDays } from "../resume-types.ts";
import {
  CLOUD_STALE_DAYS,
  loadKeywordClouds,
  resolveCloudsForType,
  type KeywordCloudsFile,
} from "../keyword-clouds.ts";
import { getResumeFormat } from "../resume-formats.ts";
import { loadTemplateMeta } from "../cv-templates.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoPath } from "../repo-root.ts";
import { parseEditorialBans } from "./lib/editorial-bans.ts";

export const UNIVERSAL_CHECKS_PATH = ".claude/skills/resume-render/references/quality-checks.md";
const RULE_TRUNCATE_CHARS = 240;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return args;
}

async function readIfExists(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

/**
 * Scan `### <id>` headings in a quality-checks file, bucketed by the
 * enclosing `## ` section. Mirrors enforce-quality-report.md: a heading
 * under a section whose title contains "visual" is a visual check; a
 * heading under "Skipped" is a skip; everything else is structural.
 */
export function parseCheckIds(markdown: string): { structural: string[]; visual: string[]; skipped: string[] } {
  const out = { structural: [] as string[], visual: [] as string[], skipped: [] as string[] };
  let bucket: keyof typeof out = "structural";
  for (const line of markdown.split("\n")) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      const title = h2[1].toLowerCase();
      bucket = title.includes("skip") ? "skipped" : title.includes("visual") ? "visual" : "structural";
      continue;
    }
    const h3 = line.match(/^###\s+([a-z0-9_]+)\s*$/i);
    if (h3) out[bucket].push(h3[1]);
  }
  return out;
}

/** Parse an editorial-rules markdown file into dated rule entries. */
export function parseEditorialRules(markdown: string, opts: { truncate?: number } = {}): Array<{ date: string; title: string; rules: string[] }> {
  const entries: Array<{ date: string; title: string; rules: string[] }> = [];
  let current: { date: string; title: string; rules: string[] } | null = null;
  for (const raw of markdown.split("\n")) {
    const h2 = raw.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*[-—–]\s*(.+)$/);
    if (h2) {
      current = { date: h2[1], title: h2[2].trim(), rules: [] };
      entries.push(current);
      continue;
    }
    const bullet = raw.match(/^\s*-\s+(.+)$/);
    if (bullet && current) {
      let text = bullet[1].replace(/\*\*/g, "").trim();
      if (opts.truncate && text.length > opts.truncate) text = `${text.slice(0, opts.truncate - 1).trimEnd()}…`;
      current.rules.push(text);
    }
  }
  return entries;
}

function compactLineUnits(rubric: any, resume: Resume): Record<string, Record<string, unknown>> {
  const merged: Record<string, any> = {};
  const sources = [rubric?.line_units ?? {}, resume.content_policy?.line_units ?? {}];
  for (const src of sources) {
    for (const [kind, spec] of Object.entries(src as Record<string, any>)) {
      merged[kind] = { ...(merged[kind] ?? {}), ...(spec ?? {}) };
    }
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [kind, spec] of Object.entries(merged)) {
    out[kind] = {
      desired_chars: spec.desired_chars,
      max_lines: spec.max_lines,
      single_line_min_fill_pct: spec.single_line_min_fill_pct,
      wrapped_last_line_min_fill_pct: spec.wrapped_last_line_min_fill_pct,
      severity: spec.severity,
    };
    for (const k of Object.keys(out[kind])) if (out[kind][k] === undefined) delete out[kind][k];
  }
  return out;
}

function compactCaps(rubric: any, resume: Resume): Record<string, unknown> {
  const cp = resume.content_policy ?? {};
  return {
    summary_chars: { min: rubric?.summary?.min_chars, max: rubric?.summary?.max_chars },
    summary_policy: cp.summary,
    highlights: { min: cp.highlights?.min ?? rubric?.highlights?.min, max: cp.highlights?.max ?? rubric?.highlights?.max },
    skills: {
      min_blocks: cp.skills?.min_blocks ?? rubric?.skills?.min_blocks,
      max_blocks: cp.skills?.max_blocks ?? rubric?.skills?.max_blocks,
      bullets_per_block: cp.skills?.bullets_per_block ?? rubric?.skills?.bullets_per_block,
    },
    featured: {
      min: cp.experiences?.featured?.min ?? rubric?.experiences?.featured?.min,
      max: cp.experiences?.featured?.max ?? rubric?.experiences?.featured?.max,
      bullets_per_featured: cp.experiences?.featured?.bullets_per_featured ?? rubric?.experiences?.featured?.bullets_per_featured,
    },
    mentioned: {
      min: cp.experiences?.mentioned?.min ?? rubric?.experiences?.mentioned?.min,
      max: cp.experiences?.mentioned?.max ?? rubric?.experiences?.mentioned?.max,
    },
    bullet_max_chars: rubric?.bullets?.max_chars,
    weak_starts: rubric?.bullets?.weak_starts,
    coverage: (cp as any).coverage,
  };
}

function compactMarketLens(lens: any, cloudsFile: KeywordCloudsFile): Record<string, unknown> | null {
  if (!lens) return null;
  const aliases: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries((lens.keyword_aliases ?? {}) as Record<string, any>)) {
    aliases[k] = v?.requires_explicit_source ? "requires_explicit_source" : (v?.guidance ?? undefined);
  }
  const byTier = (terms: any[]) => terms.reduce((acc: Record<string, string[]>, t: any) => {
    (acc[t.tier ?? "unknown"] ??= []).push(t.term);
    return acc;
  }, {});
  const lexicon = lens.domain_lexicon;
  return {
    must_signal: lens.must_signal ?? [],
    keyword_aliases: aliases,
    proof_questions: lens.proof_questions ?? [],
    forbidden_claims: lens.forbidden_claims ?? [],
    clouds: resolveCloudsForType(lens, cloudsFile).map((c) => ({
      id: c.id, kind: c.kind, label: c.label, weight: c.weight, must_have_min: c.must_have_min,
      refreshed_at: c.refreshed_at, term_count: c.terms.length, by_tier: byTier(c.terms),
    })),
    // DEPRECATED (one release): the flat per-type block, superseded by `clouds`.
    domain_lexicon: lexicon
      ? { refreshed_at: lexicon.refreshed_at, term_count: lexicon.terms?.length ?? 0, by_tier: byTier(lexicon.terms ?? []) }
      : null,
  };
}

function compactEvidenceStrategy(es: any): Record<string, unknown> | null {
  if (!es) return null;
  const pick = (list: any[] | undefined) => (list ?? []).map((e) => ({ experience: e.experience, guidance: e.guidance ?? e.reason }));
  return {
    employer_signal_lens: es.employer_signal_lens,
    magnify: pick(es.magnify),
    support: pick(es.support),
    de_emphasize: pick(es.de_emphasize),
  };
}

async function loadConfirmations(file: string, resumeId: string): Promise<Record<string, Array<Record<string, unknown>>>> {
  const raw = await readIfExists(file);
  const out: Record<string, Array<Record<string, unknown>>> = { confirmed: [], declined: [], pending: [] };
  if (!raw) return out;
  const parsed = YAML.parse(raw) ?? {};
  const rows: any[] = Array.isArray(parsed) ? parsed : (parsed.confirmations ?? []);
  for (const row of rows) {
    if (row.resume_id && row.resume_id !== resumeId) continue;
    const entry: Record<string, unknown> = { signal: row.signal ?? row.term, kind: row.kind ?? "market_signal" };
    if (row.source_update_required) entry.source_update_required = true;
    if (row.status === "confirmed") out.confirmed.push(entry);
    else if (row.status === "declined" || row.status === "not_applicable") out.declined.push({ ...entry, status: row.status });
    else out.pending.push({ ...entry, question: row.question });
  }
  return out;
}

function voiceSummary(frameworkRules: string | null, profileRules: string | null, banlist: string | null): Record<string, unknown> {
  const bands = frameworkRules?.match(/CV bullets?[^\n]*/i)?.[0]?.trim();
  const forbidden: string[] = [];
  if (banlist) {
    const section = banlist.split(/^## Forbidden phrases[^\n]*$/m)[1] ?? "";
    for (const line of section.split("\n")) {
      const m = line.match(/^\s*-\s+"?([^"\n]+?)"?\s*$/);
      if (m) forbidden.push(m[1]);
    }
  }
  const profileHeadings = profileRules
    ? [...profileRules.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
    : [];
  return {
    cv_bullet_band: bands ?? null,
    profile_rules: profileHeadings,
    forbidden_phrases: forbidden,
    banlist_categories: banlist ? [...banlist.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].replace(/\s*\(.*\)$/, "").trim()) : [],
  };
}

/** One referenced cloud, as the brief and the audit gate report it. */
export type CloudStatusEntry = {
  id: string;
  kind: string;
  label: string;
  weight: number;
  /** the cloud id resolves in state/org/keyword-clouds.yaml */
  present: boolean;
  refreshed_at: string | null;
  age_days: number | null;
  stale: boolean;
  term_count: number;
};

export type CloudsStatus = {
  /** The positioning references at least one keyword cloud. */
  present: boolean;
  /** No clouds at all — the market-narrative-first flow has not been run. */
  missing: boolean;
  /**
   * Researched too long ago to trust. Only clouds the positioning actually
   * leans on (weight >= 4) make it stale: a weight-1 aside may drift without
   * blocking a render. A cloud with no (or an unparseable) `refreshed_at` is
   * stale too: unknown freshness is not freshness.
   */
  stale: boolean;
  stale_after_days: number;
  /** total terms across every referenced cloud */
  term_count: number;
  /** oldest referenced cloud, in whole days; null when none is dated */
  age_days: number | null;
  clouds: CloudStatusEntry[];
  /** ids referenced by the type that do not exist in the clouds file */
  unknown_cloud_ids: string[];
};

/** A cloud at or above this weight must be current for the positioning to render. */
export const CLOUD_LOAD_BEARING_WEIGHT = 4;

/**
 * Keyword-cloud freshness for one positioning. Market narrative comes first:
 * every positioning is written against current keyword clouds, researched from
 * the title outward, before anything is rendered against it. Callers (the
 * brief, the audit gate, the render/review/apply skills) all read this one
 * function so "current" means the same thing everywhere.
 *
 * Deliberately synchronous: the caller owns loading the shared clouds file.
 */
export function cloudsStatus(
  resume: Resume | null | undefined,
  file: KeywordCloudsFile,
  now = new Date(),
): CloudsStatus {
  const lens = resume?.market_lens;
  const refs = Array.isArray((lens as any)?.clouds) ? ((lens as any).clouds as Array<{ id: string; weight: number }>) : [];
  const resolved = resolveCloudsForType(lens, file, now);
  const known = new Set(resolved.map((c) => c.id));
  const clouds: CloudStatusEntry[] = resolved.map((c) => ({
    id: c.id, kind: c.kind, label: c.label, weight: c.weight, present: true,
    refreshed_at: c.refreshed_at, age_days: c.age_days, stale: c.stale, term_count: c.terms.length,
  }));
  const ages = clouds.map((c) => c.age_days).filter((a): a is number => a !== null);
  return {
    present: clouds.length > 0,
    missing: clouds.length === 0,
    stale: clouds.some((c) => c.weight >= CLOUD_LOAD_BEARING_WEIGHT && c.stale),
    stale_after_days: CLOUD_STALE_DAYS,
    term_count: clouds.reduce((sum, c) => sum + c.term_count, 0),
    age_days: ages.length ? Math.max(...ages) : null,
    clouds,
    unknown_cloud_ids: refs.map((r) => r?.id).filter((id) => id && !known.has(id)),
  };
}

/** @deprecated one release: the flat per-type block. Use `cloudsStatus`. */
export type LexiconStatus = {
  present: boolean;
  refreshed_at: string | null;
  age_days: number | null;
  term_count: number;
  stale: boolean;
  missing: boolean;
  stale_after_days: number;
};

/**
 * `clouds` reshaped into the old `lexicon` block, so a skill or agent that has
 * not been migrated yet still reads a correct verdict. Falls back to the real
 * flat block when the type still carries one.
 *
 * @deprecated one release.
 */
export function legacyLexiconAlias(status: CloudsStatus, resume: Resume | null | undefined): LexiconStatus {
  if (status.missing && resume?.market_lens?.domain_lexicon) return lexiconStatus(resume);
  return {
    present: status.present,
    refreshed_at: status.clouds[0]?.refreshed_at ?? null,
    age_days: status.age_days,
    term_count: status.term_count,
    stale: status.stale,
    missing: status.missing,
    stale_after_days: status.stale_after_days,
  };
}

/** @deprecated one release: reads `market_lens.domain_lexicon`. Use `cloudsStatus`. */
export function lexiconStatus(resume: Resume | null | undefined, now = new Date()): LexiconStatus {
  const lexicon = resume?.market_lens?.domain_lexicon;
  const present = Boolean(lexicon);
  const age = present ? lexiconAgeDays(lexicon, now) : null;
  return {
    present,
    refreshed_at: lexicon?.refreshed_at ?? null,
    age_days: age,
    term_count: lexicon?.terms?.length ?? 0,
    stale: present && (age === null || age > LEXICON_STALE_DAYS),
    missing: !present,
    stale_after_days: LEXICON_STALE_DAYS,
  };
}

/** One unit as the last audit measured it, sized so a writer can rewrite it blind. */
export type MeasuredUnit = {
  path: string;
  kind: string;
  page: number | null;
  lines: number;
  chars: number | null;
  /** fill of the unit's LAST rendered line, in percent of the column */
  fill_pct: number | null;
  /** chars one FULL rendered line of this unit holds; null when unmeasurable */
  chars_per_line: number | null;
  status: MeasuredStatus;
  text: string;
};

export type MeasuredStatus = "ok" | "short" | "ragged" | "over";
export const MEASURED_STATUSES: MeasuredStatus[] = ["ok", "short", "ragged", "over"];

export type MeasuredBand = {
  /** [min, max] chars for a well-filled SINGLE rendered line; null when unmeasurable */
  single: [number, number] | null;
  wrapped_last_line_min_fill_pct: number | null;
  single_line_min_fill_pct: number | null;
  max_lines: number | null;
};

export type Measured = {
  audit_generated_at: string | null;
  verdict: string | null;
  pages: Record<string, unknown> | null;
  fit: { verdict: string | null; lines_to_remove: number | null; lines_to_add: number | null } | null;
  chars_per_line: Record<string, number>;
  bands: Record<string, MeasuredBand>;
  units: MeasuredUnit[];
  failing: MeasuredUnit[];
  summary: { units: number; short_single_lines: number; ragged_tails: number; over_max_lines: number };
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Chars one full rendered line of a unit holds. Newer audits carry
 * `chars_per_line` per unit; older ones don't, so a single-line unit is
 * back-estimated from its char count and its fill.
 */
function unitCharsPerLine(u: any): number | null {
  const measured = num(u?.chars_per_line);
  if (measured !== null) return Math.round(measured);
  const chars = num(u?.chars);
  const fill = num(u?.last_line_fill_pct);
  if (num(u?.lines) === 1 && chars !== null && fill !== null && fill > 0) return Math.round(chars / (fill / 100));
  return null;
}

function unitStatus(u: any, spec: Record<string, unknown> | undefined): MeasuredStatus {
  const lines = num(u?.lines) ?? 1;
  const fill = num(u?.last_line_fill_pct);
  const maxLines = num(spec?.max_lines);
  if (maxLines !== null && lines > maxLines) return "over";
  if (fill === null) return "ok";
  const singleMin = num(spec?.single_line_min_fill_pct);
  if (lines === 1) return singleMin !== null && fill < singleMin ? "short" : "ok";
  const wrappedMin = num(spec?.wrapped_last_line_min_fill_pct);
  return wrappedMin !== null && fill < wrappedMin ? "ragged" : "ok";
}

/** A rendered line is "full" a hair short of the column edge; 98% is the ceiling. */
const FULL_LINE_CEILING = 0.98;

/**
 * The measured half of the brief: what the last audit actually observed for
 * this baseline, keyed the same way the rubric's `line_units` bands are, so an
 * agent can size an edit without opening the composition or the audit json.
 *
 * `lineUnitsSpec` is the resolved rubric spec (rubric line_units merged with
 * the resume's content_policy overrides), i.e. what `compactLineUnits` returns.
 */
export function measuredFromAudit(audit: any, lineUnitsSpec: Record<string, Record<string, unknown>>): Measured {
  const rawUnits: any[] = Array.isArray(audit?.line_units) ? audit.line_units : [];
  const units: MeasuredUnit[] = rawUnits.map((u) => {
    const kind = String(u?.kind ?? "");
    return {
      path: String(u?.unit_path ?? ""),
      kind,
      page: num(u?.page),
      lines: num(u?.lines) ?? 1,
      chars: num(u?.chars),
      fill_pct: num(u?.last_line_fill_pct),
      chars_per_line: unitCharsPerLine(u),
      status: unitStatus(u, lineUnitsSpec[kind]),
      text: String(u?.text ?? ""),
    };
  });

  const perKind: Record<string, number[]> = {};
  for (const u of units) {
    if (u.chars_per_line !== null) (perKind[u.kind] ??= []).push(u.chars_per_line);
  }
  const charsPerLine: Record<string, number> = {};
  for (const [kind, values] of Object.entries(perKind)) {
    const m = median(values);
    if (m !== null) charsPerLine[kind] = m;
  }

  const bands: Record<string, MeasuredBand> = {};
  for (const kind of new Set([...Object.keys(lineUnitsSpec), ...units.map((u) => u.kind)])) {
    const spec = lineUnitsSpec[kind] ?? {};
    const cpl = charsPerLine[kind] ?? null;
    const singleMin = num(spec.single_line_min_fill_pct);
    bands[kind] = {
      single: cpl !== null && singleMin !== null ? [Math.round(cpl * (singleMin / 100)), Math.round(cpl * FULL_LINE_CEILING)] : null,
      wrapped_last_line_min_fill_pct: num(spec.wrapped_last_line_min_fill_pct),
      single_line_min_fill_pct: singleMin,
      max_lines: num(spec.max_lines),
    };
  }

  // The audit's failing_units are a per-rule list (one unit can trip two rules)
  // and carry truncated text; re-project them onto the measured units so the
  // agent reads one shape with the full text it needs to quote.
  const byPath = new Map(units.map((u) => [u.path, u]));
  const failing: MeasuredUnit[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(audit?.failing_units) ? audit.failing_units : []) {
    const p = String(f?.unit_path ?? "");
    if (seen.has(p)) continue;
    seen.add(p);
    const kind = String(f?.kind ?? "");
    failing.push(
      byPath.get(p) ?? {
        path: p,
        kind,
        page: num(f?.page),
        lines: num(f?.lines) ?? 1,
        chars: null,
        fill_pct: num(f?.last_line_fill_pct),
        chars_per_line: null,
        status: unitStatus(f, lineUnitsSpec[kind]),
        text: String(f?.text ?? ""),
      },
    );
  }

  const pages = audit?.pages ?? null;
  const fit = audit?.fit ?? null;
  return {
    audit_generated_at: typeof audit?.generated_at === "string" ? audit.generated_at : null,
    verdict: typeof audit?.verdict === "string" ? audit.verdict : null,
    pages: pages
      ? {
          count: num(pages.count),
          target: num(pages.target),
          hard_max: num(pages.hard_max),
          fills: Array.isArray(pages.fills) ? pages.fills : [],
          last_page_fill_pct: num(pages.last_page_fill_pct),
          min_last_page_fill_pct: num(pages.min_last_page_fill_pct),
        }
      : null,
    fit: fit
      ? { verdict: fit.verdict ?? null, lines_to_remove: num(fit.lines_to_remove), lines_to_add: num(fit.lines_to_add) }
      : null,
    chars_per_line: charsPerLine,
    bands,
    units,
    failing,
    summary: {
      units: units.length,
      short_single_lines: units.filter((u) => u.status === "short").length,
      ragged_tails: units.filter((u) => u.status === "ragged").length,
      over_max_lines: units.filter((u) => u.status === "over").length,
    },
  };
}

/** How an agent turns this brief into an applied, re-audited edit. */
export const HOW_TO_EDIT =
  'Write edits as {path, text} pairs (or "delete") into a JSON file and run `npm run resume:edit -- --resume <id> --edits <file>`; it applies, reanchors citations, re-audits and stamps the review trail in one process. Size a replacement to `measured.bands[kind].single` chars for one line.';

export async function buildResumeContext(args: Record<string, string>): Promise<Record<string, unknown>> {
  const resumeId = args.resume;
  if (!resumeId) throw new Error("--resume <id> is required");
  const profileCtx = resolveProfileContext(args.profile);
  const resume = await getResume(resumeId, { profileId: profileCtx.profileId });
  if (!resume) throw new Error(`Resume '${resumeId}' not found in ${profileCtx.resumesPath}`);
  const cloudsFile = await loadKeywordClouds();

  const templateName = args.template || resume.template || DEFAULT_TEMPLATE;
  const formatId = args.format ?? resume.format_id ?? null;
  const format = formatId ? await getResumeFormat(formatId) : null;
  const templateMeta = await loadTemplateMeta(templateName);
  const rubricPath = path.join(repoPath("templates/resume"), templateName, "rubric.yaml");
  const rubricRaw = await readIfExists(rubricPath);
  const rubric: any = rubricRaw ? YAML.parse(rubricRaw) ?? {} : {};

  let pagePolicy: Record<string, unknown> = { ...(rubric.page_budget ?? {}) };
  pagePolicy = { ...pagePolicy, ...(resume.page_policy ?? {}) };
  if (format?.page_policy) pagePolicy = { ...pagePolicy, ...format.page_policy };
  delete pagePolicy.reason;

  const universalChecks = parseCheckIds((await readIfExists(UNIVERSAL_CHECKS_PATH)) ?? "");
  const templateChecksPath = path.join(repoPath("templates/resume"), templateName, "quality-checks.md");
  const templateChecks = parseCheckIds((await readIfExists(templateChecksPath)) ?? "");
  const checkIds = {
    structural: [...new Set([...universalChecks.structural, ...templateChecks.structural])],
    visual: [...new Set([...universalChecks.visual, ...templateChecks.visual])],
    template_skips: templateChecks.skipped,
  };

  const truncate = args["full-rules"] === "true" ? undefined : RULE_TRUNCATE_CHARS;
  const profileRulesPath = path.join(profileCtx.profileDir, "resume-editorial-rules.md");
  const resumeDir = path.join(profileCtx.renderedResumesDir, resumeId);
  const resumeRulesPath = path.join(resumeDir, "editorial-rules.md");
  const editorial = {
    profile_path: profileRulesPath,
    resume_path: resumeRulesPath,
    truncated: Boolean(truncate),
    profile: parseEditorialRules((await readIfExists(profileRulesPath)) ?? "", { truncate }),
    resume: parseEditorialRules((await readIfExists(resumeRulesPath)) ?? "", { truncate }),
  };

  // The machine-readable subset of the same rules, enforced by the audit as
  // `gates.editorial`. Carried in the brief so the writer composes against the
  // exact rules it will be failed on, not a paraphrase of the prose file.
  const bansPath = path.join(profileCtx.profileDir, "editorial-bans.yaml");
  const bansRaw = await readIfExists(bansPath);
  let bans: { path: string; present: boolean; rules: unknown[]; parse_error?: string } = { path: bansPath, present: Boolean(bansRaw), rules: [] };
  if (bansRaw) {
    try { bans = { ...bans, rules: parseEditorialBans(bansRaw) }; }
    catch (e) { bans = { ...bans, parse_error: String((e as Error)?.message ?? e).slice(0, 200) }; }
  }

  const voice = voiceSummary(
    await readIfExists("references/voice/voice-rules.md"),
    await readIfExists(path.join(profileCtx.profileDir, "voice-rules.md")),
    await readIfExists("references/voice/slop-banlist.md"),
  );

  const metadataRaw = await readIfExists(path.join(resumeDir, "metadata.json"));
  const metadata: any = metadataRaw ? JSON.parse(metadataRaw) : null;
  const artefacts: Record<string, string> = { ...(metadata?.artefacts ?? {}) };
  if (artefacts.composition_json) {
    const prov = artefacts.composition_json.replace(/\.composition\.json$/, ".provenance.json");
    const audit = artefacts.composition_json.replace(/\.composition\.json$/, ".audit.json");
    const plan = path.join(resumeDir, "keyword-plan.json");
    if (await exists(prov)) artefacts.provenance_json = prov;
    if (await exists(audit)) artefacts.audit_json = audit;
    if (await exists(plan)) artefacts.keyword_plan = plan;
  }

  const lineUnits = compactLineUnits(rubric, resume);
  let measured: Measured | null = null;
  if (artefacts.audit_json) {
    const auditRaw = await readIfExists(artefacts.audit_json);
    if (auditRaw) {
      try { measured = measuredFromAudit(JSON.parse(auditRaw), lineUnits); }
      catch { measured = null; }
    }
  }

  const r: any = resume;
  return {
    generated_at: new Date().toISOString(),
    how_to_edit: HOW_TO_EDIT,
    profile: { id: profileCtx.profileId, dir: profileCtx.profileDir, cv_source: profileCtx.cvSourcePath, profile_md: profileCtx.profileMdPath },
    resume: {
      id: resume.id,
      label: resume.label,
      display_headline: resume.display_headline ?? null,
      cover_letter_angle: r.cover_letter_angle ?? null,
      should: r.should ?? [],
      could: r.could ?? [],
      flagged: r.flagged ?? [],
      search_keywords: r.search_keywords ?? [],
      evidence_strategy: compactEvidenceStrategy(r.evidence_strategy),
      market_lens: compactMarketLens(r.market_lens, cloudsFile),
      rate_band: r.rate_band ?? null,
      render_policy: resume.render_policy ?? null,
      notes: r.notes ?? null,
    },
    template: {
      name: templateName,
      version: templateMeta?.version ?? null,
      description: templateMeta?.description ?? rubric.description ?? null,
      rubric_path: rubricPath,
      allowed_headings: rubric.allowed_headings ?? [],
      section_order: rubric.section_order ?? [],
      section_ordering: rubric.section_ordering ?? {},
      page_policy: pagePolicy,
      caps: compactCaps(rubric, resume),
      line_units: lineUnits,
    },
    format: format
      ? { id: format.id, label: format.label, audience: format.audience ?? null, purpose: format.purpose ?? null, writer_instructions: format.writer_instructions ?? [], section_policy: format.section_policy ?? null, heading_policy: format.heading_policy ?? null }
      : null,
    editorial_rules: editorial,
    editorial_bans: bans,
    voice,
    clouds: cloudsStatus(resume, cloudsFile),
    // DEPRECATED (one release): `clouds` is the real block; this mirrors its
    // verdict so skills and agents mid-migration keep working.
    lexicon: legacyLexiconAlias(cloudsStatus(resume, cloudsFile), resume),
    market_confirmations: await loadConfirmations(profileCtx.marketConfirmationsPath, resumeId),
    check_ids: checkIds,
    baseline: metadata
      ? {
          approval_status: metadata.approval_status ?? null,
          content_hash: metadata.content_hash ?? null,
          approved_hash: metadata.approved_hash ?? null,
          stale: metadata.approval_status === "stale",
          page_count: metadata.page_count ?? null,
          last_render_at: metadata.last_render_at ?? null,
          artefacts,
        }
      : { approval_status: "missing", artefacts: {} },
    measured,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.resume) {
    console.error("Usage: tsx tools/resume/resume-context.ts --resume <id> [--profile <id>] [--template <name>] [--format <id>] [--full-rules] [--pretty] [--out <path>]");
    process.exit(2);
  }
  const brief = await buildResumeContext(args);
  const json = args.pretty === "true" ? JSON.stringify(brief, null, 2) : JSON.stringify(brief);
  if (args.out) {
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, json);
    console.log(JSON.stringify({ ok: true, out: args.out, bytes: Buffer.byteLength(json) }));
  } else {
    console.log(json);
  }
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
