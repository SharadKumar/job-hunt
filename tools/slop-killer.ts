#!/usr/bin/env tsx
/**
 * slop-killer.ts — scan a draft for AI-slop phrases.
 *
 * Reads references/voice/slop-banlist.md plus optional org/profile banlists,
 * runs each entry as a case-insensitive whole-word match against the draft,
 * and returns {hits, slop_score, verdict}. Explicit fatal phrases fail;
 * stylistic/slop-pattern hits warn for writer judgement.
 *
 * Usage:
 *   tsx tools/slop-killer.ts --file path/to/draft.md
 *   tsx tools/slop-killer.ts --text "I am writing to express interest in..."
 *
 * Exit code:
 *   0 if verdict=pass
 *   1 if verdict=warn
 *   2 if verdict=fail
 * Output: JSON on stdout.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.ts";

type Verdict = "pass" | "warn" | "fail";

type Hit = {
  phrase: string;
  position: number;
  category: string;
  weight: number;
  fatal?: boolean;
};

type Result = {
  slop_score: number;
  verdict: Verdict;
  hits: Hit[];
  unique_phrases: number;
  word_count: number;
};

const FORCED_FAIL = [
  "as an ai language model",
  "i'd be more than happy to",
  "i would be more than happy to",
  "feel free to reach out at your convenience",
];

async function loadBanlist(banlistPath: string, optional = false): Promise<{ phrases: { phrase: string; category: string; weight: number }[] }> {
  const md = await fs.readFile(banlistPath, "utf8").catch((e: any) => {
    if (optional && e?.code === "ENOENT") return "";
    throw e;
  });
    const phrases: { phrase: string; category: string; weight: number }[] = [];
    const lines = md.split("\n");
    let category = "general";
    let weight = 5;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const heading = line.match(/^##+\s*(.+?)(?:\s*\(.*\))?\s*$/);
      if (heading) {
        category = heading[1].toLowerCase();
        if (/forbidden|instant fail/.test(line.toLowerCase())) weight = 50;
        else if (/hollow openers|hype words|empty closers/.test(category)) weight = 10;
        else if (/latinate|connective scaffolding|construction tics/.test(category)) weight = 8;
        else weight = 5;
        continue;
      }
      // bullet line: "- phrase (optional comment)" — take everything up to first " (" or " — "
      const bullet = line.match(/^[-•*]\s*"?(.+?)"?\s*(?:\(|—|$)/);
      if (bullet) {
        const phrase = bullet[1].trim().replace(/^["“”']|["“”']$/g, "").trim();
        if (phrase && phrase.length > 1) {
          phrases.push({ phrase, category, weight });
        }
      }
    }
  return { phrases };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a regex that matches a phrase as a whole-token sequence, case-insensitive. */
function phraseRegex(phrase: string): RegExp {
  // Tokens are word-characters or hyphens; non-word chars become flexible whitespace
  const tokens = phrase.split(/\s+/).map(escapeRegex);
  // Use \W* between tokens so punctuation and varying whitespace don't break the match
  return new RegExp(`\\b${tokens.join("\\W+")}\\b`, "gi");
}

function check(text: string, banlist: { phrases: { phrase: string; category: string; weight: number }[] }): Result {
  const hits: Hit[] = [];

  for (const f of FORCED_FAIL) {
    const re = phraseRegex(f);
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ phrase: f, position: m.index, category: "forbidden", weight: 100, fatal: true });
    }
  }

  for (const { phrase, category, weight } of banlist.phrases) {
    const re = phraseRegex(phrase);
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ phrase, position: m.index, category, weight });
    }
  }

  // Em-dash density: more than 1 per 120 words is a strong slop signal.
  const words = text.split(/\s+/).filter(Boolean).length;
  const emDashCount = (text.match(/—/g) || []).length;
  const allowedEmDashes = Math.max(1, Math.floor(words / 120));
  if (words > 0 && emDashCount > allowedEmDashes) {
    const excess = emDashCount - allowedEmDashes;
    hits.push({
      phrase: `em-dash density (${emDashCount} in ${words} words; max ${allowedEmDashes})`,
      position: 0,
      category: "punctuation",
      weight: Math.min(60, 10 + excess * 4),
    });
  }

  // Two em-dashes in the same sentence
  for (const sentence of text.split(/[.!?]\s+/)) {
    const c = (sentence.match(/—/g) || []).length;
    if (c >= 2) {
      hits.push({ phrase: "two em-dashes in one sentence", position: text.indexOf(sentence), category: "punctuation", weight: 5 });
      break;
    }
  }

  // Triple ellipses
  if (/\.\.\.\s*\.\.\./.test(text)) {
    hits.push({ phrase: "stacked ellipses", position: text.indexOf("..."), category: "punctuation", weight: 5 });
  }

  // Smart-quote / straight-quote mixing
  const hasSmart = /["“”]/.test(text);
  const hasStraight = /"/.test(text);
  // Note: "" is U+201C/201D vs U+0022. Quick check:
  if (/[“”]/.test(text) && /\"/.test(text)) {
    hits.push({ phrase: "smart/straight quote mixing", position: 0, category: "punctuation", weight: 3 });
  }

  // Score: sum of weights, then per-word normalisation
  const rawScore = hits.reduce((s, h) => s + h.weight, 0);
  const wordsForScore = Math.max(words, 1);
  // Scale: 5 weight per 100 words = ~5 points
  const slop_score = Math.min(100, Math.round((rawScore * 100) / wordsForScore));

  let verdict: Verdict = "pass";
  if (hits.some((h) => h.fatal)) verdict = "fail";
  else if (hits.length || slop_score >= 10) verdict = "warn";

  return { slop_score, verdict, hits, unique_phrases: new Set(hits.map((h) => h.phrase)).size, word_count: words };
}

async function main() {
  const args = process.argv.slice(2);
  let filePath = "";
  let text = "";
  let banlistPath = "references/voice/slop-banlist.md";
  const extraBanlistPaths: string[] = [repoPath("state/org/slop-banlist.md")];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") filePath = args[++i];
    else if (args[i] === "--text") text = args[++i];
    else if (args[i] === "--banlist") banlistPath = args[++i];
    else if (args[i] === "--extra-banlist") extraBanlistPaths.push(args[++i]);
  }
  if (filePath) text = await fs.readFile(filePath, "utf8");
  if (!text) {
    console.error("Usage: tsx tools/slop-killer.ts (--file <path> | --text '...') [--banlist <path>] [--extra-banlist <path>]");
    process.exit(2);
  }

  const banlists = [
    await loadBanlist(path.resolve(banlistPath)),
    ...(await Promise.all(extraBanlistPaths.map((p) => loadBanlist(path.resolve(p), true)))),
  ];
  const banlist = { phrases: banlists.flatMap((b) => b.phrases) };
  const result = check(text, banlist);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "warn" ? 1 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
