/**
 * Canonical classification contract.
 *
 * Mechanical facts are extracted deterministically. Semantic decisions are
 * supplied by Jev, or by an explicitly identified attended agent fallback.
 * No caller may silently manufacture semantic fit when neither is available.
 */

import { sha256 } from "./lib/hash.ts";

export type DisciplineFit = "core" | "platform_gap" | "adjacent" | "outside";
export type ClassificationSource = "jev" | "agent_fallback" | "migrated_agent" | "deterministic_only";
export type ClassificationStatus = "automatic" | "uncertain" | "degraded" | "insufficient_input";
export type WorkArrangement = "remote" | "hybrid" | "onsite" | "unknown";
export type LocationFlexibility = "remote" | "flexible" | "onsite" | "unknown";

export type DecisionDistribution = {
  selected: string | number | boolean;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  margin: number | null;
};

export type ClassificationProvenance = {
  decision_id: string;
  content_hash: string;
  policy_hash: string;
  profile_hash: string;
  resume_set_hash: string;
  requested_model: string;
  effective_model: string | null;
  /** Stable identity of the Vercel route and transport, not an underlying model version. */
  gateway_route_fingerprint: string | null;
  /** Version reported by the provider, null while Vercel returns only its alias. */
  resolved_model_version: string | null;
  model_version_observable: boolean;
  created_at: string;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  recorded_response_cost_usd?: number | null;
  evaluation_mode?: "live" | "record" | "replay" | "migration" | "agent";
  cache_hit: boolean;
  zero_data_retention: true;
  question_set_hash?: string | null;
  /** Hash of every possible classification question and criterion for this profile. */
  question_schema_hash?: string | null;
  question_ids?: string[];
  /** Jev Choice and Score confidence came from TypeSafe provider metadata. */
  confidence_source?: "typesafe_provider_metadata" | "agent" | null;
  /** Previous Jev decision replaced by an attended fallback, when applicable. */
  supersedes_decision_id?: string | null;
};

export type ClassificationV2 = {
  schema_version: 2;
  source: ClassificationSource;
  status: ClassificationStatus;
  red_flags: ("exclusive_engagement" | "onsite_5_days" | "inside_ir35_equivalent" | "junior_or_mid_level" | "no_remote_at_all" | "unknown_recruiter_low_quality" | "permanent_or_full_time" | "clearance_required")[];
  bonuses: ("fully_remote" | "short_term_contract" | "rate_above_target_band" | "australian_government" | "servicenow_or_salesforce_or_m365" | "fractional_or_part_time_explicit" | "home_city")[];
  work_arrangement: WorkArrangement;
  day_rate: { min: number | null; max: number | null; currency: string; inc_super: boolean | null; stated_explicitly: boolean };
  seniority: "junior" | "mid" | "senior" | "lead" | "principal" | "director" | "unknown";
  contract_length_months: number | null;
  is_contract: boolean;
  requires_exclusivity: boolean;
  requires_payg: boolean;
  industry: string | null;
  short_summary: string;
  profile_relevance: number;
  profile_relevance_reason: string;
  detected_domain: string;
  discipline_fit: DisciplineFit;
  location_flexibility: LocationFlexibility;
  location_flexibility_quote: string;
  matched_resume_id: string | null;
  resume_match_explanation: string;
  requires_tailoring: boolean;
  tailoring_rationale: string;
  decisions: Record<string, DecisionDistribution | null>;
  provenance: ClassificationProvenance;
};

export type MechanicalClassification = Pick<ClassificationV2,
  "red_flags" | "bonuses" | "work_arrangement" | "day_rate" | "seniority" |
  "contract_length_months" | "is_contract" | "requires_exclusivity" |
  "requires_payg" | "industry" | "short_summary" | "location_flexibility" |
  "location_flexibility_quote"
>;

export function classificationContentHash(input: { title: string; description: string; location?: string }): string {
  return sha256(JSON.stringify({ title: input.title.trim(), description: input.description.trim(), location: input.location?.trim() ?? "" }));
}

/** A channel's Contract/Temp label does not establish independent contracting. */
export function isExplicitFixedTermEmployment(text: string): boolean {
  const normalised = text.toLowerCase().replace(/[\u2010-\u2015]/g, "-");
  const fixedTerm = /\bfixed[- ]term\b/.test(normalised);
  const employeeTerms = /\b(?:employee benefits|paid parental leave|leave loading|competitive salar(?:y|ies)|your development will be managed|conversion to a permanent role)\b/.test(normalised);
  const contractorAlternative = /\b(?:abn|independent contractor|day[- ]rate|daily rate|freelance)\b/.test(normalised);
  return fixedTerm && employeeTerms && !contractorAlternative;
}

