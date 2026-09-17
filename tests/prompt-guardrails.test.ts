/**
 * prompt-guardrails.test.ts — the writer agents' load-bearing clauses are the
 * product.
 *
 * `agents/resume-writer.md` and `agents/cover-letter-writer.md` are not docs;
 * they are the anti-fabrication contract every downstream gate assumes is
 * already in force. A well-meaning edit that "tightens" the prompt can delete
 * the cardinal rule, a tier row, or the "never downgrade a deterministic fail"
 * clause without any test noticing. This test pins the exact phrases, and
 * names the missing one when it goes.
 *
 * These are literal substrings on purpose. If a phrase is deliberately
 * reworded, update it here in the same commit and say why in the message.
 *
 * It also asserts the Codex TOML wrappers are in sync with the canonical
 * Markdown. `tools/sync-codex-agents.ts` has no --check flag, so the check
 * regenerates into a throwaway directory and diffs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED: Record<string, string[]> = {
  "agents/resume-writer.md": [
    // The cardinal anti-fabrication rule and its tier table.
    "The cardinal rule: JD and market vocabulary dictate spelling and placement, never facts.",
    "| **1 Corpus-backed** |",
    "| **1b Alias-grounded** |",
    "| **2 Preppable domain knowledge** |",
    "| **3 Unfakeable experiential claim** |",
    "NEVER render. No exceptions",
    "Certification names are exact-form only",
    // Process clauses.
    "**The audit report is your only measurement channel.**",
    "`resume:audit` is the only render and measurement path.",
    "gates.term_grounding",
    "**Never downgrade a deterministic `fail` to a narrated \"warn\".**",
    "**Never edit canonical files silently.**",
    "**Never inject vocabulary as claims.**",
    "**Never return uncited production content.**",
    // Output discipline.
    "Still banned, in every mode:",
    "tier-3 experiential claims",
    "term stuffing outside the single screener block",
    "**Return the compact JSON below and nothing else.**",
  ],
  "agents/resume-critic.md": [
    // Independence is the whole product: a critic that edits, renders or
    // approves is just a second writer.
    "**You never edit a file.**",
    "**You never render, audit, fit or approve.**",
    "**You do not re-report what a deterministic gate already reported.**",
    "**You do not soften.**",
    "**Hard cap of 20 findings**",
    "**Compact JSON only.**",
    // The verdict contract the skill and resume:approve both depend on.
    "`block` — only for `contradiction`, `unsupported`, or `rule`.",
    "\"verdict\": \"pass | revise | block\"",
    // The proposed edit is written into the CV verbatim, so its rules are load-bearing.
    "**Source-backed.**",
    "**Rule-compliant.**",
    "No em dashes, anywhere",
    // A familiarity-framed skills line is authorised by the ledger/plan, not a
    // fabrication; deleting this clause turns every prepped term into a false
    // `unsupported` fail.
    "Such a line is NOT an unsupported claim and must not be reported as one.",
    "npm run resume:critic:apply",
    "--record-only",
  ],
  "agents/cover-letter-writer.md": [
    // Sanctity + anti-fabrication.
    "**Sanctity contract**: never return `human_review_needed: false` on a letter that failed any hard check.",
    "**Never embellish facts**",
    "Don't fabricate.",
    "**Never auto-send.**",
    "**Never reuse a previously-drafted letter**",
    "**Never touch pipeline state.**",
    // Quality-gate process.
    "npm run slop:check -- --file <path>",
    "npm run voice:check -- --file <path> --kind cover_letter",
    "Avoid every phrase in slop-banlist.md.",
    "No future-dated or placeholder text",
    "Every declared check id in the universal + per-template files MUST appear with a verdict in your report.",
    "Missing a verdict is worse than failing",
    "Ceiling: 4 attempts.",
    "\"human_review_needed\": true | false",
  ],
};

for (const [file, phrases] of Object.entries(REQUIRED)) {
  const text = await fs.readFile(file, "utf8");
  for (const phrase of phrases) {
    assert.ok(
      text.includes(phrase),
      `${file} no longer contains the load-bearing phrase:\n  ${phrase}\nIf this was a deliberate rewording, update tests/prompt-guardrails.test.ts in the same commit.`,
    );
  }
  console.log(`  ✓ ${file} keeps all ${phrases.length} load-bearing phrases`);
}

// Frontmatter both CLIs depend on.
for (const file of Object.keys(REQUIRED)) {
  const text = await fs.readFile(file, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, `${file}: missing YAML frontmatter`);
  assert.match(fm![1], /(^|\n)name: [a-z-]+/, `${file}: frontmatter missing 'name'`);
  assert.match(fm![1], /(^|\n)description: \S/, `${file}: frontmatter missing 'description'`);
}
console.log("  ✓ both agents carry the name/description frontmatter the Agent tool and Codex sync need");

// --- Codex wrappers are generated, never hand-edited ------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agents-sync-"));
await fs.cp("agents", path.join(tmp, "agents"), { recursive: true });
await fs.mkdir(path.join(tmp, ".codex", "agents"), { recursive: true });

const tsxBin = path.resolve("node_modules/.bin/tsx");
const script = path.resolve("tools/sync-codex-agents.ts");
const run = spawnSync(tsxBin, [script], { cwd: tmp, encoding: "utf8" });
assert.equal(run.status, 0, `codex:sync-agents failed in the scratch copy:\n${run.stderr}`);

const expectedDir = path.join(tmp, ".codex", "agents");
const generated = (await fs.readdir(expectedDir)).filter((f) => f.endsWith(".toml")).sort();
const committed = (await fs.readdir(".codex/agents")).filter((f) => f.endsWith(".toml")).sort();
assert.deepEqual(committed, generated, "'.codex/agents' has wrappers the canonical agents/ no longer generates (or is missing one); run `npm run codex:sync-agents`");
for (const name of generated) {
  const want = await fs.readFile(path.join(expectedDir, name), "utf8");
  const have = await fs.readFile(path.join(".codex/agents", name), "utf8");
  assert.equal(have, want, `.codex/agents/${name} is out of sync with agents/${name.replace(/\.toml$/, ".md")}; run \`npm run codex:sync-agents\` (never edit the TOML by hand)`);
}
await fs.rm(tmp, { recursive: true, force: true });
console.log(`  ✓ all ${generated.length} Codex agent wrappers match the canonical Markdown`);

console.log("prompt-guardrails: all assertions passed");
