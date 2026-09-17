#!/usr/bin/env tsx

/**
 * Backfill the same cheap technical-relevance gate used by the SEEK collector.
 * Defaults to dry-run. `--apply` only rejects unclassified SEEK discoveries;
 * agent-classified/actionable rows are never touched.
 */

import { load, setStatus } from "./pipeline.ts";
import { looksTechnicallyRelevant } from "./channels/seek.ts";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const roles = await load();
  const rejected = roles.filter((role) =>
    role.channel === "seek" &&
    role.status === "discovered" &&
    (role.classificationSource ?? role.classification?._classifier ?? "none") === "none" &&
    !looksTechnicallyRelevant(role.title, role.description ?? ""),
  );

  if (apply) {
    for (const role of rejected) {
      await setStatus(role.id, "rejected", "pre-ingest technical relevance backfill");
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    matched: rejected.length,
    examples: rejected.slice(0, 20).map((role) => ({ id: role.id, company: role.company, title: role.title })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
