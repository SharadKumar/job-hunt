#!/usr/bin/env tsx
/**
 * screening-resolve-open.ts — answer parked screening questions from evidence
 * before anyone is asked (owner, 25 Nov 2026).
 *
 * A question an employer form asked that the harness could not answer at the
 * time is parked in the screening answers' unknown_questions with no answer.
 * Each run, before the send pass, this sweep offers every parked question to
 * the same resolver the submit adapters use (tools/screening-derive.ts): a
 * small model answers from the CV, the profile and what the person already
 * said, held to deterministic guardrails. A high or medium confidence answer is
 * recorded as derived, with its evidence, and the screening retry queue then
 * resumes the paused application. Only a question nothing covers stays
 * parked for the person.
 *
 *   npm run -s screening:resolve-open            # resolve and record
 *   npm run -s screening:resolve-open -- --dry-run
 *
 * Prints one JSON line: { ok, checked, answered, remaining, results[] }, each
 * result with its answer and confidence, or the reason it stays parked.
 */

import fs from "node:fs/promises";
import YAML from "yaml";
import { profilePath } from "./profile-context.ts";
import type { PageQuestion } from "./channels/seek-submit.ts";

/** A parked row as a question: its recorded options make it a select, otherwise free text. */
export function parkedQuestion(row: { question: string; context?: unknown }): PageQuestion {
  const context = typeof row.context === "string" ? row.context : "";
  const labels = context.includes(" | ") ? context.split(" | ").map((s) => s.trim()).filter(Boolean) : [];
  return labels.length >= 2
    ? { kind: "select", label: row.question, id: "", name: "", options: labels.map((label, i) => ({ label, id: `o${i}` })), required: true }
    : { kind: "text", label: row.question, id: "", name: "", options: [], required: true };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const file = profilePath("screening-answers.yaml");
  let raw: any;
  try { raw = YAML.parse(await fs.readFile(file, "utf8")); } catch (e: any) {
    console.log(JSON.stringify({ ok: false, error: `screening answers unreadable: ${e?.message ?? e}` }));
    return 1;
  }
  const open = (Array.isArray(raw?.unknown_questions) ? raw.unknown_questions : [])
    .filter((u: any) => u && typeof u.question === "string" && (u.answer == null || String(u.answer).trim() === ""));
  const { resolveWithDetail } = await import("./screening-derive.ts");
  const results: { opportunity: string; question: string; answered: boolean; answer?: string | number; confidence?: string | null; via?: string; reason?: string }[] = [];
  const seen = new Set<string>();
  for (const row of open) {
    const key = `${row.opportunity_id ?? ""}|${row.question}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dryRun) { results.push({ opportunity: String(row.opportunity_id ?? ""), question: row.question, answered: false }); continue; }
    const detail = await resolveWithDetail({ id: String(row.opportunity_id ?? "any"), company: row.company, title: row.title }, parkedQuestion(row));
    const base = { opportunity: String(row.opportunity_id ?? ""), question: String(row.question).slice(0, 160) };
    results.push(detail.decision
      ? { ...base, answered: true, answer: typeof detail.answer === "string" ? detail.answer.slice(0, 300) : detail.answer, confidence: detail.confidence, via: detail.via }
      : { ...base, answered: false, reason: detail.reason.slice(0, 300) });
  }
  const answered = results.filter((r) => r.answered).length;
  console.log(JSON.stringify({ ok: true, dryRun, checked: results.length, answered, remaining: results.length - answered, results }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
}
