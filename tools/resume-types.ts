#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadResolvedResumes, type MarketLens, type ResolvedResume } from "./resumes.ts";
import {
  CLOUD_STALE_DAYS,
  loadKeywordClouds,
  validateKeywordClouds,
  validateTypeCloudRefs,
} from "./keyword-clouds.ts";
import { resolveProfileContext } from "./profile-context.ts";
import {
  discoverProfiles,
  loadMetadataStatus,
  profileIdFromArg,
  profileLabel,
  type ProfileRef,
} from "./profile-team.ts";

function parseArgs(): { cmd: string; args: Record<string, string> } {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : "list";
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return { cmd, args };
}

function summariseResolved(profile: ProfileRef, resolved: ResolvedResume[]): Record<string, unknown>[] {
  return resolved.map(({ resume, source }) => ({
    profile: profile.label,
    id: resume.id,
    label: resume.label,
    active: resume.active !== false,
    source,
    template: resume.template ?? "classic",
    market_lens: Boolean(resume.market_lens),
    search_keywords: resume.search_keywords?.length ?? 0,
  }));
}

const GENERIC_SOURCE_PATTERNS = new Set([
  "agile",
  "architecture",
  "automation",
  "cloud",
  "consulting",
  "delivery",
  "governance",
  "integration",
  "leadership",
  "management",
  "platform",
  "roadmap",
  "security",
  "stakeholder",
  "strategy",
  "transformation",
]);

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, " ").replace(/\s+/g, " ").trim();
}

