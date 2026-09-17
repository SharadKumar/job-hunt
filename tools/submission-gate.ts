#!/usr/bin/env tsx
/**
 * submission-gate.ts: the single code-level chokepoint every submission MUST
 * pass before a channel adapter is invoked.
 *
 * Until now the submission-safety contract ("never submit without explicit
 * approval; honour the kill switch, the daily cap, per-channel opt-in, and the
 * validation gate") lived ONLY in the submission-runner agent's prose. Prose
 * is not enforcement: a headless run, a prompt regression, or a future adapter
 * could submit with nothing stopping it. This module turns that contract into
 * code. `submission-runner` (attended) and `tools/autopilot-submit.ts`
 * (unattended SEEK Quick Apply) both call it; the channel adapters are
 * reachable only through it.
 *
 * Two provenance forms are accepted in --approved-by:
 *
 *   attended:<session-reference>   a user confirmed this exact package at the
 *                                  action point in an attended session.
 *   autopilot:<run-id>             an unattended run (2026-09-15 user decision:
 *                                  SEEK Quick Apply on autopilot). Valid only
 *                                  while submission-policy.yaml has
 *                                  `autopilot.enabled: true`, and it adds gates
 *                                  the attended path does not need.
 *
 * Common gates, in order (fail-fast):
 *   1. provenance present and, for autopilot, enabled in policy → else needs_approval
 *   2. kill_switch off                                  → else blocked  (+ audit policy_kill_switch_blocked)
 *   3. [autopilot only] status is `approved`            → else gate_failed
 *   4. [autopilot only] classification._classifier is "agent" → else gate_failed
 *   5. [autopilot only] userSaved, OR discipline_fit core and not an
 *      interstate onsite/unknown-flexibility row        → else gate_failed
 *   6. [autopilot only] <archive>/letter-critic.json is a pass whose letter
 *      sha256 matches the current cover-letter.md      → else gate_failed
 *   7. tailored CV explicitly approved when required    → else gate_failed
 *   7b. a baseline-by-reference package's `resume.ref` still hashes to the
 *      recorded sha256, the baseline beside it is still approved, and its
 *      approved_hash still matches the one recorded at prepare time
 *                                                       → else gate_failed
 *   8. channel opted into auto_submit (and, for autopilot, listed in
 *      autopilot.channels)                              → else manual
 *   9. role not flagged red_flag_blocker                → else gate_failed (+ audit validation_gate_failed)
 *  10. rate is set in the profile (no TODO)             → else gate_failed (+ audit)
 *  11. no prior submission to this company+role-family  → else duplicate (needs a user decision;
 *      a user-saved row bypasses this because saving is an order to apply)
 *  12. artefact checks: ATS-lint / slop / voice verdicts → else gate_failed (+ audit)
 *  13. daily cap max_auto_submits_per_day not reached   → else capped   (+ audit daily_cap_hit)
 *  14. [autopilot only] autopilot.max_per_day not reached, counting today's
 *      audit `submitted` events with actor "autopilot"  → else capped   (+ audit daily_cap_hit)
 *   → otherwise: submit.
 *
 * CLI:
 *   tsx tools/submission-gate.ts --opportunity-id <id> [--channel <ch>] \
 *     [--cv-docx <path>] [--cover-md <path>] --approved-by attended:<ref>|autopilot:<run-id>
 *
 * Output: JSON { allowed, action, reason, provenance, checks }. Exit 0 if allowed, else 1.
 * The `action` field is authoritative for routing; callers should switch on it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import { load as loadPipeline, type Opportunity } from "./pipeline.ts";
import { log as auditLog, query as auditQuery, checkDuplicate } from "./audit.ts";
import { repoPath } from "./repo-root.ts";
import { readCurrentVerdict } from "./letter-critic.ts";
import { sha256 } from "./lib/hash.ts";

const exec = promisify(execFile);

const POLICY_PATH = repoPath("state/profile/submission-policy.yaml");
const PROFILE_PATH = repoPath("state/profile/profile.md");

// Channels that are ALWAYS manual regardless of any auto_submit flag: the
// policy documents these as FORCED FALSE.
const FORCED_MANUAL_CHANNELS = new Set(["recruiter_email", "manual"]);

export type GateAction =
  | "submit"          // all gates pass, caller may invoke the adapter
  | "manual"          // route to manual_action_needed (channel not opted in)
  | "duplicate"       // prior submission exists, caller must ask the user
  | "needs_approval"  // no approval token supplied: usage error / unsafe
  | "gate_failed"     // a hard validation gate failed
  | "blocked"         // kill switch is on
  | "capped";         // daily cap reached

export type CheckResult = { gate: string; ok: boolean; detail: string };

export type Provenance = "attended" | "autopilot";

export type GateDecision = {
  allowed: boolean;
  action: GateAction;
  reason: string;
  opportunityId: string;
  channel: string;
  provenance: Provenance | null;
  checks: CheckResult[];
};

export type AutopilotPolicy = {
  enabled?: boolean;
  channels?: string[];
  max_per_day?: number;
  require_letter_critic_pass?: boolean;
  core_discipline_only?: boolean;
  saved_jobs_bypass_fit_gates?: boolean;
  saved_jobs_hard_blocks?: string[];
  journal_every_send?: boolean;
  unsave_after_apply?: boolean;
};

export type Policy = {
  kill_switch?: boolean;
  max_auto_submits_per_day?: number;
  autopilot?: AutopilotPolicy;
  channels?: Record<string, { auto_submit?: boolean }>;
  tailored_resume_policy?: {
    explicit_human_approval_required?: boolean;
    inherit_baseline_approval?: boolean;
    block_submission_while_status_in?: string[];
  };
  hard_gates?: {
    cv_lint_ats_must_pass?: boolean;
    slop_killer_verdict_in?: string[];
    voice_check_verdict_in?: string[];
    rate_set_in_profile?: boolean;
    no_red_flag_blocker?: boolean;
    duplicate_check?: boolean;
    audit_dedup_check?: boolean;
    audit_dedup_within_days?: number;
  };
};

async function loadPolicy(): Promise<Policy> {
  return YAML.parse(await fs.readFile(POLICY_PATH, "utf8")) as Policy;
}

const VERDICT_BY_CODE: Record<number, "pass" | "warn" | "fail"> = { 0: "pass", 1: "warn", 2: "fail" };

/** Run a verdict-style checker (slop/voice/lint) and map its exit code. */
async function runVerdict(npmScript: string, args: string[]): Promise<"pass" | "warn" | "fail" | "error"> {
  try {
    await exec("npm", ["run", "-s", npmScript, "--", ...args]);
    return "pass"; // exit 0
  } catch (e: any) {
    const code = typeof e?.code === "number" ? e.code : 3;
    return VERDICT_BY_CODE[code] ?? "error";
  }
}