/** Extract only facts that are explicit enough to be mechanically repeatable. */
export function extractMechanicalClassification(
  title: string,
  description: string,
  opts: { currency?: string; location?: string } = {},
): MechanicalClassification {
  const text = `${title}\n${description}`;
  const lc = text.toLowerCase();
  const red_flags: MechanicalClassification["red_flags"] = [];
  const bonuses: MechanicalClassification["bonuses"] = [];
  if (/(onsite|on-site|in.?office).{0,30}(5 days|five days|full[- ]time)|(5 days|five days).{0,30}(onsite|on-site|in.?office)/.test(lc)) red_flags.push("onsite_5_days");
  if (/payg only|paye only|inside ir35|standard payroll|via (our|the) payroll only/.test(lc)) red_flags.push("inside_ir35_equivalent");
  if (/\b(junior|mid[- ]level|graduate|early career)\b/.test(lc)) red_flags.push("junior_or_mid_level");
  if (/no remote|in-office only|office based only/.test(lc)) red_flags.push("no_remote_at_all");
  if (/exclusive(?:ity)? (?:engagement|agreement|contract)|no other (?:work|concurrent|clients)|non[- ]compete/.test(lc)) red_flags.push("exclusive_engagement");
  if (/(?:must|required to) (?:currently |already )?(?:hold|have|possess) (?:an? )?(?:active |current |existing )?(?:baseline|nv1|nv2|pv|tspv)(?: security)? clearance|(?:active|current|existing) (?:baseline|nv1|nv2|pv|tspv)(?: security)? clearance (?:is )?required/.test(lc)) red_flags.push("clearance_required");
  const contractSignal = /\b(contract|contractor|contracting|freelance|fractional|interim|day rate)\b/.test(lc);
  const employeeSignal = /\b(permanent|fte|full[- ]time employee|permanent full[- ]time)\b/.test(lc);
  const fixedTermEmployee = isExplicitFixedTermEmployment(text);
  if (fixedTermEmployee || (employeeSignal && !contractSignal)) red_flags.push("permanent_or_full_time");

  let work_arrangement: WorkArrangement = "unknown";
  let location_flexibility: LocationFlexibility = "unknown";
  let location_flexibility_quote = "";
  const remote = text.match(/.{0,35}(fully remote|100% remote|work from anywhere|remote-first|based anywhere).{0,35}/i);
  const flexibleMatch = text.match(/.{0,35}(all major cities|interstate candidates|any state|occasional travel|national programme|open to (?:other|alternative) locations).{0,35}/i);
  const flexible = flexibleMatch && !/\bnot(?:\s+\w+){0,2}\s+open to (?:other|alternative) locations/i.test(flexibleMatch[0]) ? flexibleMatch : null;
  const hybrid = text.match(/.{0,35}(hybrid|\d days? (?:per week|a week) (?:in|at) (?:the )?office).{0,35}/i);
  const onsite = text.match(/.{0,35}(onsite|on-site|office-based|in-office).{0,35}/i);
  if (remote) {
    work_arrangement = "remote"; location_flexibility = "remote"; location_flexibility_quote = remote[0].trim(); bonuses.push("fully_remote");
  } else if (hybrid) {
    work_arrangement = "hybrid"; location_flexibility = flexible ? "flexible" : "onsite"; location_flexibility_quote = (flexible?.[0] ?? hybrid[0]).trim();
  } else if (onsite) {
    work_arrangement = "onsite"; location_flexibility = "onsite"; location_flexibility_quote = onsite[0].trim();
  } else if (flexible) {
    location_flexibility = "flexible"; location_flexibility_quote = flexible[0].trim();
  }

  if (/\b(part[- ]?time|fractional|few days a week|flexible hours)\b/.test(lc)) bonuses.push("fractional_or_part_time_explicit");
  if (/\b(1|2|3)[- ]month|short[- ]term|short engagement|short contract\b/.test(lc)) bonuses.push("short_term_contract");
  if (/\b(servicenow|salesforce|microsoft 365|m365|sharepoint)\b/.test(lc)) bonuses.push("servicenow_or_salesforce_or_m365");
  if (/\b(nsw government|service nsw|revenue nsw|nsw department|federal government|australian government)\b/.test(lc)) bonuses.push("australian_government");

  let seniority: MechanicalClassification["seniority"] = "unknown";
  if (/\b(director|head of)\b/i.test(title)) seniority = "director";
  else if (/\bprincipal\b/i.test(title)) seniority = "principal";
  else if (/\blead\b|engineering manager|delivery manager/i.test(title)) seniority = "lead";
  else if (/\bsenior\b|architect/i.test(title)) seniority = "senior";
  else if (/\bjunior\b|graduate/i.test(title)) seniority = "junior";
  else if (/\bmid[- ]level\b/i.test(title)) seniority = "mid";

  const rate = lc.match(/\$\s*(\d{2,4})(?:\s*(?:-|to)\s*\$?\s*(\d{2,4}))?\s*(?:\/|per\s*)?day/);
  const normaliseRate = (raw: string | undefined): number | null => raw ? Number(raw) * (Number(raw) < 100 ? 100 : 1) : null;
  const length = lc.match(/(\d{1,2})[- ]month(?:s|\s|$)/);
  const summary = description.replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    red_flags,
    bonuses,
    work_arrangement,
    day_rate: {
      min: normaliseRate(rate?.[1]), max: normaliseRate(rate?.[2]), currency: opts.currency ?? "AUD",
      inc_super: /inc\.?\s*super|including super/.test(lc) ? true : /\+\s*super|ex(?:cluding)?\s*super/.test(lc) ? false : null,
      stated_explicitly: Boolean(rate),
    },
    seniority,
    contract_length_months: length ? Number(length[1]) : null,
    is_contract: contractSignal && !employeeSignal && !fixedTermEmployee,
    requires_exclusivity: red_flags.includes("exclusive_engagement"),
    requires_payg: red_flags.includes("inside_ir35_equivalent"),
    industry: /nsw government/.test(lc) ? "NSW government" : /\b(bank|insurance|fintech)\b/.test(lc) ? "financial services" : null,
    short_summary: summary,
    location_flexibility,
    location_flexibility_quote,
  };
}

export function canPromoteFromClassification(c: ClassificationV2 | undefined): boolean {
  return Boolean(c && c.schema_version === 2 && c.status === "automatic" && (c.source === "jev" || c.source === "agent_fallback") && c.matched_resume_id);
}

export function canAuthoriseApplication(c: ClassificationV2 | undefined): boolean {
  return canPromoteFromClassification(c);
}

export function canSatisfyAutopilotClassificationGate(c: ClassificationV2 | undefined): boolean {
  return Boolean(c && c.schema_version === 2 && c.status === "automatic" && (c.source === "jev" || c.source === "agent_fallback") && c.matched_resume_id);
}
