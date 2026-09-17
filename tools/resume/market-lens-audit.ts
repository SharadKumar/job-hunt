#!/usr/bin/env tsx

import { sha256 } from "../lib/hash.ts";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { getResume, type MarketLens } from "../resumes.ts";
import { resolveProfileContext } from "../profile-context.ts";

type SignalStatus = "explicit" | "implicit" | "needs_confirmation" | "missing";

type AuditSignal = {
  signal: string;
  status: SignalStatus;
  matched_terms: string[];
  evidence_lines: number[];
  reason: string;
};

type AuditResult = {
  resume_id: string;
  profile_id: string | null;
  cv_source_hash: string;
  applied_terms: string[];
  implicit_terms_used: Array<{ term: string; source_signal: string; rationale: string }>;
  confirmation_needed: Array<{ signal: string; question: string; reason: string }>;
  open_questions: Array<{ signal: string; question: string; reason: string }>;
  source_update_required: Array<{ signal: string; question: string; reason: string }>;
  suppressed_confirmations: Array<{ signal: string; status: ConfirmationStatus; reason: string }>;
  missing_signals: string[];
  signals: AuditSignal[];
};

/**
 * `familiarity` (2026-09-11) is the fourth evidence-interview answer: the user
 * did NOT deliver the term but can credibly prepare and speak to it. It never
 * authorises a delivered-work claim — it authorises tier-2 familiarity framing
 * only (see resume-keywords.ts / resume-term-grounding.ts). Readers that do not
 * know the value must treat it as answered (never re-ask) rather than crash.
 */
export type ConfirmationStatus = "pending" | "confirmed" | "declined" | "not_applicable" | "familiarity";

/**
 * One row of market-confirmations.yaml. `kind` defaults to `market_signal`
 * (the original rows); `keyword` rows are written by the keyword approval loop
 * (resume-keywords.ts / the /apply and /resume-render skills) and carry the
 * extra optional fields below.
 */
export type MarketConfirmation = {
  resume_id?: string;
  kind?: "market_signal" | "keyword";
  /**
   * `person` means the answer is a fact about the CANDIDATE, not about the
   * positioning that happened to ask it, so it holds across every resume.
   * Keyword rows are always person-scoped (the resume_id records who asked).
   * Market-signal rows stay positioning-scoped.
   */
  scope?: "person" | "resume";
  signal: string;
  term?: string;
  category?: string;
  opportunity_id?: string;
  question?: string;
  proposed_phrasing?: string;
  evidence_hint?: string;
  origin?: "attended" | "daily";
  asked_at?: string;
  status: ConfirmationStatus;
  source_update_required?: boolean;
  source_patch?: string;
  source_ref?: string | null;
  notes?: string;
  updated_at?: string;
};

type MarketConfirmationsFile = {
  confirmations?: MarketConfirmation[];
};

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) out[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  return out;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function lineNumbersFor(text: string, needle: string): number[] {
  const wanted = normalise(needle);
  if (!wanted) return [];
  const out: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (normalise(line).includes(wanted)) out.push(index + 1);
  });
  return out;
}

function directSignalMatches(source: string, signal: string): number[] {
  const compactSignal = normalise(signal);
  const words = compactSignal.split(" ").filter((word) => word.length > 2);
  const direct = lineNumbersFor(source, signal);
  if (direct.length) return direct;
  if (!words.length) return [];
  const out: number[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const tokens = new Set(normalise(line).split(" ").filter(Boolean));
    const hits = words.filter((word) => tokens.has(word)).length;
    if (hits === words.length) out.push(index + 1);
  });
  return out;
}

function aliasSupport(lens: MarketLens, source: string, signal: string): { terms: string[]; lines: number[] } {
  const terms: string[] = [];
  const lines = new Set<number>();
  for (const [alias, rule] of Object.entries(lens.keyword_aliases ?? {})) {
    if (normalise(alias) !== normalise(signal)) continue;
    const patterns = rule.acceptable_if_source_mentions ?? [];
    const matchingPatterns = patterns.filter((pattern) => {
      const matchedLines = lineNumbersFor(source, pattern);
      matchedLines.forEach((line) => lines.add(line));
      return matchedLines.length > 0;
    });
    if (matchingPatterns.length) terms.push(alias);
  }
  return { terms: [...new Set(terms)], lines: [...lines].sort((a, b) => a - b) };
}