async function rateIsSet(): Promise<boolean> {
  // Policy intent: "if profile.md still has a TODO for rate, no auto-submit."
  let text: string;
  try { text = await fs.readFile(PROFILE_PATH, "utf8"); } catch { return false; }
  const rateLines = text.split("\n").filter((l) => /\brate\b/i.test(l));
  return !rateLines.some((l) => /TODO/i.test(l));
}

async function submittedToday(nowISO: string, actor?: string): Promise<number> {
  const start = new Date(nowISO);
  start.setHours(0, 0, 0, 0);
  const events = await auditQuery({ type: "submitted", sinceISO: start.toISOString() });
  return actor ? events.filter((e) => e.actor === actor).length : events.length;
}

/** Home city from profile.md (`city:` in the front matter); mirrors score.ts. */
async function homeCityFromProfile(): Promise<string | undefined> {
  try {
    const md = await fs.readFile(PROFILE_PATH, "utf8");
    return md.match(/^\s*city:\s*([A-Za-z ]+)\s*$/m)?.[1]?.trim();
  } catch { return undefined; }
}

/**
 * Interstate onsite / unknown-flexibility rows are what `pipeline:rescore`
 * parks. Same test as score.ts so the gate and the scorer cannot disagree.
 */
function isParkedInterstate(opportunity: Opportunity, homeCity: string | undefined): { parked: boolean; detail: string } {
  const loc = opportunity.location ?? "";
  const flex = (opportunity.classification as { location_flexibility?: string } | undefined)?.location_flexibility ?? "unknown";
  const isInterstate = Boolean(homeCity && loc && !new RegExp(`${homeCity}|NSW|Remote`, "i").test(loc));
  if (!isInterstate) return { parked: false, detail: `location '${loc || "unstated"}' is home/NSW/remote` };
  if (flex === "onsite" || flex === "unknown") return { parked: true, detail: `interstate (${loc}) with location_flexibility '${flex}'` };
  return { parked: false, detail: `interstate (${loc}) but location_flexibility '${flex}'` };
}

