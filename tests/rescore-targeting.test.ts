/**
 * rescore-targeting.test.ts — which rows a rescore selects, and which rows it
 * is allowed to move.
 *
 * Everything that writes runs against a throwaway SQLite database and a
 * throwaway audit dir, so the real state/pipeline is never touched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Classification } from "../tools/classify-jd.ts";
import type { Opportunity } from "../tools/pipeline.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-targeting-"));

// Both must be set before pipeline.ts is evaluated: the store resolves its file
// from PIPELINE_DB, and audit.ts pins AUDIT_DIR at import time.
process.env.PIPELINE_DB = path.join(tempRoot, "pipeline.db");
process.env.AUDIT_DIR = path.join(tempRoot, "audit");

// Every runtime import happens after those are set: a static import would
// evaluate audit.ts first, which pins AUDIT_DIR at module load.
const { selectOpportunitiesForRescore, applyRescore } = await import("../tools/rescore-pipeline.ts");
const { upsertMany, patch, setStatus, get } = await import("../tools/pipeline.ts");

// --- selection --------------------------------------------------------------

const role = (id: string, status: Opportunity["status"]): Opportunity => ({
  id,
  channel: "seek",
  title: `Role ${id}`,
  company: "Example",
  url: `https://example.test/${id}`,
  status,
  history: [],
});

const roles = [
  role("new-a", "discovered"),
  role("old-b", "discovered"),
  role("existing-shortlist", "shortlisted"),
  role("already-submitted", "submitted"),
];

const selected = selectOpportunitiesForRescore(
  roles,
  ["discovered", "shortlisted"],
  new Set(["new-a", "already-submitted"]),
  Infinity,
);

assert.deepEqual(selected.map((item) => item.id), ["new-a"]);
console.log("Targeted rescore selection test passed");

// --- what a rescore may move ------------------------------------------------

const agentClassification = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "rescore", "agent-classification.json"), "utf8"),
) as Classification;

const SHORTLIST_MIN = 55;

function scoreResult(score: number, extra: { parked_reason?: string; red_flag_blocker?: boolean } = {}) {
  return {
    score,
    reasons: [`classifier: ${agentClassification._classifier}`],
    red_flag_blocker: extra.red_flag_blocker ?? false,
    breakdown: {} as any,
    classification: agentClassification,
    parked_reason: extra.parked_reason,
  } as Awaited<ReturnType<typeof import("../tools/score.ts").scoreRole>>;
}

const card = (n: number, title: string) => ({
  channel: "seek",
  url: `https://example.test/job/${n}`,
  title,
  company: `Company ${n}`,
  description: `Description for job ${n}`,
  status: "discovered" as const,
});

/** History rows a status move leaves behind (patch writes from === to entries). */
const statusMoves = (row: Opportunity) => row.history.filter((h) => h.from !== h.to);

try {
  const [parkedRow, discoveredRow, awaitingRow, shortlistedRow, probeRow] = await upsertMany([
    card(1, "Parked interstate architect"),
    card(2, "Discovered architect"),
    card(3, "Awaiting approval architect"),
    card(4, "Shortlisted architect"),
    card(5, "Transition probe"),
  ]);

  await setStatus(parkedRow.id, "parked", "interstate onsite; user ruled on it");
  await patch(parkedRow.id, { parkedReason: "interstate onsite (Melbourne VIC)" }, "seed");

  await setStatus(awaitingRow.id, "shortlisted", "fits");
  await setStatus(awaitingRow.id, "drafted", "package assembled");
  await setStatus(awaitingRow.id, "awaiting_approval", "in the tray");

  await setStatus(shortlistedRow.id, "shortlisted", "fits");
  await setStatus(probeRow.id, "shortlisted", "fits");

  // Does the live transition table allow the demotion a rescore wants to make?
  let demotionAllowed = true;
  try {
    await setStatus(probeRow.id, "discovered", "probe");
  } catch {
    demotionAllowed = false;
  }

  const parkedBefore = (await get(parkedRow.id))!;
  const awaitingBefore = (await get(awaitingRow.id))!;

  const counts = await applyRescore([
    { before: parkedBefore, result: scoreResult(92) },
    { before: (await get(discoveredRow.id))!, result: scoreResult(88) },
    { before: awaitingBefore, result: scoreResult(91) },
    { before: (await get(shortlistedRow.id))!, result: scoreResult(18) },
  ], SHORTLIST_MIN);

  // 1. A parked row with a reason keeps its hold, however well it now scores.
  const parkedAfter = (await get(parkedRow.id))!;
  assert.equal(parkedAfter.status, "parked", "a parked row with a reason stays parked");
  assert.equal(parkedAfter.parkedReason, "interstate onsite (Melbourne VIC)", "its parked reason survives");
  assert.equal(parkedAfter.score, 92, "but its score is refreshed");
  assert.deepEqual(
    statusMoves(parkedAfter).map((h) => h.to),
    statusMoves(parkedBefore).map((h) => h.to),
    "a left-parked row gains no status history",
  );
  assert.equal(counts.left_parked, 1);

  // 2. A discovered row above the threshold is promoted, through setStatus.
  const promoted = (await get(discoveredRow.id))!;
  assert.equal(promoted.status, "shortlisted");
  assert.equal(promoted.score, 88);
  assert.equal(promoted.classificationSource, "agent");
  const move = statusMoves(promoted).at(-1)!;
  assert.equal(move.from, "discovered");
  assert.equal(move.to, "shortlisted");
  assert.match(move.reason ?? "", /rescore/, "the history entry names rescore");
  assert.equal(counts.promoted, 1);

  const audit = fs.readFileSync(path.join(tempRoot, "audit", "audit-log.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    audit.some((e) => e.role_id === discoveredRow.id && e.actor === "rescore" && e.details?.to === "shortlisted"),
    "the promotion writes an audit event with actor rescore",
  );

  // 3. An awaiting_approval row is rescored but never rewound (this is the
  //    --all case: it is in the selection, and its status is protected).
  const awaitingAfter = (await get(awaitingRow.id))!;
  assert.equal(awaitingAfter.status, "awaiting_approval", "a packaged row is never rewound");
  assert.equal(awaitingAfter.score, 91, "its score is still refreshed");
  assert.deepEqual(
    statusMoves(awaitingAfter).map((h) => h.to),
    statusMoves(awaitingBefore).map((h) => h.to),
    "a protected row gains no status history",
  );
  assert.equal(counts.skipped_protected, 1);

  // 4. A shortlisted row that drops below the threshold leaves the apply queue.
  const demoted = (await get(shortlistedRow.id))!;
  assert.equal(demoted.score, 18, "the new score is written either way");
  if (demotionAllowed) {
    assert.equal(demoted.status, "discovered", "a sub-threshold row leaves the queue");
    const back = statusMoves(demoted).at(-1)!;
    assert.equal(back.from, "shortlisted");
    assert.equal(back.to, "discovered");
    assert.match(back.reason ?? "", /rescore/);
    assert.equal(counts.demoted, 1);
  } else {
    // tools/pipeline.ts does not yet list `discovered` under `shortlisted` in
    // VALID_TRANSITIONS. The rescore must not force the move; it leaves the row
    // alone and reports nothing demoted.
    assert.equal(demoted.status, "shortlisted", "a refused transition leaves the row where it is");
    assert.equal(counts.demoted, 0, "a refused move is not reported as demoted");
    console.log("Note: shortlisted → discovered is not in VALID_TRANSITIONS; the demotion path is inert until tools/pipeline.ts allows it");
  }

  console.log("Rescore status-targeting tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
