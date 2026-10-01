import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRunLogEdges } from "../tools/ui/run-log.ts";
import { readLastRun } from "../tools/ui/health-api.ts";
import { parseRunLog } from "../tools/ui/workspace-api.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-"));
const file = path.join(dir, "2026-10-01.log");
const first = "=== 2026-10-01T07:00:00+10:00 starting daily run ===\n=== 2026-10-01T07:12:00+10:00 finished daily run (exit 2) ===\n";
const second = "=== 2026-10-01T09:33:00+10:00 starting daily run ===\n";
const now = new Date("2026-10-01T09:35:00+10:00");
try {
  // The previous finish remains visible in the tail of a newly started run.
  await fs.writeFile(file, first + second);
  let edges = await readRunLogEdges(file);
  let parsed = parseRunLog(edges.head, edges.tail, { mtime_ms: now.getTime(), now: now.getTime() });
  assert.equal(parsed.running, true);
  assert.equal(parsed.exit_code, null);
  assert.equal(parsed.duration_s, 120);
  assert.equal((await readLastRun(dir, now))?.started_at, "2026-09-30T23:33:00.000Z");
  assert.equal((await readLastRun(dir, now))?.running, true);

  // Latest start is outside both ordinary log edges and crosses a scan boundary.
  const payload = "x".repeat(65536 - 25);
  await fs.writeFile(file, first + second + payload);
  edges = await readRunLogEdges(file);
  assert.match(edges.head, /09:33:00/);
  parsed = parseRunLog(edges.head, edges.tail, { mtime_ms: now.getTime(), now: now.getTime() });
  assert.equal(parsed.running, true);

  await fs.appendFile(file, "\n=== 2026-10-01T09:36:00+10:00 finished daily run (exit 0) ===\n");
  edges = await readRunLogEdges(file);
  parsed = parseRunLog(edges.head, edges.tail);
  assert.equal(parsed.running, false);
  assert.equal(parsed.duration_s, 180);
  assert.equal(parsed.exit_code, 0);
  const last = await readLastRun(dir, new Date("2026-10-01T09:37:00+10:00"));
  assert.equal(last?.duration_seconds, 180);
  assert.equal(last?.exit_code, 0);
  console.log("Latest daily run stays consistent across health and schedules");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
