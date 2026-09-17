/**
 * editorial-bans.ts — deterministic enforcement of the mechanical subset of a
 * profile's editorial rules.
 *
 * WHY
 * ---
 * `<profile-dir>/resume-editorial-rules.md` is prose. resume-writer reads it,
 * then repeatedly renders the exact wording it forbids (a side project called a
 * "product", a venture titled plain "CTO", ventures leading Career
 * Highlights) and reports the row as compliant. Prose cannot fail a gate.
 *
 * `<profile-dir>/editorial-bans.yaml` is the machine-readable subset: rules
 * that are decidable from the composed text alone. This module applies them and
 * `resume-audit.ts` folds the verdict in as `gates.editorial`, so a violation is
 * an exit-2 hard stop rather than something a writer can narrate away (see
 * `feedback_no_self_excused_fails`). Judgement calls — tone, bullet counts,
 * whether a claim over-reaches — stay in the prose file and remain the model's
 * job (`feedback_intelligent_not_deterministic_checks`).
 *
 * Matching is deliberately blunt:
 *   - plain phrases match with a word boundary at the START, stem-tolerant at
 *     the end ("incorporat" catches "incorporated"/"incorporation"). `match:
 *     word` on a rule forces strict whole-word matching at both ends.
 *   - `forbidden_regex` entries are applied case-insensitively, verbatim.
 *   - `title_must_equal` is exact string equality on a scoped experience title.
 *
 * Rules may also be narrowed to a subset of resume positionings with
 * `resumes: [ids]` / `except_resumes: [ids]`. The same profile can run one
 * positioning where "developer" is a demotion and another where it is the
 * whole point, so a ban is not always profile-wide.
 *
 * The gate is inert when no rules file exists (template samples, other
 * profiles): callers report `skip`, never `fail`.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import type { ResumeContent, ExperienceItem } from "../../../templates/resume/_interface.ts";

export type BanSeverity = "warn" | "fail";
export type BanVerdict = "pass" | "warn" | "fail";
export type BanFieldScope = "headline" | "summary" | "highlights" | "skills" | "any";

export type EditorialBanRule = {
  id: string;
  note?: string;
  scope: { company?: string; field?: BanFieldScope | BanFieldScope[] };
  /** Apply only to these resume ids. Mutually exclusive with `except_resumes`. */
  resumes?: string[];
  /** Apply to every resume id except these. Mutually exclusive with `resumes`. */
  except_resumes?: string[];
  title_must_equal?: string;
  forbidden_phrases?: string[];
  forbidden_regex?: string[];
  /** End-boundary behaviour for `forbidden_phrases`. Default `stem`. */
  match?: "stem" | "word";
  severity?: BanSeverity;
};

export type EditorialBanIssue = {
  rule_id: string;
  unit_path: string;
  matched: string;
  severity: BanSeverity;
  detail?: string;
};

export type EditorialBanResult = {
  verdict: BanVerdict;
  issues: EditorialBanIssue[];
  stats: { rules: number; fail_count: number; warn_count: number };
};

type TextUnit = { path: string; text: string };

const FIELD_SCOPES: BanFieldScope[] = ["headline", "summary", "highlights", "skills", "any"];

