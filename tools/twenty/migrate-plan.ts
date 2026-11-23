/**
 * migrate-plan.ts: what the one-time migration creates in Twenty (plan F12),
 * read from the harness's files. Pure readers; nothing here talks to Twenty.
 *
 * Every planned record has a stable id, uuid5("<object>:<sourceId>"), so a
 * second run finds what the first one made. Every source is optional: a
 * missing file plans nothing for its object.
 *
 * Sources (all under the repo root, or HARNESS_PROFILE's profile directory):
 *   - applications: state/pipeline/archive/<harnessId>/ for each opening in
 *     scope (cover-letter.md, letter-critic.json, metadata.json,
 *     confirmation.txt, manual-checklist.md, CV PDF and DOCX, screenshots);
 *     interview-brief.md and *debrief*.md become Notes on the opening;
 *   - documents: one per profile file kind, body = file text, revision 1;
 *   - screening questions: screening-answers.yaml unknown_questions;
 *   - keyword questions: market-confirmations.yaml confirmations;
 *   - positionings: resumes.yaml, with the baseline PDF and DOCX attached;
 *   - runs: the latest 50 state/journal/summary/<date>.md files;
 *   - people (F18): contacts.jsonl and the audit log's contact fields,
 *     minimised to name, role title, company, email and LinkedIn URL.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Opportunity } from "../pipeline.ts";
import { sha256 } from "../lib/hash.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoPath } from "../repo-root.ts";
import { openingId, uuid5 } from "../store/twenty-backend.ts";

export const recordId = (object: string, sourceId: string) => uuid5(`${object}:${sourceId}`);
export const companyId = (name: string) => uuid5(`company:${name.trim().toLowerCase()}`);

/** One record to create, keyed by its Twenty REST plural. */
export type PlannedRecord = { id: string; record: Record<string, unknown> };
/** A file to upload and attach to one record. */
export type PlannedFile = { id: string; name: string; path: string; targetField: string; targetId: string };
/** A Note and the opening it hangs off. */
export type PlannedNote = { id: string; targetId: string; title: string; markdown: string; targetOpeningId: string };

export type MigrationPlan = {
  companies: PlannedRecord[];
  positionings: PlannedRecord[];
  documents: PlannedRecord[];
  documentRevisions: PlannedRecord[];
  applications: PlannedRecord[];
  screeningQuestions: PlannedRecord[];
  keywordQuestions: PlannedRecord[];
  runs: PlannedRecord[];
  people: PlannedRecord[];
  notes: PlannedNote[];
  attachments: PlannedFile[];
  skipped: Record<string, number>;
};

export const RUN_LIMIT = 50;

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}
async function readJson(file: string): Promise<any> {
  const t = await readText(file);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}
async function readYaml(file: string): Promise<any> {
  const t = await readText(file);
  if (t == null) return null;
  try { return YAML.parse(t); } catch { return null; }
}
async function listDir(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir)).sort(); } catch { return []; }
}
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

// ---------------------------------------------------------------- documents

/** Document kinds (F5) and where each one's file lives, first match wins. */
export function documentSources(): { kind: string; name: string; candidates: string[] }[] {
  const p = resolveProfileContext(null, { files: true });
  const inProfile = (f: string) => path.join(p.profileDir, f);
  const org = (f: string) => repoPath("state", "org", f);
  return [
    { kind: "PROFILE", name: "Profile", candidates: [p.profileMdPath] },
    { kind: "CV_SOURCE", name: "CV source", candidates: [p.cvSourcePath] },
    { kind: "VOICE_RULES", name: "Voice rules", candidates: [inProfile("voice-rules.md"), org("voice-rules.md")] },
    { kind: "VOICE_SAMPLES", name: "Voice samples", candidates: [p.voiceSamplesPath] },
    { kind: "SLOP_BANLIST", name: "Slop banlist", candidates: [inProfile("slop-banlist.md"), org("slop-banlist.md")] },
    { kind: "EDITORIAL_RULES", name: "Editorial rules", candidates: [inProfile("resume-editorial-rules.md")] },
    { kind: "EDITORIAL_BANS", name: "Editorial bans", candidates: [inProfile("editorial-bans.yaml")] },
    { kind: "LETTER_CRITIC_RULES", name: "Letter critic rules", candidates: [inProfile("letter-critic-rules.yaml")] },
    { kind: "SCREENING_ANSWERS", name: "Screening answers", candidates: [inProfile("screening-answers.yaml")] },
    { kind: "CHANNELS", name: "Channels", candidates: [inProfile("channels.yaml")] },
    { kind: "SCORING", name: "Scoring", candidates: [inProfile("scoring-weights.yaml")] },
    { kind: "SUBMISSION_POLICY", name: "Submission policy", candidates: [inProfile("submission-policy.yaml")] },
    { kind: "POSITIONINGS", name: "Positionings", candidates: [p.resumesPath] },
    { kind: "KEYWORD_CLOUDS", name: "Keyword clouds", candidates: [org("keyword-clouds.yaml"), inProfile("keyword-clouds.yaml")] },
    { kind: "MARKET_CONFIRMATIONS", name: "Market confirmations", candidates: [p.marketConfirmationsPath] },
    // Profile files with no kind of their own: kind OTHER, named by their file
    // name, so a run materialises them back under the same name.
    { kind: "OTHER", name: "jev-policy.yaml", candidates: [inProfile("jev-policy.yaml")] },
    { kind: "OTHER", name: "skills-taxonomy.yaml", candidates: [inProfile("skills-taxonomy.yaml")] },
  ];
}

