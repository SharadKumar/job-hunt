/**
 * Durable, attended human labels for the Jev calibration cohort.
 *
 * Generated benchmark JSON is evidence, not a writable source of truth. Human
 * labels live under ignored local state, are bound to both the role content
 * hash and the exact Jev decision id, and are invalidated rather than carried
 * forward when either changes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { log as auditLog } from "../audit.ts";
import { classificationContentHash, type DisciplineFit } from "../classification.ts";
import { writeAtomic } from "../lib/fs.ts";
import { load, type Opportunity } from "../pipeline.ts";
import { store } from "../pipeline-store.ts";
import { repoPath } from "../repo-root.ts";
import { activeResumes } from "../resumes.ts";

export type HumanDisciplineLabel = DisciplineFit | "insufficient_evidence";
export type HumanResumeLabel = string | "none" | "insufficient_evidence";
export type HumanApplyLabel = "yes" | "no" | "insufficient_evidence";

export type JevAdjudication = {
  role_id: string;
  content_hash: string;
  jev_decision_id: string;
  discipline_fit: HumanDisciplineLabel | null;
  matched_resume_id: HumanResumeLabel | null;
  apply_worthy: HumanApplyLabel | null;
  notes: string | null;
  actor: string;
  recorded_at: string;
};

export type AdjudicationFile = {
  schema_version: 1;
  updated_at: string | null;
  labels: Record<string, JevAdjudication>;
};

export type AdjudicationRequirements = {
  discipline_fit: boolean;
  matched_resume_id: boolean;
  apply_worthy: boolean;
};

export type AdjudicationQueueItem = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  pipeline_status: string;
  description: string;
  description_excerpt: string;
  priority: number;
  sources: Array<"frozen_cohort" | "agent_disagreement" | "shadow_proxy_disagreement">;
  outcome_consequential: boolean;
  jev_automatic: boolean;
  differences: { discipline_fit: boolean; matched_resume_id: boolean };
  generic_agent: Record<string, unknown> | null;
  jev: {
    status: string;
    discipline_fit: string;
    discipline_distribution: Record<string, number> | null;
    matched_resume_id: string | null;
    resume_distribution: Record<string, number> | null;
    profile_relevance: number;
    decision_id: string;
  } | null;
  content_hash: string;
  required: AdjudicationRequirements;
  human_label: JevAdjudication | null;
  delegated_decision: boolean;
  independent_human_complete: boolean;
  complete: boolean;
  stale: boolean;
  stale_reason: string | null;
};

export type AdjudicationQueue = {
  schema_version: 1;
  generated_at: string;
  active_resumes: { id: string; label: string }[];
  counts: {
    items: number;
    pending: number;
    complete: number;
    stale: number;
    priority_1: number;
    priority_1_pending: number;
    delegated_decisions: number;
    independent_human_complete: number;
    frozen_primary_required: number;
    frozen_primary_complete: number;
    frozen_primary_human_complete: number;
    shadow_review_required: number;
    shadow_review_complete: number;
    shadow_review_human_complete: number;
  };
  items: AdjudicationQueueItem[];
};

type AgentReview = {
  items?: Array<Record<string, any>>;
};

type ShadowReview = {
  items?: Array<Record<string, any>>;
};

function adjudicationPath(explicit?: string): string {
  return explicit
    ? path.resolve(explicit)
    : process.env.JEV_ADJUDICATIONS_PATH
      ? path.resolve(process.env.JEV_ADJUDICATIONS_PATH)
      : repoPath("state/jev/adjudications.json");
}

async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function loadAdjudications(file?: string): Promise<AdjudicationFile> {
  const value = await readJsonOr<AdjudicationFile>(adjudicationPath(file), {
    schema_version: 1,
    updated_at: null,
    labels: {},
  });
  if (value.schema_version !== 1 || !value.labels || typeof value.labels !== "object") {
    throw new Error("Jev adjudications have an unsupported or malformed schema");
  }
  return value;
}

export function isIndependentHumanAdjudication(label: JevAdjudication | null): boolean {
  return label?.actor === "user";
}

export function adjudicationComplete(label: JevAdjudication | null, required: AdjudicationRequirements): boolean {
  if (!label) return false;
  return (!required.discipline_fit || Boolean(label.discipline_fit))
    && (!required.matched_resume_id || Boolean(label.matched_resume_id))
    && (!required.apply_worthy || Boolean(label.apply_worthy));
}

function currentLabel(
  labels: Record<string, JevAdjudication>,
  roleId: string,
  contentHash: string,
  decisionId: string | null,
): { label: JevAdjudication | null; stale: boolean; reason: string | null } {
  const label = labels[roleId] ?? null;
  if (!label) return { label: null, stale: false, reason: null };
  if (label.content_hash !== contentHash) return { label, stale: true, reason: "The role content changed after this label was recorded." };
  if (!decisionId || label.jev_decision_id !== decisionId) return { label, stale: true, reason: "The Jev decision changed after this label was recorded." };
  return { label, stale: false, reason: null };
}

function itemPriority(agentItem: Record<string, any> | undefined, shadowItem: Record<string, any> | undefined): number {
  if (agentItem?.priority === 1) return 1;
  if (shadowItem) return 2;
  if (agentItem?.outcome_consequential) return 3;
  if (agentItem) return 4;
  return 5;
}

function outcomeConsequential(row: Opportunity): boolean {
  return ["submitted", "responded", "interview", "offered", "won"].includes(row.status);
}

export async function getAdjudicationQueue(options: {
  adjudicationsFile?: string;
  cohortFile?: string;
  agentReviewFile?: string;
  shadowReviewFile?: string;
  now?: Date;
} = {}): Promise<AdjudicationQueue> {
  const cohortIds = await readJsonOr<string[]>(
    options.cohortFile ?? repoPath("docs/benchmarks/jev-cohort.json"),
    [],
  );
  const agentReview = await readJsonOr<AgentReview>(
    options.agentReviewFile ?? repoPath("docs/benchmarks/jev-agent-disagreement-review.json"),
    {},
  );
  const shadowReview = await readJsonOr<ShadowReview>(
    options.shadowReviewFile ?? repoPath("docs/benchmarks/jev-calibration-review.json"),
    {},
  );
  const saved = await loadAdjudications(options.adjudicationsFile);
  const resumes = await activeResumes().catch(() => []);
  const rows = await load();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const agentById = new Map((agentReview.items ?? []).map((item) => [String(item.id), item]));
  const shadowById = new Map((shadowReview.items ?? []).map((item) => [String(item.id), item]));
  const allIds = new Set([...cohortIds.map(String), ...agentById.keys(), ...shadowById.keys()]);
  const cohortSet = new Set(cohortIds.map(String));

  const items: AdjudicationQueueItem[] = [];
  for (const id of allIds) {
    const row = byId.get(id);
    if (!row) continue;
    const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
    const decision = store().getClassificationDecision(id, contentHash);
    const agentItem = agentById.get(id);
    const shadowItem = shadowById.get(id);
    const sources: AdjudicationQueueItem["sources"] = [];
    if (cohortSet.has(id)) sources.push("frozen_cohort");
    if (agentItem) sources.push("agent_disagreement");
    if (shadowItem) sources.push("shadow_proxy_disagreement");
    const required: AdjudicationRequirements = cohortSet.has(id)
      ? { discipline_fit: true, matched_resume_id: true, apply_worthy: true }
      : { discipline_fit: false, matched_resume_id: false, apply_worthy: true };
    const bound = currentLabel(saved.labels, id, contentHash, decision?.provenance.decision_id ?? null);
    const staleReason = !decision
      ? "No current Jev decision exists for this role and content."
      : bound.reason;
    const stale = !decision || bound.stale;
    const complete = !stale && adjudicationComplete(bound.label, required);
    const independentHumanComplete = complete && isIndependentHumanAdjudication(bound.label);
    const differences = agentItem?.differences ?? { discipline_fit: false, matched_resume_id: false };
    items.push({
      id,
      title: row.title,
      company: row.company,
      location: row.location ?? null,
      pipeline_status: row.status,
      description: row.description ?? "",
      description_excerpt: (row.description ?? "").replace(/\s+/g, " ").slice(0, 700),
      priority: itemPriority(agentItem, shadowItem),
      sources,
      outcome_consequential: agentItem?.outcome_consequential ?? outcomeConsequential(row),
      jev_automatic: decision?.status === "automatic",
      differences,
      generic_agent: agentItem?.generic_agent ?? null,
      jev: decision ? {
        status: decision.status,
        discipline_fit: decision.discipline_fit,
        discipline_distribution: decision.decisions.discipline_fit?.probabilities ?? null,
        matched_resume_id: decision.matched_resume_id,
        resume_distribution: decision.decisions.matched_resume?.probabilities ?? null,
        profile_relevance: decision.profile_relevance,
        decision_id: decision.provenance.decision_id,
      } : null,
      content_hash: contentHash,
      required,
      human_label: bound.label,
      delegated_decision: complete && !isIndependentHumanAdjudication(bound.label),
      independent_human_complete: independentHumanComplete,
      complete,
      stale,
      stale_reason: staleReason,
    });
  }

  items.sort((a, b) => Number(a.complete) - Number(b.complete) || a.priority - b.priority || a.id.localeCompare(b.id));
  const frozen = items.filter((item) => item.sources.includes("frozen_cohort"));
  const shadow = items.filter((item) => item.sources.includes("shadow_proxy_disagreement"));
  return {
    schema_version: 1,
    generated_at: (options.now ?? new Date()).toISOString(),
    active_resumes: resumes.map((resume) => ({ id: resume.id, label: resume.label })),
    counts: {
      items: items.length,
      pending: items.filter((item) => !item.complete && !item.stale).length,
      complete: items.filter((item) => item.complete).length,
      stale: items.filter((item) => item.stale).length,
      priority_1: items.filter((item) => item.priority === 1).length,
      priority_1_pending: items.filter((item) => item.priority === 1 && !item.complete && !item.stale).length,
      delegated_decisions: items.filter((item) => item.delegated_decision).length,
      independent_human_complete: items.filter((item) => item.independent_human_complete).length,
      frozen_primary_required: frozen.length,
      frozen_primary_complete: frozen.filter((item) => item.complete).length,
      frozen_primary_human_complete: frozen.filter((item) => item.independent_human_complete).length,
      shadow_review_required: shadow.length,
      shadow_review_complete: shadow.filter((item) => item.complete).length,
      shadow_review_human_complete: shadow.filter((item) => item.independent_human_complete).length,
    },
    items,
  };
}

const DISCIPLINE_LABELS = new Set<HumanDisciplineLabel>(["core", "platform_gap", "adjacent", "outside", "insufficient_evidence"]);
const APPLY_LABELS = new Set<HumanApplyLabel>(["yes", "no", "insufficient_evidence"]);

function optionalString(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("label values must be strings or null");
  return value.trim() || null;
}

export async function recordAdjudication(input: {
  role_id?: unknown;
  content_hash?: unknown;
  jev_decision_id?: unknown;
  discipline_fit?: unknown;
  matched_resume_id?: unknown;
  apply_worthy?: unknown;
  notes?: unknown;
  actor?: unknown;
}, options: { adjudicationsFile?: string; now?: Date } = {}): Promise<JevAdjudication> {
  const roleId = optionalString(input.role_id);
  const expectedContentHash = optionalString(input.content_hash);
  const expectedDecisionId = optionalString(input.jev_decision_id);
  if (!roleId || !expectedContentHash || !expectedDecisionId) {
    throw new Error("role_id, content_hash and jev_decision_id are required");
  }
  const row = (await load()).find((candidate) => candidate.id === roleId);
  if (!row) throw new Error(`unknown role id: ${roleId}`);
  const contentHash = classificationContentHash({ title: row.title, description: row.description ?? "", location: row.location });
  if (contentHash !== expectedContentHash) throw new Error("role content changed; reload the review queue before saving");
  const decision = store().getClassificationDecision(roleId, contentHash);
  if (!decision) throw new Error("no current Jev decision exists for this role and content");
  if (decision.provenance.decision_id !== expectedDecisionId) throw new Error("Jev decision changed; reload the review queue before saving");

  const discipline = optionalString(input.discipline_fit) as HumanDisciplineLabel | null;
  const resume = optionalString(input.matched_resume_id) as HumanResumeLabel | null;
  const apply = optionalString(input.apply_worthy) as HumanApplyLabel | null;
  const notes = optionalString(input.notes);
  const actor = optionalString(input.actor) ?? "user";
  if (discipline && !DISCIPLINE_LABELS.has(discipline)) throw new Error(`invalid discipline_fit label: ${discipline}`);
  if (apply && !APPLY_LABELS.has(apply)) throw new Error(`invalid apply_worthy label: ${apply}`);
  const activeIds = new Set((await activeResumes()).map((resumeItem) => resumeItem.id));
  if (resume && resume !== "none" && resume !== "insufficient_evidence" && !activeIds.has(resume)) {
    throw new Error(`matched_resume_id must be an active resume id, none or insufficient_evidence: ${resume}`);
  }
  if (!discipline && !resume && !apply) throw new Error("at least one human label is required");
  if (notes && notes.length > 4000) throw new Error("notes must be at most 4000 characters");

  const at = (options.now ?? new Date()).toISOString();
  const label: JevAdjudication = {
    role_id: roleId,
    content_hash: contentHash,
    jev_decision_id: decision.provenance.decision_id,
    discipline_fit: discipline,
    matched_resume_id: resume,
    apply_worthy: apply,
    notes,
    actor,
    recorded_at: at,
  };
  const file = adjudicationPath(options.adjudicationsFile);
  const current = await loadAdjudications(file);
  current.updated_at = at;
  current.labels[roleId] = label;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(current, null, 2) + "\n");
  await auditLog({
    event_type: "jev_adjudication_recorded",
    role_id: roleId,
    actor,
    channel: row.channel ?? null,
    details: {
      content_hash: contentHash,
      jev_decision_id: decision.provenance.decision_id,
      discipline_fit: discipline,
      matched_resume_id: resume,
      apply_worthy: apply,
      notes,
    },
  });
  return label;
}
