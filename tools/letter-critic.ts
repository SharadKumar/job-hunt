#!/usr/bin/env tsx
/**
 * letter-critic.ts — cold, isolated fact-check of a cover letter against the
 * evidence corpus, run as a machine gate before an unattended SEEK submission.
 *
 * Why it exists (2026-09-15): the user moved SEEK Quick Apply to autopilot.
 * The human read that used to catch writer drift (venture work attributed to
 * the lender, an unsupported "stayed on schedule", a file-share estate called
 * a SharePoint estate, a recruiter/client mix-up) is gone from the loop, so a
 * separate LLM context with no memory of the drafting session reads the letter
 * against `state/profile/cv-source.md`, `state/profile/profile.md` and the
 * standing confidentiality rules, and returns strict JSON.
 *
 * There is no API key in this environment. The daily run itself is a
 * `claude -p` session, so the critic spawns a fresh `claude -p` child with no
 * tools, no project settings and a bespoke system prompt. If the child cannot
 * be spawned or returns unparseable output the tool exits 2 (error) and never
 * reports a pass; a missing verdict is a closed gate, not an open one.
 *
 * Deterministic pre-checks run before the LLM (em/en dashes, never-named
 * entities, other agencies' requisition codes). They are mechanical facts and
 * are recorded as `fail` findings alongside the LLM's.
 *
 * CLI:
 *   tsx tools/letter-critic.ts --letter <cover-letter.md> --jd <jd.md> [--out <json>]
 *       [--model sonnet|opus|haiku] [--timeout-ms 240000] [--apply-fixes]
 *   tsx tools/letter-critic.ts --digest [--since 14d] [--archive <dir>]
 *
 * The digest is the learning loop. Blocks recur on the same few themes (scope
 * inflation on one engagement, a venture named in a letter, one client's work
 * attributed to another) because a verdict file is read once and forgotten.
 * `--digest` reads every verdict in the archive, keeps the `fail` findings from
 * blocked verdicts, groups them by subject plus verb class, and prints a
 * standing-rule candidate per theme. No model call: it is pure aggregation.
 * Promotion of a theme into `letter-critic-rules.yaml` is an attended decision.
 *
 * Output JSON (also written to --out, default <letter-dir>/letter-critic.json):
 *   { verdict: "pass"|"block", findings: [{severity, quote, issue, fix}],
 *     letter_sha256, letter_path, jd_path, model, checked_at, ... }
 *
 * Exit codes: 0 pass, 1 block, 2 error (could not run or could not parse).
 * `--apply-fixes` is reserved and currently a no-op: the critic never edits.
 */

import { sha256 } from "./lib/hash.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";
import { resolveProfileContext } from "./profile-context.ts";

export type CriticFinding = { severity: "fail" | "warn"; quote: string; issue: string; fix: string; source?: "deterministic" | "llm" };

export type CriticResult = {
  verdict: "pass" | "block";
  findings: CriticFinding[];
  letter_sha256: string;
  letter_path: string;
  jd_path: string | null;
  model: string;
  checked_at: string;
  llm: { session_id?: string; cost_usd?: number; duration_ms?: number; verdict?: string } | null;
  error?: string;
};

export function sha256Text(text: string): string {
  return sha256(text);
}

/**
 * An error the CLI can report as a machine-readable reason. The gate callers
 * read the reason, not the prose, so the two failure modes stay distinct:
 * the child could not run at all, or it ran and said something unusable.
 */
export class CriticError extends Error {
  reason: string;
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CriticError";
    this.reason = reason;
  }
}

export const UNPARSEABLE = "unparseable critic output";
export const COULD_NOT_RUN = "critic could not run";

/**
 * Read an existing letter-critic.json and report whether it is a current pass
 * for the letter text supplied. Used by submission-gate (autopilot provenance)
 * and by autopilot-submit to skip a re-run when nothing changed.
 */