async function planDocuments(plan: MigrationPlan, migratedAt: string): Promise<void> {
  for (const src of documentSources()) {
    const file = src.candidates.find((c) => existsSync(c));
    const body = file ? await readText(file) : null;
    if (body == null) { if (src.kind !== "OTHER") bump(plan.skipped, "document: no file"); continue; }
    const key = src.kind === "OTHER" ? `OTHER:${src.name}` : src.kind;
    const docId = recordId("document", key);
    plan.documents.push({ id: docId, record: { id: docId, name: src.name, kind: src.kind, currentRevision: 1, migratedAt } });
    const revId = recordId("documentRevision", `${key}:1`);
    plan.documentRevisions.push({ id: revId, record: { id: revId, name: `${src.name} r1`, revision: 1, baseRevision: null, kind: src.kind, body, documentId: docId, migratedAt } });
  }
}

// -------------------------------------------------------------- applications

const CV_FILE = /\.(pdf|docx)$/i;
const SCREENSHOT = /\.(png|jpe?g)$/i;
const PAGE_RENDER = /-page-\d+\.png$/i;

export function criticVerdict(v: unknown): "PASS" | "BLOCK" | "PENDING" {
  const s = String(v ?? "").toLowerCase();
  if (s === "pass") return "PASS";
  if (s === "block" || s === "fail" || s === "revise") return "BLOCK";
  return "PENDING";
}

/** The confirmation reference from a confirmation.txt: the captured text, else its first line. */
export function confirmationRef(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/^Confirmation text:\s*(.+)$/m);
  const ref = (m?.[1] ?? text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return ref && ref !== "(none captured)" ? ref.slice(0, 500) : null;
}

/** Fields of one application from its archive's metadata (many historical shapes). */
export function applicationFields(meta: any, row: Opportunity, confirmation: string | null): Record<string, unknown> {
  const m = meta && typeof meta === "object" ? meta : {};
  const mode = String(m.resume?.mode ?? m.mode ?? "").toLowerCase();
  const cov = m.keyword_coverage ?? m.keywordCoverage ?? {};
  const pct = typeof cov.surfaced_pct === "number" ? cov.surfaced_pct : typeof cov.renderable_pct === "number" ? cov.renderable_pct : null;
  const submitted = typeof m.submitted === "object" && m.submitted ? (m.submitted.at ?? m.submitted.submittedAt) : m.submitted;
  return {
    cvMode: mode === "baseline" ? "BASELINE" : mode === "tailored" ? "TAILORED" : null,
    keywordCoverage: pct,
    submittedAt: isoOrNull(m.submittedAt) ?? isoOrNull(submitted) ?? isoOrNull(row.submittedAt),
    actor: confirmation && /autopilot/i.test(confirmation) ? "autopilot" : typeof m.submittedVia === "string" ? m.submittedVia : null,
    confirmationRef: confirmationRef(confirmation) ?? (typeof m.confirmationRef === "string" ? m.confirmationRef : null),
  };
}

