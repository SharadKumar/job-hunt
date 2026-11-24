#!/usr/bin/env tsx
/**
 * slack-questions.ts — ask the person the screening questions nothing else
 * answers, in a Slack DM, and take their thread reply as the answer (owner,
 * 25 Nov 2026; plan C4).
 *
 * Order of work for a parked question: the run's sweep tries the CV, the
 * profile and what the person already said (screening-resolve-open.ts). A
 * question still unanswered after that is posted here once, as a DM from the
 * harness's Slack app. The person replies in the thread; the reply is checked
 * like any request (no notes to self, the profile's never-named rules) and
 * written as the answer in the Screening answers document, and the paused
 * application resumes on the next run. Each post records `slack_ts` on the
 * parked row, so nothing is asked twice.
 *
 * Runs on the five-minute intake poll and after each run's sweep. Without
 * SLACK_BOT_TOKEN (state/twenty/keys.env or .env.local) it does nothing.
 *
 * Slack app scopes: chat:write, im:write, im:history, users:read.email.
 */

import YAML from "yaml";
import { twentyClient } from "./store/twenty-backend.ts";
import { cleanAnswer, documentBody, neverNamedFindings, saveRevision } from "./decisions/requests.ts";
import { normaliseQuestion } from "./channels/seek-submit.ts";

type Slack = (method: string, body: Record<string, unknown>) => Promise<any>;

export function slackApi(token: string, fetchImpl: typeof fetch = fetch): Slack {
  return async (method, body) => {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? res.status}`);
    return json;
  };
}

export type Parked = { index: number; opportunity_id?: string; company?: string; title?: string; question: string; context?: string; slack_ts?: string };

/** Parked rows with no answer, in document order. */
export function openRows(body: string): Parked[] {
  let raw: any;
  try { raw = YAML.parse(body); } catch { return []; }
  const rows = Array.isArray(raw?.unknown_questions) ? raw.unknown_questions : [];
  return rows
    .map((u: any, index: number) => ({ ...u, index }))
    .filter((u: any) => typeof u.question === "string" && (u.answer == null || String(u.answer).trim() === ""));
}

/** The DM text for one question: what is asked, by whom, and the choices if any. */
export function questionText(row: Parked): string {
  const where = [row.title, row.company].filter(Boolean).join(" at ");
  const choices = typeof row.context === "string" && row.context.includes(" | ") ? `\nChoices: ${row.context}` : "";
  return `Screening question${where ? ` for ${where}` : ""}:\n> ${row.question}${choices}\nReply in this thread with the answer exactly as the employer should see it. I'll also remember it for similar questions.`;
}

/**
 * Set a field on the n-th unknown_questions row by text edit, so the rest of
 * the document (and the person's comments) is untouched.
 */
export function setRowField(body: string, index: number, field: string, value: string): string {
  const lines = body.split("\n");
  let inUnknown = false;
  let row = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^unknown_questions:/.test(lines[i])) { inUnknown = true; continue; }
    if (inUnknown && /^\S/.test(lines[i])) break;
    if (!inUnknown) continue;
    const start = lines[i].match(/^(\s*)-\s/);
    if (!start) continue;
    row++;
    if (row !== index) continue;
    const indent = start[1] + "  ";
    let end = i + 1;
    while (end < lines.length && !/^\s*-\s/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
    for (let j = i; j < end; j++) {
      const m = lines[j].match(new RegExp(`^(\\s*-?\\s*)${field}:\\s`));
      if (m) { lines[j] = `${m[1]}${field}: ${JSON.stringify(value)}`; return lines.join("\n"); }
    }
    lines.splice(end, 0, `${indent}${field}: ${JSON.stringify(value)}`);
    return lines.join("\n");
  }
  return body;
}

