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
    "`block`: only for `contradiction`, `unsupported`, or `rule`.",
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

// --- Repo-wide prompt and doc consistency ----------------------------------
//
// The prompts and the docs are one contract. These four assertions stop the
// drift that a reader cannot see: a clause that contradicts AGENTS.md, an
// `npm run` name that no longer exists, a prompt pointing an agent at the
// JSON export instead of the store, and a dash the voice rules ban.

async function walk(dir: string, ext: string): Promise<string[]> {
  if (/-workspace$/.test(dir)) return []; // skill-creator eval workspaces hold fixture roots, not prompts
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, ext)));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const promptFiles = [
  ...(await walk("agents", ".md")),
  ...(await walk(".claude/skills", ".md")),
];
const docFiles = [
  ...promptFiles,
  ...(await walk("docs", ".md")),
  "README.md",
  "AGENTS.md",
];

// (a) Clauses that contradicted the send-authority contract, or named a tool
// that does not exist. Each was a real defect; none may come back.
const BANNED_PHRASES = [
  "never executes Sections 6-8",
  "stay attended",
  "submit:recruiter_email",
  "does not authorize a later unattended submit",
];
for (const file of docFiles) {
  const text = await fs.readFile(file, "utf8");
  for (const phrase of BANNED_PHRASES) {
    assert.ok(
      !text.includes(phrase),
      `${file} contains the banned phrase "${phrase}". It contradicts AGENTS.md section 2 or names something that does not exist; rewrite the clause.`,
    );
  }
}
console.log(`  ✓ ${docFiles.length} prompt/doc files carry none of the ${BANNED_PHRASES.length} banned phrases`);

// (b) Every `npm run <name>` a prompt or doc tells someone to run must exist.
const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as { scripts: Record<string, string> };
const scriptNames = new Set(Object.keys(pkg.scripts));
const PLACEHOLDER_SCRIPTS = new Set(["hunt:<channel>"]);
const scriptRefs = new Map<string, string[]>();
for (const file of docFiles) {
  const text = await fs.readFile(file, "utf8");
  for (const m of text.matchAll(/npm run (?:-s )?([A-Za-z0-9:_.<>*-]+)/g)) {
    const name = m[1].replace(/[.,;)`]+$/, "");
    if (!scriptRefs.has(name)) scriptRefs.set(name, []);
    scriptRefs.get(name)!.push(file);
  }
}
for (const [name, files] of scriptRefs) {
  if (PLACEHOLDER_SCRIPTS.has(name)) continue;
  if (name.endsWith(":*")) {
    // A family reference like `submit:*` is satisfied by any script in it.
    const prefix = name.slice(0, -1);
    assert.ok(
      [...scriptNames].some((s) => s.startsWith(prefix)),
      `npm script family "${name}" in ${[...new Set(files)].join(", ")} matches no script in package.json.`,
    );
    continue;
  }
  if (name.includes("<")) {
    // A placeholder like `hunt:<channel>` is fine as long as some real script
    // fits the shape; `hunt:<thing>` with no `hunt:*` script is not.
    const shape = new RegExp(`^${name.replace(/<[^>]+>/g, "\u0001").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\u0001/g, "[A-Za-z0-9_.-]+")}$`);
    assert.ok(
      [...scriptNames].some((s) => shape.test(s)),
      `npm script placeholder "${name}" in ${[...new Set(files)].join(", ")} matches no script in package.json.`,
    );
    continue;
  }
  assert.ok(
    scriptNames.has(name),
    `npm script "${name}" is referenced in ${[...new Set(files)].join(", ")} but package.json has no such script. Fix the reference or add the script.`,
  );
}
console.log(`  ✓ all ${scriptRefs.size} distinct npm scripts referenced in prompts and docs exist`);

// (c) The pipeline lives in SQLite. `opportunities.json` is an on-demand
// export; a prompt that sends an agent to read it is reading a stale file.
for (const file of promptFiles) {
  const text = await fs.readFile(file, "utf8");
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.includes("opportunities.json")) continue;
    assert.ok(
      /\bexport\b|\bdigest\b/i.test(line),
      `${file}:${i + 1} points an agent at state/pipeline/opportunities.json. Rows live in the SQLite store; read them with \`npm run pipeline -- get|list\`. The file name may only appear alongside the words "export" or "digest".`,
    );
  }
}
console.log(`  ✓ no prompt file reads the opportunities.json export`);

// (d) AGENTS.md section 3 rule 2: no em dash, no en dash, anywhere.
const dashFiles = [...promptFiles, ...(await walk("references/harness", ".md")), "AGENTS.md"];
for (const file of dashFiles) {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n");
  const bad = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /[—–]/.test(line))
    .map(({ line, i }) => `  ${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  assert.equal(
    bad.length,
    0,
    `${file} contains ${bad.length} em/en dash line(s); AGENTS.md section 3 rule 2 bans both. Rewrite the clause, do not swap the punctuation.\n${bad.join("\n")}`,
  );
}
console.log(`  ✓ ${dashFiles.length} prompt files are free of em and en dashes`);

console.log("prompt-guardrails: all assertions passed");
