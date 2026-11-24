/**
 * requests.ts — carry out what the person asked an agent to do (plan rev 7,
 * Principle 3 and F14).
 *
 * The person asks through Grok or Twenty's AI chat. That request is their
 * instruction, not a suggestion for them to vet, so it runs without a second
 * confirmation, after the same automatic checks as any other work. The record
 * is a proposal row with status REQUESTED; Twenty's own stamp, not a field the
 * caller sets, says who asked:
 *
 *   proposer GROK, createdBy APPLICATION or MANUAL → the Career bot's request tool
 *   createdBy AGENT, the owner's member id       → the owner's AI chat
 *   anything else (API key, workflow, a member)  → not a request: it waits for
 *                                                  the person's tap (PROPOSED)
 *
 * What happens to a request:
 *   - reserved kinds (package approvals, document edits, outcomes,
 *     disclosures) always wait for the person's button: status PROPOSED;
 *   - ANSWER_SCREENING runs now: the answer is cleaned, checked against the
 *     profile's never-named rules, matched to an open screening question and
 *     written into the Screening answers document;
 *   - agent work (redrafts, research, interview prep, follow-up drafts,
 *     rescans, keyword confirmations) is queued for the daily run's agent
 *     half: status CONFIRMED, picked up by `proposals.ts next`.
 * Every outcome is written on the record, so Today and Grok's brief can show
 * what was done for the person and why anything was not.
 */

import YAML from "yaml";
import { twentyClient } from "../store/twenty-backend.ts";
import { normaliseQuestion } from "../channels/seek-submit.ts";
import { EXECUTORS } from "./proposals.ts";

type Call = (method: string, path: string, body?: unknown) => Promise<any>;
type Stamp = { source?: string | null; workspaceMemberId?: string | null } | null | undefined;

export type RequestRecord = {
  id: string;
  proposalType?: string | null;
  proposer?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  openingId?: string | null;
  status?: string | null;
  createdBy?: Stamp;
};

export type RequestVerdict = { id: string; type: string; status: "DONE" | "FAILED" | "CONFIRMED" | "PROPOSED"; outcome: string };

/** Kinds the person always confirms with a button, whoever asks. */
export const RESERVED = new Set(["APPROVE_PACKAGE", "UPDATE_DOCUMENT", "SUGGEST_OUTCOME", "DISCLOSURE"]);

/** Kinds the daily run's agent half carries out. */
export const AGENT_QUEUE = new Set(["REDRAFT_LETTER", "DRAFT_FOLLOW_UP", "RESEARCH_COMPANY", "PREP_INTERVIEW", "RESCAN_CHANNEL", "CONFIRM_KEYWORD"]);

/** At most this many requests are handled per pass, so a flood waits. */
export const PER_PASS = 20;

/** Who asked, from Twenty's stamp; null when it is not the person's request. */
export function requestOrigin(rec: RequestRecord, ownerMemberId: string): "GROK" | "AI_CHAT" | null {
  const c = rec.createdBy;
  if (!c) return null;
  // The Career bot's request tool is an app logic function. On Twenty 2.60 it
  // writes under the member who installed the app, so its records carry a
  // MANUAL stamp (measured 25 Nov 2026), or APPLICATION on other versions.
  // The harness's API key (API) and agents (AGENT) can never pass as Grok.
  if (rec.proposer === "GROK" && (c.source === "APPLICATION" || c.source === "MANUAL")) return "GROK";
  if (c.source === "AGENT" && ownerMemberId && c.workspaceMemberId === ownerMemberId) return "AI_CHAT";
  return null;
}

/**
 * A screening answer as it will appear in an employer's form: plain text, no
 * notes to self. Notes in brackets that ask for checking are refused rather
 * than silently dropped, so a half-finished answer never goes out.
 */
