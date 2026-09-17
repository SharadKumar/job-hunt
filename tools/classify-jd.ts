#!/usr/bin/env tsx
/**
 * classify-jd.ts — JD classification utility for the harness.
 *
 * Architectural note (post-refactor): reasoning-heavy classification
 * (judgement of profile_relevance, matched_resume_id, red flags, bonuses)
 * now happens IN-AGENT. The agent (Claude Code or Codex CLI in interactive
 * mode, or via `claude -p` for the headless launchd path) reads the JD,
 * reads resumes.yaml + profile context, and produces the Classification
 * shape directly using its own LLM context. This module:
 *
 *   1. Defines the Classification schema (the canonical shape all agents
 *      and consumers conform to).
 *   2. Provides a regex-only fast-path for triage (high-volume scrape
 *      pre-filter, no judgement required).
 *   3. Provides validation + write helpers the agent can call once it has
 *      a classification ready.
 *
 * No external LLM calls. No API key. The agent does the LLM work.
 *
 * CLI:
 *   tsx tools/classify-jd.ts --regex --jd path --title "..."
 *     → returns regex-only classification (fast, weak)
 *   tsx tools/classify-jd.ts --schema
 *     → prints the JSON schema the agent should fill in
 */

import { promises as fs } from "node:fs";
import { repoPath } from "./repo-root.ts";

export type Classification = {
  // Canonical red-flag IDs that map to scoring-weights.yaml.red_flag_penalties
  red_flags: ("exclusive_engagement" | "onsite_5_days" | "inside_ir35_equivalent" | "junior_or_mid_level" | "no_remote_at_all" | "unknown_recruiter_low_quality" | "permanent_or_full_time")[];

  // Canonical bonus IDs that map to scoring-weights.yaml.bonuses
  bonuses: ("fully_remote" | "short_term_contract" | "rate_above_target_band" | "australian_government" | "servicenow_or_salesforce_or_m365" | "fractional_or_part_time_explicit")[];

  work_arrangement: "remote" | "hybrid" | "onsite" | "unknown";

  // Day rate explicit in the posting (AUD assumed unless stated)
  day_rate: {
    min: number | null;
    max: number | null;
    currency: string;
    inc_super: boolean | null;
    stated_explicitly: boolean;
  };

  seniority: "junior" | "mid" | "senior" | "lead" | "principal" | "director" | "unknown";
  contract_length_months: number | null;        // null if unstated or permanent
  is_contract: boolean;                          // false if permanent / fixed-term employee
  requires_exclusivity: boolean;
  requires_payg: boolean;                        // PAYG-only vs ABN-allowed
  industry: string | null;                       // free text, short
  short_summary: string;                         // 2-3 sentence neutral summary

  // Fit against the user's profile (0-100). Load-bearing: this is a
  // MULTIPLIER on the final score, with a guarded high-relevance floor for
  // blocker-free contracts. A role that's
  // genuinely irrelevant to the user's profession (e.g. GPU datacenter
  // hardware role for an enterprise IT architect) gets crushed regardless
  // of how remote / fractional / senior-titled it is.
  profile_relevance: number;
  profile_relevance_reason: string;               // 1-sentence why
  detected_domain: string;                        // e.g. "enterprise IT consulting", "GPU/AI infra"

  // Discipline gate (2026-09-15). The role's PRIMARY discipline, read from the
  // title noun and the must-have list, against the user's role families and
  // evidence base:
  //   core          the discipline is one the user has delivered (architect,
  //                 delivery/programme lead, engineering lead, AI engineering)
  //   platform_gap  same discipline, but built around a named platform or
  //                 product the user has not delivered and could only prepare
  //                 for (e.g. Solution Architect on Guidewire)
  //   adjacent      a neighbouring discipline the user could argue into
  //                 (e.g. change lead, technical BA, product manager)
  //   outside       a different discipline or a product specialist (security,
  //                 network, data architect, Maximo/Pega/SAP lead, test manager)
  // The deterministic scorer caps profile_relevance by this band, so an
  // "outside" role can never sit above 25 whatever else the JD offers.
  discipline_fit: "core" | "platform_gap" | "adjacent" | "outside";

  // Location flexibility (2026-09-15). Whether a role advertised in another
  // city could be done from the user's home city:
  //   remote     fully remote / remote-first / based anywhere
  //   flexible   hybrid or unspecified but the ad signals openness to other
  //              locations (any state, all major cities, interstate welcome,
  //              lists several states, occasional travel only)
  //   onsite     routine attendance in the advertised city, or hybrid there
  //              with no flexibility wording
  //   unknown    card blurb only, cannot tell
  // Paired with the exact wording that decided it, so the Sheet shows why.
  location_flexibility: "remote" | "flexible" | "onsite" | "unknown";
  location_flexibility_quote: string;

  // Which active resume positioning from resumes.yaml best matches this opportunity.
  // The /apply draft orchestration uses this to pick the CV variant +
  // cover-letter angle. null = no active resume is a credible match (the opportunity-finder
  // should not promote to shortlist).
  matched_resume_id: string | null;
  resume_match_explanation: string;               // 1-sentence why this resume won

  // Tailoring decision (made at classification time). Default policy is
  // baseline-by-default: the resume's approved baseline CV is sent as-is,
  // and only the cover letter is per-opp. We tailor the CV itself only
  // when (a) score is high (top decile / ≥ 80) AND (b) the JD demands
  // specifics the resume's baseline doesn't already surface AND (c) the
  // user hasn't flagged this opp for "no-tailoring" treatment.
  // false = use resume's approved baseline (the common case).
  // true  = exception path — run cv-tailor for this opportunity.
  requires_tailoring: boolean;
  tailoring_rationale: string;                    // 1-sentence why (or why not)

  // "agent" = the agent (Claude Code / Codex CLI session) classified inline using its own LLM context.
  // "regex" = the regex-only triage classifier (fast, weak).
  _classifier: "agent" | "regex";
};