export type EvaluateOpts = {
  opportunityId: string;
  channel?: string;
  cvDocxPath?: string;
  coverMdPath?: string;
  approvedBy?: string;       // "attended:<session-reference>" or "autopilot:<run-id>"
  nowISO?: string;           // injectable for tests
  opportunities?: Opportunity[];    // injectable for tests (skip disk load)
  policy?: Policy;           // injectable for tests
  archiveDir?: string;       // injectable for tests; default state/pipeline/archive/<id>
  homeCity?: string;         // injectable for tests; default from profile.md
};

export function parseProvenance(approvedBy: string | undefined): { kind: Provenance; ref: string } | null {
  const m = approvedBy?.match(/^(attended|autopilot):(.+)$/);
  if (!m) return null;
  return { kind: m[1] as Provenance, ref: m[2] };
}

/**
 * Verify a baseline-by-reference package. Returns null when the package is not
 * one (tailored, legacy copy-based, or no metadata at all), else the verdict.
 */
export async function verifyBaselineRef(opts: { archiveDir: string; cvDocxPath?: string }): Promise<{ ok: boolean; detail: string } | null> {
  const metaPath = path.join(opts.archiveDir, "metadata.json");
  let meta: any;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    return { ok: false, detail: `package metadata at ${metaPath} is unreadable: ${e?.message ?? e}` };
  }
  const resume = meta?.resume;
  if (!resume || typeof resume.ref !== "string") return null;
  const ref: string = resume.ref;
  const refPath = path.isAbsolute(ref) ? ref : repoPath(ref);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(refPath);
  } catch {
    return { ok: false, detail: `metadata.resume.ref points at a file that is not there: ${ref}` };
  }
  const actual = sha256(bytes);
  if (typeof resume.sha256 !== "string") return { ok: false, detail: `metadata.resume.ref is set but metadata.resume.sha256 is missing, so the reference cannot be verified` };
  if (actual !== resume.sha256) {
    return { ok: false, detail: `resume at ${ref} has changed since the package was prepared (sha256 ${actual.slice(0, 12)}, package recorded ${String(resume.sha256).slice(0, 12)})` };
  }

  // The referenced file must also be the currently approved baseline.
  let baselineMeta: any = null;
  try {
    baselineMeta = JSON.parse(await fs.readFile(path.join(path.dirname(refPath), "metadata.json"), "utf8"));
  } catch {
    return { ok: false, detail: `no baseline metadata.json beside ${ref}; approval cannot be confirmed` };
  }
  if (baselineMeta.approval_status !== "approved" || !baselineMeta.approved_hash || baselineMeta.approved_hash !== baselineMeta.content_hash) {
    return { ok: false, detail: `baseline beside ${ref} is '${baselineMeta.approval_status ?? "unapproved"}' (approved_hash ${String(baselineMeta.approved_hash).slice(0, 12)}, content_hash ${String(baselineMeta.content_hash).slice(0, 12)})` };
  }
  if (typeof resume.baseline_content_hash === "string" && resume.baseline_content_hash !== baselineMeta.approved_hash) {
    return { ok: false, detail: `baseline was re-approved since the package was prepared (package ${resume.baseline_content_hash.slice(0, 12)}, resume-approve ${String(baselineMeta.approved_hash).slice(0, 12)})` };
  }
  if (opts.cvDocxPath) {
    const sending = sha256(await fs.readFile(opts.cvDocxPath).catch(() => Buffer.alloc(0)));
    if (sending !== actual) {
      return { ok: false, detail: `the docx handed to the adapter (${path.basename(opts.cvDocxPath)}, sha256 ${sending.slice(0, 12)}) is not the package's referenced baseline` };
    }
  }
  return { ok: true, detail: `baseline ref ${ref} verified (sha256 ${actual.slice(0, 12)}, approved ${String(baselineMeta.approved_at ?? "?").slice(0, 10)})` };
}