export async function readCurrentVerdict(criticJsonPath: string, letterText: string): Promise<{ ok: boolean; detail: string; result?: CriticResult }> {
  let raw: string;
  try { raw = await fs.readFile(criticJsonPath, "utf8"); } catch { return { ok: false, detail: `no letter-critic.json at ${criticJsonPath}` }; }
  let parsed: CriticResult;
  try { parsed = JSON.parse(raw) as CriticResult; } catch { return { ok: false, detail: "letter-critic.json is not valid JSON" }; }
  const sha = sha256Text(letterText);
  if (parsed.letter_sha256 !== sha) return { ok: false, detail: `letter-critic.json is for a different letter (sha ${String(parsed.letter_sha256).slice(0, 12)} vs current ${sha.slice(0, 12)})`, result: parsed };
  if (parsed.verdict !== "pass") return { ok: false, detail: `letter-critic verdict is '${parsed.verdict}' (${parsed.findings?.filter((f) => f.severity === "fail").length ?? 0} fail findings)`, result: parsed };
  return { ok: true, detail: `letter-critic pass for sha ${sha.slice(0, 12)} at ${parsed.checked_at}`, result: parsed };
}

// ---------------------------------------------------------------------------
// Deterministic pre-checks (mechanical facts only; semantics go to the LLM).
// ---------------------------------------------------------------------------

// Profile-owned rules (state/profile/letter-critic-rules.yaml, git-ignored):
// regex pre-checks in `never_named` and free-text `standing_rules`. The
// framework carries only the generic rules; everything about a specific
// person's clients, ventures and engagements lives in the profile.
type NeverNamed = { pattern: RegExp; issue: string; fix: string };
type ProfileRules = { neverNamed: NeverNamed[]; standingRules: string[]; profileFacts: string[]; profileSections: string[] };
const DEFAULT_PROFILE_SECTIONS = ["Engagement targets", "Government eligibility", "Work arrangement", "Standing apply rules"];

export async function loadProfileRules(profileId?: string | null): Promise<ProfileRules> {
  const p = path.join(resolveProfileContext(profileId).profileDir, "letter-critic-rules.yaml");
  let y: any = null;
  try { y = YAML.parse(await fs.readFile(p, "utf8")); } catch { return { neverNamed: [], standingRules: [], profileFacts: [], profileSections: DEFAULT_PROFILE_SECTIONS }; }
  const neverNamed: NeverNamed[] = [];
  for (const r of y?.never_named ?? []) {
    if (!r?.pattern) continue;
    try { neverNamed.push({ pattern: new RegExp(String(r.pattern), "i"), issue: String(r.issue ?? "Banned term."), fix: String(r.fix ?? "Remove it.") }); }
    catch { /* skip an invalid regex rather than crash the gate */ }
  }
  const str = (a: unknown) => (Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []);
  return { neverNamed, standingRules: str(y?.standing_rules), profileFacts: str(y?.profile_facts), profileSections: str(y?.profile_sections).length ? str(y?.profile_sections) : DEFAULT_PROFILE_SECTIONS };
}

/**
 * Mechanical, model-free checks over the letter text. Exported so the unit
 * tests can pin the behaviour (an em dash, a never-named term, a clearance
 * claim, a requisition-style code) without spawning a child model.
 */
