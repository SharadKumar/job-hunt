#!/usr/bin/env tsx
/**
 * resume-index.ts — build a browsable HTML index of everything under
 * `state/profile/resumes/`.
 *
 * One self-contained page (inline CSS, vanilla JS, no CDN and no framework): a
 * binder of CVs. Index tabs down the left edge, one per positioning, and an
 * open spread beside them: the printed brief on the left page, the PDF in the
 * browser's own viewer on the right. Every value comes from state files,
 * nothing personal is hardcoded here. The design plan sits above the CSS
 * further down.
 *
 * Data sources per resume folder:
 *   - resumes.yaml            (via tools/resumes.ts): label, active, template, page_policy
 *   - metadata.json           approval status / approved_at / hashes
 *   - <prefix>.audit.json     verdict, page fills, gates, keyword coverage, timings
 *   - keyword-plan.json       coverage + open questions
 *   - <prefix>.composition.json / .provenance.json  featured/mentioned/dropped, unsupported claims
 *
 * CLI:
 *   tsx tools/resume/resume-index.ts [--profile <id>] [--out <path>]
 */

import { exists, readJsonIfExists } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../profile.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { loadResolvedResumes } from "../resumes.ts";
import { repoPath } from "../repo-root.ts";
import { loadComposition } from "./lib/composition-io.ts";
import { applyComposition } from "./resume-keywords.ts";
import type { ResumeContent } from "../../templates/resume/_interface.ts";

export type GateChip = { name: string; verdict: string; reason: string | null };

/** One rubric issue from the audit's compact report. */
export type AuditIssue = { rule: string; severity: string; detail: string };

/** One mark in the proofreader's tick row: always the same eight, in order. */
export type CheckMark = { key: string; label: string; verdict: "pass" | "warn" | "fail" | "skip"; reason: string | null };

/** A rendered page, paired with its fill percentage and the policy it answers to. */
export type PageMark = { src: string; fill: number | null; threshold: number; low: boolean };

/** One keyword, as a dot: surfaced, renderable but unsurfaced, or not renderable. */
export type KeywordDot = { term: string | null; state: "surfaced" | "renderable" | "absent" };

/** Which population the dot row counts: the plan's must-haves, or every renderable term. */
export type KeywordDotKind = "must_have" | "renderable";

export type Stamp = { kind: "approved" | "stale" | "fresh" | "missing"; text: string };

export type AuditSummary = {
  verdict: string;
  generated_at: string | null;
  page_count: number | null;
  page_target: number | null;
  fills: number[];
  last_page_fill_pct: number | null;
  min_last_page_fill_pct: number | null;
  failing_units: number;
  /** Non-unit rubric issues, verbatim from the compact report. */
  issues: AuditIssue[];
  gates: GateChip[];
  keyword_coverage: {
    surfaced_pct: number | null;
    renderable_pct: number | null;
    must_have_surfaced: number | null;
    must_have_total: number | null;
    surfaced_total: number | null;
    renderable_total: number | null;
    verdict: string | null;
  } | null;
  ats_composite: number | null;
  total_ms: number | null;
  cycles: number | null;
  warnings: string[];
};

export type ResumeCard = {
  id: string;
  label: string;
  dirName: string;
  active: boolean;
  inYaml: boolean;
  template: string;
  pagePolicy: { target: number | null; hard_max: number | null };
  status: "approved" | "stale" | "fresh" | "missing";
  statusDate: string | null;
  audit: AuditSummary | null;
  /**
   * The keyword plan's coverage, read from the plan APPLIED to this render's
   * composition when both exist, so the counts say what landed on the page
   * rather than what the pre-render plan hoped for.
   */
  keywordPlan: {
    surfaced_pct: number | null;
    renderable_pct: number | null;
    questions: number;
    verdict: string | null;
    surfaced_total: number | null;
    renderable_total: number | null;
    familiarity_total: number | null;
    must_have_surfaced: number | null;
    must_have_renderable: number | null;
  } | null;
  counts: { featured: number | null; mentioned: number | null; dropped: number | null; unsupported_claims: number | null };
  /** The roles the CV gives full space to, in the order the page shows them. */
  featuredRoles: Array<{ title: string; company: string; years: string }>;
  /** Keyword-plan questions still waiting on an answer, as plain term names. */
  openQuestions: string[];
  /** The resume-critic's unresolved findings from its latest round, one line each. */
  openFindings: string[];
  /** The critic's latest summary sentence and round, shown behind the Review tab. */
  review: { verdict: string | null; round: number | null; summary: string | null };
  warnCount: number;
  failCount: number;
  links: Record<string, string | null>;
  pngs: string[];
  /** Page thumbnails with their fill percentage and the threshold each answers to. */
  pages: PageMark[];
  /** How many pages the PDF has, per the audit, falling back to the image count. */
  pdfPageCount: number;
  /** The seven marks in the tick row, always present, `skip` when never run. */
  checks: CheckMark[];
  /** The approval stamp: what it says and which ink it is inked in. */
  stamp: Stamp;
  /** One dot per keyword in the counted population. */
  keywordDots: KeywordDot[];
  /** one row per keyword cloud the positioning references, heaviest first */
  keywordClouds: KeywordCloudRow[];
  /** What that population is: must-haves when the plan has any, else renderable terms. */
  keywordDotKind: KeywordDotKind;
  /** Last-written times for the artefacts an approval is an approval *of*. */
  mtimes: { audit: string | null; composition: string | null };
};

export type ResumeIndexModel = {
  profileName: string;
  profileId: string | null;
  generatedAt: string;
  resumesDir: string;
  outPath: string;
  headerLinks: Array<{ label: string; href: string }>;
  cards: ResumeCard[];
};

/* ------------------------------------------------------------------ utils */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Link from the generated index file to some other path on disk. */
export function relativeLink(outPath: string, target: string): string {
  const rel = path.relative(path.dirname(path.resolve(outPath)), path.resolve(target)).split(path.sep).join("/");
  return encodeURI(rel || path.basename(target));
}

/** Tolerant on purpose: a corrupt artefact must degrade the index, not crash it. */
async function readJson<T = any>(file: string): Promise<T | null> {
  return readJsonIfExists<T>(file).catch(() => null);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}

/** "2022-10" + "current" -> "2022 to now"; a single year collapses to itself. */
export function yearSpan(start: unknown, end: unknown): string {
  const year = (value: unknown): string | null => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (/^(current|present|now|ongoing)$/i.test(text)) return "now";
    const match = text.match(/(19|20)\d{2}/);
    return match ? match[0] : null;
  };
  const from = year(start);
  const to = year(end);
  if (from && to) return from === to ? from : `${from} to ${to}`;
  return from ?? to ?? "";
}

function gateVerdict(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = (value as any).verdict;
    if (typeof v === "string") return v;
  }
  return "skip";
}

/** Small counts read better as words in a sentence; large ones as digits. */
function countWord(n: number): string {
  const spelled = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  return n >= 0 && n < spelled.length ? spelled[n] : String(n);
}

function count(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  return num(value);
}

/**
 * One plain-English line explaining a gate's verdict, drawn from whatever
 * detail that gate happens to carry. Gates are heterogeneous (some are bare
 * strings, some objects with issues / counts / stats), so this is a best-effort
 * read that falls back to silence rather than inventing a reason.
 */
function gateReason(name: string, value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, any>;
  const plural = (n: number, one: string, many: string) => `${countWord(n)} ${n === 1 ? one : many}`;

  if (name === "term_grounding") {
    const injected = count(v.jd_injected) ?? 0;
    const unconfirmed = count(v.unconfirmed_terms) ?? 0;
    const ungrounded = num(v.ungrounded_count) ?? 0;
    if (injected > 0) return `${plural(injected, "term comes", "terms come")} from the job ad rather than the source CV`;
    if (unconfirmed > 0) return `${plural(unconfirmed, "term is", "terms are")} still unconfirmed`;
    if (ungrounded > 0) return `${plural(ungrounded, "generic word", "generic words")} only, nothing invented`;
    return "every term traces back to the source CV";
  }
  if (name === "preserve" && v.stats) {
    const s = v.stats;
    const bits = [`${countWord(num(s.featured) ?? 0)} featured`, `${countWord(num(s.mentioned) ?? 0)} mentioned`];
    const dropped = num(s.dropped_with_reason) ?? 0;
    bits.push(dropped ? `${countWord(dropped)} dropped with a reason` : "none dropped");
    return bits.join(", ");
  }

  const issues = count(v.issues) ?? 0;
  const missing = count(v.missing) ?? 0;
  const fails = num(v.fail_count) ?? 0;
  const warns = num(v.warn_count) ?? 0;
  if (fails > 0) return plural(fails, "problem to fix", "problems to fix");
  if (issues > 0) return plural(issues, "issue raised", "issues raised");
  if (missing > 0) return plural(missing, "item missing", "items missing");
  if (warns > 0) return plural(warns, "thing worth a look", "things worth a look");
  if (v.fail_count != null || v.issues != null || v.missing != null) return "nothing to fix";
  return null;
}

/* ------------------------------------------------------------------ model */

function summariseAudit(audit: any): AuditSummary {
  const gatesRaw = (audit?.gates ?? {}) as Record<string, unknown>;
  const gates: GateChip[] = Object.entries(gatesRaw)
    .map(([name, value]) => ({ name, verdict: gateVerdict(value), reason: gateReason(name, value) }));
  const kc = audit?.keyword_coverage ?? null;
  return {
    verdict: typeof audit?.verdict === "string" ? audit.verdict : "unknown",
    generated_at: typeof audit?.generated_at === "string" ? audit.generated_at : null,
    page_count: num(audit?.pages?.count),
    page_target: num(audit?.pages?.target),
    fills: Array.isArray(audit?.pages?.fills) ? audit.pages.fills.filter((f: unknown) => typeof f === "number") : [],
    last_page_fill_pct: num(audit?.pages?.last_page_fill_pct),
    min_last_page_fill_pct: num(audit?.pages?.min_last_page_fill_pct),
    failing_units: num(audit?.failing_units_total) ?? (Array.isArray(audit?.failing_units) ? audit.failing_units.length : 0),
    issues: Array.isArray(audit?.issues)
      ? audit.issues
          .filter((i: any) => i && typeof i === "object")
          .map((i: any) => ({ rule: String(i.rule ?? ""), severity: String(i.severity ?? ""), detail: String(i.detail ?? "") }))
          .filter((i: AuditIssue) => i.rule)
      : [],
    gates,
    keyword_coverage: kc
      ? {
          surfaced_pct: num(kc.surfaced_pct),
          renderable_pct: num(kc.renderable_pct),
          must_have_surfaced: num(kc.must_have_surfaced),
          must_have_total: num(kc.must_have_total),
          surfaced_total: num(kc.surfaced_total),
          renderable_total: num(kc.renderable_total),
          verdict: typeof kc.verdict === "string" ? kc.verdict : null,
        }
      : null,
    // ats_composite is emitted by newer audits only; absent on older artefacts.
    ats_composite: num(audit?.ats_composite) ?? num(audit?.gates?.ats?.composite) ?? num(audit?.ats?.composite),
    total_ms: num(audit?.timings_ms?.total),
    cycles: num(audit?.cycles) ?? num(audit?.render_cycles) ?? num(audit?.iterations) ?? num(audit?.fit?.cycles),
    warnings: Array.isArray(audit?.warnings) ? audit.warnings.map(String) : [],
  };
}

function approvalStatus(
  meta: any,
  hasArtefacts: boolean,
  mtimes: { audit: string | null; composition: string | null } = { audit: null, composition: null },
): { status: ResumeCard["status"]; date: string | null } {
  if (!meta) return { status: hasArtefacts ? "fresh" : "missing", date: null };
  // A stored approval goes stale as soon as the render's content_hash moves on.
  if (meta.approved_hash && meta.content_hash && meta.approved_hash !== meta.content_hash) {
    return { status: "stale", date: shortDate(meta.approved_at) };
  }
  // Hashes can agree while the artefacts on disk were rewritten after the
  // approval: the approval was of pages that no longer exist as approved.
  const approvedAt = meta.approved_at ? Date.parse(meta.approved_at) : NaN;
  if (Number.isFinite(approvedAt)) {
    const rebuilt = [mtimes.audit, mtimes.composition]
      .map((iso) => (iso ? Date.parse(iso) : NaN))
      .some((t) => Number.isFinite(t) && t > approvedAt + 1000);
    if (rebuilt) return { status: "stale", date: shortDate(meta.approved_at) };
  }
  const declared = typeof meta.approval_status === "string" ? meta.approval_status : null;
  if (declared === "approved") return { status: "approved", date: shortDate(meta.approved_at) };
  if (declared === "stale") return { status: "stale", date: shortDate(meta.approved_at) };
  if (declared) return { status: "fresh", date: shortDate(meta.last_render_at) };
  return { status: hasArtefacts ? "fresh" : "missing", date: shortDate(meta.last_render_at) };
}