export async function runSlackQuestions(opts: { url: string; key: string; ownerMemberId: string; token: string; fetchImpl?: typeof fetch; maxNew?: number }): Promise<{ asked: number; answered: number; refused: string[] }> {
  const { call } = twentyClient({ url: opts.url, key: opts.key }, opts.fetchImpl);
  const slack = slackApi(opts.token, opts.fetchImpl);
  const doc = await documentBody(call, "SCREENING_ANSWERS");
  if (!doc) return { asked: 0, answered: 0, refused: ["no Screening answers document"] };
  const member = (await call("GET", `/rest/workspaceMembers/${opts.ownerMemberId}`)).data?.workspaceMember;
  const email = member?.userEmail;
  if (!email) return { asked: 0, answered: 0, refused: ["the owner has no email in Twenty"] };
  const owner = (await slack("users.lookupByEmail", { email })).user?.id as string;
  const channel = (await slack("conversations.open", { users: owner })).channel?.id as string;
  const rules = (await documentBody(call, "LETTER_CRITIC_RULES"))?.body ?? null;

  let body = doc.body;
  let asked = 0, answered = 0;
  const refused: string[] = [];
  const posted = new Set<string>();

  // Replies first, so an answer given since the last pass lands before anything new is asked.
  for (const row of openRows(body).filter((r) => r.slack_ts)) {
    const replies = (await slack("conversations.replies", { channel, ts: row.slack_ts, limit: 20 })).messages ?? [];
    const reply = replies.filter((m: any) => m.ts !== row.slack_ts && m.user === owner).pop();
    if (!reply?.text) continue;
    const cleaned = cleanAnswer(String(reply.text));
    const findings = cleaned.ok ? neverNamedFindings(cleaned.answer, rules) : [];
    if (!cleaned.ok || findings.length) {
      const why = cleaned.ok ? findings.join("; ") : cleaned.reason;
      refused.push(`${row.question.slice(0, 60)}: ${why}`);
      await slack("chat.postMessage", { channel, thread_ts: row.slack_ts, text: `Not used: ${why}. Reply again with the final wording.` }).catch(() => {});
      continue;
    }
    // Every open copy of the same question takes the answer.
    for (const r of openRows(body).filter((x) => normaliseQuestion(x.question) === normaliseQuestion(row.question))) {
      body = setRowField(body, r.index, "answer", cleaned.answer);
      body = setRowField(body, r.index, "answered_via", "slack");
    }
    answered++;
    await slack("reactions.add", { channel, timestamp: reply.ts, name: "white_check_mark" }).catch(() => {});
  }

  // Then ask what is still open and not yet asked, one DM per distinct question.
  for (const row of openRows(body)) {
    const key = normaliseQuestion(row.question);
    if (row.slack_ts || posted.has(key) || asked >= (opts.maxNew ?? 10)) continue;
    const sent = await slack("chat.postMessage", { channel, text: questionText(row), unfurl_links: false });
    for (const r of openRows(body).filter((x) => normaliseQuestion(x.question) === key && !x.slack_ts)) body = setRowField(body, r.index, "slack_ts", String(sent.ts));
    posted.add(key);
    asked++;
  }

  if (body !== doc.body) await saveRevision(call, "SCREENING_ANSWERS", doc, body, "screening-answers.yaml");
  return { asked, answered, refused };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { loadLocalEnv } = await import("./jev/env.ts");
    await loadLocalEnv();
    const { twentyConfig } = await import("./store/twenty-backend.ts");
    const cfg = await twentyConfig().catch(() => null);
    const token = process.env.SLACK_BOT_TOKEN ?? "";
    const owner = process.env.TWENTY_OWNER_MEMBER_ID ?? "";
    if (!token) { console.log(JSON.stringify({ ok: true, skipped: "SLACK_BOT_TOKEN not set" })); return; }
    if (!cfg || !owner) { console.log(JSON.stringify({ ok: false, error: "needs the Twenty keys and TWENTY_OWNER_MEMBER_ID" })); process.exit(2); }
    const out = await runSlackQuestions({ url: cfg.url, key: cfg.key, ownerMemberId: owner, token });
    console.log(JSON.stringify({ ok: true, ...out }));
  })().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
}