export function deterministicFindings(letter: string, neverNamed: NeverNamed[]): CriticFinding[] {
  const out: CriticFinding[] = [];
  const lines = letter.split("\n");
  for (const line of lines) {
    if (/[\u2014\u2013]/.test(line)) {
      out.push({ severity: "fail", source: "deterministic", quote: line.trim().slice(0, 160), issue: "Contains an em or en dash. The profile bans both in all candidate-facing content.", fix: "Rewrite the clause as two sentences, a comma clause, or a colon. Do not swap in a hyphen." });
    }
    for (const rule of neverNamed) {
      if (rule.pattern.test(line)) out.push({ severity: "fail", source: "deterministic", quote: line.trim().slice(0, 160), issue: rule.issue, fix: rule.fix });
    }
    // Clearance: any claim of holding / having / possessing a clearance is a breach.
    if (/\b(hold|holding|held|have|having|possess|possessing|with)\b[^.]{0,40}\b(active |current )?(baseline|nv1|nv2|pv|tspv|negative vetting)\b[^.]{0,20}\bclearance\b/i.test(line)
      && !/\b(eligible|ready to apply|willing|able to obtain|do not (currently )?hold|not currently hold)\b/i.test(line)) {
      out.push({ severity: "fail", source: "deterministic", quote: line.trim().slice(0, 160), issue: "Reads as holding a security clearance. The profile holds none; only eligibility and readiness to apply may be stated.", fix: "State: Australian citizen, eligible for and ready to apply for a Baseline clearance." });
    }
    // Requisition / reference codes that look like another agency's (LH-01234, RFQ-xxxx, REQ12345).
    const code = line.match(/\b(LH|RFQ|REQ|JR|JOB|REF)[-\s]?\d{4,}\b/i);
    if (code) out.push({ severity: "warn", source: "deterministic", quote: line.trim().slice(0, 160), issue: `Contains a requisition-style code (${code[0]}). It may only appear if this recruiter's own advert uses it.`, fix: "Confirm the code is in jd.md for this advertiser; otherwise remove it." });
  }
  // A requisition code found in the letter but not in the JD is a fail; resolved by the caller once jd text is known.
  return out;
}

export function requisitionCodesNotInJd(letter: string, jd: string): CriticFinding[] {
  const codes = new Set<string>();
  for (const m of letter.matchAll(/\b(?:LH|RFQ|REQ|JR|JOB|REF)[-\s]?\d{4,}\b/gi)) codes.add(m[0].replace(/\s+/g, "-").toUpperCase());
  const out: CriticFinding[] = [];
  for (const c of codes) {
    const jdHas = new RegExp(c.replace(/-/g, "[-\\s]?"), "i").test(jd);
    if (!jdHas) out.push({ severity: "fail", source: "deterministic", quote: c, issue: "Requisition code is not in this advertiser's JD; it belongs to another representative of the same requisition.", fix: "Remove the code from the letter." });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM call via a fresh `claude -p` child.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TEMPLATE = `You are an independent fact-checker for a job applicant's cover letter. You have no memory of how the letter was drafted and you take nothing on trust. Your only sources of truth are the CORPUS (the applicant's canonical CV source), the PROFILE facts, and the STANDING RULES below. The JD is context for what the letter is responding to; it is never evidence for a claim about the applicant.

Read the letter sentence by sentence. For every number, client, employer, technology, title, date, outcome and scope claim, find the line in the CORPUS that supports it. If you cannot, it is unsupported. Misattribution (right fact, wrong employer or client), inflation (a bigger number, a broader scope, a stronger verb than the corpus), invented outcomes ("stayed on schedule", "delivered", "in production" when the corpus says scoped or architected), and JD wording presented as the applicant's experience are all failures. Generic professional English that makes no factual claim is fine. Reusing the JD's own phrasing to describe the role ("architecting and building", "hands-on", "day one") is not a failure when the underlying claim is supported by the corpus; it is a style choice, and at most a warn.

STANDING RULES (each breach is a fail):
1. Security clearance: unless the PROFILE facts state a currently held clearance, the applicant may be described only as eligible for and ready to apply for one. Any wording that reads as holding, having or having held a clearance the profile does not list is a breach.
2. No em dashes and no en dashes anywhere in the letter.
3. Spelling follows the PROFILE's English variant (default Australian English). For Australian English, US-only spellings are a breach: -ize verbs (organize, prioritize, realize, optimize), -or nouns (color, behavior), center, catalog, license as a noun. "Program" and "programme" are both acceptable Australian usage; never fail on that pair.
4. No requisition or reference code that belongs to another agency; a code may appear only if this advertiser's own JD text uses it.
5. Recruiter vs client: when the advertiser is a recruiter, the letter must not describe the recruiter as the organisation that runs the systems, owns the programme or is the end client. Attribute the work to "the client" or "your client".
6. Do not raise style, tone, length or persuasiveness. You are checking facts and rules only. Do not raise a gap the letter itself states openly (for example "I don't have direct GCP delivery"); disclosed gaps are correct behaviour.
{{PROFILE_RULES}}

Severity:
- "fail": unsupported claim, misattribution, inflation, invented outcome, any rule 1 to 11 breach. Any fail makes the verdict "block".
- "warn": a claim that is supported but loosely worded, a minor precision issue that would not mislead a reader, or JD phrasing echoed around a supported claim. Warns alone give "pass".

Return only JSON matching the schema: { "verdict": "pass"|"block", "findings": [ { "severity": "fail"|"warn", "quote": "<exact words from the letter>", "issue": "<what is wrong and which corpus line or rule decides it>", "fix": "<the minimal rewrite>" } ] }. An empty findings array with verdict "pass" is the correct answer for a clean letter. Quote exactly; never paraphrase the letter in "quote".`;

/** Generic rules plus the profile's own, numbered on from the generic list. */
export function systemPrompt(standingRules: string[]): string {
  const extra = standingRules.map((r, i) => `${7 + i}. ${r}`).join("\n");
  return SYSTEM_PROMPT_TEMPLATE.replace("{{PROFILE_RULES}}", extra);
}

const JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "block"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["fail", "warn"] },
          quote: { type: "string" },
          issue: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "quote", "issue", "fix"],
      },
    },
  },
  required: ["verdict", "findings"],
};