async function planApplications(plan: MigrationPlan, rows: Opportunity[], migratedAt: string): Promise<void> {
  const archive = repoPath("state", "pipeline", "archive");
  for (const row of rows) {
    const dir = path.join(archive, row.id);
    if (!existsSync(dir)) continue;
    const files = await listDir(dir);
    const letter = await readText(path.join(dir, "cover-letter.md"));
    const critic = await readJson(path.join(dir, "letter-critic.json"));
    const meta = await readJson(path.join(dir, "metadata.json"));
    const confirmation = await readText(path.join(dir, "confirmation.txt"));
    const checklist = await readText(path.join(dir, "manual-checklist.md"));
    const compositionFile = files.find((f) => f.endsWith(".composition.json"));
    const id = recordId("application", row.id);
    plan.applications.push({
      id,
      record: {
        id,
        name: `${row.title ?? row.id} at ${row.company ?? "?"}`.slice(0, 200),
        letterMarkdown: letter,
        letterSha: letter != null ? sha256(letter) : null,
        criticVerdict: critic ? criticVerdict(critic.verdict) : "PENDING",
        composition: compositionFile ? await readJson(path.join(dir, compositionFile)) : null,
        manualChecklist: checklist,
        ...applicationFields(meta, row, confirmation),
        openingId: openingId(row.id),
        migratedAt,
      },
    });

    const attach = (file: string, name = path.basename(file)) =>
      plan.attachments.push({ id: recordId("attachment", `application:${row.id}:${name}`), name, path: file, targetField: "targetApplicationId", targetId: id });
    for (const f of files) {
      if (CV_FILE.test(f) || (SCREENSHOT.test(f) && !PAGE_RENDER.test(f))) attach(path.join(dir, f));
    }
    // A baseline package names the approved baseline instead of copying it.
    for (const ref of [obj(meta)?.resume?.ref, obj(meta)?.resume?.pdf_ref]) {
      if (typeof ref !== "string" || !ref) continue;
      const abs = path.isAbsolute(ref) ? ref : repoPath(ref);
      if (existsSync(abs) && !files.includes(path.basename(abs))) attach(abs);
    }
    // No letter renderer exists in the harness, so the letter goes up as markdown.
    if (letter != null) attach(path.join(dir, "cover-letter.md"));
    if (checklist != null) attach(path.join(dir, "manual-checklist.md"));

    for (const f of files) {
      if (!/\.md$/i.test(f) || !/(interview-brief|debrief)/i.test(f)) continue;
      const markdown = await readText(path.join(dir, f));
      if (markdown == null) continue;
      const title = /debrief/i.test(f) ? "Interview debrief" : "Interview brief";
      plan.notes.push({ id: recordId("note", `${row.id}:${f}`), targetId: recordId("noteTarget", `${row.id}:${f}`), title: `${title}: ${row.title ?? row.id}`.slice(0, 200), markdown, targetOpeningId: openingId(row.id) });
    }
  }
}
const obj = (v: any) => (v && typeof v === "object" ? v : null);

// ----------------------------------------------------------------- questions

export function keywordAnswer(status: unknown): { answer: string | null; status: "OPEN" | "ANSWERED" } {
  switch (String(status ?? "").toLowerCase()) {
    case "confirmed": return { answer: "CONFIRM", status: "ANSWERED" };
    case "declined":
    case "not_applicable": return { answer: "NOT_APPLICABLE", status: "ANSWERED" };
    case "familiarity": return { answer: "FAMILIARITY", status: "ANSWERED" };
    default: return { answer: "PENDING", status: "OPEN" };
  }
}

async function planQuestions(plan: MigrationPlan, inScope: Map<string, Opportunity>, positionings: Set<string>, migratedAt: string): Promise<void> {
  const p = resolveProfileContext(null, { files: true });
  const screening = await readYaml(path.join(p.profileDir, "screening-answers.yaml"));
  const seenQ = new Set<string>();
  for (const q of Array.isArray(screening?.unknown_questions) ? screening.unknown_questions : []) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) { bump(plan.skipped, "screeningQuestion: no question text"); continue; }
    const opp = typeof q.opportunity_id === "string" ? q.opportunity_id : "";
    const source = `${opp}:${norm(q.question)}`;
    if (seenQ.has(source)) continue;
    seenQ.add(source);
    const row = inScope.get(opp);
    const answer = typeof q.answer === "string" && q.answer.trim() ? q.answer : null;
    const id = recordId("screeningQuestion", source);
    plan.screeningQuestions.push({ id, record: { id, question: q.question, channel: row?.channel ?? (opp.split(/-/)[0] || null), answer, status: answer ? "ANSWERED" : "OPEN", openingId: row ? openingId(opp) : null, migratedAt } });
  }

  const ledger = await readYaml(p.marketConfirmationsPath);
  const seenK = new Set<string>();
  for (const c of Array.isArray(ledger?.confirmations) ? ledger.confirmations : []) {
    const term = typeof c?.signal === "string" && c.signal.trim() ? c.signal : typeof c?.term === "string" ? c.term : "";
    if (!term.trim()) { bump(plan.skipped, "keywordQuestion: no term"); continue; }
    const resume = typeof c.resume_id === "string" ? c.resume_id : "";
    const scope = c.scope === "person" || c.kind === "keyword" ? "person" : resume || "person";
    const source = `${scope}:${norm(term)}`;
    if (seenK.has(source)) continue;
    seenK.add(source);
    const opp = typeof c.opportunity_id === "string" ? c.opportunity_id : "";
    const id = recordId("keywordQuestion", source);
    plan.keywordQuestions.push({
      id,
      record: {
        id, term, weight: null, cloud: typeof c.category === "string" ? c.category : null,
        ...keywordAnswer(c.status),
        positioningId: resume && positionings.has(resume) ? recordId("positioning", resume) : null,
        openingId: inScope.has(opp) ? openingId(opp) : null,
        migratedAt,
      },
    });
  }
}