function isLikelyNamedToken(pattern: string): boolean {
  return /\b[A-Z][A-Za-z0-9+#.]{2,}\b/.test(pattern) || /\d/.test(pattern);
}

function isWeakEvidencePattern(pattern: string): boolean {
  const clean = normalise(pattern);
  const words = clean.split(" ").filter(Boolean);
  if (!clean) return true;
  if (GENERIC_SOURCE_PATTERNS.has(clean)) return true;
  if (words.length === 1 && !isLikelyNamedToken(pattern)) return true;
  if (words.length === 2 && words.every((word) => GENERIC_SOURCE_PATTERNS.has(word))) return true;
  return false;
}

/** @deprecated one release: use CLOUD_STALE_DAYS. Same number, cloud-shaped name. */
export const LEXICON_STALE_DAYS = CLOUD_STALE_DAYS;
const LEXICON_TIERS = new Set(["corpus", "preppable", "confirm", "forbidden"]);
const LEXICON_CATEGORIES = new Set(["tool", "platform", "methodology", "certification", "title", "domain", "concept"]);

export type DomainLexiconTerm = {
  term: string;
  aliases?: string[];
  category?: string;
  tier?: string;
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

export function lexiconAgeDays(lexicon: DomainLexicon | undefined, now = new Date()): number | null {
  if (!lexicon?.refreshed_at) return null;
  const then = new Date(lexicon.refreshed_at);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/**
 * Validate `market_lens.domain_lexicon` (B6). `corpusText` is the normalised
 * cv-source text when available; pass null to skip evidence-pattern checks.
 *
 * DEPRECATED (one release): the flat per-type block was replaced by shared
 * keyword clouds. A type that still carries one gets validated as before, plus
 * a deprecation warning telling the maintainer to migrate it.
 */
export function validateDomainLexicon(
  resumeId: string,
  lens: MarketLens | undefined,
  corpusText: string | null,
  now = new Date(),
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lexicon = (lens as any)?.domain_lexicon as DomainLexicon | undefined;
  if (!lexicon) return { errors, warnings };
  warnings.push(`${resumeId}: market_lens.domain_lexicon is deprecated; move its terms into state/org/keyword-clouds.yaml and reference them from market_lens.clouds.`);

  if (!lexicon.refreshed_at) {
    warnings.push(`${resumeId}: domain_lexicon has no refreshed_at; run the /resume-strategy lexicon refresh.`);
  } else {
    const age = lexiconAgeDays(lexicon, now);
    if (age === null) errors.push(`${resumeId}: domain_lexicon.refreshed_at '${lexicon.refreshed_at}' is not a valid date.`);
    else if (age > LEXICON_STALE_DAYS) warnings.push(`${resumeId}: domain_lexicon is ${age} days old (limit ${LEXICON_STALE_DAYS}); run the /resume-strategy lexicon refresh.`);
  }

  const forbidden = new Set((lens?.forbidden_claims ?? []).map(normalise));
  const seen = new Set<string>();
  (lexicon.terms ?? []).forEach((entry, index) => {
    const where = `${resumeId}: domain_lexicon.terms[${index}]`;
    if (!entry || typeof entry.term !== "string" || !entry.term.trim()) {
      errors.push(`${where} must have a string 'term'.`);
      return;
    }
    const key = normalise(entry.term);
    if (seen.has(key)) warnings.push(`${where} duplicates term '${entry.term}'.`);
    seen.add(key);
    if (!entry.tier || !LEXICON_TIERS.has(entry.tier)) {
      errors.push(`${where} '${entry.term}' tier must be one of ${[...LEXICON_TIERS].join("|")}.`);
    }
    if (entry.category && !LEXICON_CATEGORIES.has(entry.category)) {
      warnings.push(`${where} '${entry.term}' has unknown category '${entry.category}'.`);
    }
    if (entry.tier === "forbidden" && !forbidden.has(key)) {
      errors.push(`${where} '${entry.term}' is tier forbidden but is not listed in market_lens.forbidden_claims.`);
    }
    if (entry.tier === "corpus") {
      const patterns = (entry.evidence_patterns ?? []).filter((p) => typeof p === "string" && p.trim());
      if (!patterns.length) {
        warnings.push(`${where} '${entry.term}' is tier corpus but has no evidence_patterns.`);
      } else if (corpusText !== null) {
        const hit = patterns.some((p) => corpusText.includes(normalise(p)));
        if (!hit) warnings.push(`${where} '${entry.term}' is tier corpus but none of its evidence_patterns match cv-source.md.`);
      }
      patterns.forEach((p) => {
        if (isWeakEvidencePattern(p)) warnings.push(`${where} '${entry.term}' uses weak evidence pattern '${p}'.`);
      });
    }
    if (entry.tier === "confirm" && !entry.why) {
      warnings.push(`${where} '${entry.term}' is tier confirm but has no 'why' (the evidence interview needs it).`);
    }
  });

  return { errors, warnings };
}

function validateMarketLens(resumeId: string, lens?: MarketLens): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!lens) return { errors, warnings };

  const proofQuestions = lens.proof_questions ?? [];
  proofQuestions.forEach((question, index) => {
    if (typeof question !== "string") errors.push(`${resumeId}: market_lens.proof_questions[${index}] must be a string; quote questions containing ':' in YAML.`);
  });

  const aliases = lens.keyword_aliases ?? {};
  for (const [alias, rule] of Object.entries(aliases)) {
    const patterns = rule.acceptable_if_source_mentions ?? [];
    if (!rule.requires_explicit_source && patterns.length < 2) {
      warnings.push(`${resumeId}: alias '${alias}' has fewer than 2 source evidence patterns.`);
    }
    patterns.forEach((pattern, index) => {
      if (typeof pattern !== "string") {
        errors.push(`${resumeId}: alias '${alias}' pattern[${index}] must be a string.`);
        return;
      }
      if (isWeakEvidencePattern(pattern)) {
        warnings.push(`${resumeId}: alias '${alias}' uses weak source pattern '${pattern}'. Use a source-specific phrase, named platform+action, outcome, or metric.`);
      }
    });
  }

  if ((lens.capability_map?.length ?? 0) > 0) {
    const signals = new Set((lens.must_signal ?? []).map(normalise));
    for (const entry of lens.capability_map ?? []) {
      if (entry.market_relevance === "high" && entry.resume_value !== "filler" && !signals.has(normalise(entry.signal))) {
        warnings.push(`${resumeId}: high-relevance capability '${entry.signal}' is not listed in must_signal.`);
      }
    }
  }

  return { errors, warnings };
}

async function cmdList(args: Record<string, string>): Promise<void> {
  const profile: ProfileRef = { id: profileIdFromArg(args.profile), label: profileLabel(profileIdFromArg(args.profile)) };
  const resolved = await loadResolvedResumes({ profileId: profile.id });
  const rows = summariseResolved(profile, resolved);
  if (args.json === "true") console.log(JSON.stringify(rows, null, 2));
  else {
    for (const row of rows) {
      console.log(`${row.profile}\t${row.id}\t${row.source}\t${row.active ? "active" : "inactive"}\t${row.label}\tmarket_lens=${row.market_lens}`);
    }
  }
}

async function cmdValidate(args: Record<string, string>): Promise<void> {
  const profiles = await discoverProfiles(args);
  const results: Record<string, unknown>[] = [];
  let failed = 0;
  for (const profile of profiles) {
    try {
      const resolved = await loadResolvedResumes({ profileId: profile.id });
      const corpusText = await loadCorpusText(profile.id);
      const clouds = await loadKeywordClouds();
      const cloudDiagnostics = validateKeywordClouds(clouds, corpusText);
      const lensDiagnostics = resolved.map(({ resume }) => {
        const lens = validateMarketLens(resume.id, resume.market_lens);
        const refs = validateTypeCloudRefs(resume.id, resume.market_lens, clouds);
        const lexicon = validateDomainLexicon(resume.id, resume.market_lens, corpusText);
        return {
          resume: resume.id,
          errors: [...lens.errors, ...refs.errors, ...lexicon.errors],
          warnings: [...lens.warnings, ...refs.warnings, ...lexicon.warnings],
        };
      }).filter((entry) => entry.errors.length || entry.warnings.length);
      const errorCount = lensDiagnostics.reduce((sum, entry) => sum + entry.errors.length, 0)
        + cloudDiagnostics.errors.length;
      if (errorCount) failed++;
      results.push({
        profile: profile.label,
        ok: errorCount === 0,
        resumes: resolved.length,
        sources: countSources(resolved),
        clouds: { total: clouds.clouds.length, ...cloudDiagnostics },
        lens_diagnostics: lensDiagnostics,
      });
    } catch (e) {
      failed++;
      results.push({ profile: profile.label, ok: false, error: (e as Error).message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}

async function loadCorpusText(profileId: string | null): Promise<string | null> {
  const ctx = resolveProfileContext(profileId);
  try {
    return normalise(await fs.readFile(ctx.cvSourcePath, "utf8"));
  } catch {
    return null;
  }
}

function countSources(resolved: ResolvedResume[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of resolved) counts[entry.source] = (counts[entry.source] ?? 0) + 1;
  return counts;
}

async function cmdMatrix(args: Record<string, string>): Promise<void> {
  const profiles = await discoverProfiles({ ...args, profile: args.profile ?? "all" });
  const rows: Record<string, unknown>[] = [];
  for (const profile of profiles) {
    const resolved = await loadResolvedResumes({ profileId: profile.id });
    for (const entry of resolved) {
      rows.push({
        ...summariseResolved(profile, [entry])[0],
        ...(await loadMetadataStatus(profile.id, entry.resume.id)),
      });
    }
  }
  if (args.json === "true") console.log(JSON.stringify(rows, null, 2));
  else {
    for (const row of rows) {
      console.log(`${row.profile}\t${row.id}\t${row.source}\t${row.active ? "active" : "inactive"}\t${row.render_status}\t${row.label}`);
    }
  }
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs();
  if (cmd === "list") return cmdList(args);
  if (cmd === "validate") return cmdValidate(args);
  if (cmd === "matrix") return cmdMatrix(args);
  console.error("Usage: tsx tools/resume-types.ts (list|validate|matrix) [--profile <id|all>] [--json]");
  process.exit(2);
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