export function cleanAnswer(raw: unknown): { ok: true; answer: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "no answer given" };
  let a = raw.replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!a) return { ok: false, reason: "the answer is empty" };
  if (/\((?:[^)]*\b(?:verify|check|confirm|tbc|tbd|todo|cv|exact)\b[^)]*)\)/i.test(a) || /\b(?:tbc|tbd|todo)\b/i.test(a)) {
    return { ok: false, reason: "the answer carries a note to check something; give the final wording" };
  }
  if (/[—–]/.test(a)) a = a.replace(/\s*[—–]\s*/g, ", ");
  if (a.length > 500) return { ok: false, reason: "the answer is longer than 500 characters" };
  return { ok: true, answer: a };
}

/** never_named rules from the profile's letter-critic rules (YAML text). */
export function neverNamedFindings(text: string, rulesYaml: string | null): string[] {
  if (!rulesYaml) return [];
  let y: any = null;
  try { y = YAML.parse(rulesYaml); } catch { return []; }
  const out: string[] = [];
  for (const r of y?.never_named ?? []) {
    if (!r?.pattern) continue;
    let re: RegExp;
    try { re = new RegExp(String(r.pattern), "i"); } catch { continue; }
    if (re.test(text)) out.push(String(r.issue ?? "names something the profile never names") + (r.fix ? ` Fix: ${r.fix}` : ""));
  }
  return out;
}

/**
 * Set the answer on every open entry in unknown_questions that matches the
 * question. Text edit, not a re-serialise, so the person's comments survive.
 * Returns the new body and how many entries it answered.
 */
export function answerUnknownQuestion(body: string, question: string, answer: string, via: string): { body: string; answered: number } {
  const target = normaliseQuestion(question);
  if (!target) return { body, answered: 0 };
  const lines = body.split("\n");
  let inUnknown = false;
  let answered = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^unknown_questions:/.test(line)) { inUnknown = true; continue; }
    if (inUnknown && /^\S/.test(line)) inUnknown = false;
    if (!inUnknown) continue;
    const q = line.match(/^(\s+)question:\s*(.+)$/);
    if (!q) continue;
    let value: unknown = q[2];
    try { value = YAML.parse(q[2]); } catch { /* keep raw */ }
    if (normaliseQuestion(String(value)) !== target) continue;
    // Find this entry's answer line (before the next entry starts).
    for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]) && !/^\S/.test(lines[j]); j++) {
      const m = lines[j].match(/^(\s+)answer:\s*(.*)$/);
      if (!m) continue;
      const current = m[2].trim();
      if (current && current !== "null" && current !== "~" && current !== '""') break; // already answered: leave it
      lines[j] = `${m[1]}answer: ${JSON.stringify(answer)}`;
      lines.splice(j + 1, 0, `${m[1]}answered_via: ${JSON.stringify(via)}`);
      answered++;
      break;
    }
  }
  return { body: lines.join("\n"), answered };
}

export async function documentBody(call: Call, kind: string): Promise<{ docId: string; revision: number; body: string } | null> {
  const docs = (await call("GET", `/rest/documents?filter=${encodeURIComponent(`kind[eq]:${kind}`)}&limit=1`)).data?.documents ?? [];
  const doc = docs[0];
  if (!doc) return null;
  const rev = Number(doc.currentRevision) || 0;
  const revs = (await call("GET", `/rest/documentRevisions?filter=${encodeURIComponent(`and(documentId[eq]:${doc.id},revision[eq]:${rev})`)}&limit=1`)).data?.documentRevisions ?? [];
  return revs[0] ? { docId: doc.id, revision: rev, body: String(revs[0].body ?? "") } : null;
}

export async function saveRevision(call: Call, kind: string, cur: { docId: string; revision: number }, body: string, name: string): Promise<number> {
  const next = cur.revision + 1;
  await call("POST", "/rest/documentRevisions", { name: `${name} r${next}`, revision: next, baseRevision: cur.revision, kind, body, documentId: cur.docId });
  await call("PATCH", `/rest/documents/${cur.docId}`, { currentRevision: next });
  return next;
}