/** Fill policy: 90 percent everywhere, except the last page which can carry its own floor. */
const DEFAULT_MIN_FILL_PCT = 90;

function buildPages(pngs: string[], audit: AuditSummary | null): PageMark[] {
  const fills = audit?.fills ?? [];
  const lastFloor = audit?.min_last_page_fill_pct ?? DEFAULT_MIN_FILL_PCT;
  const total = Math.max(pngs.length, fills.length);
  const out: PageMark[] = [];
  for (let i = 0; i < total; i += 1) {
    const fill = num(fills[i]);
    const threshold = i === total - 1 ? lastFloor : DEFAULT_MIN_FILL_PCT;
    out.push({ src: pngs[i] ?? "", fill, threshold, low: fill != null && fill < threshold });
  }
  return out;
}

/**
 * The tick row is a fixed row: the six audit gates plus keyword coverage, in a
 * stable order so the same mark always sits in the same place across
 * positionings. Gates the audit never ran come back as `skip` rather than
 * vanishing, because an absent check is itself worth seeing.
 */
const CHECK_ORDER: Array<{ key: string; label: string }> = [
  { key: "evaluate", label: "Evaluate" },
  { key: "provenance", label: "Provenance" },
  { key: "ats", label: "ATS" },
  { key: "term_grounding", label: "Term grounding" },
  { key: "preserve", label: "Preserve" },
  { key: "editorial", label: "Editorial" },
  { key: "keyword_coverage", label: "Keywords" },
  // Not a gate: the resume-critic's independent content review, read off
  // `<prefix>.critic.json`. It sits last because it is the only mark a machine
  // did not decide.
  { key: "critic", label: "Review" },
];

/** pass / revise / block / missing, in the tick row's vocabulary. */
function criticMark(review: any): { verdict: CheckMark["verdict"]; reason: string | null } {
  const verdict = typeof review?.verdict === "string" ? review.verdict : null;
  if (!verdict) return { verdict: "skip", reason: "never reviewed" };
  const mark = verdict === "pass" ? "pass" : verdict === "revise" ? "warn" : verdict === "block" ? "fail" : "skip";
  // The sentence itself lives behind the Review tab; the row says only the
  // verdict and the round so the tick column stays one line per mark.
  const round = typeof review?.round === "number" ? review.round : null;
  const open = Array.isArray(review?.findings) ? review.findings.length : 0;
  const reason = verdict === "pass"
    ? (round ? `round ${round}` : null)
    : `${verdict}${open ? `, ${open} open` : ""}${round ? `, round ${round}` : ""}`;
  return { verdict: mark as CheckMark["verdict"], reason };
}

/** The findings the latest round left on the table, one line each. */
export function openCriticFindings(review: any): string[] {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return findings
    .map((f: any) => {
      const where = f?.unit_paths?.[0] ?? f?.unit_path ?? null;
      const why = String(f?.why ?? "").trim();
      if (!why) return null;
      return `${String(f?.kind ?? "finding")}${where ? ` at ${where}` : ""}: ${why}`;
    })
    .filter(Boolean) as string[];
}

function markVerdict(value: string): CheckMark["verdict"] {
  return value === "pass" || value === "warn" || value === "fail" ? value : "skip";
}

/** Plain words for the rubric rules the evaluate gate raises, and what they cap. */
const ISSUE_RULES: Record<string, { one: string; many: string; unit: string }> = {
  featured_bullet_count: { one: "role", many: "roles", unit: "bullet" },
  skills_bullets_per_block: { one: "skill block", many: "skill blocks", unit: "item" },
  bullet_length: { one: "bullet", many: "bullets", unit: "word" },
  summary_length: { one: "summary", many: "summaries", unit: "word" },
  page_target: { one: "page count", many: "page counts", unit: "page" },
  last_page_fill: { one: "last page", many: "last pages", unit: "percent" },
  chronology: { one: "role out of order", many: "roles out of order", unit: "" },
};

/** "bullets 9 above max 7" -> +2; "bullets 2 below min 3" -> -1. */
function issueDelta(detail: string): number | null {
  const over = detail.match(/(\d+(?:\.\d+)?)\s+above\s+max\s+(\d+(?:\.\d+)?)/i);
  if (over) return Math.round(Number(over[1]) - Number(over[2]));
  const under = detail.match(/(\d+(?:\.\d+)?)\s+below\s+min\s+(\d+(?:\.\d+)?)/i);
  if (under) return -Math.round(Number(under[2]) - Number(under[1]));
  return null;
}

/** Join reason fragments, dropping the tail rather than running past the cap. */
function capReason(parts: string[], limit = 90): string | null {
  const kept: string[] = [];
  for (const part of parts) {
    const next = [...kept, part].join("; ");
    if (kept.length && next.length > limit) {
      const more = `${kept.join("; ")}; +${parts.length - kept.length} more`;
      return more.length <= limit ? more : kept.join("; ");
    }
    kept.push(part);
  }
  const joined = kept.join("; ");
  if (!joined) return null;
  return joined.length <= limit ? joined : `${joined.slice(0, limit - 1).trimEnd()}\u2026`;
}

/**
 * The evaluate gate carries a bare verdict; the detail lives in the report's
 * top-level `issues`. Group them by rule and say what each group is, in words,
 * so the mark names the problem instead of shrugging at it.
 */
export function summariseIssues(issues: AuditIssue[]): string | null {
  if (!issues.length) return null;
  const order: string[] = [];
  const groups = new Map<string, AuditIssue[]>();
  for (const issue of issues) {
    if (!groups.has(issue.rule)) { groups.set(issue.rule, []); order.push(issue.rule); }
    groups.get(issue.rule)!.push(issue);
  }
  const parts = order.map((rule) => {
    const group = groups.get(rule)!;
    const n = group.length;
    const spoken = ISSUE_RULES[rule];
    if (!spoken) return `${countWord(n)} ${rule.replace(/_/g, " ")}`;
    const noun = n === 1 ? spoken.one : spoken.many;
    const deltas = group.map((i) => issueDelta(i.detail)).filter((d): d is number => d != null);
    if (!deltas.length || !spoken.unit) return `${countWord(n)} ${noun}`;
    const over = deltas.filter((d) => d > 0);
    const worst = over.length ? Math.max(...over) : Math.max(...deltas.map(Math.abs));
    const unit = `${spoken.unit}${worst === 1 ? "" : "s"}`;
    return `${countWord(n)} ${noun} ${countWord(worst)} ${unit} ${over.length ? "over cap" : "under floor"}`;
  });
  return capReason(parts);
}

/**
 * A mark's reason, one compact line that names the issue. Gates are
 * heterogeneous and some (evaluate) carry nothing but a verdict, so this reads
 * the compact report directly rather than trusting the gate object alone.
 */
function checkReason(key: string, gate: GateChip | undefined, audit: AuditSummary | null, auditRaw: any): string | null {
  const raw = auditRaw?.gates?.[key];
  const detailsOf = (issues: unknown): string[] =>
    Array.isArray(issues)
      ? issues.map((i: any) => String(i?.detail ?? i?.rule ?? i ?? "").trim()).filter(Boolean)
      : [];

  if (key === "evaluate") {
    return summariseIssues(audit?.issues ?? []) ?? (gate ? "nothing to fix" : null);
  }

  if (key === "provenance") {
    // The compact gate carries counts only; the full block carries the stats.
    const stats = raw?.stats ?? auditRaw?.provenance?.stats ?? null;
    const parts: string[] = [];
    const unsupported = num(stats?.unsupported_claims) ?? 0;
    const weak = num(stats?.weak_citations) ?? 0;
    const numbers = num(stats?.number_unsupported) ?? 0;
    if (unsupported) parts.push(`${unsupported} unsupported ${unsupported === 1 ? "claim" : "claims"}`);
    if (weak) parts.push(`${weak} weak ${weak === 1 ? "citation" : "citations"}`);
    if (numbers) parts.push(`${numbers} ${numbers === 1 ? "number" : "numbers"} not in cited lines`);
    if (parts.length) return capReason(parts);
    const missing = detailsOf(raw?.missing);
    if (missing.length) return capReason([`${missing.length} citation${missing.length === 1 ? "" : "s"} missing`]);
    const fails = num(raw?.fail_count) ?? 0;
    if (fails) return capReason([`${fails} citation${fails === 1 ? "" : "s"} to fix`]);
    return gate ? "pass" : null;
  }

  if (key === "term_grounding") {
    if (!raw || typeof raw !== "object") return gate?.reason ?? null;
    const injected = count(raw.jd_injected) ?? 0;
    const unconfirmed = count(raw.unconfirmed_terms) ?? 0;
    const ungrounded = num(raw.ungrounded_count) ?? 0;
    const parts: string[] = [];
    if (ungrounded > 0) parts.push(`${countWord(ungrounded)} generic ${ungrounded === 1 ? "word" : "words"} only, nothing invented`);
    if (unconfirmed > 0) parts.push(`${unconfirmed} unconfirmed`);
    if (injected > 0) parts.push(`${injected} injected`);
    if (!parts.length) return "every term traces back to the source CV";
    return capReason(parts);
  }

  if (key === "ats") {
    const issues = detailsOf(raw?.issues);
    if (issues.length) return capReason(issues);
    return gate ? "pass" : null;
  }

  if (key === "preserve") {
    const stats = raw?.stats ?? null;
    const unaccounted = count(stats?.unaccounted) ?? 0;
    const unsourced = count(stats?.unsourced) ?? 0;
    const parts: string[] = [];
    if (unaccounted) parts.push(`${unaccounted} unaccounted ${unaccounted === 1 ? "role" : "roles"}`);
    if (unsourced) parts.push(`${unsourced} unsourced ${unsourced === 1 ? "role" : "roles"}`);
    if (parts.length) return capReason(parts);
    return gate?.reason ?? null;
  }

  if (key === "editorial") {
    const rules = Array.isArray(raw?.issues)
      ? [...new Set(raw.issues.map((i: any) => String(i?.rule ?? i?.id ?? "").trim()).filter(Boolean))] as string[]
      : [];
    if (rules.length) return capReason([`${rules.length === 1 ? "rule" : "rules"} matched: ${rules.join(", ")}`]);
    return gate ? "nothing to fix" : null;
  }

  return gate?.reason ?? null;
}

function buildChecks(
  audit: AuditSummary | null,
  plan: ResumeCard["keywordPlan"],
  keywords: { kind: KeywordDotKind; dots: KeywordDot[]; familiarity: number },
  auditRaw: any,
  criticReview: any,
): CheckMark[] {
  const { kind: dotKind, dots, familiarity } = keywords;
  const byName = new Map((audit?.gates ?? []).map((g) => [g.name, g]));
  return CHECK_ORDER.map(({ key, label }) => {
    if (key === "critic") {
      const { verdict, reason } = criticMark(criticReview);
      return { key, label, verdict, reason };
    }
    if (key === "keyword_coverage") {
      const kc = audit?.keyword_coverage ?? null;
      const verdict = markVerdict(kc?.verdict ?? (plan?.verdict ?? "skip"));
      // The dot row beneath already counts the terms, so a passing mark stays
      // quiet; anything else names the shortfall rather than shrugging at it.
      const surfaced = dots.filter((d) => d.state === "surfaced").length;
      const kind = dotKind === "renderable" ? "renderable" : "must-have";
      // Terms the user answered "Bring in as familiarity" are renderable with
      // framing, not delivered work, so they are named rather than folded in.
      const framed = familiarity ? `, plus ${familiarity} as familiarity` : "";
      // The applied plan counts facts, not spellings, so its must-have numbers
      // are the ones the audit reports; the dot row only answers when a plan
      // predating clouds leaves no coverage block behind.
      const mustSurfaced = plan?.must_have_surfaced ?? kc?.must_have_surfaced ?? null;
      const mustRenderable = plan?.must_have_renderable ?? num(auditRaw?.keyword_coverage?.must_have_renderable) ?? null;
      const fromPlan = mustSurfaced != null && mustRenderable != null && mustRenderable > 0
        ? `${mustSurfaced} of ${mustRenderable} must-have terms surfaced${framed}`
        : null;
      const reason = !dots.length && !fromPlan
        ? (kc || plan ? "no must-have terms in the plan" : null)
        : verdict === "pass" ? null
        : fromPlan ?? `${surfaced} of ${dots.length} ${kind} terms surfaced${framed}`;
      return { key, label, verdict, reason };
    }
    const gate = byName.get(key);
    if (!gate) return { key, label, verdict: "skip" as const, reason: null };
    return { key, label, verdict: markVerdict(gate.verdict), reason: checkReason(key, gate, audit, auditRaw) };
  });
}

/**
 * Dots per keyword. The plan file carries per-term flags when it was written
 * against a composition; must-have terms are the population whenever the plan
 * declares any. Proactive plans declare none, so the row falls back to every
 * renderable term (grounded / alias-grounded / confirmed) rather than rendering
 * an empty row and saying there are no must-haves. Per-term `surfaced_in` is
 * the truth about what landed on the page; when a plan carries none, the
 * audit's own surfaced total fills the row instead and the dots stay unnamed,
 * because a count cannot say WHICH term surfaced.
 */
