#!/usr/bin/env tsx

import { parseArgs } from "../lib/args.ts";
import { getAdjudicationQueue, recordAdjudication } from "./adjudications.ts";

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.positionals[0] ?? "list";
const textFlag = (name: string): string | undefined => typeof parsed.flags[name] === "string" ? parsed.flags[name] as string : undefined;

if (command === "list") {
  const queue = await getAdjudicationQueue();
  console.log(JSON.stringify({ ok: true, counts: queue.counts, items: queue.items.map((item) => ({
    id: item.id,
    priority: item.priority,
    title: item.title,
    company: item.company,
    sources: item.sources,
    complete: item.complete,
    stale: item.stale,
  })) }));
} else if (command === "record") {
  try {
    const label = await recordAdjudication({
      role_id: textFlag("id"),
      content_hash: textFlag("content-hash"),
      jev_decision_id: textFlag("decision-id"),
      discipline_fit: textFlag("discipline-fit"),
      matched_resume_id: textFlag("matched-resume-id"),
      apply_worthy: textFlag("apply-worthy"),
      notes: textFlag("notes"),
      actor: textFlag("actor") ?? "user",
    });
    console.log(JSON.stringify({ ok: true, label }));
  } catch (error: any) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
} else {
  console.log(JSON.stringify({ ok: false, error: "Usage: jev:adjudicate -- list | record --id <role> --content-hash <hash> --decision-id <id> [--discipline-fit <label>] [--matched-resume-id <id>] [--apply-worthy yes|no|insufficient_evidence] [--notes <text>]" }));
  process.exitCode = 1;
}