export async function readConfirmations(filePath: string): Promise<MarketConfirmation[]> {
  try {
    const parsed = YAML.parse(await fs.readFile(filePath, "utf8")) as MarketConfirmationsFile | null;
    return (parsed?.confirmations ?? []).filter((entry) => entry?.signal && entry?.status);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

/**
 * A `kind: keyword` row records what the PERSON has or has not done ("have you
 * delivered Terraform?"). That answer cannot change because a different
 * positioning asks it, so keyword rows are matched across resumes, on the term
 * or on any alias form of the same fact. `market_signal` rows stay scoped to
 * their positioning: the same signal phrase can legitimately mean different
 * things under two lenses.
 */
export function isPersonScoped(entry: MarketConfirmation): boolean {
  return entry.kind === "keyword" || entry.scope === "person";
}

export function matchingConfirmation(
  confirmations: MarketConfirmation[],
  resumeId: string,
  signal: string,
  question: string | null,
  options: { aliases?: string[] } = {},
): MarketConfirmation | null {
  const normalSignal = normalise(signal);
  const wanted = new Set([normalSignal, ...(options.aliases ?? []).map(normalise)].filter(Boolean));
  const normalQuestion = question ? normalise(question) : null;
  const matches = confirmations.filter((entry) => {
    const personScoped = isPersonScoped(entry);
    if (!personScoped && entry.resume_id && entry.resume_id !== resumeId) return false;
    if (personScoped) {
      // Alias forms only cross-match for person-scoped rows; a market_signal row
      // answers its own signal wording and nothing else.
      if ([entry.signal, entry.term].some((form) => form && wanted.has(normalise(form)))) return true;
    } else if (normalise(entry.signal) === normalSignal) {
      return true;
    }
    return Boolean(normalQuestion && entry.question && normalise(entry.question) === normalQuestion);
  });
  if (!matches.length) return null;
  // An answer beats an unanswered row, so a term answered under resume A is not
  // re-asked just because resume B still carries a stale `pending` row for it.
  // Among equals, the asking positioning's own row wins.
  return matches.find((e) => e.status !== "pending" && e.resume_id === resumeId)
    ?? matches.find((e) => e.status !== "pending")
    ?? matches.find((e) => e.resume_id === resumeId)
    ?? matches[0];
}

function signalFromQuestion(question: string): string {
  const [prefix] = question.split(":");
  if (prefix && prefix.length >= 4 && prefix.length <= 80 && prefix !== question) return prefix.trim();
  return question.replace(/\?$/, "").split(/\s+/).slice(0, 5).join(" ");
}

function addOpenQuestions(
  resumeId: string,
  lens: MarketLens,
  confirmations: MarketConfirmation[],
  alreadyReportedQuestions: Set<string>,
): AuditResult["open_questions"] {
  const openQuestions: AuditResult["open_questions"] = [];
  const add = (signal: string, question: string, reason: string) => {
    const key = normalise(question);
    if (!key || alreadyReportedQuestions.has(key)) return;
    alreadyReportedQuestions.add(key);
    openQuestions.push({ signal, question, reason });
  };

  for (const entry of confirmations) {
    if (entry.resume_id && entry.resume_id !== resumeId) continue;
    if (!entry.question) continue;
    if (entry.status === "pending") {
      add(entry.signal, entry.question, "Already asked; keep as an outstanding market/source-completion question.");
    }
  }

  for (const question of lens.proof_questions ?? []) {
    const prior = matchingConfirmation(confirmations, resumeId, signalFromQuestion(question), question);
    if (prior?.status === "declined" || prior?.status === "not_applicable" || prior?.status === "confirmed" || prior?.status === "familiarity") continue;
    add(prior?.signal ?? signalFromQuestion(question), question, "Proof question from market_lens; answer may improve precision or unlock stronger wording.");
  }

  return openQuestions;
}

function auditMarketLens(resumeId: string, lens: MarketLens, source: string, profileId: string | null, confirmations: MarketConfirmation[] = []): AuditResult {
  const signals: AuditSignal[] = [];
  const appliedTerms = new Set<string>();
  const implicitTerms: AuditResult["implicit_terms_used"] = [];
  const missingSignals: string[] = [];
  const confirmationNeeded: AuditResult["confirmation_needed"] = [];
  const alreadyReportedQuestions = new Set<string>();
  const sourceUpdateRequired: AuditResult["source_update_required"] = [];
  const suppressedConfirmations: AuditResult["suppressed_confirmations"] = [];

  for (const signal of lens.must_signal ?? []) {
    const explicitLines = directSignalMatches(source, signal);
    if (explicitLines.length) {
      signals.push({
        signal,
        status: "explicit",
        matched_terms: [signal],
        evidence_lines: explicitLines,
        reason: "Signal text, or near-complete signal wording, appears in source.",
      });
      appliedTerms.add(signal);
      continue;
    }

    const support = aliasSupport(lens, source, signal);
    if (support.terms.length) {
      signals.push({
        signal,
        status: "implicit",
        matched_terms: support.terms,
        evidence_lines: support.lines,
        reason: "Source contains configured supporting patterns, but not the market signal verbatim.",
      });
      appliedTerms.add(signal);
      for (const term of support.terms) {
        implicitTerms.push({ term, source_signal: signal, rationale: "Configured keyword alias support matched source evidence." });
      }
      continue;
    }

    const question = (lens.proof_questions ?? []).find((q) => normalise(q).includes(normalise(signal).split(" ")[0])) ?? null;
    const priorConfirmation = matchingConfirmation(confirmations, resumeId, signal, question);
    if (priorConfirmation?.status === "confirmed") {
      signals.push({
        signal,
        status: "needs_confirmation",
        matched_terms: [],
        evidence_lines: [],
        reason: "User previously confirmed this signal, but cv-source.md still lacks source evidence.",
      });
      sourceUpdateRequired.push({
        signal,
        question: priorConfirmation.question ?? question ?? `Add source evidence for ${signal}.`,
        reason: "Do not ask again; update cv-source.md first, then re-run the audit.",
      });
      if (priorConfirmation.question ?? question) alreadyReportedQuestions.add(normalise(priorConfirmation.question ?? question!));
      continue;
    }
    if (priorConfirmation?.status === "declined" || priorConfirmation?.status === "not_applicable" || priorConfirmation?.status === "familiarity") {
      signals.push({
        signal,
        status: "missing",
        matched_terms: [],
        evidence_lines: [],
        reason: `Previously marked ${priorConfirmation.status}; suppressing repeat question.`,
      });
      suppressedConfirmations.push({
        signal,
        status: priorConfirmation.status,
        reason: priorConfirmation.status === "familiarity"
          ? "Answered as familiarity: render only under familiarity framing, never as a delivered-work claim."
          : "Prior user answer says not to use this claim unless the market lens or source evidence changes.",
      });
      missingSignals.push(signal);
      continue;
    }
    if (question) {
      signals.push({
        signal,
        status: "needs_confirmation",
        matched_terms: [],
        evidence_lines: [],
        reason: priorConfirmation?.status === "pending"
          ? "Question is already pending in market-confirmations.yaml."
          : "No configured source pattern matched; proof question exists.",
      });
      confirmationNeeded.push({
        signal,
        question,
        reason: priorConfirmation?.status === "pending"
          ? "Already asked; leave as outstanding until the user answers."
          : "Confirm and update cv-source.md before rendering this claim.",
      });
      alreadyReportedQuestions.add(normalise(question));
    } else {
      signals.push({
        signal,
        status: "missing",
        matched_terms: [],
        evidence_lines: [],
        reason: "No explicit text, configured supporting pattern, or proof question matched.",
      });
      missingSignals.push(signal);
    }
  }

  return {
    resume_id: resumeId,
    profile_id: profileId,
    cv_source_hash: sha256(source),
    applied_terms: [...appliedTerms],
    implicit_terms_used: implicitTerms,
    confirmation_needed: confirmationNeeded,
    open_questions: addOpenQuestions(resumeId, lens, confirmations, alreadyReportedQuestions),
    source_update_required: sourceUpdateRequired,
    suppressed_confirmations: suppressedConfirmations,
    missing_signals: missingSignals,
    signals,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const resumeId = args.resume;
  if (!resumeId) {
    console.error("Usage: tsx tools/resume/market-lens-audit.ts --resume <id> [--profile <person-id>] [--profile-resumes <path>] [--org-resume-types <path>] [--cv-source <path>] [--confirmations <path>]");
    process.exit(2);
  }

  const resume = await getResume(resumeId, {
    profileId: args.profile,
    profileResumesPath: args["profile-resumes"],
    orgResumeTypesPath: args["org-resume-types"],
  });
  if (!resume) throw new Error(`Resume '${resumeId}' not found.`);
  if (!resume.market_lens) throw new Error(`Resume '${resumeId}' has no market_lens.`);

  const context = resolveProfileContext(args.profile);
  const source = await fs.readFile(args["cv-source"] ?? context.cvSourcePath, "utf8");
  const confirmations = await readConfirmations(args.confirmations ?? context.marketConfirmationsPath);
  const result = auditMarketLens(resumeId, resume.market_lens, source, context.profileId, confirmations);

  // `source_update_required` is the fail class: the user has already answered
  // "confirm and update source" for these signals, so the positioning may not
  // be rendered until cv-source.md carries the fact. Printing that as a
  // zero-exit report let a caller treat a blocking audit as a clean one.
  // `confirmation_needed` / `missing_signals` stay non-fatal on purpose: they
  // are questions for the person and gaps to report, not a broken state.
  const blocking = result.source_update_required ?? [];
  console.log(JSON.stringify({ ...result, verdict: blocking.length ? "fail" : "pass" }, null, 2));
  if (blocking.length) {
    console.error(
      `market-lens-audit: ${blocking.length} signal(s) require a cv-source.md update before '${resumeId}' may be rendered: ` +
        blocking.map((b) => b.signal).join(", "),
    );
    process.exit(1);
  }
}

if (process.argv[1] && /market-lens-audit\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
