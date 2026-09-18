/**
 * resume-index model: the data layer behind the CV binder page.
 *
 * Reads what is on disk for each resume folder (metadata, audit report,
 * keyword plan, composition, provenance, critic review) and turns it into the
 * `ResumeIndexModel` the renderer consumes. Nothing here emits HTML.
 *
 * Split out of `tools/resume/resume-index.ts`, which stays the CLI entry and
 * re-exports every symbol these modules define.
 */

import { exists, readJsonIfExists } from "../../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadProfile } from "../../profile.ts";
import { resolveProfileContext } from "../../profile-context.ts";
import { loadResolvedResumes } from "../../resumes.ts";
import { repoPath } from "../../repo-root.ts";
import { loadComposition } from "../lib/composition-io.ts";
import { applyComposition } from "../resume-keywords.ts";
import type { ResumeContent } from "../../../templates/resume/_interface.ts";
import { countWord, shortHumanDate } from "./vocabulary.ts";

/* ------------------------------------------------- artefacts as they sit on disk */

/**
 * The shapes below describe the JSON this page reads, and nothing more. Fields
 * are `unknown` rather than typed values because a report or plan written by an
 * older run may carry less, or carry something else entirely; naming them still
 * buys a spelling check, and every read goes through `num`, `count` or `String`.
 */

/** The counts a gate hangs off `stats`, whichever gate it is. */
export type RawGateStats = {
  featured?: unknown;
  mentioned?: unknown;
  dropped_with_reason?: unknown;
  unsupported_claims?: unknown;
  weak_citations?: unknown;
  number_unsupported?: unknown;
  unaccounted?: unknown;
  unsourced?: unknown;
};

/** One issue as a gate or the compact report lists it. */
export type RawIssue = { rule?: unknown; id?: unknown; severity?: unknown; detail?: unknown };

/** One gate in an audit report: sometimes a bare verdict string, sometimes this. */
export type RawGate = {
  verdict?: unknown;
  composite?: unknown;
  issues?: unknown;
  missing?: unknown;
  stats?: RawGateStats;
  fail_count?: unknown;
  warn_count?: unknown;
  jd_injected?: unknown;
  unconfirmed_terms?: unknown;
  ungrounded_count?: unknown;
};

/** The audit's keyword coverage block, shared by the report and the plan. */
export type RawCoverage = {
  surfaced_pct?: unknown;
  renderable_pct?: unknown;
  surfaced_total?: unknown;
  renderable_total?: unknown;
  familiarity_total?: unknown;
  must_have_surfaced?: unknown;
  must_have_renderable?: unknown;
  must_have_total?: unknown;
  must_have_unsurfaced?: unknown;
  verdict?: unknown;
};

/** `<prefix>.audit.json`, the compact report `resume:audit` leaves behind. */
export type RawAudit = {
  verdict?: unknown;
  generated_at?: unknown;
  pages?: { count?: unknown; target?: unknown; fills?: unknown; last_page_fill_pct?: unknown; min_last_page_fill_pct?: unknown };
  failing_units?: unknown;
  failing_units_total?: unknown;
  issues?: unknown;
  gates?: { ats?: RawGate; [key: string]: RawGate | undefined };
  keyword_coverage?: RawCoverage;
  ats_composite?: unknown;
  ats?: { composite?: unknown };
  provenance?: { stats?: RawGateStats };
  timings_ms?: { total?: unknown };
  cycles?: unknown;
  render_cycles?: unknown;
  iterations?: unknown;
  fit?: { cycles?: unknown };
  warnings?: unknown;
};

/** `metadata.json`: what was approved, when, and of which render. */
export type RawMetadata = {
  approval_status?: unknown;
  approved_at?: string;
  last_render_at?: string;
  approved_hash?: unknown;
  content_hash?: unknown;
};

/** One finding in `<prefix>.critic.json`. */
export type RawFinding = { kind?: unknown; why?: unknown; unit_path?: unknown; unit_paths?: unknown[] };

/** `<prefix>.critic.json`: the resume-critic's latest round. */
export type RawCritic = { verdict?: unknown; round?: unknown; findings?: unknown; summary_sentence?: unknown };

/** `<prefix>.provenance.json`, read only for its unsupported-claim count. */
export type RawProvenance = { unsupported_claims?: unknown };

/** One term in `keyword-plan.json`. */
export type RawTerm = {
  term?: unknown;
  status?: unknown;
  render_as?: unknown;
  source_update_required?: unknown;
  surfaced_in?: unknown;
  must_have?: unknown;
  cloud_id?: unknown;
};

