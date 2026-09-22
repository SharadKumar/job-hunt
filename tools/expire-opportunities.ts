#!/usr/bin/env tsx

import { reconcileExpiredOpportunities } from "./opportunity-expiry.ts";

function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const nowRaw = valueAfter(argv, "--now");
const now = nowRaw ? new Date(nowRaw) : undefined;
if (now && Number.isNaN(now.getTime())) {
  console.error(JSON.stringify({ ok: false, error: `invalid --now value: ${nowRaw}` }));
  process.exit(2);
}

reconcileExpiredOpportunities({
  apply: argv.includes("--apply"),
  now,
  timeZone: valueAfter(argv, "--timezone"),
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
  process.exit(1);
});