// --------------------------------------------------------------- positionings

const APPROVAL = new Set(["PENDING", "APPROVED", "STALE", "REJECTED"]);

async function planPositionings(plan: MigrationPlan, migratedAt: string): Promise<Set<string>> {
  const p = resolveProfileContext(null, { files: true });
  const ids = new Set<string>();
  let resumes: any[] = [];
  try {
    const { loadResumes } = await import("../resumes.ts");
    resumes = await loadResumes();
  } catch {
    const raw = await readYaml(p.resumesPath);
    resumes = Array.isArray(raw?.resumes) ? raw.resumes : [];
  }
  for (const r of resumes) {
    if (!r?.id) continue;
    ids.add(r.id);
    const dir = path.join(p.renderedResumesDir, r.id);
    const meta = await readJson(path.join(dir, "metadata.json"));
    const band = r.rate_band ?? {};
    const money = (n: unknown) => (typeof n === "number" ? { amountMicros: Math.round(n * 1_000_000), currencyCode: band.currency ?? "AUD" } : null);
    const approval = String(meta?.approval_status ?? "").toUpperCase();
    const id = recordId("positioning", r.id);
    plan.positionings.push({
      id,
      record: {
        id, name: r.label ?? r.id, harnessId: r.id,
        rateMin: money(band.floor), rateMax: money(band.ceiling),
        approvalStatus: APPROVAL.has(approval) ? approval : "PENDING",
        approvedAt: isoOrNull(meta?.approved_at),
        contentHash: typeof meta?.content_hash === "string" ? meta.content_hash : null,
        criticVerdict: criticVerdict(meta?.critic?.verdict),
        migratedAt,
      },
    });
    // The baseline: the artefact named in metadata (by basename, since recorded
    // paths may point at another checkout), else any PDF and DOCX in the folder.
    const files = await listDir(dir);
    for (const ext of ["pdf", "docx"]) {
      const named = meta?.artefacts?.[ext];
      const base = typeof named === "string" ? path.basename(named) : files.find((f) => f.toLowerCase().endsWith(`.${ext}`));
      if (!base || !files.includes(base)) continue;
      plan.attachments.push({ id: recordId("attachment", `positioning:${r.id}:${base}`), name: base, path: path.join(dir, base), targetField: "targetPositioningId", targetId: id });
    }
  }
  return ids;
}

// ----------------------------------------------------------------------- runs

