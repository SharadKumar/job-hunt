/**
 * keyword-clouds.ts — load, validate and resolve the shared keyword clouds.
 *
 * A keyword cloud is one bundle of market vocabulary — a capability, an
 * industry domain, or a vendor stack — researched once in
 * `state/org/keyword-clouds.yaml` and referenced with a weight by every resume
 * type that needs it. It replaces the flat per-type
 * `market_lens.domain_lexicon`, where the same term was researched and
 * maintained separately for each positioning.
 *
 * A term belongs to EXACTLY ONE cloud. Tiers are unchanged from the lexicon
 * (`corpus | preppable | confirm | forbidden`), so the qualification and
 * fabrication rules downstream did not have to move.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";
import type { DomainLexiconTerm, MarketLens } from "./resumes.ts";

/** A cloud researched longer ago than this is stale; refresh via /resume-strategy 3b. */
export const CLOUD_STALE_DAYS = 30;

export const CLOUD_KINDS = ["capability", "domain", "tooling"] as const;
export type CloudKind = (typeof CLOUD_KINDS)[number];

/** Identical to the former `domain_lexicon` term schema, deliberately. */
export type CloudTerm = DomainLexiconTerm;

export type KeywordCloud = {
  id: string;
  kind: CloudKind;
  label: string;
  description?: string;
  refreshed_at?: string | null;
  source_summary?: string;
  terms?: CloudTerm[];
};

export type KeywordCloudsFile = {
  version: 1;
  clouds: KeywordCloud[];
};

/** One `market_lens.clouds[]` entry on a resume type. */
export type CloudRef = {
  id: string;
  weight: number;
  must_have_min?: number;
};

/** A cloud reference resolved against the clouds file, for one positioning. */
export type ResolvedCloud = {
  id: string;
  kind: CloudKind;
  label: string;
  weight: number;
  must_have_min: number | null;
  refreshed_at: string | null;
  age_days: number | null;
  stale: boolean;
  terms: CloudTerm[];
};

export const DEFAULT_KEYWORD_CLOUDS_PATH = repoPath("state/org/keyword-clouds.yaml");

const CACHE = new Map<string, KeywordCloudsFile>();

export function parseKeywordClouds(text: string): KeywordCloudsFile {
  const raw = (YAML.parse(text) ?? {}) as Partial<KeywordCloudsFile>;
  return { version: 1, clouds: Array.isArray(raw.clouds) ? raw.clouds : [] };
}

/** Load (and cache) the shared clouds file. Returns an empty file when absent. */
export async function loadKeywordClouds(filePath = DEFAULT_KEYWORD_CLOUDS_PATH): Promise<KeywordCloudsFile> {
  const cached = CACHE.get(filePath);
  if (cached) return cached;
  let parsed: KeywordCloudsFile;
  try {
    parsed = parseKeywordClouds(await fs.readFile(filePath, "utf8"));
  } catch {
    parsed = { version: 1, clouds: [] };
  }
  CACHE.set(filePath, parsed);
  return parsed;
}

/** Test/CLI hook: forget the cached parse of one path (or all of them). */
export function clearKeywordCloudsCache(filePath?: string): void {
  if (filePath) CACHE.delete(filePath);
  else CACHE.clear();
}

export function cloudsById(file: KeywordCloudsFile): Map<string, KeywordCloud> {
  return new Map(file.clouds.map((c) => [c.id, c]));
}

export function cloudAgeDays(cloud: { refreshed_at?: string | null } | undefined, now = new Date()): number | null {
  if (!cloud?.refreshed_at) return null;
  const then = new Date(cloud.refreshed_at);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TIERS = new Set(["corpus", "preppable", "confirm", "forbidden"]);
const CATEGORIES = new Set(["tool", "platform", "methodology", "certification", "title", "domain", "concept"]);

const GENERIC_SOURCE_PATTERNS = new Set([
  "agile", "architecture", "automation", "cloud", "consulting", "delivery", "governance", "integration",
  "leadership", "management", "platform", "roadmap", "security", "stakeholder", "strategy", "transformation",
]);

export function normaliseCloudText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, " ").replace(/\s+/g, " ").trim();
}

