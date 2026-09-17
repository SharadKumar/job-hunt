#!/usr/bin/env node
/**
 * A stand-in for tools/autopilot-submit.ts, pointed at by HARNESS_AUTOPILOT_BIN
 * in tests/ui-b.test.ts. It prints a line of prose and then one JSON summary
 * line, exactly as the real tool does, so the job table's tail and its parsed
 * final line are exercised without a browser, a gate or a pipeline write.
 *
 * FAKE_AUTOPILOT_DELAY_MS holds the exit back, so a test can see a job while it
 * is still running.
 */
const argv = process.argv.slice(2);
const id = argv.includes("--id") ? argv[argv.indexOf("--id") + 1] : null;
const delay = Number(process.env.FAKE_AUTOPILOT_DELAY_MS ?? 0) || 0;

setTimeout(() => {
  console.log(`[fake-autopilot] starting ${id}`);
  console.log(JSON.stringify({
    id,
    runId: "ui-retry",
    dryRun: false,
    outcome: "submitted",
    status: "submitted",
    notes: ["status → submitted"],
  }));
  process.exit(0);
}, delay);
