#!/usr/bin/env tsx
/**
 * leak-check.ts — keep personal data and secrets out of git.
 *
 * The repository is public; a person's data lives in `state/` (and, once the
 * Twenty workspace is the store, in the workspace). This check runs as the
 * pre-commit hook (`.githooks/pre-commit`) and on demand.
 *
 * It blocks:
 *   - staged paths under `state/`, except the tracked examples in ALLOWED_STATE;
 *   - staged `.env` files (`.env.example` is allowed);
 *   - added lines that look like a secret: JWTs, Slack webhook URLs,
 *     `Authorization: Bearer …` literals, common API key shapes, private keys;
 *   - added lines containing a term from the private `state/leak-terms.txt`
 *     (one term per line, `#` comments; case-insensitive; optional file).
 *
 * A line that must carry a pattern (a test fixture) can end with the marker
 * `leak-check: allow`.
 *
 * Usage:
 *   tsx tools/leak-check.ts            # staged changes (the hook)
 *   tsx tools/leak-check.ts --history  # every commit on the current branch
 *
 * Prints one JSON object. Exit 0 clean, 1 findings, 2 could not run.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const ALLOWED_STATE = new Set([
  "state/org/resume-formats.yaml",
  "state/org/resume-types.example.yaml",
]);

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "slack-webhook", re: /hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]{10,}/i },
  { name: "bearer-literal", re: /Authorization["']?\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const ALLOW_MARKER = "leak-check: allow";

export type Finding = { kind: "path" | "secret" | "term"; file: string; line?: number; detail: string };

export function pathFindings(files: string[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const norm = f.replace(/\\/g, "/");
    if (norm.startsWith("state/") && !ALLOWED_STATE.has(norm)) {
      out.push({ kind: "path", file: norm, detail: "personal state must not be committed" });
    }
    const base = path.posix.basename(norm);
    if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") {
      out.push({ kind: "path", file: norm, detail: "environment files hold secrets" });
    }
  }
  return out;
}

export function loadTerms(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.toLowerCase());
}

/** Scan added lines of a unified diff (`git diff -U0` / `git log -p`). */
export function diffFindings(diff: string, terms: string[]): Finding[] {
  const out: Finding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const text = raw.slice(1);
    const at = line++;
    if (file === "/dev/null" || text.includes(ALLOW_MARKER)) continue;
    // The checker's own pattern table and its tests describe secrets; they don't hold them.
    if (file === "tools/leak-check.ts") continue;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) out.push({ kind: "secret", file, line: at, detail: p.name });
    }
    const lower = text.toLowerCase();
    for (const t of terms) {
      if (lower.includes(t)) out.push({ kind: "term", file, line: at, detail: "private term from state/leak-terms.txt" });
    }
  }
  return out;
}

function git(args: string[], root: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function main(): number {
  const history = process.argv.includes("--history");
  let root: string;
  try { root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim(); } catch (e: any) {
    console.log(JSON.stringify({ ok: false, error: `not a git repository: ${e?.message ?? e}` }));
    return 2;
  }
  let terms: string[] = [];
  try { terms = loadTerms(readFileSync(path.join(root, "state", "leak-terms.txt"), "utf8")); } catch { /* optional */ }

  const findings: Finding[] = [];
  if (history) {
    findings.push(...diffFindings(git(["log", "-p", "--no-color", "--format=", "HEAD"], root), terms));
  } else {
    const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root).split("\0").filter(Boolean);
    findings.push(...pathFindings(staged));
    findings.push(...diffFindings(git(["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR"], root), terms));
  }
  // Never echo the matched text: a finding names the file, line and rule only.
  console.log(JSON.stringify({ ok: findings.length === 0, mode: history ? "history" : "staged", terms: terms.length, findings }));
  if (findings.length) {
    console.error("leak-check: commit blocked. Remove the flagged content, or mark a deliberate fixture line with `leak-check: allow`.");
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
