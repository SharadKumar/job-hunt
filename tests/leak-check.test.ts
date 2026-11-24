#!/usr/bin/env tsx
/**
 * leak-check.test.ts — the pre-commit guard that keeps personal state and
 * secrets out of the public repository.
 *
 * Pure tests of the path and diff rules, then an end-to-end run of the hook
 * against a throwaway git repository. Secret-shaped strings are assembled at
 * runtime so this file never carries one.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathFindings, diffFindings, loadTerms } from "../tools/leak-check.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const jwt = ["eyJ" + "a".repeat(20), "b".repeat(20), "c".repeat(20)].join(".");
const slack = "https://hooks." + "slack.com/services/T000/B000/" + "x".repeat(24);
const bearer = "Authorization: " + "Bearer " + "z".repeat(32);

// Paths.
{
  const f = pathFindings([
    "state/twenty/keys.env",
    "state/org/resume-formats.yaml",
    "state/org/resume-types.example.yaml",
    "state/org/team.yaml",
    ".env",
    ".env.local",
    ".env.example",
    "tools/x.ts",
  ]);
  const files = f.map((x) => x.file).sort();
  assert.deepEqual(files, [".env", ".env.local", "state/org/team.yaml", "state/twenty/keys.env"].sort());
}

// Secrets and terms in added lines only.
{
  const diff = [
    "+++ b/docs/a.md",
    "@@ -0,0 +1,6 @@",
    `+token ${jwt}`,
    `+webhook ${slack}`,
    `+${bearer}`,
    "+mentions Acme Widgets here",
    `+fixture ${jwt} leak-check: allow`,
    "+nothing to see",
    "+++ b/docs/b.md",
    "@@ -3 +3 @@",
    `-${jwt}`,
  ].join("\n");
  const f = diffFindings(diff, loadTerms("# comment\nacme widgets\n\n"));
  assert.deepEqual(f.map((x) => `${x.kind}:${x.detail}:${x.line}`), [
    "secret:jwt:1",
    "secret:slack-webhook:2",
    "secret:bearer-literal:3",
    "term:private term from state/leak-terms.txt:4",
  ]);
  assert.ok(f.every((x) => !JSON.stringify(x).includes("Acme")), "findings never echo the matched text");
}

// End to end: the hook blocks a staged state/ file and a staged secret, and passes a clean commit.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leak-check-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  const run = () => spawnSync("npx", ["--no-install", "tsx", path.join(repo, "tools/leak-check.ts")], { cwd: dir, encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp" } });

  fs.mkdirSync(path.join(dir, "state/twenty"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state/twenty/keys.env"), "KEY=x\n");
  g("add", "-f", "state/twenty/keys.env");
  let r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).findings[0].kind, "path");
  g("rm", "-q", "--cached", "state/twenty/keys.env");

  fs.writeFileSync(path.join(dir, "notes.md"), `${slack}\n`);
  g("add", "notes.md");
  r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).findings[0].detail, "slack-webhook");

  fs.writeFileSync(path.join(dir, "notes.md"), "plain text\n");
  g("add", "notes.md");
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("leak-check: ok");
