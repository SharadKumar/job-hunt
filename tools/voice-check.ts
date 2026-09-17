#!/usr/bin/env tsx
/**
 * voice-check.ts — compare a draft against the user's voice samples + rules.
 *
 * Checks:
 *   - English variant compliance (AU vs US spellings)
 *   - Average sentence length (cover/dm: 12-22 words, hard cap 30; CV: 18-28)
 *   - Em-dash density (≤ 1 per 80 words)
 *   - Forbidden opener patterns
 *   - Optional: distance from voice-samples.md cadence (avg sentence length delta)
 *
 * Usage:
 *   tsx tools/voice-check.ts --file path/to/draft.md --kind cover_letter
 *   tsx tools/voice-check.ts --text "..." --kind dm
 *
 * --kind ∈ {cover_letter, dm, comment, cv_bullet, generic}
 *
 * Output: JSON with {verdict, issues[], stats{}}
 * Exit code: 0 pass, 1 warn, 2 fail.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProfileContext } from "./profile-context.ts";

type Kind = "cover_letter" | "dm" | "comment" | "cv_bullet" | "generic";
type Verdict = "pass" | "warn" | "fail";

type Issue = { rule: string; severity: "warn" | "fail"; detail: string };

const KIND_TARGETS: Record<Kind, { avgWords: [number, number]; maxWords: number }> = {
  cover_letter: { avgWords: [12, 22], maxWords: 30 },
  dm: { avgWords: [8, 18], maxWords: 25 },
  comment: { avgWords: [8, 20], maxWords: 30 },
  cv_bullet: { avgWords: [18, 28], maxWords: 35 },
  generic: { avgWords: [12, 25], maxWords: 35 },
};

// AU spellings (correct) and their forbidden US-only counterparts.
const AU_PAIRS: [string, string][] = [
  ["organisation", "organization"],
  ["organisations", "organizations"],
  ["optimise", "optimize"],
  ["optimisation", "optimization"],
  ["prioritise", "prioritize"],
  ["realise", "realize"],
  ["analyse", "analyze"],
  ["customise", "customize"],
  ["modernise", "modernize"],
  ["modernisation", "modernization"],
  ["behaviour", "behavior"],
  ["colour", "color"],
  ["favour", "favor"],
  ["recognise", "recognize"],
  ["specialise", "specialize"],
  ["categorise", "categorize"],
  ["centre", "center"],
  ["licence", "license"], // noun in AU
  ["practise", "practice"], // verb in AU
];

const FORBIDDEN_OPENERS = [
  /^\s*i am writing to\b/i,
  /^\s*i hope this (message|email) finds you well/i,
  /^\s*i'?m thrilled to\b/i,
  /^\s*i'?m excited to apply\b/i,
  /^\s*i'?m reaching out to\b/i,
  /^\s*as a [^,.]{3,40}? with \d+\+? years/i,
  /^\s*i am a results-driven\b/i,
  /^\s*i am passionate about\b/i,
];

function splitSentences(text: string): string[] {
  // Naive but fine for short drafts
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function avgWords(sentences: string[]): number {
  if (!sentences.length) return 0;
  const total = sentences.reduce((s, sen) => s + sen.split(/\s+/).filter(Boolean).length, 0);
  return total / sentences.length;
}

function check(text: string, kind: Kind, voiceSamples: string): { verdict: Verdict; issues: Issue[]; stats: Record<string, number | string> } {
  const issues: Issue[] = [];
  const target = KIND_TARGETS[kind];

  const sentences = splitSentences(text);
  const avg = avgWords(sentences);
  const longest = sentences.reduce((m, s) => Math.max(m, s.split(/\s+/).filter(Boolean).length), 0);

  if (avg < target.avgWords[0]) {
    issues.push({ rule: "avg_sentence_length", severity: "warn", detail: `avg ${avg.toFixed(1)} words/sentence is below target ${target.avgWords[0]}` });
  } else if (avg > target.avgWords[1]) {
    issues.push({ rule: "avg_sentence_length", severity: "warn", detail: `avg ${avg.toFixed(1)} words/sentence exceeds target ${target.avgWords[1]}` });
  }
  if (longest > target.maxWords) {
    issues.push({ rule: "max_sentence_length", severity: "warn", detail: `longest sentence is ${longest} words (max ${target.maxWords})` });
  }

  // English variant
  for (const [au, us] of AU_PAIRS) {
    const re = new RegExp(`\\b${us}\\b`, "i");
    if (re.test(text)) {
      issues.push({ rule: "english_variant", severity: "fail", detail: `US spelling '${us}' — use '${au}'` });
    }
  }

  // Dashes. AGENTS.md section 3 rule 2 is absolute: no em dash (U+2014) and no
  // en dash (U+2013) in generated content, ever. This used to be a density warn,
  // which let dashes through every gate that only stops on `fail`.
  const words = text.split(/\s+/).filter(Boolean).length;
  const emDashes = (text.match(/\u2014/g) || []).length;
  const enDashes = (text.match(/\u2013/g) || []).length;
  if (emDashes > 0) {
    issues.push({ rule: "em_dash", severity: "fail", detail: `${emDashes} em dash${emDashes === 1 ? "" : "es"}; rewrite the clause (no em dashes, ever)` });
  }
  if (enDashes > 0) {
    issues.push({ rule: "en_dash", severity: "fail", detail: `${enDashes} en dash${enDashes === 1 ? "" : "es"}; use "to" for a range or rewrite the clause` });
  }

  // Forbidden openers (cover/dm/comment)
  if (kind === "cover_letter" || kind === "dm" || kind === "comment") {
    for (const re of FORBIDDEN_OPENERS) {
      if (re.test(text)) {
        issues.push({ rule: "forbidden_opener", severity: "fail", detail: `opener matches '${re}'` });
      }
    }
  }

  // Cover-letter must have no section headers
  if (kind === "cover_letter" && /^#{1,6}\s+/m.test(text)) {
    issues.push({ rule: "cover_letter_no_headers", severity: "fail", detail: "cover letter contains markdown headers" });
  }

  // Distance from voice samples (cadence) — compare against KIND-RELEVANT
  // sample sentences only. The voice-samples corpus mixes long-form CV
  // summaries (60+ wpm) with mid-form notes (20-40 wpm) and short-form
  // pastes (under 20 wpm). Comparing every kind's draft to the GLOBAL avg
  // gives false positives for short kinds (cover_letter, dm, comment) when
  // the corpus is long-form heavy.
  //
  // Approach: build a kind-matched sample subset by filtering sentences
  // whose word count is within the kind's `avgWords` band (with slack).
  // If that subset is too thin to be meaningful (< 5 sentences), skip the
  // check and report `cadence_drift_skipped` so the operator knows to add
  // short-form samples to Section B of voice-samples.md.
  if (voiceSamples) {
    const sampleSentences = splitSentences(voiceSamples);
    const [lo, hi] = target.avgWords;
    const slackLo = Math.max(4, lo - 4);
    const slackHi = hi + 6;
    const kindMatched = sampleSentences.filter((s) => {
      const w = s.split(/\s+/).filter(Boolean).length;
      return w >= slackLo && w <= slackHi;
    });
    const kindMatchedAvg = avgWords(kindMatched);

    if (kindMatched.length >= 5 && kindMatchedAvg > 0) {
      if (Math.abs(avg - kindMatchedAvg) > 8) {
        issues.push({
          rule: "cadence_drift",
          severity: "warn",
          detail: `draft avg ${avg.toFixed(1)} vs kind-matched samples avg ${kindMatchedAvg.toFixed(1)} (delta > 8; ${kindMatched.length} matching sample sentences)`,
        });
      }
    } else {
      issues.push({
        rule: "cadence_drift_skipped",
        severity: "warn",
        detail: `samples have only ${kindMatched.length} sentences in the ${slackLo}-${slackHi} word band for kind=${kind}; need ≥ 5 to compare. Add real ${kind} samples to Section B of voice-samples.md to enable this check.`,
      });
    }
  }

  let verdict: Verdict = "pass";
  if (issues.some((i) => i.severity === "fail")) verdict = "fail";
  else if (issues.length) verdict = "warn";

  return {
    verdict,
    issues,
    stats: {
      sentences: sentences.length,
      avg_words_per_sentence: Number(avg.toFixed(1)),
      longest_sentence_words: longest,
      em_dashes: emDashes,
      en_dashes: enDashes,
      total_words: words,
      kind,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let filePath = "";
  let text = "";
  let kind: Kind = "generic";
  let samplesPath = "state/profile/voice-samples.md";
  let profileId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") filePath = argv[++i];
    else if (argv[i] === "--text") text = argv[++i];
    else if (argv[i] === "--kind") kind = argv[++i] as Kind;
    else if (argv[i] === "--samples") samplesPath = argv[++i];
    else if (argv[i] === "--profile") profileId = argv[++i];
  }
  if (profileId && samplesPath === "state/profile/voice-samples.md") {
    samplesPath = resolveProfileContext(profileId).voiceSamplesPath;
  }
  if (filePath) text = await fs.readFile(filePath, "utf8");
  if (!text) {
    console.error("Usage: tsx tools/voice-check.ts (--file <path> | --text '...') [--kind cover_letter|dm|comment|cv_bullet|generic] [--samples <path>]");
    process.exit(2);
  }
  const samples = await fs.readFile(path.resolve(samplesPath), "utf8").catch(() => "");
  const result = check(text, kind, samples);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "warn" ? 1 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