/**
 * Whether a term could be put on the page at all, in exactly the terms the
 * keyword plan itself uses: grounded or alias-grounded outright, confirmed only
 * once the source carries it, and anything answered as familiarity. Reading it
 * any looser makes the binder's counts disagree with the plan's own coverage.
 */
function isRenderableTerm(t: any): boolean {
  if (t?.render_as === "familiarity") return true;
  const status = String(t?.status ?? "");
  if (status === "grounded" || status === "alias_grounded") return true;
  return status === "confirmed" && !t?.source_update_required;
}

/** One term inside a cloud, with everything a chip needs to describe itself. */
export type TermDetail = { term: string; state: KeywordDot["state"]; mustHave: boolean; familiarity: boolean };

export type KeywordCloudRow = {
  id: string;
  label: string;
  weight: number;
  total: number;
  surfaced: number;
  /** Terms this CV COULD carry: source-backed, plus any answered as familiarity. */
  renderable: number;
  /** Of the renderable ones, how many are familiarity rather than delivered work. */
  familiarity: number;
  dots: KeywordDot[];
  /** The cloud's terms by state, for the expandable panel under the row. */
  terms: { surfaced: string[]; renderable: string[]; absent: string[] };
  /** The same terms, one row each, for the used / not-used chip view. */
  termDetails: TermDetail[];
  /** Where the surfaced terms landed; a term counts in every place it appears. */
  where: { skills: number; experience: number; summary: number };
};

/**
 * Replay a keyword plan against the composition it was rendered into.
 *
 * The plan on disk is written before the render, so `surfaced_in` is empty on
 * every term and `coverage.surfaced_*` is zero. `applyComposition` is the same
 * function the audit uses, so the binder's counts and the audit's
 * `keyword_coverage` come from one place and cannot drift. Anything unexpected
 * in the plan shape falls back to the raw plan rather than losing the section.
 */
function appliedPlan(rawPlan: any, content: ResumeContent | null): any {
  if (!rawPlan || !content || !Array.isArray(rawPlan.terms) || !rawPlan.terms.length) return rawPlan;
  try {
    const clone = structuredClone(rawPlan);
    if (!Array.isArray(clone.warnings)) clone.warnings = [];
    if (!Array.isArray(clone.questions)) clone.questions = [];
    if (!clone.title) clone.title = {};
    return applyComposition(clone, content);
  } catch {
    return rawPlan;
  }
}

/**
 * One row per keyword cloud, heaviest cloud first, each carrying its counts and
 * its terms grouped by state.
 *
 * Coverage is a per-cloud question ("how much of agentic-engineering did this
 * CV actually carry?"), so the section reads cloud by cloud rather than as one
 * undifferentiated row of must-haves. Falls back to an empty list for plans
 * predating clouds, and `coverageHtml` then keeps the old single row.
 */
/**
 * Terms a plan carries outside any declared cloud: the taxonomy and lexicon
 * rows a positioning still has to answer for. They get a row of their own,
 * last and weightless, so the per-cloud bars and the flat chip lists count the
 * same population and both reconcile with the summary sentence.
 */
const OTHER_CLOUD = { id: "other", label: "Other market terms", weight: 0 };

export function buildKeywordCloudRows(plan: any): KeywordCloudRow[] {
  const clouds: any[] = Array.isArray(plan?.clouds) ? plan.clouds : [];
  if (!clouds.length) return [];
  const terms: any[] = Array.isArray(plan?.terms) ? plan.terms : [];
  const cloudId = (value: unknown) => String(value ?? "");
  const known = new Set(clouds.map((c) => cloudId(c?.id)));
  const groups: Array<{ meta: any; mine: any[] }> = [...clouds]
    .sort((a, b) => (Number(b?.weight) || 0) - (Number(a?.weight) || 0) || String(a?.id).localeCompare(String(b?.id)))
    .map((c) => ({ meta: c, mine: terms.filter((t) => cloudId(t?.cloud_id) === cloudId(c?.id)) }));
  const loose = terms.filter((t) => !known.has(cloudId(t?.cloud_id)));
  if (loose.length) groups.push({ meta: OTHER_CLOUD, mine: loose });
  return groups
    .map(({ meta: c, mine }) => {
      const isFamiliarity = (t: any) => t?.render_as === "familiarity";
      const stateOf = (t: any): KeywordDot["state"] =>
        Array.isArray(t?.surfaced_in) && t.surfaced_in.length > 0
          ? "surfaced"
          : isRenderableTerm(t) ? "renderable" : "absent";
      const dots: KeywordDot[] = mine.map((t) => ({ term: String(t?.term ?? "").trim() || null, state: stateOf(t) }));
      const named = (t: any) => String(t?.term ?? "").trim();
      const group = (state: KeywordDot["state"], suffixFamiliarity = false) =>
        mine.filter((t) => stateOf(t) === state).map((t) => (suffixFamiliarity && isFamiliarity(t) ? `${named(t)} (familiarity)` : named(t))).filter(Boolean);
      const placeOf = (field: string): "skills" | "experience" | "summary" | "other" => {
        if (field.startsWith("skill") || field.startsWith("additional_skills")) return "skills";
        if (field === "summary" || field === "headline" || field.startsWith("highlight")) return "summary";
        if (field.startsWith("credential")) return "other";
        return "experience";
      };
      const where = { skills: 0, experience: 0, summary: 0 };
      for (const t of mine) {
        const places = new Set((Array.isArray(t?.surfaced_in) ? t.surfaced_in : []).map((f: unknown) => placeOf(String(f))));
        if (places.has("skills")) where.skills += 1;
        if (places.has("experience")) where.experience += 1;
        if (places.has("summary")) where.summary += 1;
      }
      const surfaced = dots.filter((d) => d.state === "surfaced").length || Number(c.surfaced) || 0;
      const renderableStatus = dots.filter((d) => d.state === "renderable").length + surfaced;
      return {
        id: String(c.id),
        label: String(c.label ?? c.id),
        weight: Number(c.weight) || 0,
        total: dots.length || Number(c.total) || 0,
        surfaced,
        renderable: Math.max(renderableStatus, Number(c.renderable) || 0, surfaced),
        familiarity: mine.filter(isFamiliarity).length || Number(c.familiarity) || 0,
        dots,
        terms: { surfaced: group("surfaced"), renderable: group("renderable", true), absent: group("absent") },
        termDetails: mine
          .map((t) => ({ term: named(t), state: stateOf(t), mustHave: Boolean(t?.must_have), familiarity: isFamiliarity(t) }))
          .filter((t) => t.term),
        where,
      };
    });
}

/** One term as it reads on a chip: the word, the cloud it came from, its state. */
export type TermChip = { term: string; cloud: string; state: KeywordDot["state"]; mustHave: boolean; familiarity: boolean };

/**
 * Every renderable term across every cloud, split by whether it landed on the
 * page. Clouds already sort heaviest first, so walking them in order and
 * sorting alphabetically inside each one gives the reading order the chips use.
 * Plans predating clouds fall back to whatever the dot row could name.
 */
export function termChips(card: ResumeCard): { used: TermChip[]; unused: TermChip[]; absent: TermChip[] } {
  const rows: TermChip[] = [];
  if (card.keywordClouds.length) {
    for (const cloud of card.keywordClouds) {
      const sorted = [...cloud.termDetails].sort((a, b) => a.term.localeCompare(b.term));
      for (const t of sorted) {
        rows.push({ term: t.term, cloud: cloud.label, state: t.state, mustHave: t.mustHave, familiarity: t.familiarity });
      }
    }
  } else {
    const mustHave = card.keywordDotKind === "must_have";
    for (const dot of card.keywordDots) {
      if (!dot.term) continue;
      rows.push({ term: dot.term, cloud: "", state: dot.state, mustHave, familiarity: false });
    }
  }
  return {
    used: rows.filter((r) => r.state === "surfaced"),
    unused: rows.filter((r) => r.state === "renderable"),
    absent: rows.filter((r) => r.state === "absent"),
  };
}

function buildKeywordDots(plan: any, audit: AuditSummary | null, auditRaw: any): { kind: KeywordDotKind; dots: KeywordDot[]; familiarity: number } {
  const terms: any[] = Array.isArray(plan?.terms) ? plan.terms : [];
  // Plans predating `render_as` (and audit-only rows) simply report 0 here.
  const familiarity = num(plan?.coverage?.familiarity_total)
    ?? terms.filter((t) => t?.render_as === "familiarity").length;
  const named = (t: any) => String(t?.term ?? "").trim() || null;
  const surfacedIn = (t: any) => Array.isArray(t?.surfaced_in) && t.surfaced_in.length > 0;

  const mustTerms = terms.filter((t) => t?.must_have);
  if (mustTerms.length) {
    return {
      kind: "must_have",
      familiarity,
      dots: mustTerms.map((t) => ({
        term: named(t),
        state: surfacedIn(t) ? "surfaced" : isRenderableTerm(t) ? "renderable" : "absent",
      })),
    };
  }

  const kc = audit?.keyword_coverage ?? null;
  const mustTotal = kc?.must_have_total ?? 0;
  if (mustTotal) {
    const surfaced = kc?.must_have_surfaced ?? 0;
    const renderable = num(auditRaw?.keyword_coverage?.must_have_renderable) ?? surfaced;
    const unsurfacedNames: string[] = Array.isArray(auditRaw?.keyword_coverage?.must_have_unsurfaced)
      ? auditRaw.keyword_coverage.must_have_unsurfaced.map((t: any) => String(t?.term ?? t ?? "").trim()).filter(Boolean)
      : [];
    const dots: KeywordDot[] = [];
    for (let i = 0; i < mustTotal; i += 1) {
      const state: KeywordDot["state"] = i < surfaced ? "surfaced" : i < renderable ? "renderable" : "absent";
      const name = state === "surfaced" ? null : unsurfacedNames[i - surfaced] ?? null;
      dots.push({ term: name, state });
    }
    return { kind: "must_have", familiarity, dots };
  }

  // No must-haves anywhere: count the terms this plan could actually render.
  const renderableTerms = terms.filter(isRenderableTerm);
  if (renderableTerms.length) {
    if (renderableTerms.some(surfacedIn)) {
      return {
        kind: "renderable",
        familiarity,
        dots: renderableTerms.map((t) => ({ term: named(t), state: surfacedIn(t) ? "surfaced" : "renderable" })),
      };
    }
    const surfaced = num(auditRaw?.keyword_coverage?.surfaced_total) ?? kc?.surfaced_total ?? 0;
    return {
      kind: "renderable",
      familiarity,
      dots: renderableTerms.map((_t, i) => ({ term: null, state: i < surfaced ? "surfaced" : "renderable" })),
    };
  }

  // No plan terms on disk, but the audit counted some: dots from its totals.
  const renderableTotal = num(auditRaw?.keyword_coverage?.renderable_total) ?? kc?.renderable_total ?? 0;
  if (renderableTotal) {
    const surfaced = num(auditRaw?.keyword_coverage?.surfaced_total) ?? kc?.surfaced_total ?? 0;
    const dots: KeywordDot[] = [];
    for (let i = 0; i < renderableTotal; i += 1) dots.push({ term: null, state: i < surfaced ? "surfaced" : "renderable" });
    return { kind: "renderable", familiarity, dots };
  }
  return { kind: "must_have", familiarity, dots: [] };
}

function stampFor(status: ResumeCard["status"], date: string | null): Stamp {
  if (status === "approved") {
    const when = shortHumanDate(date);
    return { kind: "approved", text: when ? `Approved ${when}` : "Approved" };
  }
  if (status === "stale") return { kind: "stale", text: "Stale, rebuilt after approval" };
  if (status === "fresh") return { kind: "fresh", text: "Not approved" };
  return { kind: "missing", text: "No render" };
}

async function mtimeOf(file: string | null): Promise<string | null> {
  if (!file) return null;
  const stat = await fs.stat(file).catch(() => null);
  return stat ? stat.mtime.toISOString() : null;
}

