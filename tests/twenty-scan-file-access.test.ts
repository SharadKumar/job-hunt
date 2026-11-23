#!/usr/bin/env tsx
/**
 * twenty-scan-file-access.test.ts: the V22 matcher. Synthetic lines only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXCLUDED, isCommentLine, matchLine, scan, scanFile, scanText } from "../tools/twenty/scan-file-access.ts";

assert.deepEqual(matchLine(`const p = repoPath("state/pipeline/archive", id);`), ["pipeline_dir"]);
assert.deepEqual(matchLine(`repoPath("state", "pipeline", "archive")`), ["pipeline_dir"]);
assert.deepEqual(matchLine(`const db = "state/pipeline/pipeline.db";`), ["pipeline_dir", "pipeline_db"]);
assert.deepEqual(matchLine(`npm run pipeline -- export > opportunities.json`), ["opportunities_json"]);
assert.deepEqual(matchLine(`read state/profile/cv-source.md first`), ["profile"]);
assert.deepEqual(matchLine(`path.join(root, 'state', 'profiles', id)`), ["profile"]);
assert.deepEqual(matchLine(`append to state/journal/2026-01-01.md`), ["journal"]);
assert.deepEqual(matchLine(`const q = "approval-queue.json";`), ["approval_queue"]);
// Near misses stay quiet.
assert.deepEqual(matchLine(`import { pipeline } from "./pipeline.ts";`), []);
assert.deepEqual(matchLine(`state/twenty/keys.env`), []);
assert.deepEqual(matchLine(`templates/profile/profile.md`), []);
assert.deepEqual(matchLine(`the pipelines database`), []);
assert.deepEqual(matchLine(`state/cache/run-1/profile/cv-source.md`), []);

assert.deepEqual(scanText("a state/journal x\nb state/journal y\nc pipeline.db"), { journal: 2, pipeline_db: 1 });

// Comments in code describe; they never access. Prose in skills always counts.
assert.equal(isCommentLine(` * reads state/profile/x.md`, "tools/a.ts"), true);
assert.equal(isCommentLine(`  // state/profile`, "tools/a.ts"), true);
assert.equal(isCommentLine(`# logs to state/journal`, "scripts/a.sh"), true);
assert.equal(isCommentLine(`# Read state/profile/x.md`, ".claude/skills/x/SKILL.md"), false);
assert.deepEqual(scanFile(`// state/profile/x.md\nconst p = "state/profile/x.md";`, "tools/a.ts").direct, { profile: 1 });

// Resolver calls are routed; marked lines are file-mode branches or labels.
{
  const r = scanFile([
    `const ctx = resolveProfileContext(profileId);`,
    `const q = pipelineFile("approval-queue.json");`,
    `Run \`npm run -s profile:path -- cv-source.md\` first.`,
    `: path.join(root, "state", "pipeline"); // scan:file-mode`,
    `"=== CORPUS (state/profile/cv-source.md) ===", // scan:label`,
    `readFile("state/journal/x.md")`,
  ].join("\n"), "tools/a.ts");
  assert.deepEqual(r, { direct: { journal: 1 }, fileMode: 1, labels: 1, routed: 3 });
}

// A synthetic tree: counts per path, exclusions honoured, other folders ignored.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-file-access-"));
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
put("tools/a.ts", `repoPath("state/pipeline/archive")\nrepoPath("state/profile/x.md")\n// state/profile/comment.md\nprofilePath("x.md")\n`);
put("tools/store/paths.ts", `: path.join(root, "state", "journal"); // scan:file-mode\n`);
put("tools/twenty/migrate.ts", `state/pipeline\n`);
put("tools/store/sqlite-backend.ts", `pipeline.db\n`);
put("tools/pipeline-store.ts", `pipeline.db\n`);
put(".claude/skills/x/SKILL.md", `Read state/journal/ first.\n`);
put("agents/y.md", `nothing here\n`);
put("tests/z.test.ts", `state/pipeline\n`);
put("tools/node_modules/m.js", `state/pipeline\n`);
const r: any = await scan(root);
assert.equal(r.gate, false);
assert.equal(r.files_scanned, 4);
assert.equal(r.files_with_hits, 2);
assert.equal(r.total_hits, 3);
assert.equal(r.file_mode_hits, 1);
assert.equal(r.routed_hits, 1);
assert.deepEqual(r.by_dir, { tools: 2, ".claude/skills": 1 });
assert.deepEqual(r.paths[0], { path: "tools/a.ts", hits: 2, patterns: { pipeline_dir: 1, profile: 1 } });
assert.ok(EXCLUDED.has("tools/twenty/migrate.ts"));
fs.rmSync(root, { recursive: true, force: true });

// Git-ignored paths (eval workspaces and other generated output) are skipped.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "scan-file-access-git-"));
  const add = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  add(".gitignore", ".claude/skills/*-workspace/\n");
  add(".claude/skills/x/SKILL.md", `Read state/journal/ first.\n`);
  add(".claude/skills/x-workspace/out/run.md", `Read state/profile/x.md and state/journal/y.md\n`);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", repo]);
  const g: any = await scan(repo);
  assert.equal(g.files_scanned, 1);
  assert.equal(g.total_hits, 1);
  assert.equal(g.git_ignored_skipped, 1);
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log("twenty-scan-file-access: ok");
