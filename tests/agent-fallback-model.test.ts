import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("npx", ["tsx", "tools/jev/adopt-agent-fallback.ts", "--id", "example", "--model", "gpt-6-astra", "--json", "{}"], {
  cwd: root,
  env: { ...process.env, HARNESS_DAILY_MODEL: "gpt-6-sol" },
  encoding: "utf8",
});
assert.equal(result.status, 1);
assert.match(result.stderr, /agent-fallback model gpt-6-astra does not match running model gpt-6-sol/);
console.log("agent-fallback model provenance test passed");