async function buildCard(args: {
  id: string;
  label: string;
  active: boolean;
  inYaml: boolean;
  template: string;
  pagePolicy: { target: number | null; hard_max: number | null };
  dir: string;
  outPath: string;
}): Promise<ResumeCard> {
  const { dir, outPath } = args;
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => !f.startsWith("."));
  const pick = (suffix: string) => {
    const hit = files.find((f) => f.endsWith(suffix));
    return hit ? path.join(dir, hit) : null;
  };
  const plain = (ext: string) => {
    const hit = files.find((f) => f.endsWith(ext) && !f.includes(".composition.") && !f.includes(".provenance.") && !f.includes(".audit.") && !f.includes(".quality-report."));
    return hit ? path.join(dir, hit) : null;
  };

  const pdf = plain(".pdf");
  const docx = plain(".docx");
  const html = plain(".html");
  const md = plain(".md");
  const auditPath = pick(".audit.json");
  const compositionPath = pick(".composition.json");
  const provenancePath = pick(".provenance.json");
  const criticPath = pick(".critic.json");
  const keywordPlanPath = files.includes("keyword-plan.json") ? path.join(dir, "keyword-plan.json") : null;
  const metadataPath = files.includes("metadata.json") ? path.join(dir, "metadata.json") : null;
  const pngs = files.filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));

  const auditRaw = auditPath ? await readJson(auditPath) : null;
  const audit = auditPath ? summariseAudit(auditRaw) : null;
  const meta = metadataPath ? await readJson(metadataPath) : null;
  const rawPlan = keywordPlanPath ? await readJson(keywordPlanPath) : null;
  const loaded = compositionPath ? await loadComposition(compositionPath).catch(() => null) : null;
  const composition: any = loaded?.content ?? null;
  // `keyword-plan.json` is written by `resume:keywords --proactive`, which runs
  // BEFORE the render: every term has an empty `surfaced_in` and every cloud a
  // surfaced count of zero. The audit gets real numbers by replaying the plan
  // against the composition, so the binder does exactly the same thing.
  const plan = appliedPlan(rawPlan, composition);
  const criticReview = criticPath ? await readJson(criticPath) : null;
  const provenance = provenancePath ? await readJson(provenancePath) : null;

  const experiences: any[] = Array.isArray(composition?.experiences) ? composition!.experiences : [];
  const featured = composition ? experiences.filter((e) => e?.placement === "feature" || e?.placement === "featured").length : null;
  const mentioned = composition ? experiences.filter((e) => e?.placement === "mention" || e?.placement === "mentioned").length : null;
  const dropped = composition ? (Array.isArray(composition.dropped_experiences) ? composition.dropped_experiences.length : 0) : null;
  const unsupported = provenance
    ? (Array.isArray(provenance.unsupported_claims) ? provenance.unsupported_claims.length : num(provenance.unsupported_claims) ?? 0)
    : null;

  const isFeatured = (e: any) => e?.placement === "feature" || e?.placement === "featured";
  const featuredRoles = experiences.filter(isFeatured).map((e) => ({
    title: String(e?.title ?? "").trim(),
    company: String(e?.company ?? "").trim(),
    years: yearSpan(e?.start, e?.end),
  }));
  const openQuestions: string[] = Array.isArray(plan?.questions)
    ? plan.questions.map((q: any) => String(q?.term ?? "").trim()).filter(Boolean)
    : [];

  const hasArtefacts = Boolean(pdf || docx || html || md);
  const mtimes = { audit: await mtimeOf(auditPath), composition: await mtimeOf(compositionPath) };
  const { status, date } = approvalStatus(meta, hasArtefacts, mtimes);

  let warnCount = 0;
  let failCount = 0;
  for (const gate of audit?.gates ?? []) {
    if (gate.verdict === "warn") warnCount += 1;
    if (gate.verdict === "fail") failCount += 1;
  }
  if (audit) {
    warnCount += audit.warnings.length;
    failCount += audit.failing_units;
  }

  const link = (target: string | null) => (target ? relativeLink(outPath, target) : null);
  const pngLinks = pngs.map((p) => relativeLink(outPath, p));
  const keywordPlan = plan
    ? {
        surfaced_pct: num(plan.coverage?.surfaced_pct),
        renderable_pct: num(plan.coverage?.renderable_pct),
        questions: Array.isArray(plan.questions) ? plan.questions.length : 0,
        verdict: typeof plan.verdict === "string" ? plan.verdict : null,
        surfaced_total: num(plan.coverage?.surfaced_total),
        renderable_total: num(plan.coverage?.renderable_total),
        familiarity_total: num(plan.coverage?.familiarity_total),
        must_have_surfaced: num(plan.coverage?.must_have_surfaced),
        must_have_renderable: num(plan.coverage?.must_have_renderable),
      }
    : null;
  const { kind: keywordDotKind, dots: keywordDots, familiarity: keywordFamiliarity } = buildKeywordDots(plan, audit, auditRaw);

  return {
    id: args.id,
    label: args.label,
    dirName: path.basename(dir),
    active: args.active,
    inYaml: args.inYaml,
    template: args.template,
    pagePolicy: args.pagePolicy,
    status,
    statusDate: date,
    audit,
    keywordPlan,
    counts: { featured, mentioned, dropped, unsupported_claims: unsupported },
    featuredRoles,
    openQuestions,
    openFindings: criticReview ? openCriticFindings(criticReview) : [],
    review: {
      verdict: typeof criticReview?.verdict === "string" ? criticReview.verdict : null,
      round: typeof criticReview?.round === "number" ? criticReview.round : null,
      summary: typeof criticReview?.summary_sentence === "string" ? criticReview.summary_sentence.trim() || null : null,
    },
    warnCount,
    failCount,
    links: {
      pdf: link(pdf),
      docx: link(docx),
      html: link(html),
      md: link(md),
      composition: link(compositionPath),
      provenance: link(provenancePath),
      audit: link(auditPath),
      keyword_plan: link(keywordPlanPath),
      critic: link(criticPath),
      metadata: link(metadataPath),
    },
    pngs: pngLinks,
    pages: buildPages(pngLinks, audit),
    pdfPageCount: audit?.page_count ?? pngLinks.length,
    checks: buildChecks(audit, keywordPlan, { kind: keywordDotKind, dots: keywordDots, familiarity: keywordFamiliarity }, auditRaw, criticReview),
    stamp: stampFor(status, date),
    keywordDots,
    keywordClouds: buildKeywordCloudRows(plan),
    keywordDotKind,
    mtimes,
  };
}