async function answerScreening(call: Call, rec: RequestRecord, via: string): Promise<RequestVerdict> {
  const type = "ANSWER_SCREENING";
  const p = (rec.payload ?? {}) as Record<string, unknown>;
  const question = typeof p.question === "string" ? p.question.trim() : "";
  if (!question) return { id: rec.id, type, status: "FAILED", outcome: "no question given: ask again with the exact question text" };
  const cleaned = cleanAnswer(p.answer);
  if (!cleaned.ok) return { id: rec.id, type, status: "FAILED", outcome: cleaned.reason };
  const rules = await documentBody(call, "LETTER_CRITIC_RULES");
  const findings = neverNamedFindings(cleaned.answer, rules?.body ?? null);
  if (findings.length) return { id: rec.id, type, status: "FAILED", outcome: `not used: ${findings.join("; ")}` };
  const doc = await documentBody(call, "SCREENING_ANSWERS");
  if (!doc) return { id: rec.id, type, status: "FAILED", outcome: "the Screening answers document is missing" };
  const { body, answered } = answerUnknownQuestion(doc.body, question, cleaned.answer, via);
  if (!answered) return { id: rec.id, type, status: "FAILED", outcome: "no open screening question matches that text" };
  const rev = await saveRevision(call, "SCREENING_ANSWERS", doc, body, "screening-answers.yaml");
  return { id: rec.id, type, status: "DONE", outcome: `answered ${answered} open question${answered === 1 ? "" : "s"} with "${cleaned.answer}" (Screening answers r${rev}); autopilot retries on its next run` };
}

/** Pure routing for one request; ANSWER_SCREENING needs Twenty and is done by the caller. */
export function routeRequest(rec: RequestRecord, ownerMemberId: string): RequestVerdict | "ANSWER" {
  const type = rec.proposalType ?? "";
  const origin = requestOrigin(rec, ownerMemberId);
  if (!origin) return { id: rec.id, type, status: "PROPOSED", outcome: "needs your confirmation: this was not a request made by you" };
  if (RESERVED.has(type)) return { id: rec.id, type, status: "PROPOSED", outcome: `needs your tap: ${type.toLowerCase().replace(/_/g, " ")} is always yours to confirm` };
  if (type === "ANSWER_SCREENING") return "ANSWER";
  if (AGENT_QUEUE.has(type) && EXECUTORS[type]) return { id: rec.id, type, status: "CONFIRMED", outcome: "queued: the next daily run carries it out" };
  return { id: rec.id, type, status: "FAILED", outcome: `type ${type || "(empty)"} is not something agents can do` };
}

/** Handle every REQUESTED record and write each outcome back. */
export async function runRequests(opts: { url: string; key: string; ownerMemberId: string; fetchImpl?: typeof fetch }): Promise<RequestVerdict[]> {
  const { call } = twentyClient({ url: opts.url, key: opts.key }, opts.fetchImpl);
  const filter = encodeURIComponent("status[eq]:REQUESTED");
  const recs: RequestRecord[] = (await call("GET", `/rest/proposals?filter=${filter}&order_by=createdAt&limit=${PER_PASS}`)).data?.proposals ?? [];
  const out: RequestVerdict[] = [];
  for (const rec of recs) {
    let v: RequestVerdict;
    try {
      const routed = routeRequest(rec, opts.ownerMemberId);
      v = routed === "ANSWER" ? await answerScreening(call, rec, requestOrigin(rec, opts.ownerMemberId) === "GROK" ? "grok" : "ai chat") : routed;
    } catch (e: any) {
      v = { id: rec.id, type: rec.proposalType ?? "", status: "FAILED", outcome: `could not carry it out: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    await call("PATCH", `/rest/proposals/${rec.id}`, { status: v.status, outcome: v.outcome.slice(0, 500) });
    out.push(v);
  }
  return out;
}