export async function evaluateSubmission(opts: EvaluateOpts): Promise<GateDecision> {
  const nowISO = opts.nowISO ?? new Date().toISOString();
  const policy = opts.policy ?? (await loadPolicy());
  const opportunities = opts.opportunities ?? (await loadPipeline());
  const opportunity = opportunities.find((r) => r.id === opts.opportunityId);
  const checks: CheckResult[] = [];

  const channel = opts.channel ?? opportunity?.channel ?? "unknown";
  const prov = parseProvenance(opts.approvedBy);
  const autopilot = prov?.kind === "autopilot";
  const decide = (action: GateAction, allowed: boolean, reason: string): GateDecision =>
    ({ allowed, action, reason, opportunityId: opts.opportunityId, channel, provenance: prov?.kind ?? null, checks });

  if (!opportunity) {
    checks.push({ gate: "opportunity_exists", ok: false, detail: `opportunity not found: ${opts.opportunityId}` });
    return decide("gate_failed", false, `opportunity not found: ${opts.opportunityId}`);
  }

  // 1. Provenance. Sheet state can authorize package preparation, but it never
  //    authorizes an external action on its own. Two forms carry authority:
  //    attended:<ref> (a user at the action point) and autopilot:<run-id>
  //    (only while the policy's autopilot block is enabled).
  if (!prov) {
    checks.push({ gate: "approval_token", ok: false, detail: "provenance must be attended:<session-reference> or autopilot:<run-id>" });
    return decide("needs_approval", false, "submission requires fresh attended approval for this exact application (--approved-by attended:<session-reference>) or an enabled autopilot run (--approved-by autopilot:<run-id>)");
  }
  checks.push({ gate: "approval_token", ok: true, detail: opts.approvedBy! });
  const ap = policy.autopilot ?? {};
  if (autopilot) {
    if (ap.enabled !== true) {
      checks.push({ gate: "autopilot_enabled", ok: false, detail: "submission-policy.yaml autopilot.enabled is not true" });
      return decide("needs_approval", false, "autopilot provenance supplied but autopilot.enabled is not true in submission-policy.yaml");
    }
    checks.push({ gate: "autopilot_enabled", ok: true, detail: `run ${prov.ref}` });
  }

  // 2. Kill switch: never bypass.
  if (policy.kill_switch) {
    checks.push({ gate: "kill_switch", ok: false, detail: "kill_switch is on" });
    await auditLog({
      event_type: "policy_kill_switch_blocked", role_id: opportunity.id, actor: "submission-gate", channel,
      details: { company: opportunity.company, title: opportunity.title, approved_by: opts.approvedBy },
      provenance: { url: opportunity.url, channel },
    });
    return decide("blocked", false, "kill_switch is on, all submissions halted");
  }
  checks.push({ gate: "kill_switch", ok: true, detail: "off" });

  const hg = policy.hard_gates ?? {};
  const failGate = async (gate: string, detail: string): Promise<GateDecision> => {
    checks.push({ gate, ok: false, detail });
    await auditLog({
      event_type: "validation_gate_failed", role_id: opportunity.id, actor: "submission-gate", channel,
      details: { company: opportunity.company, title: opportunity.title, gate, detail, approved_by: opts.approvedBy },
      provenance: { url: opportunity.url, channel },
    });
    return decide("gate_failed", false, `validation gate failed: ${gate}, ${detail}`);
  };

  // Autopilot-only gates. Nobody has read this package, so the row's own
  // state has to prove it was prepared the normal way and fact-checked.
  const userSaved = opportunity.userSaved === true;
  if (autopilot) {
    // (a) status is approved: the row walked drafted → awaiting_approval → approved.
    if (opportunity.status !== "approved") return failGate("autopilot_status_approved", `status is '${opportunity.status}', expected 'approved'`);
    checks.push({ gate: "autopilot_status_approved", ok: true, detail: "approved" });

    // (b) agent classification; regex triage never authorises a send.
    const classifier = opportunity.classification?._classifier;
    if (classifier !== "agent") return failGate("autopilot_agent_classified", `classification._classifier is '${classifier ?? "missing"}'`);
    checks.push({ gate: "autopilot_agent_classified", ok: true, detail: "agent" });

    // (c) user-saved (an order to apply) OR core discipline and not parked interstate.
    if (userSaved) {
      checks.push({ gate: "autopilot_fit", ok: true, detail: `userSaved at ${opportunity.userSavedAt ?? "unknown"}; fit gates bypassed` });
    } else {
      const fit = opportunity.classification?.discipline_fit;
      if (ap.core_discipline_only !== false && fit !== "core") return failGate("autopilot_fit", `discipline_fit is '${fit ?? "missing"}' and the row is not user-saved`);
      const homeCity = opts.homeCity ?? (await homeCityFromProfile());
      const parked = isParkedInterstate(opportunity, homeCity);
      if (parked.parked) return failGate("autopilot_fit", `${parked.detail}; the row belongs in parked, not the autopilot queue`);
      checks.push({ gate: "autopilot_fit", ok: true, detail: `discipline_fit core; ${parked.detail}` });
    }

    // (d) red-flag blocker is checked below for every provenance; autopilot
    //     additionally never lets a saved row bypass it (hard blocks only).
    // (e) letter-critic pass on the exact letter text.
    if (ap.require_letter_critic_pass !== false) {
      const archiveDir = opts.archiveDir ?? repoPath(`state/pipeline/archive/${opportunity.id}`);
      const letterPath = opts.coverMdPath ?? `${archiveDir}/cover-letter.md`;
      let letterText: string;
      try { letterText = await fs.readFile(letterPath, "utf8"); } catch { return failGate("autopilot_letter_critic", `cover letter not readable at ${letterPath}`); }
      const verdict = await readCurrentVerdict(`${archiveDir}/letter-critic.json`, letterText);
      if (!verdict.ok) return failGate("autopilot_letter_critic", verdict.detail);
      checks.push({ gate: "autopilot_letter_critic", ok: true, detail: verdict.detail });
    }
  }

  // 3. Tailored resumes have their own approval lifecycle. An approved
  // baseline cannot silently authorise role-specific edits.
  //    The gate applies when a tailored artefact is actually being sent. A
  //    classifier "requires_tailoring" hint with no tailored artefact means the
  //    approved baseline goes instead (the unattended path never tailors), so
  //    the baseline approval check further down is the one that matters.
  const sendingTailored = Boolean(opportunity.tailoredResume) && opportunity.tailoredResume?.mode !== "baseline";
  if (policy.tailored_resume_policy?.explicit_human_approval_required && sendingTailored) {
    const tailoredStatus = opportunity.tailoredResume?.approvalStatus ?? "missing";
    if (tailoredStatus !== "approved") {
      checks.push({ gate: "tailored_resume_approval", ok: false, detail: `tailored resume status is '${tailoredStatus}'` });
      return decide("gate_failed", false, `validation gate failed: tailored_resume_approval, tailored resume status is '${tailoredStatus}'`);
    }
    checks.push({
      gate: "tailored_resume_approval",
      ok: true,
      detail: `approved by ${opportunity.tailoredResume?.approvedBy ?? "human"}`,
    });
  }

  // 3b. Baseline-by-reference integrity. A baseline package no longer copies
  //     the approved CV into the archive; it records `resume.ref` (the path to
  //     the approved baseline docx), its sha256, and the baseline's approved
  //     content hash. A reference is only as good as its verification, so the
  //     gate re-hashes the file on disk and refuses the send unless it is the
  //     exact artefact the package was prepared from AND that baseline is still
  //     approved with the same hash resume-approve recorded.
  const refCheck = await verifyBaselineRef({
    archiveDir: opts.archiveDir ?? repoPath(`state/pipeline/archive/${opportunity.id}`),
    cvDocxPath: opts.cvDocxPath,
  });
  if (refCheck) {
    if (!refCheck.ok) return failGate("baseline_resume_ref", refCheck.detail);
    checks.push({ gate: "baseline_resume_ref", ok: true, detail: refCheck.detail });
  }

  // 4. Per-channel auto_submit opt-in. Not opted in (or forced-manual) → manual queue.
  //    Autopilot additionally requires the channel in autopilot.channels.
  const optedIn = !FORCED_MANUAL_CHANNELS.has(channel) && policy.channels?.[channel]?.auto_submit === true;
  if (!optedIn) {
    checks.push({ gate: "auto_submit", ok: false, detail: `channel '${channel}' not opted into auto_submit` });
    return decide("manual", false, `channel '${channel}' is manual-only, route to manual_action_needed`);
  }
  checks.push({ gate: "auto_submit", ok: true, detail: `channel '${channel}' opted in` });
  if (autopilot) {
    const apChannels = ap.channels ?? [];
    if (!apChannels.includes(channel)) {
      checks.push({ gate: "autopilot_channel", ok: false, detail: `channel '${channel}' not in autopilot.channels [${apChannels.join(", ")}]` });
      return decide("manual", false, `channel '${channel}' is not on autopilot, route to manual_action_needed`);
    }
    checks.push({ gate: "autopilot_channel", ok: true, detail: `channel '${channel}' on autopilot` });
  }
  //    LinkedIn (2026-09-16): only Easy Apply ads have an adapter. "Apply on
  //    company website" ads and rows the enricher never classified go manual.
  if (channel === "linkedin_jobs") {
    const method = opportunity.applyMethod ?? "unknown";
    if (method !== "easy_apply") {
      checks.push({ gate: "apply_method", ok: false, detail: `linkedin applyMethod is '${method}', adapter handles easy_apply only` });
      return decide("manual", false, `linkedin ad is '${method}', not Easy Apply, route to manual_action_needed`);
    }
    checks.push({ gate: "apply_method", ok: true, detail: "linkedin Easy Apply" });
  }

  // 4. Red-flag blocker. A user-saved row is an order to apply regardless of
  //    fit: no blocker stops it (user decision 2026-09-15: "saved jobs always
  //    applied, no questions").
  if (hg.no_red_flag_blocker && opportunity.red_flag_blocker === true) {
    if (autopilot && userSaved) {
      checks.push({ gate: "no_red_flag_blocker", ok: true, detail: "blocker bypassed: user-saved job is always applied (user decision 2026-09-15)" });
    } else {
      return failGate("no_red_flag_blocker", "opportunity is flagged red_flag_blocker");
    }
  } else {
    checks.push({ gate: "no_red_flag_blocker", ok: true, detail: "no blocker" });
  }

  // 5. Rate set in profile.
  if (hg.rate_set_in_profile && !(await rateIsSet())) {
    return failGate("rate_set_in_profile", "profile.md still has a TODO rate");
  }
  checks.push({ gate: "rate_set_in_profile", ok: true, detail: "rate set" });

  // 6. Cross-channel dedup: a prior submission to the same company+role-family
  //    is a decision for the user, not an auto-submit.
  if ((hg.audit_dedup_check || hg.duplicate_check) && autopilot && userSaved && ap.saved_jobs_bypass_fit_gates !== false) {
    checks.push({ gate: "audit_dedup", ok: true, detail: "skipped: user-saved row is an order to apply regardless of duplicate status" });
  } else if (hg.audit_dedup_check || hg.duplicate_check) {
    const within = hg.audit_dedup_within_days ?? 60;
    const dup = await checkDuplicate(opportunity.company, opportunity.title, within);
    const priorSubmitted = dup.matches.filter((m) => m.status === "submitted");
    if (priorSubmitted.length) {
      checks.push({ gate: "audit_dedup", ok: false, detail: `prior submission(s) within ${within}d: ${priorSubmitted.map((m) => m.role_id).join(", ")}` });
      return decide("duplicate", false, `already submitted to ${opportunity.company} for this role-family within ${within} days, needs a user decision`);
    }
    checks.push({ gate: "audit_dedup", ok: true, detail: `no prior submission within ${within}d` });
  }

  // 7. Artefact checks. If the policy requires a check we cannot run (missing
  //    artefact path), fail closed: never submit something we can't verify.
  if (hg.cv_lint_ats_must_pass) {
    if (!opts.cvDocxPath) return failGate("cv_lint_ats_must_pass", "no CV docx supplied to verify ATS lint");
    const v = await runVerdict("resume:lint:ats", ["--file", opts.cvDocxPath]);
    if (v === "fail" || v === "error") return failGate("cv_lint_ats_must_pass", `ATS lint verdict: ${v}`);
    checks.push({ gate: "cv_lint_ats_must_pass", ok: true, detail: `verdict ${v}` });
  }
  if (hg.slop_killer_verdict_in?.length) {
    if (!opts.coverMdPath) return failGate("slop_killer_verdict_in", "no cover letter supplied to verify slop verdict");
    const v = await runVerdict("slop:check", ["--file", opts.coverMdPath]);
    if (!hg.slop_killer_verdict_in.includes(v)) return failGate("slop_killer_verdict_in", `slop verdict '${v}' not in [${hg.slop_killer_verdict_in.join(", ")}]`);
    checks.push({ gate: "slop_killer_verdict_in", ok: true, detail: `verdict ${v}` });
  }
  if (hg.voice_check_verdict_in?.length) {
    if (!opts.coverMdPath) return failGate("voice_check_verdict_in", "no cover letter supplied to verify voice verdict");
    const v = await runVerdict("voice:check", ["--file", opts.coverMdPath, "--kind", "cover_letter"]);
    if (!hg.voice_check_verdict_in.includes(v)) return failGate("voice_check_verdict_in", `voice verdict '${v}' not in [${hg.voice_check_verdict_in.join(", ")}]`);
    checks.push({ gate: "voice_check_verdict_in", ok: true, detail: `verdict ${v}` });
  }

  // 8. Daily cap.
  const cap = policy.max_auto_submits_per_day ?? Infinity;
  const todayCount = await submittedToday(nowISO);
  if (todayCount >= cap) {
    checks.push({ gate: "daily_cap", ok: false, detail: `${todayCount}/${cap} submitted today` });
    await auditLog({
      event_type: "daily_cap_hit", role_id: opportunity.id, actor: "submission-gate", channel,
      details: { company: opportunity.company, title: opportunity.title, submitted_today: todayCount, cap, approved_by: opts.approvedBy },
      provenance: { url: opportunity.url, channel },
    });
    return decide("capped", false, `daily cap reached (${todayCount}/${cap}), try again tomorrow`);
  }
  checks.push({ gate: "daily_cap", ok: true, detail: `${todayCount}/${cap} submitted today` });

  // 9. Autopilot cap: separate from the attended cap, counted on audit
  //    `submitted` events whose actor is "autopilot".
  if (autopilot) {
    const apCap = ap.max_per_day ?? 0;
    const apCount = await submittedToday(nowISO, "autopilot");
    if (apCount >= apCap) {
      checks.push({ gate: "autopilot_daily_cap", ok: false, detail: `${apCount}/${apCap} autopilot submissions today` });
      await auditLog({
        event_type: "daily_cap_hit", role_id: opportunity.id, actor: "submission-gate", channel,
        details: { company: opportunity.company, title: opportunity.title, submitted_today: apCount, cap: apCap, approved_by: opts.approvedBy, scope: "autopilot" },
        provenance: { url: opportunity.url, channel },
      });
      return decide("capped", false, `autopilot daily cap reached (${apCount}/${apCap}), the rest waits for tomorrow`);
    }
    checks.push({ gate: "autopilot_daily_cap", ok: true, detail: `${apCount}/${apCap} autopilot submissions today` });
  }

  return decide("submit", true, "all gates pass");
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  if (!a["opportunity-id"]) {
    console.error("Usage: tsx tools/submission-gate.ts --opportunity-id <id> [--channel <ch>] [--cv-docx <path>] [--cover-md <path>] --approved-by attended:<ref>|autopilot:<run-id>");
    process.exit(2);
  }
  const decision = await evaluateSubmission({
    opportunityId: a["opportunity-id"],
    channel: a.channel,
    cvDocxPath: a["cv-docx"],
    coverMdPath: a["cover-md"],
    approvedBy: a["approved-by"],
  });
  console.log(JSON.stringify(decision, null, 2));
  process.exit(decision.allowed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(3); });
}