/** Parse + validate a bans YAML document. Throws on a malformed rule. */
export function parseEditorialBans(yamlText: string): EditorialBanRule[] {
  const doc = YAML.parse(yamlText) ?? {};
  const version = doc.version ?? 1;
  if (Number(version) !== 1) throw new Error(`editorial-bans: unsupported version ${version}`);
  const rules: unknown[] = Array.isArray(doc.rules) ? doc.rules : [];
  return rules.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, any>;
    if (!r.id) throw new Error(`editorial-bans: rules[${i}] has no id`);
    const scope = (r.scope ?? {}) as Record<string, any>;
    if (!scope.company && !scope.field) throw new Error(`editorial-bans: rule '${r.id}' has neither scope.company nor scope.field`);
    const fields: BanFieldScope[] | undefined = scope.field === undefined || scope.field === null
      ? undefined
      : (Array.isArray(scope.field) ? scope.field : [scope.field]).map(String) as BanFieldScope[];
    for (const f of fields ?? []) {
      if (!FIELD_SCOPES.includes(f)) throw new Error(`editorial-bans: rule '${r.id}' has unknown scope.field '${f}'`);
    }
    if (r.resumes !== undefined && !Array.isArray(r.resumes)) throw new Error(`editorial-bans: rule '${r.id}' has non-list resumes`);
    if (r.except_resumes !== undefined && !Array.isArray(r.except_resumes)) throw new Error(`editorial-bans: rule '${r.id}' has non-list except_resumes`);
    if (r.resumes && r.except_resumes) throw new Error(`editorial-bans: rule '${r.id}' sets both resumes and except_resumes`);
    if (r.title_must_equal && !scope.company) throw new Error(`editorial-bans: rule '${r.id}' uses title_must_equal without scope.company`);
    if (r.severity && r.severity !== "warn" && r.severity !== "fail") throw new Error(`editorial-bans: rule '${r.id}' has unknown severity '${r.severity}'`);
    if (r.match && r.match !== "stem" && r.match !== "word") throw new Error(`editorial-bans: rule '${r.id}' has unknown match '${r.match}'`);
    return {
      id: String(r.id),
      note: r.note ? String(r.note) : undefined,
      scope: { company: scope.company ? String(scope.company) : undefined, field: fields && fields.length === 1 ? fields[0] : fields },
      resumes: r.resumes ? r.resumes.map(String) : undefined,
      except_resumes: r.except_resumes ? r.except_resumes.map(String) : undefined,
      title_must_equal: r.title_must_equal ? String(r.title_must_equal) : undefined,
      forbidden_phrases: Array.isArray(r.forbidden_phrases) ? r.forbidden_phrases.map(String) : undefined,
      forbidden_regex: Array.isArray(r.forbidden_regex) ? r.forbidden_regex.map(String) : undefined,
      match: r.match as "stem" | "word" | undefined,
      severity: (r.severity as BanSeverity | undefined) ?? "fail",
    };
  });
}

