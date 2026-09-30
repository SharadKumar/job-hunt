import assert from "node:assert/strict";
import { boundedCommand } from "../tools/lib/bounded-command.ts";

const cwd = process.cwd();
const success = await boundedCommand(process.execPath, ["-e", "console.log('done')"], { cwd, timeoutMs: 5000 });
assert.equal(success.exit_code, 0);
assert.equal(success.stdout.trim(), "done");
const failed = await boundedCommand(process.execPath, ["-e", "console.error('useful final error');process.exit(7)"], { cwd, timeoutMs: 5000 });
assert.equal(failed.exit_code, 7);
assert.match(failed.stderr, /useful final error/);
const start = Date.now();
const timeout = await boundedCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { cwd, timeoutMs: 150, graceMs: 100 });
assert.equal(timeout.exit_code, 124);
assert.equal(timeout.timed_out, true);
assert.ok(Date.now() - start < 5000);
await assert.rejects(boundedCommand(process.execPath, [], { cwd, timeoutMs: NaN }), /positive/);
console.log("bounded-command: success, failure and forced timeout passed");
