import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const sync = spawnSync("npm", ["run", "codex:sync-agents"], {
  cwd: repoRoot,
  encoding: "utf8",
});
assert.equal(sync.status, 0, sync.stderr || sync.stdout);

const agentDir = path.join(repoRoot, ".codex", "agents");
const agentFiles = fs.readdirSync(agentDir).filter((file) => file.endsWith(".toml"));
assert.ok(agentFiles.length > 0, "expected generated Codex agent roles");

for (const file of agentFiles) {
  const text = fs.readFileSync(path.join(agentDir, file), "utf8");
  assert.match(text, /^name = "[^"]+"$/m, `${file}: missing Codex role name`);
  assert.match(text, /^description = "[^"]+"$/m, `${file}: missing description`);
  assert.match(text, /^developer_instructions = /m, `${file}: missing instructions`);
  assert.doesNotMatch(text, /^model = "(?:haiku|sonnet|opus)"$/m, `${file}: Claude model leaked into Codex config`);
  assert.doesNotMatch(text, /^tools = "\[/m, `${file}: Claude tool list serialized as a string`);
}

const projectConfig = fs.readFileSync(path.join(repoRoot, ".codex", "config.toml"), "utf8");
assert.doesNotMatch(projectConfig, /^model = "gpt-5-codex"$/m, "deprecated Codex model configured");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "job-hunt-daily-wrapper-"));
try {
  const fakeBin = path.join(tempRoot, "bin");
  const fakeRepo = path.join(tempRoot, "repo");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeRepo, { recursive: true });

  const fakeCodex = path.join(fakeBin, "codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 23\n", { mode: 0o755 });

  const daily = spawnSync("bash", [path.join(repoRoot, "scripts", "daily.sh")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HARNESS_CLI: "codex",
      PATH: `${fakeBin}:/usr/bin:/bin`,
      REPO_DIR: fakeRepo,
    },
    encoding: "utf8",
  });
  assert.equal(daily.status, 23, "daily wrapper must propagate the agent CLI exit code");

  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const log = fs.readFileSync(path.join(fakeRepo, "state", "journal", "launchd", `${date}.log`), "utf8");
  assert.match(log, /finished daily run \(exit 23\)/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`Codex config tests passed (${agentFiles.length} generated roles)`);