function isLikelyNamedToken(pattern: string): boolean {
  return /\b[A-Z][A-Za-z0-9+#.]{2,}\b/.test(pattern) || /\d/.test(pattern);
}

export function isWeakEvidencePattern(pattern: string): boolean {
  const clean = normaliseCloudText(pattern);
  const words = clean.split(" ").filter(Boolean);
  if (!clean) return true;
  if (GENERIC_SOURCE_PATTERNS.has(clean)) return true;
  if (words.length === 1 && !isLikelyNamedToken(pattern)) return true;
  if (words.length === 2 && words.every((word) => GENERIC_SOURCE_PATTERNS.has(word))) return true;
  return false;
}

/**
 * Validate the whole clouds file.
 *
 * Carries over every rule the old `validateDomainLexicon` enforced (tier and
 * category vocabulary, corpus terms need matching evidence patterns, weak
 * patterns, confirm terms need a `why`, staleness) and adds the rules the
 * shared model needs: unique cloud ids, known `kind`, and one term in exactly
 * one cloud across the whole file.
 *
 * `corpusText` is the normalised cv-source text; pass null to skip the
 * evidence-pattern checks.
 *
 * NOTE ON FORBIDDEN TERMS: the old validator required a `forbidden` lexicon
 * term to be mirrored in that type's `market_lens.forbidden_claims`. A cloud is
 * shared across positionings, so the cloud is now the authority: a forbidden
 * term is forbidden for every type that references the cloud, and only needs a
 * `why` explaining the block. `resolveForbiddenClaims` unions the cloud-level
 * blocks into the per-type list rather than demanding they be kept in sync.
 */
export function validateKeywordClouds(
  file: KeywordCloudsFile,
  corpusText: string | null,
  now = new Date(),
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const termOwner = new Map<string, string>();

  if (file.version !== 1) errors.push(`keyword-clouds: unsupported version '${file.version}' (expected 1).`);

  file.clouds.forEach((cloud, cloudIndex) => {
    const where = `keyword-clouds.clouds[${cloudIndex}]`;
    if (!cloud || typeof cloud.id !== "string" || !cloud.id.trim()) {
      errors.push(`${where} must have a string 'id'.`);
      return;
    }
    if (seenIds.has(cloud.id)) errors.push(`${where} duplicates cloud id '${cloud.id}'.`);
    seenIds.add(cloud.id);
    if (!CLOUD_KINDS.includes(cloud.kind)) {
      errors.push(`${cloud.id}: kind must be one of ${CLOUD_KINDS.join("|")}.`);
    }
    if (!cloud.label || typeof cloud.label !== "string") warnings.push(`${cloud.id}: cloud has no label.`);

    if (!cloud.refreshed_at) {
      warnings.push(`${cloud.id}: cloud has no refreshed_at; run the /resume-strategy cloud refresh (step 3b).`);
    } else {
      const age = cloudAgeDays(cloud, now);
      if (age === null) errors.push(`${cloud.id}: refreshed_at '${cloud.refreshed_at}' is not a valid date.`);
      else if (age > CLOUD_STALE_DAYS) warnings.push(`${cloud.id}: cloud is ${age} days old (limit ${CLOUD_STALE_DAYS}); run the /resume-strategy cloud refresh.`);
    }

    const terms = cloud.terms ?? [];
    if (!terms.length) warnings.push(`${cloud.id}: cloud has no terms; it is declared but not yet researched.`);

    terms.forEach((entry, index) => {
      const at = `${cloud.id}.terms[${index}]`;
      if (!entry || typeof entry.term !== "string" || !entry.term.trim()) {
        errors.push(`${at} must have a string 'term'.`);
        return;
      }
      const key = normaliseCloudText(entry.term);
      const owner = termOwner.get(key);
      // One term, one cloud: a term in two clouds would be counted, questioned
      // and weighted twice, and no cloud would own its refresh.
      if (owner) errors.push(`${at} '${entry.term}' already belongs to cloud '${owner}'; a term lives in exactly one cloud.`);
      else termOwner.set(key, cloud.id);

      if (!entry.tier || !TIERS.has(entry.tier)) {
        errors.push(`${at} '${entry.term}' tier must be one of ${[...TIERS].join("|")}.`);
      }
      if (entry.category && !CATEGORIES.has(entry.category)) {
        warnings.push(`${at} '${entry.term}' has unknown category '${entry.category}'.`);
      }
      if (entry.tier === "forbidden" && !entry.why) {
        warnings.push(`${at} '${entry.term}' is tier forbidden but has no 'why' saying what the block protects against.`);
      }
      if (entry.tier === "corpus") {
        const patterns = (entry.evidence_patterns ?? []).filter((p) => typeof p === "string" && p.trim());
        if (!patterns.length) {
          warnings.push(`${at} '${entry.term}' is tier corpus but has no evidence_patterns.`);
        } else if (corpusText !== null) {
          const hit = patterns.some((p) => corpusText.includes(normaliseCloudText(p)));
          if (!hit) warnings.push(`${at} '${entry.term}' is tier corpus but none of its evidence_patterns match cv-source.md.`);
        }
        patterns.forEach((p) => {
          if (isWeakEvidencePattern(p)) warnings.push(`${at} '${entry.term}' uses weak evidence pattern '${p}'.`);
        });
      }
      if (entry.tier === "confirm" && !entry.why) {
        warnings.push(`${at} '${entry.term}' is tier confirm but has no 'why' (the evidence interview needs it).`);
      }
    });
  });

  return { errors, warnings };
}

/** Raw `market_lens.clouds` entries for one type, tolerant of a missing lens. */
export function cloudRefs(lens: MarketLens | undefined): CloudRef[] {
  const refs = (lens as any)?.clouds;
  return Array.isArray(refs) ? (refs as CloudRef[]) : [];
}

/** Validate one resume type's `market_lens.clouds` block against the clouds file. */
export function validateTypeCloudRefs(
  resumeId: string,
  lens: MarketLens | undefined,
  file: KeywordCloudsFile,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const refs = cloudRefs(lens);
  const known = cloudsById(file);
  const seen = new Set<string>();

  if (!refs.length) {
    // The deprecated flat block still counts as "declared" for one release.
    if (!(lens as any)?.domain_lexicon) {
      warnings.push(`${resumeId}: market_lens declares no clouds; run the /resume-strategy cloud refresh (step 3b).`);
    }
    return { errors, warnings };
  }

  refs.forEach((ref, index) => {
    const where = `${resumeId}: market_lens.clouds[${index}]`;
    if (!ref || typeof ref.id !== "string" || !ref.id.trim()) {
      errors.push(`${where} must have a string 'id'.`);
      return;
    }
    if (!known.has(ref.id)) errors.push(`${where} references unknown cloud '${ref.id}'.`);
    if (seen.has(ref.id)) errors.push(`${where} references cloud '${ref.id}' twice.`);
    seen.add(ref.id);
    if (!Number.isInteger(ref.weight) || ref.weight < 1 || ref.weight > 5) {
      errors.push(`${where} '${ref.id}' weight must be an integer 1-5 (got ${JSON.stringify(ref.weight)}).`);
    }
    if (ref.must_have_min !== undefined) {
      if (!Number.isInteger(ref.must_have_min) || ref.must_have_min < 0) {
        errors.push(`${where} '${ref.id}' must_have_min must be a non-negative integer.`);
      } else {
        const available = known.get(ref.id)?.terms?.length ?? 0;
        if (ref.must_have_min > available) {
          warnings.push(`${where} '${ref.id}' must_have_min ${ref.must_have_min} exceeds the cloud's ${available} terms.`);
        }
      }
    }
  });

  return { errors, warnings };
}

/**
 * Resolve one positioning's clouds, heaviest first.
 *
 * Unknown ids are dropped rather than thrown: `validateTypeCloudRefs` is the
 * place that reports them, and a render should not crash on a typo it can see.
 */
export function resolveCloudsForType(
  lens: MarketLens | undefined,
  file: KeywordCloudsFile,
  now = new Date(),
): ResolvedCloud[] {
  const known = cloudsById(file);
  const out: ResolvedCloud[] = [];
  for (const ref of cloudRefs(lens)) {
    const cloud = known.get(ref?.id);
    if (!cloud) continue;
    const age = cloudAgeDays(cloud, now);
    out.push({
      id: cloud.id,
      kind: cloud.kind,
      label: cloud.label ?? cloud.id,
      weight: Number(ref.weight) || 1,
      must_have_min: ref.must_have_min ?? null,
      refreshed_at: cloud.refreshed_at ?? null,
      age_days: age,
      stale: age === null || age > CLOUD_STALE_DAYS,
      terms: cloud.terms ?? [],
    });
  }
  return out.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/** Every term a positioning's clouds bring, tagged with the cloud it came from. */
export function resolvedCloudTerms(resolved: ResolvedCloud[]): Array<CloudTerm & { cloud_id: string; cloud_kind: CloudKind; cloud_weight: number }> {
  return resolved.flatMap((c) => (c.terms ?? []).map((t) => ({ ...t, cloud_id: c.id, cloud_kind: c.kind, cloud_weight: c.weight })));
}

/**
 * The effective forbidden-claim list for a positioning: what the type declares
 * plus every `forbidden` term its clouds carry. The cloud is the authority, so
 * the type does not have to mirror the block by hand.
 */
export function resolveForbiddenClaims(lens: MarketLens | undefined, resolved: ResolvedCloud[]): string[] {
  const out = new Set<string>(lens?.forbidden_claims ?? []);
  for (const t of resolvedCloudTerms(resolved)) if (t.tier === "forbidden") out.add(t.term);
  return [...out];
}