const SYSTEM_PREFIX = `You classify job postings into a strict JSON schema for an automated harness, scoring relevance against the user's actual profile. Use the tool provided.

# USER PROFILE CONTEXT (the bar for profile_relevance)

`;

const SYSTEM_SUFFIX = `

# Reasoning rules

- **Start with the discipline gate, then score relevance inside its band.** Read the PRIMARY discipline from the title noun and the must-have list, and set "discipline_fit":
  - "core" (relevance 75-100): the discipline is one the user has actually delivered per the profile's role families and evidence (solution/enterprise/digital architect, delivery manager / programme lead / project manager, engineering lead, applied AI / AI engineering, AI governance / AI assurance / responsible-AI leadership, M365 consulting). Within the band, 90+ means the JD's must-haves are all evidenced; 75-89 means one or two must-haves are thin.
  - "platform_gap" (relevance 55-74): same discipline, but the JD is built around a named platform or product the user has not delivered and could only prepare for (Solution Architect on Guidewire, Delivery Lead for a Workday programme). The higher the platform dominates the JD, the lower in the band.
  - "adjacent" (relevance 30-54): a neighbouring discipline the user could argue into from evidence (change lead, technical BA, product manager, service delivery manager, consultant).
  - "outside" (relevance 0-25): a different discipline, or a product/technology specialist the evidence does not support. This includes Security Architect, Network Architect, Data Architect / Data Engineer, Test Manager, DBA, Maximo / Pega / SAP / Salesforce-developer leads, infrastructure and network project managers, finance/ERP transformation, generic technology-risk controls testing (CISA/CRISC audit roles). AI governance, AI assurance and AI testing leadership are NOT outside: the evidence base includes a 68-control Claude Enterprise tenant governance audit framed on ISO 42001 and NIST AI RMF, so those roles are core for the applied-ai positioning. A senior title, government sector, architecture wording or "technical lead" scope does NOT lift an outside role out of this band. If the user would never be shortlisted on the evidence, it is outside.
- **Relevance measures fit to the evidence, nothing else.** Work arrangement, remote/hybrid, rate, location, contract length, sector and seniority are scored elsewhere and must not move "profile_relevance" or appear in "profile_relevance_reason". A remote, short, well-paid Security Architect contract is still "outside" at 15.
- **matched_resume_id must be null for "outside"**, and may be null for "adjacent" when no positioning could honestly carry the application. A resume is chosen because the positioning fits the discipline, never because the role is senior or cloud-adjacent.
- Generic “data” or “database” language is not a fit signal. Treat pure data engineering, DataOps, ETL, BI/reporting, data modelling, DBA/database administration and data-science roles as "outside" unless the job is principally enterprise architecture, programme/delivery leadership, or evidence-backed M&A/separation work.
- **Be honest, not generous.** An inflated relevance shortlists a role the user cannot win; a false negative buries a strong contract. When the JD text is only a search-card blurb, score from the title and blurb and say so in "profile_relevance_reason".
- **location_flexibility** answers one question: could a candidate based in the profile's home city do this role? "remote" for fully remote / remote-first / based anywhere; "flexible" when the ad signals openness to other locations (any state, all major cities, interstate candidates welcome, lists several states, occasional travel only, national programme with WFH); "onsite" when it requires routine attendance in the advertised city, including hybrid in that city with no flexibility wording; "unknown" for a card blurb. Put the exact deciding phrase in location_flexibility_quote (empty string when unknown). A company name containing "National" is not a flexibility signal.
- detected_domain is the role's domain in 2-5 words (e.g. "enterprise IT consulting", "GPU/AI infra", "DevOps/SRE for B2B SaaS", "embedded firmware", "MarTech full-stack web").
- profile_relevance_reason: ONE sentence naming the discipline call and the evidence that supports or fails it.

- Detect red flags from semantics, not keyword matches. "Looking for someone who can dedicate themselves fully" implies exclusive_engagement even without the word "exclusive". "Standard payroll arrangement" implies inside_ir35_equivalent / PAYG.
- "Junior" / "mid-level" / "graduate" / "early career" → junior_or_mid_level.
- Permanent, FTE, or full-time employee-only role → permanent_or_full_time and is_contract=false. A genuine contractor engagement may require full-time hours; do not flag that as employee-only.
- "Must be in-office" / "5 days a week onsite" / "office-based role" → onsite_5_days.
- "Fully remote" / "work from anywhere" / "100% remote" → bonus fully_remote + arrangement=remote.
- "Hybrid 2-3 days" → arrangement=hybrid, not a red flag.
- Day rate: extract numeric min/max if stated. AUD assumed for AU postings. Note inc_super if stated. If the posting says "negotiable" / "competitive" / "TBD" treat stated_explicitly=false.
- Seniority: infer from title + scope hints, not title alone. "Architect"/"Lead"/"Principal"/"Staff" → senior/lead/principal. A developer/engineer role that explicitly leads a capability, mentors squads, owns architecture or drives adoption is lead or senior, not automatically mid. "Director" → director. Default to senior for senior IT contracts when unclear.
- Contract length: extract months if stated ("6 month contract" → 6, "3 months with extension" → 3, "12-month engagement" → 12). null if unstated or permanent.
- is_contract: true for contract/contractor/day-rate roles; false for permanent/FTE.
- requires_exclusivity: true only if posting explicitly forbids concurrent work / requires non-compete on consulting.
- requires_payg: true if posting says PAYG/PAYE/employment-only / forbids ABN / "via our payroll only".
- Industry: short free-text (e.g. "NSW government", "banking", "fintech", "retail").
- Be conservative. Only flag what's clearly indicated. Unknown beats guessed.`;

