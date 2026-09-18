#!/usr/bin/env tsx
/**
 * score.ts — transparent weighted scorer for a role vs the user's profile.
 *
 * Reads:
 *   state/profile/scoring-weights.yaml
 *   state/profile/skills-taxonomy.yaml
 *   state/profile/profile.md (frontmatter for target rate, location, arrangement)
 *
 * Inputs: a Role object (or JSON via --role-json or --role-file).
 *
 * Output: {score: 0-100, reasons: string[], red_flag_blocker: bool, breakdown: {...}}
 *
 * Usage:
 *   tsx tools/score.ts --role-file /tmp/role.json
 *   echo '{...}' | tsx tools/score.ts --stdin
 */

import { repoPath } from "./repo-root.ts";
import { readYaml } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import { classifyJdRegex, type Classification } from "./classify-jd.ts";

export type Role = {
  id: string;
  channel: string;
  title: string;
  company: string;
  location?: string;
  description: string;          // raw JD text
  postedAt?: string;            // ISO
  dayRate?: { min?: number; max?: number; currency?: string; inc_super?: boolean };
  salary?: { min?: number; max?: number; currency?: string };
  contractLength?: string;
  workArrangement?: "remote" | "hybrid" | "onsite" | "unknown";
  url: string;
};

/**
 * Banded read of how well the role's stated requirements line up with the
 * candidate. ADVISORY: `fit_verdict` never feeds `score` and never re-ranks the
 * pipeline — it is an added field so the Sheet and existing tests keep working.
 */
export type FitBand = "weak" | "partial" | "strong" | "over_qualified";

export type FitVerdict = {
  band: FitBand;
  /** 0-100 share of the JD's required terms the candidate's taxonomy covers */
  required_match: number;
  /** 0-100 share of the JD's preferred / desirable terms covered */
  preferred_match: number;
  /** required_match * 0.7 + preferred_match * 0.3, rounded */
  combined: number;
  /**
   * "term_lists" when the classification exposed required/preferred term lists;
   * "overall_overlap" when only one overall skill-overlap number existed, in
   * which case required and preferred are both DERIVED from that single number
   * (so `combined` equals it) rather than measured separately.
   */
  derived_from: "term_lists" | "overall_overlap";
  /** over_qualified is a flight risk to flag, never a "best match" signal */
  flight_risk: boolean;
  reason: string;
};

export type ScoreResult = {
  score: number;
  reasons: string[];
  red_flag_blocker: boolean;
  breakdown: Record<string, number>;
  /**
   * Advisory band, always populated by `scoreRole`. Optional on the type so
   * existing constructors of a bare ScoreResult (tests, fixtures) still typecheck.
   */
  fit_verdict?: FitVerdict;
  /** Set when the role fits but is held for a logistics reason the user has ruled on (e.g. interstate onsite). */
  parked_reason?: string;
};

export type SkillTaxonomy = {
  categories: Record<string, Record<string, { synonyms: string[]; seniority: "expert" | "practitioner" | "familiar" }>>;
};

type Weights = {
  weights: Record<string, number>;
  thresholds: Record<string, number>;
  red_flag_penalties: Record<string, number>;
  bonuses: Record<string, number>;
  resume_priority_bonuses?: Record<string, number>;
};

const SENIORITY_MULT: Record<string, number> = { expert: 1.0, practitioner: 0.7, familiar: 0.4 };

/** The canonical skill → synonyms → seniority taxonomy (shared with resume-keywords.ts). */
export async function loadTaxonomy(filePath = repoPath("state/profile/skills-taxonomy.yaml")): Promise<SkillTaxonomy> {
  const parsed = await readYaml<SkillTaxonomy | null>(filePath).catch((e: any) => { if (e?.code === "ENOENT") return null; throw e; });
  return parsed?.categories ? parsed : { categories: {} };
}