async function latestJournal(): Promise<string | null> {
  const dir = repoPath("state", "journal");
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

export async function buildResumeIndexModel(options: { profileId?: string | null; outPath?: string } = {}): Promise<ResumeIndexModel> {
  const profileId = options.profileId ?? null;
  const context = resolveProfileContext(profileId);
  const resumesDir = context.renderedResumesDir;
  const outPath = path.resolve(options.outPath ?? path.join(resumesDir, "index.html"));

  let profileName = "Resumes";
  try { profileName = (await loadProfile(profileId)).name; } catch { /* profile.md may be absent in fixtures */ }

  const resolved = await loadResolvedResumes({ profileId }).catch(() => []);
  const dirEntries = (await fs.readdir(resumesDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);

  const cards: ResumeCard[] = [];
  const claimed = new Set<string>();

  for (const entry of resolved) {
    const resume = entry.resume;
    claimed.add(resume.id);
    cards.push(await buildCard({
      id: resume.id,
      label: resume.label ?? resume.id,
      active: resume.active !== false,
      inYaml: true,
      template: resume.template ?? "classic",
      pagePolicy: {
        target: num(resume.page_policy?.target_pages) ?? num(resume.page_policy?.preferred),
        hard_max: num(resume.page_policy?.hard_max),
      },
      dir: path.join(resumesDir, resume.id),
      outPath,
    }));
  }

  // Folders on disk that no longer have a resumes.yaml entry still hold artefacts
  // worth browsing — surface them as inactive, clearly not-in-yaml cards.
  for (const name of dirEntries) {
    if (claimed.has(name)) continue;
    const card = await buildCard({
      id: name,
      label: name,
      active: false,
      inYaml: false,
      template: "unknown",
      pagePolicy: { target: null, hard_max: null },
      dir: path.join(resumesDir, name),
      outPath,
    });
    if (card.status === "missing" && !card.pngs.length && !card.links.audit) continue; // empty folder
    cards.push(card);
  }

  cards.sort((a, b) => (a.active === b.active ? a.label.localeCompare(b.label) : a.active ? -1 : 1));

  // Plain-English labels: the reader shows these in the quiet footer, so they
  // read as things the user recognises, not as filenames.
  const headerCandidates: Array<{ label: string; file: string }> = [
    { label: "Source CV", file: context.cvSourcePath },
    { label: "Editorial rules", file: path.join(context.profileDir, "resume-editorial-rules.md") },
    { label: "Ban list", file: path.join(context.profileDir, "editorial-bans.yaml") },
    { label: "Market confirmations", file: context.marketConfirmationsPath },
    { label: "Profile report", file: path.join(context.profileDir, "profile-report.html") },
  ];
  const journal = await latestJournal();
  if (journal) headerCandidates.push({ label: "Latest journal", file: journal });

  const headerLinks: Array<{ label: string; href: string }> = [];
  for (const candidate of headerCandidates) {
    if (await exists(candidate.file)) headerLinks.push({ label: candidate.label, href: relativeLink(outPath, candidate.file) });
  }

  return {
    profileName,
    profileId,
    generatedAt: new Date().toISOString(),
    resumesDir,
    outPath,
    headerLinks,
    cards,
  };
}
/* ------------------------------------------------------------- vocabulary */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const words = countWord;

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "2026-01-03" -> "3 January", plus the year when it isn't the current one. */
function longDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const stamp = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date().getUTCFullYear() ? stamp : `${stamp} ${d.getUTCFullYear()}`;
}

/** Compact form for the rail, e.g. "10 Sep". */
function shortHumanDate(iso: string | null): string | null {
  const long = longDate(iso);
  return long ? long.replace(/([A-Z][a-z]{2})[a-z]+/, "$1") : null;
}

const GATE_LABELS: Record<string, string> = { ats: "ATS" };

function gateLabel(name: string): string {
  return GATE_LABELS[name] ?? upperFirst(name.replace(/[_-]+/g, " "));
}

function verdictWords(verdict: string): string {
  if (verdict === "pass") return "passes";
  if (verdict === "warn") return "worth a look";
  if (verdict === "fail") return "fails";
  return "not run";
}

function pageCountOf(card: ResumeCard): number {
  return card.audit?.page_count ?? card.pngs.length;
}

/**
 * The readiness paragraph. The stamp above it already says the approval state
 * and the tick row below already says which checks pass, so this says only two
 * things: the shape of the paper, and the single most useful next move.
 */
export function readinessSentences(card: ResumeCard): string[] {
  if (card.status === "missing") return ["No render on disk yet.", `Run /resume-render ${card.id} to make one.`];

  const out: string[] = [];
  const fills = card.audit?.fills ?? [];
  const pages = pageCountOf(card);
  if (pages > 0) {
    const noun = pages === 1 ? "page" : "pages";
    if (fills.length > 1) {
      const low = Math.round(Math.min(...fills));
      const high = Math.round(Math.max(...fills));
      out.push(low === high
        ? `${upperFirst(words(pages))} ${noun}, each filled to ${low} percent.`
        : `${upperFirst(words(pages))} ${noun}, filled between ${low} and ${high} percent.`);
    } else if (fills.length === 1) {
      out.push(`${upperFirst(words(pages))} ${noun}, filled to ${Math.round(fills[0])} percent.`);
    } else {
      out.push(`${upperFirst(words(pages))} ${noun} on the desk.`);
    }
  }
  out.push(nextMove(card));
  return out;
}

/** One sentence: the most important thing left to do, and nothing else. */
export function nextMove(card: ResumeCard): string {
  const failing = card.checks.filter((c) => c.verdict === "fail");
  if (failing.length) {
    return `Next, fix ${joinList(failing.map((c) => c.label.toLowerCase()))}.`;
  }
  const units = card.audit?.failing_units ?? 0;
  if (units > 0) {
    return `Next, shorten ${words(units)} ${units === 1 ? "block that runs" : "blocks that run"} longer than the template prefers.`;
  }
  const questions = card.openQuestions.length;
  if (questions > 0) {
    return `Next, answer ${words(questions)} open ${questions === 1 ? "question" : "questions"} on the keyword plan.`;
  }
  const thin = card.pages.map((page, i) => ({ page, number: i + 1 })).filter((x) => x.page.low);
  if (thin.length) {
    const labels = thin.map((x) => String(x.number));
    return `Next, fill ${labels.length === 1 ? "page" : "pages"} ${joinList(labels)} closer to the floor.`;
  }
  if (card.status === "stale") {
    const worst = card.checks.find((c) => c.verdict === "warn");
    if (worst) {
      // Only the first fragment: a whole compound reason overloads the sentence.
      const head = worst.reason ? worst.reason.split("; ")[0] : "";
      const what = head ? `${worst.label.toLowerCase()}'s ${head}` : worst.label.toLowerCase();
      return `Next, re-approve it now the pages have been rebuilt, after a look at ${what}.`;
    }
    return "Next, re-approve it now the pages have been rebuilt.";
  }
  if (card.status === "fresh") return "Next, approve it so it can go out.";
  const warns = card.checks.filter((c) => c.verdict === "warn");
  if (warns.length) return `Next, glance at ${joinList(warns.map((c) => c.label.toLowerCase()))} when you have a moment.`;
  return "Nothing is outstanding.";
}

/** The one-line state under a positioning name in the rail. */
export function railState(card: ResumeCard): string {
  if (card.failCount > 0) return `Needs a look: ${words(card.failCount)} ${card.failCount === 1 ? "check failing" : "checks failing"}`;
  if (card.status === "approved") {
    const when = shortHumanDate(card.statusDate);
    return when ? `Ready to send, approved ${when}` : "Ready to send";
  }
  if (card.openQuestions.length) {
    const n = card.openQuestions.length;
    return `Needs a look: ${n} open ${n === 1 ? "question" : "questions"}`;
  }
  if (card.status === "stale") return "Approved once, rebuilt since";
  if (card.status === "fresh") return "Rendered, not yet approved";
  return "No render yet";
}

/**
/* ----------------------------------------------------------------- render */

/**
 * Design plan — a binder of CVs, opened flat on a dark desk.
 *
 * The subject is one person's set of positionings. A binder makes that literal:
 * physical index tabs down the left edge, one per positioning, and an open
 * spread to their right. Left page is the printed brief (what this CV is, what
 * state it is in, what to do next). Right page is the PDF itself, shown in the
 * browser's own viewer with the viewer's own toolbar, because that toolbar
 * already does zoom, paging, print and download better than anything drawn
 * here. Nothing in this page tries to page the PDF: no chevrons, no thumbnail
 * gallery, no page in the hash.
 *
 * Palette. Desk #14213D (deep ink blue), paper #FFFFFF, ink #1A1D23, muted
 * #6B7280, hairline #E4E6EA. State colours are the only other ink: approved
 * green #2E7D32, needs attention amber #F0A202, inactive grey #9AA0A6, failure
 * red #C0392B. No gradients. Every shadow is hard and offset (blur 0), so the
 * pages read as paper lying on a dark table rather than as floating cards.
 *
 * Type. One geometric sans family throughout: "Avenir Next", Avenir,
 * "Helvetica Neue", Inter, system-ui. Two weights, 400 and 600. Four sizes,
 * 13 / 15 / 18 / 28. Left aligned, sentence case. No all-caps labels, no
 * tracked-out headings, no middle dots, no em dashes, no arrows.
 *
 * Layout.
 *
 *   +----+--------------------------+--------------------------------+
 *   | na |  brief page  34%, 380min |  pdf page, rest of the width   |
 *   | me |                          |  +--------------------------+  |
 *   |    |  Positioning name  28px  |  | viewer toolbar           |  |
 *   |[Bi]|  [ Approved 10 Sep ]     |  +--------------------------+  |
 *   |[nd]|  fill bars  88%   95%    |  |                          |  |
 *   |[er]|  Next, approve it.       |  |                          |  |
 *   |    |  ----------------------  |  |   the rendered CV, at    |  |
 *   |[ta]|  Gates | Review | Terms  |  |   page width, scrolled    |  |
 *   |[b ]|                          |  |   by the viewer itself   |  |
 *   |[ta]|  the chosen panel        |  |                          |  |
 *   |[b ]|                          |  |                          |  |
 *   |[ta]|  ----------------------  |  |                          |  |
 *   |[b ]|  Files, icons with       |  |                          |  |
 *   |    |  captions under them     |  |                          |  |
 *   |    |  source cv, rules, ...   |  +--------------------------+  |
 *   +----+--------------------------+--------------------------------+
 *
 * The selected tab is flush with the open page; the others sit a few pixels
 * back with an offset shadow, like tabs behind the open sheet. Tab text is the
 * positioning label rotated (writing-mode: vertical-rl). Hover or focus slides
 * a tab 4px towards the page, the one piece of motion on the screen, disabled
 * under prefers-reduced-motion.
 *
 * Interaction. Up and Down move between tabs and select as they go; Tab and
 * Enter do the same through native button semantics. That works because focus
 * never enters the iframe. Routing is `#<id>` and `#binder` only, pushState, so
 * browser back and forward retrace positionings. Landing view is the last
 * positioning read (localStorage) else the first active one.
 *
 * Overview. The "Binder" tab at the top of the column closes the binder: the
 * desk with every positioning as a small white sheet, coloured tab attached to
 * its left edge. The heading is the person's name, taken from the profile, over
 * the same lede. On each sheet the positioning label reads first, as the
 * sheet's own heading, then the preview of page one, then the stamp, the fill
 * bars and the marks in one row. The preview is tall enough (420px, cropped
 * from the top) to read the opening of the CV. Three sheets to a row on a wide
 * desk, two below 900px, one below 600px.
 *
 * Responsive. Below 960px the tabs become a horizontal strip of short tabs
 * above the content, the brief stacks above the PDF, and the viewer takes 80vh.
 *
 * Principles.
 *   1. The PDF is the product. Everything else is marginalia around it.
 *   2. Say it once. The stamp says the approval, the marks say the verdicts,
 *      the readiness line says the next move. No value appears twice.
 *   3. One panel, three ways in: Gates, Review, Terms. The eight marks keep
 *      their fixed order, and the panel remembers which tab you left open.
 *   4. Plain verbs and the command to run when something is missing.
 *   5. No personal detail lives in this file. The name comes from the profile.
 */

/* ------------------------------------------------------------- vocabulary */

/** The state colour a tab, stamp or dot is inked in. */
function stateClass(card: ResumeCard): string {
  const base = `state-${card.stamp.kind}`;
  return card.active ? base : `${base} is-inactive`;
}

/* -------------------------------------------------------------------- css */

const CSS = `
:root {
  color-scheme: light;
  --desk: #14213D;
  --paper: #FFFFFF;
  --ink: #1A1D23;
  --muted: #6B7280;
  --rule: #E4E6EA;
  --green: #2E7D32;
  --amber: #F0A202;
  --grey: #9AA0A6;
  --red: #C0392B;
  --sans: "Avenir Next", "Avenir", "Helvetica Neue", Inter, system-ui, sans-serif;
  --shadow: 6px 6px 0 rgba(0, 0, 0, 0.32);
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

html, body { height: 100%; }

body {
  margin: 0;
  background: var(--desk);
  color: var(--ink);
  font: 400 15px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
}

button { font: inherit; color: inherit; }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}

/* ------------------------------------------------------------ the binder */

.binder {
  display: flex;
  height: 100vh;
  padding: 24px 24px 24px 18px;
  gap: 0;
}

.tabs {
  flex: 0 0 64px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding-top: 4px;
  overflow: hidden;
}

.who {
  writing-mode: vertical-rl;
  margin: 0 auto 10px;
  max-height: 180px;
  overflow: hidden;
  color: #9FA9C0;
  font-size: 13px;
}

/* A tab: label rotated down the spine, state colour on its outer edge, sitting
   a few pixels back from the open page unless it is the selected one. */
.tab {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 14px 9px;
  background: #F4F5F7;
  border: 0;
  border-left: 4px solid var(--grey);
  border-radius: 3px 0 0 3px;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transform: translateX(-5px);
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.3);
  transition: transform 120ms ease-out;
}

.tab:hover, .tab:focus-visible { transform: translateX(-1px); }
.tab:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 2px; }

.tab[aria-selected="true"] {
  transform: translateX(0);
  box-shadow: none;
  background: var(--paper);
}

.tab.state-approved { border-left-color: var(--green); }
.tab.state-stale, .tab.state-fresh { border-left-color: var(--amber); }
.tab.state-missing { border-left-color: #D6D9DE; background: #EDEFF2; color: var(--muted); }
.tab.is-inactive { color: var(--grey); border-left-color: var(--grey); background: #E9EBEE; transform: translateX(-9px); }
.tab.is-inactive:hover, .tab.is-inactive:focus-visible { transform: translateX(-5px); }
.tab.is-inactive[aria-selected="true"] { transform: translateX(0); background: #F3F4F6; }

.tab-binder { border-left-color: #6B7A9B; background: #E7EAF0; }

/* ------------------------------------------------------------ the spread */

.spread { flex: 1; display: flex; gap: 14px; min-width: 0; }

.page { background: var(--paper); box-shadow: var(--shadow); min-width: 0; }

.brief {
  flex: 0 0 34%;
  min-width: 380px;
  padding: 26px 28px 32px;
  overflow-y: auto;
  font-variant-numeric: tabular-nums;
}

.pdf-page { flex: 1; display: flex; }
.pdf-page iframe { flex: 1; width: 100%; height: 100%; border: 0; display: block; }

.empty { margin: 0; padding: 28px; color: var(--muted); font-size: 15px; }

/* ------------------------------------------------------------- the brief */

/* State at a glance: the name and the stamp on one line, the fill bars and the
   single next move directly under them. Nothing else competes up here. */
.brief-head { display: flex; flex-direction: column; gap: 12px; }
.brief-headline { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.brief-title { margin: 0; font-size: 28px; font-weight: 600; line-height: 1.2; }
.brief-next { margin: 0; font-size: 15px; }

.stamp {
  display: inline-block;
  padding: 3px 9px;
  border: 1px solid var(--grey);
  border-radius: 2px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.stamp.state-approved { color: var(--green); border-color: var(--green); }
.stamp.state-stale, .stamp.state-fresh { color: var(--amber); border-color: var(--amber); }

.brief-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--rule); }
.brief-section h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.brief-section p { margin: 0 0 8px; font-size: 15px; }
.brief-section p:last-child { margin-bottom: 0; }
.brief-note { color: var(--muted); font-size: 13px; }

/* Checks: mark and name on the left, the one-line reason on the right. */
.marks { list-style: none; margin: 0; padding: 0; }
.marks li { display: grid; grid-template-columns: 148px 1fr; gap: 10px; padding: 3px 0; align-items: baseline; }
.mark-name { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.mark-name svg { width: 13px; height: 13px; flex: 0 0 13px; }
.mark-pass svg { color: var(--green); }
.mark-warn svg { color: var(--amber); }
.mark-fail svg { color: var(--red); }
.mark-skip svg { color: var(--grey); }
.mark-why { color: var(--muted); font-size: 13px; }

/* Checks pane: Gates (the marks) and Review (the critic's words) behind two
   small tabs, so the long sentence only takes space when asked for. */
.pane-tabs { display: flex; gap: 14px; margin: -4px 0 8px; border-bottom: 1px solid var(--rule); }
.pane-tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  margin-bottom: -1px; padding: 2px 0 6px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer;
}
.pane-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.pane-tab:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.review-summary { font-size: 14px; margin: 0 0 8px; }
.review-findings { margin: 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
.review-findings li { margin: 0 0 6px; }

/* Coverage: one dot per must-have term. */
.dots { list-style: none; display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 8px; padding: 0; }
.dots li { width: 8px; height: 8px; border-radius: 50%; }
.dots.is-dense { gap: 3px; }
.dots.is-dense li { width: 5px; height: 5px; }
.dots .surfaced { background: var(--ink); }
.dots .renderable { background: var(--amber); }
.dots .absent { background: transparent; box-shadow: inset 0 0 0 1px var(--grey); }
.questions { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; }

/* Coverage by cloud: one sentence, a legend, then a bar per cloud that opens
   onto the terms behind it. A bar reads at a glance where 25 dots did not. */
.coverage-summary { margin: 0 0 8px; font-size: 14px; }
.coverage-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.coverage-legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.swatch.surfaced { background: var(--ink); }
.swatch.renderable { background: var(--amber); }
.swatch.absent { background: transparent; box-shadow: inset 0 0 0 1px var(--grey); }

.clouds { list-style: none; margin: 0 0 8px; padding: 0; }
.clouds .cloud { border-bottom: 1px solid var(--rule); }
.clouds .cloud:last-child { border-bottom: 0; }
.cloud-row {
  appearance: none; background: none; border: 0; width: 100%; padding: 6px 0; margin: 0;
  font: inherit; font-size: 13px; color: var(--ink); text-align: left; cursor: pointer;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
}
.cloud-where { flex: 0 0 100%; text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.cloud-where:empty { display: none; }
.cloud-row:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.cloud-name { flex: 0 0 auto; }
.cloud-weight { color: var(--muted); margin-left: 6px; }
.cloud-bar { flex: 1 1 auto; min-width: 60px; display: flex; height: 7px; border-radius: 1px; box-shadow: inset 0 0 0 1px var(--rule); overflow: hidden; }
.cloud-bar span { display: block; height: 100%; }
.cloud-bar .surfaced { background: var(--ink); }
.cloud-bar .renderable { background: var(--amber); }
.cloud-count { flex: 0 0 auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.cloud-terms { padding: 0 0 8px; }
.cloud-terms p { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
.cloud-terms p:last-child { margin-bottom: 0; }
.cloud-terms .term-head { color: var(--ink); }

/* Terms tab: one toggle between the per-cloud bars and the flat used /
   not-used chip lists, so the same terms can be read either way. */
.view-toggle { display: flex; gap: 6px; margin: 0 0 14px; }
.view-button {
  appearance: none; background: none; border: 1px solid var(--rule); border-radius: 3px;
  padding: 3px 9px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer;
}
.view-button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
.view-button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* Stacked, not side by side: a term reads as one line at full width, where
   two narrow columns wrapped most of them onto two. */
.chip-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
.chip-head { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.chip-count { margin-left: 4px; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.chips { list-style: none; display: flex; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border: 1px solid var(--grey); border-radius: 11px;
  font-size: 12px; line-height: 1.6; color: var(--ink);
}
.chip-used { border-color: var(--ink); }
.chip-unused { border-color: var(--amber); }
.chip-gone { border-color: var(--rule); color: var(--muted); }
.chip.is-must { font-weight: 600; }
.chip-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: 0 0 5px; }
.chip-note { color: var(--muted); font-size: 11px; }
.disclose {
  appearance: none; background: none; border: 0; margin: 14px 0 0; padding: 0;
  font: inherit; font-size: 13px; color: var(--muted); text-align: left; cursor: pointer;
}
.disclose:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.absent-panel { margin-top: 8px; }

/* Pages: a fill bar per page with its percentage beneath. */
.fills { display: flex; gap: 12px; margin: 0; }
.fill { display: flex; flex-direction: column; gap: 4px; }
.fill-bar { width: 34px; height: 6px; background: var(--rule); border-radius: 1px; overflow: hidden; }
.fill-bar span { display: block; height: 100%; background: var(--ink); }
.fill-bar span.is-low { background: var(--amber); }
.fill-pct { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

.shape-bar { display: flex; height: 6px; margin-top: 22px; border-radius: 1px; overflow: hidden; background: var(--rule); }
.shape-bar span { display: block; height: 100%; }
.shape-bar .featured { background: var(--ink); }
.shape-bar .mentioned { background: var(--grey); }
.shape-bar .dropped { background: var(--rule); }
.shape-line { margin-top: 8px; color: var(--muted); font-size: 13px; }

/* Files: an icon per artefact with its name under it, the two PDF actions
   first, then a hairline, then the working sidecars. Icons are Lucide (ISC). */
.files { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 2px; }
.files .file-icon {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 66px;
  padding: 7px 2px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
}
.files .file-icon svg { width: 18px; height: 18px; }
.files .file-caption { font-size: 11px; line-height: 1.3; color: var(--muted); text-align: center; }
.files .file-icon:hover { background: #F4F5F7; }
.files .file-icon:hover .file-caption { color: var(--ink); }
.files .file-icon:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* The print action is a link that happens to be a button, so it reads as one. */
.files .file-action { font: inherit; background: none; }
.files .file-action:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.files .file-divider { align-self: stretch; width: 1px; margin: 6px 8px; background: var(--rule); }
.files .file-icon.is-quiet { color: var(--muted); }
.brief-foot { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 12px; }
.brief-foot a { color: var(--muted); font-size: 13px; }

/* --------------------------------------------------------- binder (all) */

/* The same left gutter the open spread leaves, so sheets and heading start
   clear of the tab column instead of butting against it. */
.binder-view { flex: 1; overflow-y: auto; padding: 4px 2px 24px 32px; }
.binder-view h1 { margin: 0 0 6px; color: #FFFFFF; font-size: 18px; font-weight: 600; }
.binder-lede { margin: 0 0 20px; color: #9FA9C0; font-size: 13px; }

.sheets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; max-width: 1180px; }

.sheet {
  position: relative;
  width: 100%;
  padding: 14px 14px 14px 18px;
  background: var(--paper);
  border: 0;
  border-left: 5px solid var(--grey);
  box-shadow: var(--shadow);
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sheet:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 3px; }
.sheet.state-approved { border-left-color: var(--green); }
.sheet.state-stale, .sheet.state-fresh { border-left-color: var(--amber); }
.sheet.state-missing { border-left-color: #D6D9DE; }
.sheet.is-inactive { border-left-color: var(--grey); background: #F4F5F7; }
.sheet img { width: 100%; height: 420px; object-fit: cover; object-position: top center; border: 1px solid var(--rule); }
.sheet-blank { height: 420px; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--rule); color: var(--muted); font-size: 13px; }
.sheet-name { font-size: 15px; font-weight: 600; }
.sheet-stamp { font-size: 13px; color: var(--muted); }
.sheet-stamp.state-approved { color: var(--green); }
.sheet-stamp.state-stale, .sheet-stamp.state-fresh { color: var(--amber); }
.sheet .fills { margin: 0; gap: 8px; }
.sheet-marks { display: flex; gap: 8px; }
.sheet-marks svg { width: 13px; height: 13px; }

@media (prefers-reduced-motion: reduce) {
  .tab { transition: none; }
}

/* ----------------------------------------------------------- narrow view */

@media (max-width: 960px) {
  .binder { flex-direction: column; height: auto; padding: 12px; }
  .tabs { flex: 0 0 auto; flex-direction: row; align-items: stretch; gap: 4px; overflow-x: auto; padding: 0 0 10px; }
  .who { writing-mode: horizontal-tb; max-height: none; margin: 0 10px 0 0; align-self: center; white-space: nowrap; }
  .tab {
    writing-mode: horizontal-tb;
    flex: 0 0 auto;
    max-width: 150px;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding: 8px 10px;
    border-left: 0;
    border-bottom: 4px solid var(--grey);
    border-radius: 3px 3px 0 0;
    transform: translateY(4px);
  }
  .tab:hover, .tab:focus-visible, .tab.is-inactive:hover { transform: translateY(0); }
  .tab[aria-selected="true"], .tab.is-inactive[aria-selected="true"] { transform: translateY(0); }
  .tab.is-inactive { transform: translateY(6px); }
  .tab.state-approved { border-bottom-color: var(--green); }
  .tab.state-stale, .tab.state-fresh { border-bottom-color: var(--amber); }
  .tab.state-missing { border-bottom-color: #D6D9DE; }
  .tab.is-inactive { border-bottom-color: var(--grey); }
  .tab-binder { border-bottom-color: #6B7A9B; }
  .spread { flex-direction: column; gap: 12px; }
  .brief { flex: 0 0 auto; min-width: 0; width: 100%; }
  .marks li { grid-template-columns: 120px 1fr; }
  .pdf-page { height: 80vh; }
  .binder-view { padding-left: 2px; }
  .sheets { gap: 14px; }
  .sheet { width: 100%; }
}

@media (max-width: 900px) {
  .sheets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 600px) {
  .sheets { grid-template-columns: minmax(0, 1fr); }
}
`;

/* ------------------------------------------------------------------- html */

/** Proofreader's marks: tick, tilde, cross, ring. Drawn, never a pill. */
const MARKS: Record<CheckMark["verdict"], string> = {
  pass: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 7.5 5.5 11 12 3"/></svg>`,
  warn: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 8c1.5-3 3.5-3 5 0s3.5 3 5 0"/></svg>`,
  fail: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>`,
  skip: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.5"/></svg>`,
};

/**
 * The viewer fragment. The built-in toolbar and panes are off and the page
 * opens at page width, so there is no page number in the URL and nothing here
 * to keep in sync with it. Download and print live in the brief's Files row
 * instead, since the toolbar that would otherwise offer them is hidden.
 */
export function pdfSrcFor(href: string): string {
  return `${href}#toolbar=0&navpanes=0&zoom=page-width`;
}

function stampHtml(card: ResumeCard, extraClass = "stamp"): string {
  return `<span class="${extraClass} state-${card.stamp.kind}">${escapeHtml(card.stamp.text)}</span>`;
}

/** The tab column: the name, the binder tab, then one tab per positioning. */
function tabsHtml(model: ResumeIndexModel, selectedId: string): string {
  const tabs = model.cards.map((card) => {
    const selected = card.id === selectedId;
    return `<button type="button" role="tab" class="tab ${stateClass(card)}" data-resume="${escapeHtml(card.id)}"`
      + ` aria-selected="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}"`
      + ` title="${escapeHtml(railState(card))}${card.active ? "" : ", not active"}">`
      + `<span class="tab-label">${escapeHtml(card.label)}</span></button>`;
  }).join("");

  return `<nav class="tabs" role="tablist" aria-label="Positionings" aria-orientation="vertical">`
    + `<p class="who">${escapeHtml(model.profileName)}</p>`
    + `<button type="button" role="tab" class="tab tab-binder" data-view="binder" aria-selected="false" tabindex="-1">`
    + `<span class="tab-label">Binder</span></button>`
    + tabs
    + `</nav>`;
}

/**
 * The header: state at a glance. The positioning name and the approval stamp
 * on one line, the page-fill bars under them, and the single next move as one
 * sentence. The sentence about the shape of the paper is what the bars draw,
 * so it is their label rather than a second line of prose.
 */
function headHtml(card: ResumeCard): string {
  const sentences = readinessSentences(card);
  const shape = sentences.length > 1 ? sentences[0] : "";
  const next = sentences[sentences.length - 1] ?? "";
  const bars = fillsHtml(card, 4, shape);
  return `<header class="brief-head">`
    + `<div class="brief-headline"><h1 class="brief-title">${escapeHtml(card.label)}</h1>${stampHtml(card)}</div>`
    + (card.active ? "" : `<p class="brief-note">Not active in resumes.yaml.</p>`)
    + (bars || (shape ? `<p class="brief-next">${escapeHtml(shape)}</p>` : ""))
    + (next ? `<p class="brief-next">${escapeHtml(next)}</p>` : "")
    + `</header>`;
}

/** The composition bar: featured, mentioned and dropped roles as one segment each. */
function shapeHtml(card: ResumeCard): string {
  const featured = card.counts.featured ?? 0;
  const mentioned = card.counts.mentioned ?? 0;
  const dropped = card.counts.dropped ?? 0;
  const total = featured + mentioned + dropped;
  if (!total) return "";
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  const bits = [`${words(featured)} featured`, `${words(mentioned)} mentioned`, dropped ? `${words(dropped)} dropped` : "none dropped"];
  const unsupported = card.counts.unsupported_claims ?? 0;
  if (unsupported > 0) bits.push(`${words(unsupported)} unsupported ${unsupported === 1 ? "claim" : "claims"}`);
  if (card.failCount > 0) bits.push(`${words(card.failCount)} ${card.failCount === 1 ? "failure" : "failures"}`);
  if (card.warnCount > 0) bits.push(`${words(card.warnCount)} ${card.warnCount === 1 ? "warn" : "warns"}`);
  return `<div class="shape-bar" aria-hidden="true">`
    + `<span class="featured" style="width:${pct(featured)}"></span>`
    + `<span class="mentioned" style="width:${pct(mentioned)}"></span>`
    + `<span class="dropped" style="width:${pct(dropped)}"></span>`
    + `</div>`
    + `<p class="shape-line">${escapeHtml(upperFirst(joinList(bits)))}.</p>`;
}

/** The one panel: Gates, Review and Terms behind three small tabs. */
function checksHtml(card: ResumeCard): string {
  // Preserve's reason is the featured / mentioned / dropped tally, which the
  // Pages section already prints under its composition bar. One of the two.
  const composed = (card.counts.featured ?? 0) + (card.counts.mentioned ?? 0) + (card.counts.dropped ?? 0) > 0;
  const rows = card.checks.map((check) => {
    // A tick already says nothing is wrong, so a passing check only earns a
    // reason when the reason carries something the tick does not.
    const spoken = check.reason === "nothing to fix" || check.reason === "pass"
      || (check.key === "preserve" && composed);
    const raw = check.reason && !spoken ? check.reason : null;
    const why = raw ?? (check.verdict === "pass" ? "" : verdictWords(check.verdict));
    return `<li class="mark mark-${check.verdict}">`
      + `<span class="mark-name">${MARKS[check.verdict]}${escapeHtml(check.label)}</span>`
      + `<span class="mark-why">${escapeHtml(why ? upperFirst(why) : "")}</span>`
      + `</li>`;
  }).join("");
  // The critic's words are the only thing in this section a machine did not
  // decide, and they run long. They sit behind a second tab so the tick column
  // stays compact and the sentence is still one click away.
  const findings = card.openFindings.length
    ? `<ul class="review-findings">${card.openFindings.map((f) => `<li>${escapeHtml(upperFirst(f))}</li>`).join("")}</ul>`
    : "";
  const summary = card.review.summary ? `<p class="review-summary">${escapeHtml(card.review.summary)}</p>` : "";
  const reviewBody = summary || findings
    ? `${summary}${findings}`
    : `<p class="brief-note">Not reviewed yet.</p>`;
  const openCount = card.openFindings.length;
  const reviewLabel = `Review${openCount ? ` (${openCount})` : ""}`;
  const paneId = `checks-${card.id}`;
  const tab = (key: string, label: string, selected: boolean) =>
    `<button type="button" role="tab" class="pane-tab" aria-selected="${selected ? "true" : "false"}"`
    + ` aria-controls="${escapeHtml(paneId)}-${key}" data-pane="${key}">${escapeHtml(label)}</button>`;
  const pane = (key: string, body: string, hidden: boolean) =>
    `<div class="pane" id="${escapeHtml(paneId)}-${key}" role="tabpanel" data-pane="${key}"${hidden ? " hidden" : ""}>${body}</div>`;
  return section("checks", "",
    `<div class="pane-set">`
    + `<div class="pane-tabs" role="tablist" aria-label="Checks">`
    + tab("gates", "Gates", true) + tab("review", reviewLabel, false) + tab("terms", "Terms", false)
    + `</div>`
    + pane("gates", `<ul class="marks">${rows}</ul>${shapeHtml(card)}`, false)
    + pane("review", reviewBody, true)
    + pane("terms", termsHtml(card), true)
    + `</div>`);
}

/** The sentence above the cloud bars: what landed, and what had to. */
export function coverageSummarySentence(plan: ResumeCard["keywordPlan"]): string | null {
  if (!plan) return null;
  const surfaced = plan.surfaced_total;
  const renderable = plan.renderable_total;
  if (surfaced == null || renderable == null || renderable === 0) return null;
  const familiarity = plan.familiarity_total ?? 0;
  const framed = familiarity ? `, ${familiarity} of them as familiarity` : "";
  const must = plan.must_have_surfaced != null && plan.must_have_renderable
    ? ` Must-have terms: ${plan.must_have_surfaced} of ${plan.must_have_renderable}.`
    : "";
  return `${surfaced} of ${renderable} source-backed terms appear in the CV${framed}.${must}`;
}

/** The three groups behind one cloud row, as short comma-separated lines. */
function cloudTermsHtml(c: KeywordCloudRow): string {
  const groups: Array<[string, string[]]> = [
    ["In the CV", c.terms.surfaced],
    ["Source-backed, not yet in the CV", c.terms.renderable],
    ["Not in the source", c.terms.absent],
  ];
  const lines = groups
    .filter(([, terms]) => terms.length)
    .map(([head, terms]) => `<p><span class="term-head">${escapeHtml(head)}:</span> ${escapeHtml(terms.join(", "))}</p>`)
    .join("");
  return lines || `<p>No terms in this cloud yet.</p>`;
}

/** "skills 4, experience 3, summary 1": where a cloud's surfaced terms sit. Zero places are left out. */
export function cloudWhereText(c: KeywordCloudRow): string {
  const parts: string[] = [];
  if (c.where.skills) parts.push(`skills ${c.where.skills}`);
  if (c.where.experience) parts.push(`experience ${c.where.experience}`);
  if (c.where.summary) parts.push(`summary ${c.where.summary}`);
  return parts.join(", ");
}

/** The Terms tab: the summary, the legend, then either view of the same terms. */
function termsHtml(card: ResumeCard): string {
  const sentence = coverageSummarySentence(card.keywordPlan);
  const viewId = `terms-${card.id}`;
  const toggle = `<div class="view-toggle" role="group" aria-label="Term view">`
    + `<button type="button" class="view-button" data-terms-view="clouds" aria-pressed="true"`
    + ` aria-controls="${escapeHtml(viewId)}-clouds">By cloud</button>`
    + `<button type="button" class="view-button" data-terms-view="used" aria-pressed="false"`
    + ` aria-controls="${escapeHtml(viewId)}-used">Used / not used</button>`
    + `</div>`;
  return `<div class="terms-set">`
    + (sentence ? `<p class="coverage-summary">${escapeHtml(sentence)}</p>` : "")
    + `<p class="coverage-legend">`
    + `<span><span class="swatch surfaced"></span>in the CV</span>`
    + `<span><span class="swatch renderable"></span>source-backed, not yet in the CV</span>`
    + `<span><span class="swatch absent"></span>not in the source</span>`
    + `</p>`
    + toggle
    + `<div class="terms-view" id="${escapeHtml(viewId)}-clouds" data-terms-view="clouds">${cloudsViewHtml(card)}</div>`
    + `<div class="terms-view" id="${escapeHtml(viewId)}-used" data-terms-view="used" hidden>${usedViewHtml(card)}</div>`
    + `</div>`;
}

/** One chip: the term, a dot when it is a must-have, a familiarity note when framed. */
function chipHtml(chip: TermChip, kind: string): string {
  return `<li><span class="chip chip-${kind}${chip.mustHave ? " is-must" : ""}"`
    + (chip.cloud ? ` title="${escapeHtml(chip.cloud)}"` : "")
    + `>`
    + (chip.mustHave ? `<span class="chip-dot" aria-hidden="true"></span>` : "")
    + escapeHtml(chip.term)
    + (chip.familiarity ? `<span class="chip-note">familiarity</span>` : "")
    + `</span></li>`;
}

/**
 * Used / not used: every renderable term in the plan as a chip, in two groups,
 * so the question "which terms did this CV actually carry" is answered without
 * opening a single cloud. What the source never had sits behind one quiet line.
 */
function usedViewHtml(card: ResumeCard): string {
  const { used, unused, absent } = termChips(card);
  if (!used.length && !unused.length && !absent.length) {
    return `<p class="brief-note">No named keyword terms in the plan yet.</p>`;
  }
  const group = (head: string, items: TermChip[], kind: string) =>
    `<div class="chip-group">`
    + `<p class="chip-head">${escapeHtml(head)}<span class="chip-count">${items.length}</span></p>`
    + (items.length ? `<ul class="chips">${items.map((c) => chipHtml(c, kind)).join("")}</ul>` : `<p class="brief-note">None.</p>`)
    + `</div>`;
  const panelId = `absent-${card.id}`;
  const more = absent.length
    ? `<button type="button" class="disclose" aria-expanded="false" aria-controls="${escapeHtml(panelId)}">`
      + `Not in the source: ${absent.length} ${absent.length === 1 ? "term" : "terms"}</button>`
      + `<div class="absent-panel" id="${escapeHtml(panelId)}" hidden>`
      + `<ul class="chips">${absent.map((c) => chipHtml(c, "gone")).join("")}</ul></div>`
    : "";
  return `<div class="chip-columns">`
    + group("In the CV", used, "used")
    + group("Not yet in the CV", unused, "unused")
    + `</div>${more}`;
}

/** By cloud: a bar per keyword cloud, the counts, and any open questions. */
function cloudsViewHtml(card: ResumeCard): string {
  if (card.keywordClouds.length) {
    const rows = card.keywordClouds.map((c) => {
      const total = Math.max(c.total, c.renderable, c.surfaced, 1);
      const pct = (n: number) => `${((Math.max(0, n) / total) * 100).toFixed(2)}%`;
      const amber = Math.max(0, Math.min(c.renderable, total) - c.surfaced);
      const panelId = `cloud-${card.id}-${c.id}`;
      const bar = `<span class="cloud-bar" aria-hidden="true">`
        + `<span class="surfaced" style="width:${pct(c.surfaced)}"></span>`
        + `<span class="renderable" style="width:${pct(amber)}"></span>`
        + `</span>`;
      return `<li class="cloud">`
        + `<button type="button" class="cloud-row" aria-expanded="false" aria-controls="${escapeHtml(panelId)}">`
        + `<span class="cloud-name">${escapeHtml(c.label)}<span class="cloud-weight">weight ${c.weight}</span></span>`
        + bar
        + `<span class="cloud-count">${c.surfaced} of ${c.total}</span>`
        + `<span class="cloud-where">${cloudWhereText(c)}</span>`
        + `</button>`
        + `<div class="cloud-terms" id="${escapeHtml(panelId)}" hidden>${cloudTermsHtml(c)}</div>`
        + `</li>`;
    }).join("");
    let body = `<ul class="clouds">${rows}</ul>`;
    if (card.openQuestions.length) {
      const n = card.openQuestions.length;
      body += `<p>${upperFirst(words(n))} open ${n === 1 ? "question" : "questions"} on the keyword plan.</p>`
        + `<ul class="questions">${card.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
    }
    return body;
  }
  const dots = card.keywordDots;
  const kind = card.keywordDotKind === "renderable" ? "renderable" : "must-have";
  let body: string;
  if (!dots.length) {
    body = `<p>No keyword terms in the plan yet.</p>`;
  } else {
    const surfaced = dots.filter((d) => d.state === "surfaced").length;
    const row = dots.map((d) => `<li class="${d.state}"${d.term ? ` title="${escapeHtml(d.term)}"` : ""}></li>`).join("");
    // A long row still gets one dot per term; the dots shrink so it stays two lines.
    const dense = dots.length > 40 ? " is-dense" : "";
    body = `<ul class="dots${dense}" aria-label="${upperFirst(kind)} keyword coverage">${row}</ul>`
      + `<p>${surfaced} of ${dots.length} ${kind} ${dots.length === 1 ? "term" : "terms"} surfaced.</p>`;
  }
  if (card.openQuestions.length) {
    const n = card.openQuestions.length;
    body += `<p>${upperFirst(words(n))} open ${n === 1 ? "question" : "questions"} on the keyword plan.</p>`
      + `<ul class="questions">${card.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
  }
  return body;
}

/** Fill bars: one per page, amber when the page misses its own floor. */
function fillsHtml(card: ResumeCard, limit = 4, label = ""): string {
  const pages = card.pages.slice(0, limit);
  if (!pages.length) return "";
  const bars = pages.map((page, i) => {
    const fill = Math.max(0, Math.min(100, page.fill ?? 0));
    const label = page.fill == null ? `Page ${i + 1}` : `Page ${i + 1}, filled to ${Math.round(page.fill)} percent`;
    return `<span class="fill" title="${escapeHtml(label)}">`
      + `<span class="fill-bar"><span class="${page.low ? "is-low" : ""}" style="width:${fill.toFixed(2)}%"></span></span>`
      + `<span class="fill-pct">${page.fill == null ? "" : `${Math.round(page.fill)}%`}</span>`
      + `</span>`;
  }).join("");
  const labelled = label ? ` role="img" aria-label="${escapeHtml(label)}"` : "";
  return `<div class="fills"${labelled}>${bars}</div>`;
}

/**
 * Icons for the Files row. Inline SVG, 24-unit box, stroked in the current
 * colour, drawn from Lucide (ISC licence) so the shapes read as the ones people
 * already know rather than as something invented here.
 */
const FILE_ICONS: Record<string, string> = {
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`,
  print: `<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>`,
  pdf: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>`,
  docx: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>`,
  html: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  md: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>`,
  composition: `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.48 1.59a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83L17.9 9.5"/><path d="m6.08 14.5-3.48 1.59a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.53-1.6"/>`,
  provenance: `<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
  audit: `<path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1Z"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>`,
  keyword_plan: `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><path d="M7.5 7.5h.01"/>`,
  metadata: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,
};

function iconSvg(key: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"`
    + ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${FILE_ICONS[key] ?? ""}</svg>`;
}

/**
 * The artefacts as an icon row: the two actions on the PDF, the four readable
 * formats, a hairline, then the working sidecars. Every icon carries its own
 * caption, so nothing here asks the reader to recognise a glyph cold.
 */
function filesHtml(card: ResumeCard): string {
  const readable: Array<[string, string]> = [
    ["pdf", "Open PDF"],
    ["docx", "Word"],
    ["html", "Web page"],
    ["md", "Markdown"],
  ];
  const sidecars: Array<[string, string]> = [
    ["composition", "Composition"],
    ["provenance", "Provenance"],
    ["audit", "Audit"],
    ["keyword_plan", "Keyword plan"],
    ["metadata", "Metadata"],
  ];
  const iconLink = (href: string, label: string, key: string, opts: { download?: boolean; quiet?: boolean } = {}) =>
    `<a class="file-icon${opts.quiet ? " is-quiet" : ""}" href="${escapeHtml(href)}"`
    + (opts.download ? " download" : ` target="_blank" rel="noopener"`)
    + ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">`
    + iconSvg(key)
    + `<span class="file-caption">${escapeHtml(label)}</span></a>`;

  const loud: string[] = [];
  // Two actions on the PDF itself lead the row: the viewer's own toolbar is
  // hidden, so this page has to offer the save and the print in its place.
  if (card.links.pdf) {
    loud.push(iconLink(card.links.pdf, "Download PDF", "download", { download: true }));
    loud.push(`<button type="button" class="file-icon file-action" data-print data-target="${escapeHtml(card.id)}"`
      + ` aria-label="Print" title="Print">${iconSvg("print")}<span class="file-caption">Print</span></button>`);
  }
  for (const [key, label] of readable) {
    if (card.links[key]) loud.push(iconLink(card.links[key]!, label, key));
  }
  const quiet = sidecars
    .filter(([key]) => card.links[key])
    .map(([key, label]) => iconLink(card.links[key]!, label, key, { quiet: true }));

  if (!loud.length && !quiet.length) return section("files", "", `<p>No files to open yet.</p>`, "Files");
  const divider = loud.length && quiet.length ? `<span class="file-divider" aria-hidden="true"></span>` : "";
  return section("files", "", `<div class="files">${loud.join("")}${divider}${quiet.join("")}</div>`, "Files");
}

function section(id: string, heading: string, body: string, label = ""): string {
  const attr = label ? ` aria-label="${escapeHtml(label)}"` : "";
  return `<section class="brief-section" data-section="${escapeHtml(id)}"${attr}>`
    + (heading ? `<h2>${escapeHtml(heading)}</h2>` : "") + body + `</section>`;
}

/** The left page: the printed brief for one positioning. */
function briefHtml(model: ResumeIndexModel, card: ResumeCard, current: boolean): string {
  const foot = model.headerLinks.length
    ? `<footer class="brief-foot">${model.headerLinks
        .map((l) => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`)
        .join("")}</footer>`
    : "";
  return `<section class="page brief" data-resume="${escapeHtml(card.id)}"${current ? "" : " hidden"}>`
    + headHtml(card)
    + checksHtml(card)
    + filesHtml(card)
    + foot
    + `</section>`;
}

/** The right page: the browser's own PDF viewer, toolbar and all. */
function pdfPageHtml(card: ResumeCard, current: boolean): string {
  const attrs = `class="page pdf-page" data-resume="${escapeHtml(card.id)}"${current ? "" : " hidden"}`;
  if (!card.links.pdf) {
    return `<section ${attrs}><p class="empty">No render yet. Run /resume-render ${escapeHtml(card.id)}.</p></section>`;
  }
  const src = pdfSrcFor(card.links.pdf);
  const srcAttr = current ? ` src="${escapeHtml(src)}"` : "";
  return `<section ${attrs}>`
    + `<iframe title="${escapeHtml(card.label)}, rendered CV" data-src="${escapeHtml(src)}"${srcAttr}></iframe>`
    + `</section>`;
}

/** The closed binder: every positioning as a sheet on the desk. */
function binderViewHtml(model: ResumeIndexModel, hidden: boolean): string {
  const sheets = model.cards.map((card) => {
    const first = card.pages[0]?.src ?? card.pngs[0] ?? null;
    const image = first
      ? `<img src="${escapeHtml(first)}" alt="" loading="lazy">`
      : `<span class="sheet-blank">No render yet</span>`;
    const marks = card.checks
      .map((c) => `<span class="mark-${c.verdict}" title="${escapeHtml(`${c.label}, ${verdictWords(c.verdict)}`)}">${MARKS[c.verdict]}</span>`)
      .join("");
    return `<button type="button" class="sheet ${stateClass(card)}" data-resume="${escapeHtml(card.id)}">`
      + `<span class="sheet-name">${escapeHtml(card.label)}</span>`
      + image
      + stampHtml(card, "sheet-stamp")
      + fillsHtml(card)
      + `<span class="sheet-marks">${marks}</span>`
      + `</button>`;
  }).join("");
  const active = model.cards.filter((c) => c.active).length;
  const lede = `${upperFirst(words(active))} active ${active === 1 ? "positioning" : "positionings"} of ${words(model.cards.length)}. Pick one to open it.`;
  return `<section class="binder-view" data-view="binder"${hidden ? " hidden" : ""}>`
    + `<h1>${escapeHtml(model.profileName)}</h1><p class="binder-lede">${escapeHtml(lede)}</p>`
    + `<div class="sheets">${sheets}</div>`
    + `</section>`;
}

/* --------------------------------------------------------------- behaviour */

const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("binder-model").textContent);
  var ids = data.resumes.map(function (r) { return r.id; });
  if (!ids.length) return;
  var byId = {};
  data.resumes.forEach(function (r) { byId[r.id] = r; });

  var profileKey = data.profileId || "default";
  var storeKey = "resume-binder:last:" + profileKey;
  var paneKey = "resume-binder:pane:" + profileKey;
  var termsKey = "resume-binder:terms:" + profileKey;

  function put(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // Every brief carries the same three tabs, so the one the reader chose stays
  // chosen as they move between positionings.
  function showPane(set, want) {
    var tabs = set.querySelectorAll(".pane-tab");
    var found = false;
    Array.prototype.forEach.call(tabs, function (t) {
      if (t.getAttribute("data-pane") === want) found = true;
    });
    if (!found) return;
    Array.prototype.forEach.call(tabs, function (t) {
      t.setAttribute("aria-selected", t.getAttribute("data-pane") === want ? "true" : "false");
    });
    Array.prototype.forEach.call(set.querySelectorAll(".pane"), function (p) {
      p.hidden = p.getAttribute("data-pane") !== want;
    });
  }

  function showTermsView(set, want) {
    Array.prototype.forEach.call(set.querySelectorAll(".view-button"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-terms-view") === want ? "true" : "false");
    });
    Array.prototype.forEach.call(set.querySelectorAll(".terms-view"), function (v) {
      v.hidden = v.getAttribute("data-terms-view") !== want;
    });
  }

  function applyRemembered() {
    var pane = get(paneKey);
    var view = get(termsKey);
    if (pane) {
      Array.prototype.forEach.call(document.querySelectorAll(".pane-set"), function (set) { showPane(set, pane); });
    }
    if (view) {
      Array.prototype.forEach.call(document.querySelectorAll(".terms-set"), function (set) { showTermsView(set, view); });
    }
  }

  // Checks pane tabs: one click flips between the marks, the review and the terms.
  document.addEventListener("click", function (event) {
    var tab = event.target.closest && event.target.closest(".pane-tab");
    if (!tab) return;
    var want = tab.getAttribute("data-pane");
    Array.prototype.forEach.call(document.querySelectorAll(".pane-set"), function (set) { showPane(set, want); });
    put(paneKey, want);
  });
  // The Terms toggle: the same terms, read by cloud or as two flat lists.
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest(".view-button");
    if (!button) return;
    var want = button.getAttribute("data-terms-view");
    Array.prototype.forEach.call(document.querySelectorAll(".terms-set"), function (set) { showTermsView(set, want); });
    put(termsKey, want);
  });
  // Disclosures: a cloud's terms, or the terms the source never had.
  document.addEventListener("click", function (event) {
    var row = event.target.closest && event.target.closest(".cloud-row, .disclose");
    if (!row) return;
    var open = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", open ? "false" : "true");
    var panel = document.getElementById(row.getAttribute("aria-controls"));
    if (panel) panel.hidden = open;
  });

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var spread = document.querySelector(".spread");
  var binderView = document.querySelector(".binder-view");
  var state = { view: "positioning", id: data.selected };

  function remember(id) {
    try { localStorage.setItem(storeKey, id); } catch (e) { /* private mode */ }
  }
  function recall() {
    try { return localStorage.getItem(storeKey); } catch (e) { return null; }
  }

  function parseHash() {
    var raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (raw === "binder") return { view: "binder", id: state.id };
    if (raw && byId[raw]) return { view: "positioning", id: raw };
    return null;
  }

  function hashFor(next) {
    return next.view === "binder" ? "#binder" : "#" + encodeURIComponent(next.id);
  }

  function render() {
    var showBinder = state.view === "binder";
    if (spread) spread.hidden = showBinder;
    if (binderView) binderView.hidden = !showBinder;

    tabs.forEach(function (tab) {
      var mine = showBinder ? tab.hasAttribute("data-view") : tab.getAttribute("data-resume") === state.id;
      tab.setAttribute("aria-selected", mine ? "true" : "false");
      tab.setAttribute("tabindex", mine ? "0" : "-1");
    });

    document.querySelectorAll(".brief, .pdf-page").forEach(function (pane) {
      pane.hidden = showBinder || pane.getAttribute("data-resume") !== state.id;
    });

    if (!showBinder) {
      // Only the open positioning loads its PDF: the rest wait their turn.
      var frame = document.querySelector('.pdf-page[data-resume="' + cssEscape(state.id) + '"] iframe');
      if (frame && !frame.getAttribute("src")) frame.setAttribute("src", frame.getAttribute("data-src"));
      remember(state.id);
    }
    document.title = showBinder
      ? data.profileName + ", binder"
      : byId[state.id].label + ", " + data.profileName;
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value;
  }

  function go(next, push) {
    state = { view: next.view || "positioning", id: byId[next.id] ? next.id : state.id };
    if (push !== false && location.hash !== hashFor(state)) history.pushState(state, "", hashFor(state));
    render();
  }

  function focusSelected() {
    var current = tabs.filter(function (t) { return t.getAttribute("aria-selected") === "true"; })[0];
    if (current) current.focus();
  }

  // Print goes through the open viewer's own window: the server serves the PDF
  // from this origin, so the frame is reachable. If it is not loaded, or the
  // browser refuses, open the PDF in a tab with its toolbar and print there.
  function printResume(id) {
    var frame = document.querySelector('.pdf-page[data-resume="' + cssEscape(id) + '"] iframe');
    try {
      if (frame && frame.getAttribute("src") && frame.contentWindow) {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        return;
      }
    } catch (e) { /* not loaded, or blocked: fall through to a real window */ }
    var entry = byId[id];
    if (!entry || !entry.pdf) return;
    var win = window.open(entry.pdf + "#toolbar=1", "_blank");
    if (!win) return;
    win.addEventListener("load", function () {
      try { win.print(); } catch (e) { /* the tab is open; the reader can print */ }
    });
  }

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-print]") : null;
    if (!button) return;
    event.preventDefault();
    printResume(button.getAttribute("data-target"));
  });

  document.addEventListener("click", function (event) {
    var node = event.target && event.target.closest ? event.target.closest(".tab, .sheet") : null;
    if (!node) return;
    if (node.hasAttribute("data-view")) { go({ view: "binder" }, true); return; }
    go({ view: "positioning", id: node.getAttribute("data-resume") }, true);
  });

  // Focus never enters the iframe, so the tab column can own the arrow keys.
  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    var tag = (event.target && event.target.tagName ? event.target.tagName : "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    var order = ["binder"].concat(ids);
    var index = order.indexOf(state.view === "binder" ? "binder" : state.id);
    var next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= order.length) return;
    event.preventDefault();
    go(next === 0 ? { view: "binder" } : { view: "positioning", id: order[next] }, true);
    focusSelected();
  });

  window.addEventListener("popstate", function () {
    var parsed = parseHash();
    state = parsed || { view: "positioning", id: data.selected };
    render();
  });

  var initial = parseHash();
  if (!initial) {
    var last = recall();
    if (last && byId[last]) initial = { view: "positioning", id: last };
  }
  if (initial) { state = initial; }
  applyRemembered();
  render();
})();
`;

function binderData(model: ResumeIndexModel, selectedId: string): string {
  const payload = {
    profileName: model.profileName,
    profileId: model.profileId,
    selected: selectedId,
    resumes: model.cards.map((card) => ({ id: card.id, label: card.label, pdf: card.links.pdf })),
  };
  // Keep the JSON inert inside <script>: no raw angle brackets or ampersands.
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function shell(title: string, body: string, tail = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
${tail}</body>
</html>
`;
}

export async function renderResumeIndexHtml(model: ResumeIndexModel): Promise<string> {
  const title = `${model.profileName}, resumes`;

  if (!model.cards.length) {
    return shell(title, `<div class="binder"><div class="spread"><section class="page brief">`
      + `<p class="empty">No positionings under ${escapeHtml(model.resumesDir)}. Run /onboarding to set some up.</p>`
      + `</section></div></div>`);
  }

  // Server-rendered landing: the first active positioning. The script swaps to
  // the last one read, or to whatever the hash asks for, as soon as it runs.
  const selected = (model.cards.find((c) => c.active) ?? model.cards[0]).id;
  const briefs = model.cards.map((card) => briefHtml(model, card, card.id === selected)).join("");
  const pages = model.cards.map((card) => pdfPageHtml(card, card.id === selected)).join("");

  const body = `<div class="binder">`
    + tabsHtml(model, selected)
    + `<div class="spread">${briefs}${pages}</div>`
    + binderViewHtml(model, true)
    + `</div>`;

  const tail = `<script type="application/json" id="binder-model">${binderData(model, selected)}</script>\n`
    + `<script>${SCRIPT}</script>\n`;
  return shell(title, body, tail);
}

/** Build the model, render it, write index.html. Returns the model. */
export async function writeResumeIndex(options: { profileId?: string | null; outPath?: string } = {}): Promise<ResumeIndexModel> {
  const model = await buildResumeIndexModel(options);
  await fs.mkdir(path.dirname(model.outPath), { recursive: true });
  await fs.writeFile(model.outPath, await renderResumeIndexHtml(model), "utf8");
  return model;
}

/* -------------------------------------------------------------------- cli */

function parseArgs(argv: string[]): { profile?: string; out?: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [flag, inline] = token.slice(2).split("=", 2);
    args[flag] = inline ?? argv[++i] ?? "";
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profileId = args.profile && args.profile !== "default" ? args.profile : null;
  const model = await writeResumeIndex({ profileId, outPath: args.out ? path.resolve(args.out) : undefined });
  console.log(JSON.stringify({
    index: model.outPath,
    resumes: model.cards.length,
    active: model.cards.filter((c) => c.active).length,
  }, null, 2));
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