const TOOL = {
  name: "report_classification",
  description: "Return the structured classification for this job posting.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      red_flags: { type: "array", items: { type: "string", enum: ["exclusive_engagement", "onsite_5_days", "inside_ir35_equivalent", "junior_or_mid_level", "no_remote_at_all", "unknown_recruiter_low_quality", "permanent_or_full_time"] } },
      bonuses: { type: "array", items: { type: "string", enum: ["fully_remote", "short_term_contract", "rate_above_target_band", "australian_government", "servicenow_or_salesforce_or_m365", "fractional_or_part_time_explicit"] } },
      work_arrangement: { type: "string", enum: ["remote", "hybrid", "onsite", "unknown"] },
      day_rate: {
        type: "object",
        additionalProperties: false,
        properties: {
          min: { type: ["number", "null"] },
          max: { type: ["number", "null"] },
          currency: { type: "string" },
          inc_super: { type: ["boolean", "null"] },
          stated_explicitly: { type: "boolean" },
        },
        required: ["min", "max", "currency", "inc_super", "stated_explicitly"],
      },
      seniority: { type: "string", enum: ["junior", "mid", "senior", "lead", "principal", "director", "unknown"] },
      contract_length_months: { type: ["number", "null"] },
      is_contract: { type: "boolean" },
      requires_exclusivity: { type: "boolean" },
      requires_payg: { type: "boolean" },
      industry: { type: ["string", "null"] },
      short_summary: { type: "string" },
      profile_relevance: { type: "number", minimum: 0, maximum: 100 },
      profile_relevance_reason: { type: "string" },
      detected_domain: { type: "string" },
      discipline_fit: { type: "string", enum: ["core", "platform_gap", "adjacent", "outside"], description: "primary-discipline gate; the scorer caps profile_relevance at 25 / 54 / 74 for outside / adjacent / platform_gap" },
      location_flexibility: { type: "string", enum: ["remote", "flexible", "onsite", "unknown"], description: "could the user do this from their home city; onsite = routine attendance in the advertised city" },
      location_flexibility_quote: { type: "string", description: "exact wording from the ad that decided location_flexibility; empty when unknown" },
      matched_resume_id: { type: ["string", "null"], description: "id of an active resume positioning in resumes.yaml, or null if no positioning is a credible match" },
      resume_match_explanation: { type: "string" },
      requires_tailoring: { type: "boolean", description: "false unless the JD genuinely demands specifics the resume's baseline CV doesn't already surface AND profile_relevance is high (≥80)" },
      tailoring_rationale: { type: "string", description: "1-sentence why this opp needs per-opp CV tailoring, or why baseline suffices" },
    },
    required: ["red_flags", "bonuses", "work_arrangement", "day_rate", "seniority", "contract_length_months", "is_contract", "requires_exclusivity", "requires_payg", "industry", "short_summary", "profile_relevance", "profile_relevance_reason", "detected_domain", "discipline_fit", "location_flexibility", "location_flexibility_quote", "matched_resume_id", "resume_match_explanation", "requires_tailoring", "tailoring_rationale"],
  },
};