async function loadProfile(): Promise<{ targetRoles: string[]; targetRateMin?: number; targetRateMax?: number; preferRemote: boolean; redFlagOnsite5Days: boolean; homeCity?: string }> {
  const md = await fs.readFile("state/profile/profile.md", "utf8");
  // Coarse extraction; the user's profile.md uses markdown sections we grep for
  const targetRoles: string[] = [];
  const rolesMatch = md.match(/Resume role families[^\n]*\n((?:.*\n)+?)(?:\n##|$)/);
  if (rolesMatch) {
    for (const line of rolesMatch[1].split("\n")) {
      const m = line.match(/^\s*\d+\.\s+(.+)$/);
      if (m) targetRoles.push(m[1].trim());
    }
  }
  const dayRateSection = md.match(/##\s*Engagement targets[\s\S]*?(?=\n##|$)/i)?.[0] ?? md;
  const moneyValues = [...dayRateSection.matchAll(/\$([0-9][0-9,]*)/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 100);
  const acceptanceFloor = dayRateSection.match(/Acceptance floor[^\n]*\$([0-9][0-9,]*)/i)?.[1];
  const targetRateMin = acceptanceFloor ? Number(acceptanceFloor.replace(/,/g, "")) : (moneyValues.length ? Math.min(...moneyValues) : undefined);
  const targetRateMax = moneyValues.length ? Math.max(...moneyValues) : undefined;
  const homeCity = md.match(/^\s*city:\s*([A-Za-z ]+)\s*$/m)?.[1]?.trim();
  return {
    homeCity,
    targetRoles,
    targetRateMin,
    targetRateMax,
    preferRemote: /(remote preferred|strong preference:\s*fully remote|fully remote|remote-first)/i.test(md),
    redFlagOnsite5Days: /onsite 5 days = red flag/i.test(md),
  };
}

function skillOverlap(jdText: string, taxonomy: SkillTaxonomy): { matched: { skill: string; mult: number; matches: string[] }[]; rawScore: number } {
  const matched: { skill: string; mult: number; matches: string[] }[] = [];
  let raw = 0;
  const text = jdText.toLowerCase();
  for (const cat of Object.values(taxonomy.categories)) {
    for (const [canonical, def] of Object.entries(cat)) {
      const matches: string[] = [];
      for (const syn of def.synonyms) {
        const re = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(text)) matches.push(syn);
      }
      if (matches.length) {
        const mult = SENIORITY_MULT[def.seniority] ?? 0.5;
        matched.push({ skill: canonical, mult, matches });
        raw += mult;
      }
    }
  }
  return { matched, rawScore: raw };
}

function seniorityMatch(title: string, targetRoles: string[]): number {
  const t = title.toLowerCase();
  if (!targetRoles.length) return 0.6;
  for (const tr of targetRoles) {
    for (const word of tr.toLowerCase().split(/[^\w]+/).filter((w) => w.length > 3)) {
      if (t.includes(word)) return 1.0;
    }
  }
  // Senior-y keywords boost partially
  if (/(senior|principal|lead|director|head|architect|staff)/i.test(title)) return 0.65;
  if (/(junior|graduate|associate|mid.level)/i.test(title)) return 0.1;
  return 0.4;
}

function rateFit(role: Role, profileMin?: number, profileMax?: number): { score: number; reason: string } {
  const r = role.dayRate;
  if (!r || (!r.min && !r.max)) return { score: 0.5, reason: "rate not stated (partial credit)" };
  const min = r.min ?? r.max ?? 0;
  const max = r.max ?? r.min ?? 0;
  if (profileMin == null || profileMax == null) return { score: 0.6, reason: "profile target rate not yet set (TODO)" };
  if (max < profileMin) return { score: 0.1, reason: `posted max $${max} below target min $${profileMin}` };
  if (min > profileMax) return { score: 1.0, reason: `posted min $${min} above target max — bonus` };
  return { score: 1.0, reason: `rate $${min}-${max} within target $${profileMin}-${profileMax}` };
}

function arrangementFit(role: Role, preferRemote: boolean): { score: number; reason: string } {
  const a = role.workArrangement ?? "unknown";
  if (a === "remote") return { score: 1.0, reason: "remote — preferred" };
  if (a === "hybrid") return { score: preferRemote ? 0.7 : 0.9, reason: "hybrid acceptable" };
  if (a === "onsite") return { score: 0.2, reason: "onsite — penalty" };
  return { score: 0.5, reason: "arrangement unknown" };
}

function recencyFit(role: Role): { score: number; reason: string } {
  if (!role.postedAt) return { score: 0.5, reason: "posted date unknown" };
  const days = (Date.now() - new Date(role.postedAt).getTime()) / 86_400_000;
  if (days < 2) return { score: 1.0, reason: `posted ${days.toFixed(1)} days ago` };
  if (days < 7) return { score: 0.8, reason: `posted ${days.toFixed(1)} days ago` };
  if (days < 14) return { score: 0.5, reason: `posted ${days.toFixed(0)} days ago` };
  return { score: 0.2, reason: `posted ${days.toFixed(0)} days ago — likely stale` };
}

function contractFlexibility(classification: Classification): { score: number; reason: string } {
  const signals: string[] = [];
  if (classification.bonuses.includes("fully_remote")) signals.push("fully_remote");
  if (classification.bonuses.includes("fractional_or_part_time_explicit")) signals.push("fractional_or_part_time");
  if (classification.bonuses.includes("short_term_contract")) signals.push("short_term");
  if (classification.contract_length_months && classification.contract_length_months <= 3) signals.push(`${classification.contract_length_months}mo`);
  if (!classification.requires_exclusivity) signals.push("no_exclusivity");
  if (!signals.length) return { score: 0.4, reason: "no flexibility signals" };
  return { score: Math.min(1.0, 0.4 + signals.length * 0.2), reason: signals.join(" + ") };
}

// ---------------------------------------------------------------------------
// Fit verdict (advisory band; never touches `score`)
// ---------------------------------------------------------------------------

/** Band a 0-100 combined match. 90+ is over-qualified: a flight risk, not a win. */
export function bandFor(combined: number): FitBand {
  if (combined < 40) return "weak";
  if (combined < 65) return "partial";
  if (combined < 90) return "strong";
  return "over_qualified";
}

/**
 * Optional term lists a richer classification (or a JD analysis pass) may
 * expose. `Classification` does not declare them today, so we read them
 * structurally rather than widening a type this tool does not own.
 */
type TermSignals = { required_terms?: unknown; preferred_terms?: unknown };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

/** Whole-word, case-insensitive, in either direction ("SAFe" vs "SAFe 6.0"). */
function termsOverlap(a: string, b: string): boolean {
  const re = (s: string) => new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
  return re(a).test(b) || re(b).test(a);
}

/** 0-100 share of `terms` the candidate's taxonomy demonstrably covers. */
function taxonomyCoverage(terms: string[], taxonomy: SkillTaxonomy): number {
  if (!terms.length) return 0;
  const synonyms: string[] = [];
  for (const cat of Object.values(taxonomy.categories)) {
    for (const def of Object.values(cat)) synonyms.push(...def.synonyms);
  }
  const covered = terms.filter((t) => synonyms.some((s) => termsOverlap(s, t))).length;
  return Math.round((covered / terms.length) * 100);
}

export function computeFitVerdict(input: {
  requiredTerms?: string[];
  preferredTerms?: string[];
  taxonomy?: SkillTaxonomy;
  /** 0-100 fallback when no term lists exist: the overall skill-overlap share */
  overallOverlapPct: number;
}): FitVerdict {
  const required = input.requiredTerms ?? [];
  const preferred = input.preferredTerms ?? [];
  const hasLists = Boolean(input.taxonomy) && (required.length > 0 || preferred.length > 0);

  // No term lists on this classification: there is only ONE overall overlap
  // number, so required and preferred are both DERIVED from it. The 0.7/0.3
  // blend then collapses to that same number — deliberate, and reported via
  // `derived_from` so nobody reads it as two independent measurements.
  const required_match = hasLists ? (required.length ? taxonomyCoverage(required, input.taxonomy!) : 0) : Math.round(input.overallOverlapPct);
  const preferred_match = hasLists ? (preferred.length ? taxonomyCoverage(preferred, input.taxonomy!) : 0) : Math.round(input.overallOverlapPct);
  const combined = Math.max(0, Math.min(100, Math.round(required_match * 0.7 + preferred_match * 0.3)));
  const band = bandFor(combined);
  const derived_from = hasLists ? "term_lists" : "overall_overlap";
  const reason = hasLists
    ? `required ${required_match}/100 (${required.length} terms) × 0.7 + preferred ${preferred_match}/100 (${preferred.length} terms) × 0.3 = ${combined}`
    : `no required/preferred term lists on the classification; derived from overall skill overlap ${Math.round(input.overallOverlapPct)}/100 = ${combined}`;
  return {
    band,
    required_match,
    preferred_match,
    combined,
    derived_from,
    flight_risk: band === "over_qualified",
    reason: band === "over_qualified" ? `${reason} — over-qualified: treat as a flight risk, not a best match` : reason,
  };
}

export async function scoreRole(role: Role, providedClassification?: Classification): Promise<ScoreResult & { classification: Classification }> {
  const weights = await readYaml<Weights>(repoPath("state/profile/scoring-weights.yaml"));
  const taxonomy = await readYaml<SkillTaxonomy>(repoPath("state/profile/skills-taxonomy.yaml"));
  const profile = await loadProfile();

  // Classification policy:
  //   - If the caller (typically the agent running a skill) supplies a
  //     classification, use it. The agent has already reasoned about
  //     profile_relevance against the active targets and red flags using
  //     its own LLM context.
  //   - Otherwise, fall back to the regex triage classifier. This is fast
  //     and weak — appropriate for pre-filtering a large hunt batch before
  //     the agent does grounded reclassification on the subset.
  const classification = providedClassification ?? await classifyJdRegex(role.title, role.description);

  // Merge classifier-derived day_rate into the role (channel scrape may not have it)
  if (classification.day_rate.stated_explicitly && classification.day_rate.min) {
    role.dayRate = role.dayRate ?? {
      min: classification.day_rate.min,
      max: classification.day_rate.max ?? classification.day_rate.min,
      currency: classification.day_rate.currency,
      inc_super: classification.day_rate.inc_super ?? undefined,
    };
  }
  // Same for work arrangement
  if (role.workArrangement === "unknown" || !role.workArrangement) {
    role.workArrangement = classification.work_arrangement;
  }

  const breakdown: Record<string, number> = {};
  const reasons: string[] = [`classifier: ${classification._classifier}`];

  // Skills overlap (still keyword-based — the taxonomy is finite + explicit)
  const so = skillOverlap(`${role.title} ${role.description}`, taxonomy);
  const skillsNorm = Math.min(1, so.rawScore / 8);
  breakdown.skills_overlap = skillsNorm * (weights.weights.skills_overlap ?? 0);
  if (so.matched.length) {
    const top = so.matched.sort((a, b) => b.mult - a.mult).slice(0, 5).map((m) => `${m.skill}(${m.matches[0]})`);
    reasons.push(`skills: ${top.join(", ")}`);
  }

  // Seniority: prefer the classifier's call; fall back to title regex
  const senTitle = seniorityMatch(role.title, profile.targetRoles);
  const senFromLLM = ["senior", "lead", "principal", "director"].includes(classification.seniority) ? 1.0 : classification.seniority === "mid" ? 0.3 : classification.seniority === "junior" ? 0.05 : senTitle;
  breakdown.seniority_match = senFromLLM * (weights.weights.seniority_match ?? 0);
  reasons.push(`seniority: ${classification.seniority || role.title}`);

  // Rate
  const rate = rateFit(role, profile.targetRateMin, profile.targetRateMax);
  breakdown.rate_fit = rate.score * (weights.weights.rate_fit ?? 0);
  reasons.push(`rate: ${rate.reason}`);

  // Arrangement
  const arr = arrangementFit(role, profile.preferRemote);
  breakdown.work_arrangement_fit = arr.score * (weights.weights.work_arrangement_fit ?? 0);
  reasons.push(`arrangement: ${arr.reason}`);

  // Recency
  const rec = recencyFit(role);
  breakdown.recency = rec.score * (weights.weights.recency ?? 0);

  // Contract flexibility (from classifier)
  const flex = contractFlexibility(classification);
  breakdown.contract_flexibility = flex.score * (weights.weights.contract_flexibility ?? 0);
  if (flex.reason !== "no flexibility signals") reasons.push(`flexibility: ${flex.reason}`);

  // Red-flag penalties (from classifier)
  let penalty = 0;
  for (const f of classification.red_flags) {
    const p = (weights.red_flag_penalties as any)[f] ?? 0;
    penalty += p;
    reasons.push(`red flag: ${f} (-${p})`);
  }

  // Bonuses (additive, from classifier)
  let bonus = 0;
  for (const b of classification.bonuses) {
    const v = (weights.bonuses as any)[b] ?? 0;
    bonus += v;
    if (v > 0) reasons.push(`bonus: ${b} (+${v})`);
  }

  const matchedResumeId = classification.matched_resume_id;
  if (matchedResumeId) {
    const resumePriorityBonus = weights.resume_priority_bonuses?.[matchedResumeId] ?? 0;
    bonus += resumePriorityBonus;
    if (resumePriorityBonus > 0) reasons.push(`resume priority: ${matchedResumeId} (+${resumePriorityBonus})`);
  }

  // Sum normalised contributions to a 0-100 scale, then apply bonuses/penalties
  const summed = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const baseScore = Math.max(0, Math.min(100, summed * 100 + bonus - penalty));

  // Discipline gate (2026-09-15). The classifier names the role's primary
  // discipline band; the scorer caps profile_relevance by it so a senior
  // title, government sector or remote arrangement can never lift a product
  // specialist role (Maximo, Security, Network, Data architect) into the
  // shortlist range. Classifications recorded before the gate existed carry
  // no band and are left uncapped.
  const disciplineCaps: Record<string, number> = {
    outside: weights.thresholds?.discipline_cap_outside ?? 25,
    adjacent: weights.thresholds?.discipline_cap_adjacent ?? 54,
    platform_gap: weights.thresholds?.discipline_cap_platform_gap ?? 74,
  };
  const disciplineFit = (classification as { discipline_fit?: string }).discipline_fit;
  let relevance = classification.profile_relevance;
  if (disciplineFit && disciplineCaps[disciplineFit] != null && relevance > disciplineCaps[disciplineFit]) {
    reasons.push(`discipline gate: ${disciplineFit} caps relevance ${relevance} → ${disciplineCaps[disciplineFit]}`);
    relevance = disciplineCaps[disciplineFit];
  }

  // Relevance-led composite (2026-09-15). profile_relevance is the agent's
  // read of whether the user would be shortlisted on the evidence; the
  // weighted base carries arrangement, rate, recency and tag overlap, which
  // SEEK cards often leave blank. The old multiplier let a sparse card bury a
  // 90-relevance role at 35 while a 45-relevance role sat at 37, so neither
  // number separated winners from noise. Relevance now carries most of the
  // weight and the base adjusts within it.
  const relevanceWeight = weights.weights.profile_relevance ?? 0.65;
  let score = Math.round(relevance * relevanceWeight + baseScore * (1 - relevanceWeight));
  reasons.push(`profile relevance: ${classification.profile_relevance}/100 (${classification.detected_domain}${disciplineFit ? `, ${disciplineFit}` : ""}) — ${classification.profile_relevance_reason} → ${relevance} × ${relevanceWeight.toFixed(2)} + base ${Math.round(baseScore)} × ${(1 - relevanceWeight).toFixed(2)}`);

  // A role with no credible resume positioning cannot be applied to, so it
  // can never be a shortlist candidate whatever the numbers say.
  const noPositioning = classification._classifier === "agent" && !classification.matched_resume_id;
  if (noPositioning) reasons.push("blocker: no active resume positioning fits (matched_resume_id null)");

  const red_flag_blocker =
    classification.red_flags.some((f) => f === "onsite_5_days" || f === "junior_or_mid_level" || f === "exclusive_engagement" || f === "inside_ir35_equivalent" || f === "permanent_or_full_time")
    || relevance < 25   // wholly-irrelevant roles are also blockers
    || noPositioning;

  // Low relevance never shortlists, however attractive the arrangement.
  const lowRelevanceMax = weights.thresholds?.low_relevance_max ?? 50;
  const lowRelevanceCap = weights.thresholds?.low_relevance_score_cap ?? 40;
  if (relevance < lowRelevanceMax && score > lowRelevanceCap) {
    reasons.push(`relevance ${relevance} < ${lowRelevanceMax}: score capped at ${lowRelevanceCap}`);
    score = lowRelevanceCap;
  }

  // Interstate roles (2026-09-15): the user applies to roles outside the
  // home city only when the ad is remote or reads as location-flexible. An
  // interstate role that requires routine onsite attendance keeps its fit
  // score but is reported with a parked_reason, and the rescore moves it to
  // the `parked` status so the shortlist stays the actionable queue.
  const homeCity = profile.homeCity;
  const locFlex = (classification as { location_flexibility?: string }).location_flexibility;
  const isInterstate = Boolean(homeCity && role.location && !new RegExp(`${homeCity}|NSW|Remote`, "i").test(role.location));
  let parked_reason: string | undefined;
  if (isInterstate && locFlex === "onsite") {
    parked_reason = `interstate onsite (${role.location}); apply only if remote or flexible`;
    reasons.push(`parked: ${parked_reason}`);
  } else if (isInterstate && locFlex === "unknown") {
    parked_reason = `interstate (${role.location}) with card-only blurb; location flexibility unknown`;
    reasons.push(`parked: ${parked_reason}`);
  } else if (isInterstate && (locFlex === "remote" || locFlex === "flexible")) {
    reasons.push(`interstate but ${locFlex}: ${(classification as { location_flexibility_quote?: string }).location_flexibility_quote ?? ""}`.trim());
  }

  // Blockers cap the score so the Sheet ordering matches the pipeline decision.
  const blockerCap = weights.thresholds?.blocker_score_cap ?? 30;
  if (red_flag_blocker && score > blockerCap) {
    reasons.push(`blocker present: score capped at ${blockerCap}`);
    score = blockerCap;
  }

  // SEEK cards frequently omit rate, posting timestamp and detailed skill text.
  // Keep a guarded floor for a blocker-free contract the agent has explicitly
  // judged an excellent match. The floor only applies to production agent
  // classifications, never regex triage.
  const highRelevanceMin = weights.thresholds?.high_agent_relevance_min ?? 90;
  if (
    classification._classifier === "agent"
    && classification.is_contract
    && !red_flag_blocker
    && classification.matched_resume_id
    && relevance >= highRelevanceMin
  ) {
    const generalFloor = weights.thresholds?.high_agent_relevance_score_floor ?? 60;
    const appliedAiFloor = weights.thresholds?.applied_ai_high_relevance_score_floor ?? generalFloor;
    const floor = classification.matched_resume_id === "applied-ai" ? appliedAiFloor : generalFloor;
    if (score < floor) {
      score = floor;
      reasons.push(`reasoning floor: blocker-free ${classification.matched_resume_id} contract at ${relevance}/100 relevance → ${floor}`);
    }
  }

  // Advisory band. Computed from the same inputs but kept strictly out of
  // `score`, `breakdown` and `red_flag_blocker` so ranking and the Sheet's
  // existing columns are unchanged.
  const termSignals = classification as unknown as TermSignals;
  const fit_verdict = computeFitVerdict({
    requiredTerms: stringList(termSignals.required_terms),
    preferredTerms: stringList(termSignals.preferred_terms),
    taxonomy,
    overallOverlapPct: skillsNorm * 100,
  });

  return { score, reasons, red_flag_blocker, breakdown, classification, fit_verdict, parked_reason };
}

async function main() {
  const argv = process.argv.slice(2);
  let roleFile = "";
  let useStdin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--role-file") roleFile = argv[++i];
    else if (argv[i] === "--stdin") useStdin = true;
  }
  let roleJson = "";
  if (roleFile) roleJson = await fs.readFile(roleFile, "utf8");
  else if (useStdin) {
    roleJson = await new Promise<string>((res) => {
      let acc = "";
      process.stdin.on("data", (d) => (acc += d.toString()));
      process.stdin.on("end", () => res(acc));
    });
  } else {
    console.error("Usage: tsx tools/score.ts (--role-file <path> | --stdin)");
    process.exit(2);
  }
  const role: Role = JSON.parse(roleJson);
  const result = await scoreRole(role);
  console.log(JSON.stringify(result, null, 2));
}

// Run main only when this file is invoked directly (not when imported by another tool).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