/** One cloud in `keyword-plan.json`, with the counts it was written with. */
export type RawCloud = {
  id?: unknown;
  label?: unknown;
  weight?: unknown;
  total?: unknown;
  surfaced?: unknown;
  renderable?: unknown;
  familiarity?: unknown;
};

/** `keyword-plan.json`, before or after it is replayed against a composition. */
export type RawKeywordPlan = {
  terms?: unknown;
  clouds?: unknown;
  questions?: unknown;
  warnings?: unknown;
  title?: unknown;
  verdict?: unknown;
  coverage?: RawCoverage;
};

/** One experience in a composition, read loosely: placement has been spelled both ways. */
export type RawExperience = { placement?: unknown; title?: unknown; company?: unknown; start?: unknown; end?: unknown };

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
async function readJson<T>(file: string): Promise<T | null> {
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
    const v = (value as { verdict?: unknown }).verdict;
    if (typeof v === "string") return v;
  }
  return "skip";
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
  const v = value as RawGate;
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

function summariseAudit(audit: RawAudit | null): AuditSummary {
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
          .filter((i: RawIssue | null) => i && typeof i === "object")
          .map((i: RawIssue) => ({ rule: String(i.rule ?? ""), severity: String(i.severity ?? ""), detail: String(i.detail ?? "") }))
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

/**
 * What the approval stamp says, from the metadata alone.
 *
 * The hashes are the truth. `approved_hash` is the content the person read and
 * approved; `content_hash` is the content on disk now. They agree or they do
 * not, and nothing else has a vote.
 *
 * This used to also call an approval stale when an artefact's mtime was newer
 * than `approved_at`, on the theory that the pages had been rebuilt since. A
 * file copy, a restore, a `touch`, or any of the several things that reset
 * mtimes wholesale on a machine make that theory false, and it then declares
 * every approved CV "stale, rebuilt after approval" while the hashes sit there
 * agreeing. A rebuild that changed anything moves `content_hash` and is caught
 * by the first rule; a rebuild that changed nothing was not a change.
 *
 * Exported so the decision table can be tested without a filesystem.
 */
export function approvalStatus(
  meta: RawMetadata | null,
  hasArtefacts: boolean,
): { status: ResumeCard["status"]; date: string | null } {
  if (!meta) return { status: hasArtefacts ? "fresh" : "missing", date: null };
  // A stored approval goes stale as soon as the render's content_hash moves on.
  if (meta.approved_hash && meta.content_hash && meta.approved_hash !== meta.content_hash) {
    return { status: "stale", date: shortDate(meta.approved_at) };
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
function criticMark(review: RawCritic | null): { verdict: CheckMark["verdict"]; reason: string | null } {
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
export function openCriticFindings(review: RawCritic | null): string[] {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return findings
    .map((f: RawFinding) => {
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
function checkReason(key: string, gate: GateChip | undefined, audit: AuditSummary | null, auditRaw: RawAudit | null): string | null {
  const raw = auditRaw?.gates?.[key];
  const detailsOf = (issues: unknown): string[] =>
    Array.isArray(issues)
      ? issues.map((i: RawIssue | null) => String(i?.detail ?? i?.rule ?? i ?? "").trim()).filter(Boolean)
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
      ? [...new Set(raw.issues.map((i: RawIssue | null) => String(i?.rule ?? i?.id ?? "").trim()).filter(Boolean))] as string[]
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
  auditRaw: RawAudit | null,
  criticReview: RawCritic | null,
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
function isRenderableTerm(t: RawTerm | null): boolean {
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
function appliedPlan(rawPlan: RawKeywordPlan | null, content: ResumeContent | null): RawKeywordPlan | null {
  if (!rawPlan || !content || !Array.isArray(rawPlan.terms) || !rawPlan.terms.length) return rawPlan;
  try {
    const clone = structuredClone(rawPlan);
    if (!Array.isArray(clone.warnings)) clone.warnings = [];
    if (!Array.isArray(clone.questions)) clone.questions = [];
    if (!clone.title) clone.title = {};
    // The cast is the whole point of the try: a plan off disk may not be one.
    return applyComposition(clone as Parameters<typeof applyComposition>[0], content);
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

export function buildKeywordCloudRows(plan: RawKeywordPlan | null): KeywordCloudRow[] {
  const clouds: RawCloud[] = Array.isArray(plan?.clouds) ? plan.clouds : [];
  if (!clouds.length) return [];
  const terms: RawTerm[] = Array.isArray(plan?.terms) ? plan.terms : [];
  const cloudId = (value: unknown) => String(value ?? "");
  const known = new Set(clouds.map((c) => cloudId(c?.id)));
  const groups: Array<{ meta: RawCloud; mine: RawTerm[] }> = [...clouds]
    .sort((a, b) => (Number(b?.weight) || 0) - (Number(a?.weight) || 0) || String(a?.id).localeCompare(String(b?.id)))
    .map((c) => ({ meta: c, mine: terms.filter((t) => cloudId(t?.cloud_id) === cloudId(c?.id)) }));
  const loose = terms.filter((t) => !known.has(cloudId(t?.cloud_id)));
  if (loose.length) groups.push({ meta: OTHER_CLOUD, mine: loose });
  return groups
    .map(({ meta: c, mine }) => {
      const isFamiliarity = (t: RawTerm) => t?.render_as === "familiarity";
      const stateOf = (t: RawTerm): KeywordDot["state"] =>
        Array.isArray(t?.surfaced_in) && t.surfaced_in.length > 0
          ? "surfaced"
          : isRenderableTerm(t) ? "renderable" : "absent";
      const dots: KeywordDot[] = mine.map((t) => ({ term: String(t?.term ?? "").trim() || null, state: stateOf(t) }));
      const named = (t: RawTerm) => String(t?.term ?? "").trim();
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

function buildKeywordDots(plan: RawKeywordPlan | null, audit: AuditSummary | null, auditRaw: RawAudit | null): { kind: KeywordDotKind; dots: KeywordDot[]; familiarity: number } {
  const terms: RawTerm[] = Array.isArray(plan?.terms) ? plan.terms : [];
  // Plans predating `render_as` (and audit-only rows) simply report 0 here.
  const familiarity = num(plan?.coverage?.familiarity_total)
    ?? terms.filter((t) => t?.render_as === "familiarity").length;
  const named = (t: RawTerm) => String(t?.term ?? "").trim() || null;
  const surfacedIn = (t: RawTerm) => Array.isArray(t?.surfaced_in) && t.surfaced_in.length > 0;

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
      ? auditRaw.keyword_coverage.must_have_unsurfaced.map((t: RawTerm | string | null) => String((t as RawTerm)?.term ?? t ?? "").trim()).filter(Boolean)
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

  const auditRaw = auditPath ? await readJson<RawAudit>(auditPath) : null;
  const audit = auditPath ? summariseAudit(auditRaw) : null;
  const meta = metadataPath ? await readJson<RawMetadata>(metadataPath) : null;
  const rawPlan = keywordPlanPath ? await readJson<RawKeywordPlan>(keywordPlanPath) : null;
  const loaded = compositionPath ? await loadComposition(compositionPath).catch(() => null) : null;
  const composition = loaded?.content ?? null;
  // `keyword-plan.json` is written by `resume:keywords --proactive`, which runs
  // BEFORE the render: every term has an empty `surfaced_in` and every cloud a
  // surfaced count of zero. The audit gets real numbers by replaying the plan
  // against the composition, so the binder does exactly the same thing.
  const plan = appliedPlan(rawPlan, composition);
  const criticReview = criticPath ? await readJson<RawCritic>(criticPath) : null;
  const provenance = provenancePath ? await readJson<RawProvenance>(provenancePath) : null;

  const experiences: RawExperience[] = Array.isArray(composition?.experiences) ? composition!.experiences : [];
  const featured = composition ? experiences.filter((e) => e?.placement === "feature" || e?.placement === "featured").length : null;
  const mentioned = composition ? experiences.filter((e) => e?.placement === "mention" || e?.placement === "mentioned").length : null;
  const dropped = composition ? (Array.isArray(composition.dropped_experiences) ? composition.dropped_experiences.length : 0) : null;
  const unsupported = provenance
    ? (Array.isArray(provenance.unsupported_claims) ? provenance.unsupported_claims.length : num(provenance.unsupported_claims) ?? 0)
    : null;

  const isFeatured = (e: RawExperience) => e?.placement === "feature" || e?.placement === "featured";
  const featuredRoles = experiences.filter(isFeatured).map((e) => ({
    title: String(e?.title ?? "").trim(),
    company: String(e?.company ?? "").trim(),
    years: yearSpan(e?.start, e?.end),
  }));
  const openQuestions: string[] = Array.isArray(plan?.questions)
    ? plan.questions.map((q: RawTerm) => String(q?.term ?? "").trim()).filter(Boolean)
    : [];

  const hasArtefacts = Boolean(pdf || docx || html || md);
  const mtimes = { audit: await mtimeOf(auditPath), composition: await mtimeOf(compositionPath) };
  const { status, date } = approvalStatus(meta, hasArtefacts);

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