/** Load profile context for the classifier's profile_relevance check. Cached at module level. */
let profileContextCache: string | null = null;
async function loadProfileContext(): Promise<string> {
  if (profileContextCache !== null) return profileContextCache;
  try {
    const profile = await fs.readFile(repoPath("state/profile/profile.md"), "utf8");
    // Pull the holistic CV's Professional Summary section as classifier context.
    // The full cv-source.md is too long; just the summary captures enough signal
    // for profile_relevance scoring.
    const cvSource = await fs.readFile(repoPath("state/profile/cv-source.md"), "utf8").catch(() => "");
    const summary = (cvSource.match(/##\s+Professional\s+Summary\s*\n+([\s\S]*?)(?=\n##|$)/i)?.[1] ?? "").trim();
    const taxonomy = await fs.readFile(repoPath("state/profile/skills-taxonomy.yaml"), "utf8").catch(() => "");
    // Extract just the role targets + work arrangement + a compact skills list
    const roleFamilies = (profile.match(/## Engagement targets[\s\S]*?(?=\n##|$)/i)?.[0] ?? "").trim();
    const workArr = (profile.match(/## Work arrangement[\s\S]*?(?=\n##|$)/i)?.[0] ?? "").trim();
    const redFlags = (profile.match(/## Red flags[\s\S]*?(?=\n##|$)/i)?.[0] ?? "").trim();
    profileContextCache = [
      `## CV summary`, summary,
      ``, roleFamilies,
      ``, workArr,
      ``, redFlags,
      ``, `## Skill taxonomy (canonical domains the user works in)`, taxonomy.slice(0, 5000),
    ].join("\n");
  } catch (e) {
    profileContextCache = "(profile context unavailable)";
  }
  return profileContextCache;
}

/** Conservative regex fallback used when ANTHROPIC_API_KEY is missing. */
function regexClassify(title: string, jd: string): Classification {
  const text = `${title}\n${jd}`;
  const lc = text.toLowerCase();
  const red_flags: Classification["red_flags"] = [];
  const bonuses: Classification["bonuses"] = [];
  if (/(onsite|on-site|in.?office).{0,20}(5 days|five days|full[- ]time)/.test(lc)) red_flags.push("onsite_5_days");
  if (/payg only|paye only|inside ir35|standard payroll/.test(lc)) red_flags.push("inside_ir35_equivalent");
  if (/\b(junior|mid[- ]level|graduate|early career)\b/.test(lc)) red_flags.push("junior_or_mid_level");
  if (/no remote|in-office only/.test(lc)) red_flags.push("no_remote_at_all");
  if (/exclusive(?:ity)? (?:engagement|agreement|contract)|no other (?:work|concurrent|clients)|non[- ]compete/.test(lc)) red_flags.push("exclusive_engagement");
  const hasContractSignal = /\b(contract|contractor|contracting|freelance|fractional|part[- ]time|interim)\b/.test(lc);
  if (/\b(permanent|fte|full[- ]time employee|full[- ]time role)\b/.test(lc) && !hasContractSignal) red_flags.push("permanent_or_full_time");

  let arrangement: Classification["work_arrangement"] = "unknown";
  if (/fully remote|100% remote|work from anywhere|\bremote\b/.test(lc) && !/hybrid/.test(lc)) { arrangement = "remote"; bonuses.push("fully_remote"); }
  else if (/hybrid|\d days?\s*(per week|a week|onsite)/.test(lc)) arrangement = "hybrid";
  else if (/onsite|on-site|office-based/.test(lc)) arrangement = "onsite";

  if (/\b(part[- ]?time|fractional|few days a week|2-3 days|flexible hours)\b/.test(lc)) bonuses.push("fractional_or_part_time_explicit");
  if (/\b(3 month|3-month|three month|short[- ]term|2 month|short engagement|short contract)\b/.test(lc)) bonuses.push("short_term_contract");
  if (/\b(servicenow|salesforce|microsoft 365|m365|sharepoint)\b/.test(lc)) bonuses.push("servicenow_or_salesforce_or_m365");
  if (/\b(nsw government|service nsw|revenue nsw|nsw dept|nsw department|federal government|australian government)\b/.test(lc)) bonuses.push("australian_government");

  let seniority: Classification["seniority"] = "unknown";
  if (/director|head of/i.test(title)) seniority = "director";
  else if (/principal/i.test(title)) seniority = "principal";
  else if (/\blead\b|engineering lead|delivery manager/i.test(title)) seniority = "lead";
  else if (/senior|architect/i.test(title)) seniority = "senior";
  else if (/junior|graduate/i.test(title)) seniority = "junior";

  const rateMatch = lc.match(/\$\s*(\d{2,4})(?:\s*[-–to]+\s*\$?\s*(\d{2,4}))?\s*(?:\/|per\s*)?day/);
  const min = rateMatch?.[1] ? Number(rateMatch[1]) * (Number(rateMatch[1]) < 100 ? 100 : 1) : null;
  const max = rateMatch?.[2] ? Number(rateMatch[2]) * (Number(rateMatch[2]) < 100 ? 100 : 1) : null;
  const lengthMatch = lc.match(/(\d{1,2})[- ]month(?:s|\s|$)/);
  const length = lengthMatch ? Number(lengthMatch[1]) : null;

  return {
    red_flags, bonuses, work_arrangement: arrangement,
    day_rate: { min, max, currency: "AUD", inc_super: /inc\.?\s*super|including super/.test(lc) ? true : /\+\s*super|ex(?:cluding)?\s*super/.test(lc) ? false : null, stated_explicitly: !!rateMatch },
    seniority,
    contract_length_months: length,
    is_contract: /\bcontract|contractor|day rate|fixed.term/.test(lc) && !/permanent only/.test(lc),
    requires_exclusivity: red_flags.includes("exclusive_engagement"),
    requires_payg: red_flags.includes("inside_ir35_equivalent"),
    industry: /nsw government/i.test(lc) ? "NSW government" : /bank|insurance|fintech/i.test(lc) ? "financial services" : null,
    short_summary: jd.slice(0, 200).replace(/\s+/g, " ").trim(),
    // Regex can't reliably judge profile fit — return a neutral 50 so scoring
    // doesn't crush all roles. The real classifier (Haiku) is the right tool here.
    profile_relevance: 50,
    profile_relevance_reason: "regex triage default (agent should re-classify for grounded judgement)",
    discipline_fit: "adjacent",
    location_flexibility: arrangement === "remote" ? "remote" : "unknown",
    location_flexibility_quote: "",
    detected_domain: "unknown",
    matched_resume_id: null,
    resume_match_explanation: "regex triage cannot match against active resumes",
    requires_tailoring: false,
    tailoring_rationale: "baseline-by-default; agent should re-classify to decide tailoring",
    _classifier: "regex",
  };
}

/**
 * The agent calls this with its own classification produced from reasoning.
 * Pure utility — validates the shape and tags the classifier source.
 */
export function adoptAgentClassification(c: Omit<Classification, "_classifier">): Classification {
  return { ...c, _classifier: "agent" as const };
}

/**
 * Regex-only classifier — fast, weak. Use when the agent isn't in the loop
 * (e.g. pre-filtering a 200-role hunt before the agent does grounded
 * classification on the subset that passes triage).
 */
export async function classifyJdRegex(title: string, description: string): Promise<Classification> {
  void loadProfileContext; // imported for future variants; suppress unused warning
  return regexClassify(title, description);
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  let useStdin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stdin") useStdin = true;
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  // --schema: print the JSON schema the agent should fill in
  if (a.schema === "true") {
    console.log(JSON.stringify(TOOL.input_schema, null, 2));
    return;
  }
  // --regex: regex-only triage classifier (no agent / no LLM)
  let title = a.title || "";
  let description = "";
  if (useStdin) {
    const raw = await new Promise<string>((res) => {
      let acc = ""; process.stdin.on("data", (d) => (acc += d.toString())); process.stdin.on("end", () => res(acc));
    });
    const obj = JSON.parse(raw);
    title = obj.title || title; description = obj.description || "";
  } else if (a.jd) {
    description = await fs.readFile(a.jd, "utf8");
  } else {
    console.error("Usage: tsx tools/classify-jd.ts --schema  |  --regex (--jd <path> --title '...' | --stdin)");
    process.exit(2);
  }
  const result = await classifyJdRegex(title, description);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