function extractSection(md: string, heading: string): string {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  return md.match(re)?.[1]?.trim() ?? "";
}

async function buildUserPrompt(letter: string, jd: string, rules: ProfileRules, profileId?: string | null): Promise<string> {
  const ctx = resolveProfileContext(profileId);
  const corpus = await fs.readFile(ctx.cvSourcePath, "utf8");
  const profile = await fs.readFile(ctx.profileMdPath, "utf8");
  // Sections of profile.md the critic may cite (headings matched by prefix, so
  // a heading like "Standing apply rules (user, 2026-09-15)" still resolves).
  const sections = rules.profileSections;
  const parts: string[] = [];
  for (const h of sections) {
    const body = extractSection(profile, h);
    if (body) parts.push(`## ${h}`, body);
  }
  if (rules.profileFacts.length) parts.push("## Standing facts (profile-owned)", rules.profileFacts.map((f) => `- ${f}`).join("\n"));
  const profileFacts = parts.join("\n\n");
  return [
    "=== PROFILE FACTS (state/profile/profile.md, excerpt) ===", profileFacts,
    "", "=== CORPUS (state/profile/cv-source.md, complete) ===", corpus,
    "", "=== JD (context only, never evidence about the applicant) ===", jd || "(no JD supplied)",
    "", "=== LETTER UNDER REVIEW ===", letter,
    "", "Check the LETTER UNDER REVIEW against the CORPUS, PROFILE FACTS and STANDING RULES. Return only the JSON verdict.",
  ].join("\n");
}

export type ClaudeJson = { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; session_id?: string; total_cost_usd?: number; duration_ms?: number };

