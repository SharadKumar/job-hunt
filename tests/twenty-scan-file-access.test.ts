#!/usr/bin/env tsx
/**
 * twenty-scan-file-access.test.ts: the V22 matcher. Synthetic lines only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXCLUDED, matchLine, scan, scanText } from "../tools/twenty/scan-file-access.ts";

assert.deepEqual(matchLine(`const p = repoPath("state/pipeline/archive", id);`), ["pipeline_dir"]);
assert.deepEqual(matchLine(`repoPath("state", "pipeline", "archive")`), ["pipeline_dir"]);
assert.deepEqual(matchLine(`const db = "state/pipeline/pipeline.db";`), ["pipeline_dir", "pipeline_db"]);
assert.deepEqual(matchLine(`npm run pipeline -- export > opportunities.json`), ["opportunities_json"]);
assert.deepEqual(matchLine(`read state/profile/cv-source.md first`), ["profile"]);
assert.deepEqual(matchLine(`path.join(root, 'state', 'profiles', id)`), ["profile"]);
assert.deepEqual(matchLine(`append to state/journal/2026-01-01.md`), ["journal"]);
assert.deepEqual(matchLine(`const q = "approval-queue.json";`), ["approval_queue"]);
assert.deepEqual(matchLine(`const ctx = resolveProfileContext(profileId);`), ["profile_resolver"]);
// Near misses stay quiet.
assert.deepEqual(matchLine(`import { pipeline } from "./pipeline.ts";`), []);
assert.deepEqual(matchLine(`state/twenty/keys.env`), []);
assert.deepEqual(matchLine(`templates/profile/profile.md`), []);
assert.deepEqual(matchLine(`the pipelines database`), []);

assert.deepEqual(scanText("a state/journal x\nb state/journal y\nc pipeline.db"), { journal: 2, pipeline_db: 1 });

// A synthetic tree: counts per path, exclusions honoured, other folders ignored.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-file-access-"));
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
put("tools/a.ts", `repoPath("state/pipeline/archive")\nrepoPath("state/profile/x.md")\n`);
put("tools/twenty/migrate.ts", `state/pipeline\n`);
put("tools/store/sqlite-backend.ts", `pipeline.db\n`);
put(".claude/skills/x/SKILL.md", `Read state/journal/ first.\n`);
put("agents/y.md", `nothing here\n`);
put("tests/z.test.ts", `state/pipeline\n`);
put("tools/node_modules/m.js", `state/pipeline\n`);
const r: any = await scan(root);
assert.equal(r.gate, false);
assert.equal(r.files_scanned, 3);
assert.equal(r.files_with_hits, 2);
assert.equal(r.total_hits, 3);
assert.deepEqual(r.by_dir, { tools: 2, ".claude/skills": 1 });
assert.deepEqual(r.paths[0], { path: "tools/a.ts", hits: 2, patterns: { pipeline_dir: 1, profile: 1 } });
assert.ok(EXCLUDED.has("tools/twenty/migrate.ts"));
fs.rmSync(root, { recursive: true, force: true });

console.log("twenty-scan-file-access: ok");