/** Read + parse the bans file. Returns `null` when it does not exist (gate skips). */
export async function loadEditorialBans(file: string): Promise<EditorialBanRule[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  return parseEditorialBans(raw);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A phrase regex. `\b` at the start so "product" does not fire inside
 * "byproduct"; the end is stem-tolerant by default so a documented stem like
 * "incorporat" catches its inflections.
 */
function phraseRegex(phrase: string, match: "stem" | "word"): RegExp {
  const body = escapeRegExp(phrase.trim()).replace(/\\?\s+/g, "\\s+");
  const tail = match === "word" ? "\\b" : "\\w*";
  return new RegExp(`\\b${body}${tail}`, "i");
}

/** Rendered text fields of one experience, with composition-style unit paths. */
function experienceUnits(exp: ExperienceItem, index: number, includeTitle: boolean): TextUnit[] {
  const base = `experiences[${index}]`;
  const units: TextUnit[] = [];
  if (includeTitle) units.push({ path: `${base}.title`, text: exp.title ?? "" });
  units.push({ path: `${base}.company`, text: exp.company ?? "" });
  if (exp.placement === "feature") {
    units.push({ path: `${base}.summary`, text: exp.summary ?? "" });
    (exp.bullets ?? []).forEach((b, i) => units.push({ path: `${base}.bullets[${i}]`, text: b ?? "" }));
  } else {
    units.push({ path: `${base}.one_liner`, text: exp.one_liner ?? "" });
  }
  return units;
}

/**
 * The text units a rule applies to.
 *
 * `scope.company` → title + summary + bullets + one_liner of every experience
 * whose company matches the (case-insensitive) regex. `company` itself is not
 * scanned: it is the selector, and its own name would trip venture bans.
 */
function unitsForRule(content: ResumeContent, rule: EditorialBanRule): TextUnit[] {
  if (rule.scope.company) {
    let re: RegExp;
    try { re = new RegExp(rule.scope.company, "i"); } catch { re = new RegExp(escapeRegExp(rule.scope.company), "i"); }
    return (content.experiences ?? []).flatMap((exp, i) =>
      re.test(exp.company ?? "") ? experienceUnits(exp, i, true).filter((u) => !u.path.endsWith(".company")) : [],
    );
  }

  const fields: BanFieldScope[] = rule.scope.field === undefined
    ? ["any"]
    : Array.isArray(rule.scope.field) ? rule.scope.field : [rule.scope.field];
  const headline: TextUnit[] = content.headline ? [{ path: "headline", text: content.headline }] : [];
  const summary: TextUnit[] = [{ path: "summary", text: content.summary ?? "" }];
  const highlights: TextUnit[] = (content.highlights ?? []).map((h, i) => ({ path: `highlights[${i}]`, text: h ?? "" }));
  const skills: TextUnit[] = (content.skills ?? []).flatMap((block, i) => [
    { path: `skills[${i}].name`, text: block.name ?? "" },
    ...(block.summary ? [{ path: `skills[${i}].summary`, text: block.summary }] : []),
    ...(block.bullets ?? []).map((b, j) => ({ path: `skills[${i}].bullets[${j}]`, text: b ?? "" })),
  ]);

  const anyUnits = (): TextUnit[] => [
    ...headline,
    ...summary,
    ...highlights,
    ...skills,
    ...(content.additional_skills_summary ? [{ path: "additional_skills_summary", text: content.additional_skills_summary }] : []),
    ...(content.credentials ?? []).map((c, i) => ({ path: `credentials[${i}]`, text: c ?? "" })),
    ...(content.experiences ?? []).flatMap((exp, i) => experienceUnits(exp, i, true)),
  ];

  // Union of every declared field scope, de-duplicated by unit path so a rule
  // listing e.g. `[headline, summary, any]` cannot report the same unit twice.
  const seen = new Set<string>();
  const out: TextUnit[] = [];
  for (const field of fields) {
    const picked = field === "headline" ? headline
      : field === "summary" ? summary
      : field === "highlights" ? highlights
      : field === "skills" ? skills
      : anyUnits();
    for (const unit of picked) {
      if (seen.has(unit.path)) continue;
      seen.add(unit.path);
      out.push(unit);
    }
  }
  return out;
}

/**
 * Whether a rule applies to the resume being audited.
 *
 * With no `resumes` / `except_resumes` a rule is profile-wide. When the caller
 * does not know the resume id, `except_resumes` rules still apply (an unknown
 * id cannot be one of the exceptions) but `resumes` rules do not (membership
 * cannot be confirmed), so scoping never silently widens a ban.
 */
export function ruleAppliesToResume(rule: EditorialBanRule, resumeId?: string | null): boolean {
  if (rule.resumes?.length) return resumeId ? rule.resumes.includes(resumeId) : false;
  if (rule.except_resumes?.length) return resumeId ? !rule.except_resumes.includes(resumeId) : true;
  return true;
}

/**
 * Apply every rule to a composition.
 *
 * Deterministic and side-effect free: same content + same rules → same issues,
 * in rule order then unit order. `resumeId` (falling back to
 * `content.resumeId`) selects which resume-scoped rules are in force.
 */
export function checkEditorialBans(args: { content: ResumeContent; rules: EditorialBanRule[]; resumeId?: string | null }): EditorialBanResult {
  const { content, rules } = args;
  const resumeId = args.resumeId ?? content.resumeId ?? null;
  const applicable = rules.filter((rule) => ruleAppliesToResume(rule, resumeId));
  const issues: EditorialBanIssue[] = [];

  for (const rule of applicable) {
    const severity: BanSeverity = rule.severity ?? "fail";
    const units = unitsForRule(content, rule);

    if (rule.title_must_equal !== undefined) {
      for (const unit of units) {
        if (!unit.path.endsWith(".title")) continue;
        if (unit.text.trim() !== rule.title_must_equal) {
          issues.push({
            rule_id: rule.id,
            unit_path: unit.path,
            matched: unit.text.trim(),
            severity,
            detail: `title must equal "${rule.title_must_equal}"`,
          });
        }
      }
    }

    const phraseRules = (rule.forbidden_phrases ?? []).map((p) => ({ phrase: p, re: phraseRegex(p, rule.match ?? "stem") }));
    const regexRules = (rule.forbidden_regex ?? []).map((source) => ({ source, re: new RegExp(source, "i") }));

    for (const unit of units) {
      if (!unit.text) continue;
      for (const { phrase, re } of phraseRules) {
        const m = unit.text.match(re);
        if (m) issues.push({ rule_id: rule.id, unit_path: unit.path, matched: m[0], severity, detail: `forbidden phrase "${phrase}"` });
      }
      for (const { source, re } of regexRules) {
        const m = unit.text.match(re);
        if (m) issues.push({ rule_id: rule.id, unit_path: unit.path, matched: m[0].slice(0, 120), severity, detail: `forbidden pattern /${source}/` });
      }
    }
  }

  const fail_count = issues.filter((i) => i.severity === "fail").length;
  const warn_count = issues.length - fail_count;
  return {
    verdict: fail_count ? "fail" : warn_count ? "warn" : "pass",
    issues,
    stats: { rules: applicable.length, fail_count, warn_count },
  };
}