async function spawnClaude(systemPrompt: string, userPrompt: string, model: string, timeoutMs: number): Promise<ClaudeJson> {
  const args = [
    "-p",
    "--tools", "",
    "--setting-sources", "",
    "--no-session-persistence",
    "--output-format", "json",
    "--model", model,
    "--max-budget-usd", process.env.LETTER_CRITIC_MAX_USD ?? "3",
    "--system-prompt", systemPrompt,
    "--json-schema", JSON.stringify(JSON_SCHEMA),
  ];
  // A nested session must not inherit the parent's session markers, or the
  // child may refuse to start or attach to the parent's transcript.
  const env = { ...process.env };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_PID"]) delete env[k];
  return new Promise<ClaudeJson>((resolve, reject) => {
    const child = spawn("claude", args, { env, cwd: repoPath("."), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new CriticError(COULD_NOT_RUN, `claude -p timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new CriticError(COULD_NOT_RUN, `could not spawn claude -p: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseClaudeStdout(stdout);
      if (!parsed) return reject(new CriticError(UNPARSEABLE, `claude -p exit ${code}; stdout was not JSON: ${stdout.slice(0, 300)} ${stderr.slice(0, 300)}`));
      if (parsed.is_error) return reject(new CriticError(COULD_NOT_RUN, `claude -p reported an error: ${String(parsed.result).slice(0, 300)}`));
      resolve(parsed);
    });
    child.stdin.on("error", () => { /* child closed early; the close handler reports */ });
    child.stdin.end(userPrompt);
  });
}

function parseClaudeStdout(stdout: string): ClaudeJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed) as ClaudeJson; } catch { /* fallthrough */ }
  // --output-format json is one object, but be tolerant of a leading log line.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)) as ClaudeJson; } catch { return null; }
}

/** Strip fences and pull the first JSON object out of free text. */
export function parseVerdictText(text: string): { verdict: string; findings: CriticFinding[] } | null {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (!obj || typeof obj !== "object") return null;
    return { verdict: String(obj.verdict ?? ""), findings: Array.isArray(obj.findings) ? obj.findings : [] };
  } catch { return null; }
}

/**
 * Pull the model's verdict out of a `claude -p` envelope: structured output
 * first, then the free-text result. Anything else is unusable and must close
 * the gate, so this throws rather than returning a nullish "no opinion".
 * Exported so the tests can exercise the malformed-output path without a spawn.
 */
export function verdictFromRaw(raw: ClaudeJson): { verdict: string; findings: CriticFinding[] } {
  let parsed: { verdict: string; findings: CriticFinding[] } | null = null;
  if (raw.structured_output && typeof raw.structured_output === "object") {
    const so = raw.structured_output as Record<string, unknown>;
    parsed = { verdict: String(so.verdict ?? ""), findings: Array.isArray(so.findings) ? (so.findings as CriticFinding[]) : [] };
  }
  if ((!parsed || !["pass", "block"].includes(parsed.verdict)) && typeof raw.result === "string") parsed = parseVerdictText(raw.result);
  if (!parsed || !["pass", "block"].includes(parsed.verdict)) {
    throw new CriticError(UNPARSEABLE, `no pass/block verdict in claude -p output: ${String(raw.result ?? "").slice(0, 300)}`);
  }
  return parsed;
}

