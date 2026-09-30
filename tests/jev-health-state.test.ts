import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDegradation, recordDegradation, clearDegradation, acknowledgeDegradation } from "../tools/jev/degradation.ts";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jev-health-"));
const file = path.join(temp, "health.json");
process.env.JEV_DEGRADED_PATH = file;
assert.equal(await readDegradation(), null, "an absent first-run file is allowed");
const valid = { schema_version: 2, scopes: { classification: {
  active: true, reason: "test outage", first_seen_at: "2026-09-28T00:00:00Z",
  last_seen_at: "2026-09-28T00:00:00Z", acknowledged_at: null, acknowledged_by: null,
} } };
for (const bad of ["{truncated", "null", "[]", "{}", JSON.stringify({ schema_version: 1, scopes: {} }),
  JSON.stringify({ schema_version: 2, scopes: [] }),
  ...[{ active: "false" }, { acknowledged_at: "yes" }, { acknowledged_at: "2026-09-28T00:00:00Z" }, { first_seen_at: null }]
    .map(change => JSON.stringify({ ...valid, scopes: { classification: { ...valid.scopes.classification, ...change } } })),
]) {
  await fs.writeFile(file, bad);
  await assert.rejects(readDegradation, /health state is invalid/);
  await assert.rejects(() => recordDegradation("classification", "new outage"), /health state is invalid/);
  await assert.rejects(() => clearDegradation("classification"), /health state is invalid/);
  assert.equal(await fs.readFile(file, "utf8"), bad, "corrupt evidence is not overwritten by recovery");
}
await fs.writeFile(file, JSON.stringify(valid));
assert.deepEqual(await readDegradation(), valid);
await acknowledgeDegradation("classification", "test-human");
assert.equal((await readDegradation())?.scopes.classification?.acknowledged_by, "test-human");
await clearDegradation("classification");
assert.equal((await readDegradation())?.scopes.classification?.active, false);
assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "atomic replacements retain private permissions");
assert.deepEqual(await fs.readdir(temp), ["health.json"], "successful writes leave no temporary files");
process.env.JEV_DEGRADED_PATH = temp;
await assert.rejects(readDegradation, /cannot be read/);
console.log("Jev health-state fail-closed tests passed");