/** A run record from one daily summary's markdown. */
export function runFromSummary(date: string, text: string, migratedAt: string): PlannedRecord {
  const section = (title: RegExp) => {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^## /.test(l) && title.test(l));
    if (start < 0) return [];
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const escalations = section(/Escalations/).filter((l) => /^- /.test(l)).length;
  const numbers = section(/Numbers/).find((l) => /^\|\s*\d/.test(l));
  const sent = numbers ? Number(numbers.split("|")[1].trim()) : section(/Sent today/).filter((l) => /^- /.test(l)).length;
  const generated = isoOrNull(text.match(/Generated (\S+?)\.?\s*$/m)?.[1]);
  const at = generated ?? `${date}T00:00:00.000Z`;
  const id = recordId("run", `summary:${date}`);
  return { id, record: { id, name: `Daily summary ${date}`, kind: "DAILY", startedAt: at, finishedAt: generated, exitCode: null, sentCount: Number.isFinite(sent) ? sent : null, escalationCount: escalations, summary: text, lettersSentUnattended: null, migratedAt } };
}

async function planRuns(plan: MigrationPlan, migratedAt: string): Promise<void> {
  const dir = repoPath("state", "journal", "summary");
  const files = (await listDir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).slice(-RUN_LIMIT);
  for (const f of files) {
    const text = await readText(path.join(dir, f));
    if (text != null) plan.runs.push(runFromSummary(f.slice(0, 10), text, migratedAt));
  }
}

// --------------------------------------------------------------------- people

export type MinimalContact = { name: string | null; roleTitle: string | null; company: string | null; email: string | null; linkedinUrl: string | null };

const cleanUrl = (u: string) => u.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/^http:\/\//i, "https://").replace(/^https:\/\/(www\.)?/i, "https://www.").toLowerCase();

/** Keep only the five fields F18 allows; every other field (phone, notes) is dropped. */
export function minimise(c: any): MinimalContact | null {
  if (!c || typeof c !== "object") return null;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const email = s(c.email)?.toLowerCase() ?? null;
  const li = s(c.linkedin_url ?? c.linkedinUrl ?? c.linkedin);
  return { name: s(c.name), roleTitle: s(c.role_title ?? c.roleTitle ?? c.title), company: s(c.company), email, linkedinUrl: li ? cleanUrl(li) : null };
}

/** Merge contacts that share an email or a LinkedIn URL. Contacts with neither are dropped. */
export function dedupeContacts(list: MinimalContact[]): { contacts: MinimalContact[]; unkeyed: number } {
  const out: MinimalContact[] = [];
  const byKey = new Map<string, number>();
  let unkeyed = 0;
  for (const c of list) {
    const keys = [c.email && `e:${c.email}`, c.linkedinUrl && `l:${c.linkedinUrl}`].filter(Boolean) as string[];
    if (!keys.length) { unkeyed++; continue; }
    const hit = keys.map((k) => byKey.get(k)).find((i) => i !== undefined);
    if (hit === undefined) {
      out.push({ ...c });
      for (const k of keys) byKey.set(k, out.length - 1);
      continue;
    }
    const t = out[hit];
    for (const f of ["name", "roleTitle", "company", "email", "linkedinUrl"] as const) if (!t[f] && c[f]) t[f] = c[f];
    for (const k of [t.email && `e:${t.email}`, t.linkedinUrl && `l:${t.linkedinUrl}`].filter(Boolean) as string[]) byKey.set(k, hit);
  }
  return { contacts: out, unkeyed };
}

export function personRecord(c: MinimalContact): PlannedRecord {
  const id = recordId("person", c.email ? `email:${c.email}` : `linkedin:${c.linkedinUrl}`);
  const [first, ...rest] = (c.name ?? "").split(/\s+/).filter(Boolean);
  return {
    id,
    record: {
      id,
      name: { firstName: first ?? "", lastName: rest.join(" ") },
      jobTitle: c.roleTitle ?? "",
      emails: { primaryEmail: c.email ?? "", additionalEmails: [] },
      linkedinLink: { primaryLinkUrl: c.linkedinUrl ?? "", primaryLinkLabel: "", secondaryLinks: [] },
      companyId: c.company ? companyId(c.company) : null,
    },
  };
}

async function planPeople(plan: MigrationPlan): Promise<void> {
  const dir = process.env.AUDIT_DIR || repoPath("state", "audit");
  const raw: MinimalContact[] = [];
  for (const file of ["contacts.jsonl", "audit-log.jsonl"]) {
    const text = await readText(path.join(dir, file));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"contact"')) continue;
      try {
        const c = minimise(JSON.parse(line).contact);
        if (c) raw.push(c);
      } catch { bump(plan.skipped, "person: unreadable line"); }
    }
  }
  const { contacts, unkeyed } = dedupeContacts(raw);
  if (unkeyed) plan.skipped["person: no email or LinkedIn URL"] = unkeyed;
  const companies = new Map<string, string>();
  for (const c of contacts) {
    plan.people.push(personRecord(c));
    if (c.company && !companies.has(c.company.toLowerCase())) companies.set(c.company.toLowerCase(), c.company);
  }
  for (const name of companies.values()) {
    const id = companyId(name);
    plan.companies.push({ id, record: { id, name } });
  }
}

// ----------------------------------------------------------------------- plan

export async function buildPlan(inScopeRows: Opportunity[], migratedAt: string): Promise<MigrationPlan> {
  const plan: MigrationPlan = { companies: [], positionings: [], documents: [], documentRevisions: [], applications: [], screeningQuestions: [], keywordQuestions: [], runs: [], people: [], notes: [], attachments: [], skipped: {} };
  const byId = new Map(inScopeRows.map((r) => [r.id, r]));
  const positionings = await planPositionings(plan, migratedAt);
  await planDocuments(plan, migratedAt);
  await planApplications(plan, inScopeRows, migratedAt);
  await planQuestions(plan, byId, positionings, migratedAt);
  await planRuns(plan, migratedAt);
  await planPeople(plan);
  return plan;
}