function normaliseFinding(f: unknown): CriticFinding | null {
  if (!f || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  const severity = o.severity === "fail" ? "fail" : o.severity === "warn" ? "warn" : null;
  if (!severity) return null;
  return { severity, source: "llm", quote: String(o.quote ?? ""), issue: String(o.issue ?? ""), fix: String(o.fix ?? "") };
}

export type CritiqueOpts = { letterPath: string; jdPath?: string; model?: string; timeoutMs?: number; profileId?: string | null };

export async function critiqueLetter(opts: CritiqueOpts): Promise<CriticResult> {
  const letterPath = path.resolve(opts.letterPath);
  const letter = await fs.readFile(letterPath, "utf8");
  const jdPath = opts.jdPath ? path.resolve(opts.jdPath) : null;
  let jd = "";
  if (jdPath) {
    try { jd = await fs.readFile(jdPath, "utf8"); } catch (e: any) { throw new Error(`cannot read JD ${jdPath}: ${e.message}`); }
  }
  const model = opts.model ?? process.env.LETTER_CRITIC_MODEL ?? "sonnet";
  const checkedAt = new Date().toISOString();
  const sha = sha256Text(letter);

  const rules = await loadProfileRules(opts.profileId);
  const findings: CriticFinding[] = [...deterministicFindings(letter, rules.neverNamed), ...requisitionCodesNotInJd(letter, jd)];

  const userPrompt = await buildUserPrompt(letter, jd, rules, opts.profileId);
  const raw = await spawnClaude(systemPrompt(rules.standingRules), userPrompt, model, opts.timeoutMs ?? 240_000);

  const parsed = verdictFromRaw(raw);
  for (const f of parsed.findings) {
    const n = normaliseFinding(f);
    if (n) findings.push(n);
  }

  // Any fail → block, whatever the model's own verdict field says. A model
  // "block" with no fail finding is also honoured (fail closed).
  const anyFail = findings.some((f) => f.severity === "fail");
  const verdict: "pass" | "block" = anyFail || parsed.verdict === "block" ? "block" : "pass";

  return {
    verdict,
    findings,
    letter_sha256: sha,
    letter_path: letterPath,
    jd_path: jdPath,
    model,
    checked_at: checkedAt,
    llm: { session_id: raw.session_id, cost_usd: raw.total_cost_usd, duration_ms: raw.duration_ms, verdict: parsed.verdict },
  };
}

// ---------------------------------------------------------------------------
// Digest: turn a fortnight of block verdicts into standing-rule candidates.
// ---------------------------------------------------------------------------

export type DigestTheme = {
  key: string;
  count: number;
  opportunity_ids: string[];
  sample: string;
  proposed_rule: string;
};

export type Digest = {
  since: string;
  verdicts: number;
  blocked: number;
  themes: DigestTheme[];
};

/** Verb classes the grouper recognises, in precedence order for a tie. */
export const VERB_CLASSES = ["inflate", "conflate", "misattribut", "invent", "omit"] as const;
export type VerbClass = (typeof VERB_CLASSES)[number] | "other";

// Words that start a critic sentence or name the critic's own machinery. They
// are capitalised but they are not the subject of the finding, so a candidate
// proper-noun phrase beginning with one of these is skipped.
const NOT_A_SUBJECT = new Set([
  "a", "an", "and", "any", "as", "at", "but", "by", "claim", "conflates", "corpus", "costed", "delivered",
  "describes", "even", "every", "facts", "for", "from", "he", "his", "however", "if", "in", "inflates",
  "inflation", "invented", "invents", "is", "it", "its", "jd", "led", "letter", "managed", "misattributed",
  "misattributes", "misattribution", "neither", "no", "none", "nor", "not", "nothing", "of", "omits", "on",
  "only", "or", "outcome", "profile", "reads", "represented", "rule", "rules", "scope", "standing",
  "states", "stating", "such", "that", "the", "their", "there", "these", "this", "those", "to", "took",
  "unsupported", "when", "where", "which", "while", "with", "without",
]);

/** True when any slash or dot separated part of a word is critic vocabulary. */
function isGeneric(word: string): boolean {
  return word.toLowerCase().split(/[/.'\u2019]+/).filter(Boolean).some((part) => NOT_A_SUBJECT.has(part));
}

/** Lower-case connectors allowed inside a multi-word proper-noun phrase. */
const PHRASE_CONNECTORS = new Set(["of", "and", "for", "de", "la"]);

// The stem each class is recognised by, so "inflation", "inflated" and
// "inflates" all land in one bucket, and the noun a rule candidate reads with.
const CLASS_STEMS: Record<Exclude<VerbClass, "other">, { stem: string; noun: string }> = {
  inflate: { stem: "inflat", noun: "inflation" },
  conflate: { stem: "conflat", noun: "conflation" },
  misattribut: { stem: "misattribut", noun: "misattribution" },
  invent: { stem: "invent", noun: "invention" },
  omit: { stem: "omit", noun: "omission" },
};

/** The verb class of a finding: the earliest recognised stem wins. */
export function verbClass(issue: string): VerbClass {
  const lower = issue.toLowerCase();
  let best: VerbClass = "other";
  let bestAt = Infinity;
  for (const cls of VERB_CLASSES) {
    const at = lower.indexOf(CLASS_STEMS[cls].stem);
    if (at >= 0 && at < bestAt) { best = cls; bestAt = at; }
  }
  return best;
}

/**
 * The subject of a finding: an explicit standing-rule reference when the critic
 * cited one, otherwise the first proper-noun phrase that is not the critic's
 * own vocabulary. Falls back to "general" so nothing is silently dropped.
 */
export function themeSubject(issue: string): string {
  const rule = issue.match(/standing\s+rule\s*#?\s*(\d+)/i);
  if (rule) return `standing-rule-${rule[1]}`;
  const tokens = issue.split(/\s+/);
  // Strip surrounding punctuation and any possessive, so "JD's" is still the
  // generic word "jd" and "Treasury'" is still "Treasury".
  const clean = (t: string | undefined) => (t ?? "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9&.$+]+$/, "")
    .replace(/['\u2019]s$/i, "");
  for (let i = 0; i < tokens.length; i++) {
    // A word opening a quotation is the corpus speaking, not the finding's subject.
    if (/^["'\u2018\u201c]/.test(tokens[i])) continue;
    const head = clean(tokens[i]);
    if (!/^[A-Z]/.test(head)) continue;
    if (isGeneric(head)) continue;
    const phrase = [head];
    for (let j = i + 1; j < tokens.length && phrase.length < 4; j++) {
      const next = clean(tokens[j]);
      if (!next || isGeneric(next) && !PHRASE_CONNECTORS.has(next.toLowerCase())) break;
      if (PHRASE_CONNECTORS.has(next.toLowerCase())) {
        if (!/^[A-Z]/.test(clean(tokens[j + 1]))) break;
        phrase.push(next);
        continue;
      }
      if (!/^[A-Z]/.test(next)) break;
      phrase.push(next);
    }
    return phrase.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
  }
  return "general";
}

/** `<subject>:<verb class>`, the grouping key. */
export function themeKey(issue: string): string {
  return `${themeSubject(issue)}:${verbClass(issue)}`;
}

/** `14d`, `36h`, `2w`, or an ISO date. Returns the cutoff instant. */
export function parseSince(since: string, now: Date = new Date()): Date {
  const rel = since.trim().match(/^(\d+)\s*([dhw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2].toLowerCase() === "h" ? 3_600_000 : rel[2].toLowerCase() === "w" ? 604_800_000 : 86_400_000;
    return new Date(now.getTime() - n * ms);
  }
  const abs = new Date(since);
  if (Number.isNaN(abs.getTime())) throw new Error(`cannot read --since '${since}'; use 14d, 36h, 2w or an ISO date`);
  return abs;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const yamlScalar = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A one-line `standing_rules:` candidate in the profile YAML's shape. */
export function proposedRule(subject: string, cls: VerbClass, count: number, sample: CriticFinding): string {
  const verb = cls === "other" ? "an unsupported claim" : CLASS_STEMS[cls].noun;
  const fix = oneLine(sample.fix || "").slice(0, 140);
  const body = oneLine(
    `${subject}: blocked ${count} ${count === 1 ? "letter" : "letters"} on ${verb}. `
    + `Say only what cv-source.md supports about it, in the corpus's own scope and verb. `
    + (fix ? `Permitted wording: ${fix}` : "State the permitted wording here before promoting this rule."),
  );
  return `- ${yamlScalar(body)}`;
}

/** Every `<archive>/*\/letter-critic.json`, newest first, with its directory id. */
async function readVerdicts(archiveDir: string): Promise<{ id: string; result: CriticResult }[]> {
  let entries: string[] = [];
  try { entries = (await fs.readdir(archiveDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (e: any) { throw new Error(`cannot read archive ${archiveDir}: ${e.message}`); }
  const out: { id: string; result: CriticResult }[] = [];
  for (const id of entries.sort()) {
    const p = path.join(archiveDir, id, "letter-critic.json");
    let text: string;
    try { text = await fs.readFile(p, "utf8"); } catch { continue; }
    try { out.push({ id, result: JSON.parse(text) as CriticResult }); } catch { /* a corrupt verdict is not a theme */ }
  }
  return out;
}

export async function buildDigest(opts: { archiveDir: string; since: string; now?: Date }): Promise<Digest> {
  const now = opts.now ?? new Date();
  const cutoff = parseSince(opts.since, now);
  const all = await readVerdicts(opts.archiveDir);
  const inWindow = all.filter(({ result }) => {
    const at = new Date(result?.checked_at ?? "");
    return !Number.isNaN(at.getTime()) && at.getTime() >= cutoff.getTime();
  });

  type Bucket = { subject: string; cls: VerbClass; count: number; ids: Set<string>; sample: CriticFinding };
  const buckets = new Map<string, Bucket>();
  let blocked = 0;
  for (const { id, result } of inWindow) {
    if (result?.verdict !== "block") continue;
    blocked++;
    for (const f of result.findings ?? []) {
      if (f?.severity !== "fail") continue;
      const issue = String(f.issue ?? "");
      const subject = themeSubject(issue);
      const cls = verbClass(issue);
      const key = `${subject}:${cls}`;
      const b = buckets.get(key) ?? { subject, cls, count: 0, ids: new Set<string>(), sample: f };
      b.count++;
      b.ids.add(id);
      buckets.set(key, b);
    }
  }

  const themes: DigestTheme[] = [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      count: b.count,
      opportunity_ids: [...b.ids].sort(),
      sample: oneLine(String(b.sample.issue ?? "")).slice(0, 240),
      proposed_rule: proposedRule(b.subject, b.cls, b.count, b.sample),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { since: cutoff.toISOString(), verdicts: inWindow.length, blocked, themes };
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  if (a.digest) {
    const archiveDir = a.archive ? path.resolve(a.archive) : repoPath("state/pipeline/archive");
    const since = a.since && a.since !== "true" ? a.since : "14d";
    try {
      console.log(JSON.stringify(await buildDigest({ archiveDir, since })));
    } catch (e: any) {
      console.error(`[letter-critic] ERROR: ${e?.message ?? e}`);
      process.exit(2);
    }
    return;
  }
  if (!a.letter) {
    console.error("Usage: tsx tools/letter-critic.ts --letter <cover-letter.md> --jd <jd.md> [--out <json>] [--model sonnet] [--timeout-ms 240000] [--apply-fixes]");
    console.error("       tsx tools/letter-critic.ts --digest [--since 14d] [--archive <dir>]");
    process.exit(2);
  }
  if (a["apply-fixes"]) console.error("[letter-critic] --apply-fixes is reserved; the critic never edits a letter. Ignoring.");
  const outPath = a.out ? path.resolve(a.out) : path.join(path.dirname(path.resolve(a.letter)), "letter-critic.json");
  let result: CriticResult;
  try {
    result = await critiqueLetter({ letterPath: a.letter, jdPath: a.jd, model: a.model, timeoutMs: a["timeout-ms"] ? Number(a["timeout-ms"]) : undefined });
  } catch (e: any) {
    // Fail loudly. Do not write a verdict file: a stale pass must not survive
    // a broken run, and a missing file is a closed gate. The reason is machine
    // readable so a caller can tell "the child never ran" from "the child said
    // something unusable"; both close the gate, only one is worth a retry.
    const reason = e instanceof CriticError ? e.reason : COULD_NOT_RUN;
    console.log(JSON.stringify({ verdict: "error", reason, detail: String(e?.message ?? e).slice(0, 400) }));
    console.error(`[letter-critic] ERROR: ${e?.message ?? e}`);
    process.exit(2);
  }
  await fs.writeFile(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[letter-critic] ERROR: ${e?.message ?? e}`); process.exit(2); });
}
