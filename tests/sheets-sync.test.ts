/**
 * sheets-sync.test.ts — the Sheet mirror's contract, with the Google client
 * injected.
 *
 * Nothing here touches the network or state/: the pipeline lives in a throwaway
 * SQLite database (PIPELINE_DB), the audit trail in a throwaway dir
 * (AUDIT_DIR), the approval queue in a temp file (deps.queuePath), and the
 * Sheet is a fake that records every call and keeps tab values in memory.
 *
 * `enabled: true` is pinned on every deps literal: these cases are about the
 * mirror's own contract, so they must not change meaning on a machine whose
 * profile has switched the Sheet off (`sheet.enabled: false`). The switched-off
 * path has its own file, tests/sheet-optional.test.ts.
 *
 * Run: npx tsx tests/sheets-sync.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sheets-sync-"));
// Both must be set before pipeline.ts is evaluated: the store resolves its file
// from PIPELINE_DB, and audit.ts pins AUDIT_DIR at import time.
process.env.PIPELINE_DB = path.join(tempRoot, "pipeline.db");
process.env.AUDIT_DIR = path.join(tempRoot, "audit");

const { upsert, setStatus, get } = await import("../tools/pipeline.ts");
const { runPush, runPull, TRAY_HEADER, trayRoles, reasonFor } = await import("../tools/sheets-sync.ts");
type SheetsApi = import("../tools/sheets-sync.ts").SheetsApi;

const QUEUE_PATH = path.join(tempRoot, "approval-queue.json");

type Call = { method: string; range?: string; ranges?: string[] };

/** An in-memory Sheet: tab values survive clear/update, every call is recorded. */
function fakeSheets(opts: { failGetOn?: RegExp } = {}) {
  const tabs: Record<string, any[][]> = { Pipeline: [], Tray: [] };
  const calls: Call[] = [];
  const tabOf = (range: string) => range.split("!")[0];
  const sheets: SheetsApi = {
    spreadsheets: {
      async get() {
        calls.push({ method: "spreadsheets.get" });
        return { data: { sheets: ["Pipeline", "Tray", "Followups", "Contacts", "Market", "Summary"].map((title, i) => ({ properties: { title, sheetId: i } })) } };
      },
      async batchUpdate() {
        calls.push({ method: "spreadsheets.batchUpdate" });
        return {};
      },
      values: {
        async get({ range }) {
          calls.push({ method: "values.get", range });
          if (opts.failGetOn?.test(range)) throw new Error("Quota exceeded for quota metric 'Read requests'");
          return { data: { values: tabs[tabOf(range)] ?? [] } };
        },
        async update({ range, requestBody }) {
          calls.push({ method: "values.update", range });
          tabs[tabOf(range)] = requestBody.values;
          return {};
        },
        async clear({ range }) {
          calls.push({ method: "values.clear", range });
          tabs[tabOf(range)] = [];
          return {};
        },
        async batchClear({ requestBody }) {
          calls.push({ method: "values.batchClear", ranges: requestBody.ranges });
          return {};
        },
      },
    },
  };
  return { sheets, calls, tabs };
}

const card = (n: number) => ({
  channel: "seek",
  url: `https://example.test/job/${n}`,
  title: `Solution Architect ${n}`,
  company: `Company ${n}`,
});

const agentClassification = {
  profile_relevance: 80,
  profile_relevance_reason: "Architecture-led delivery",
  is_contract: true,
  work_arrangement: "remote",
  matched_resume_id: "solution-architect",
  red_flags: [],
  _classifier: "agent",
} as any;

/** discovered → manual_action_needed, with the blocker reason in history. */
async function seedManual(n: number, score: number, reason: string) {
  const row = await upsert({ ...card(n), status: "discovered", score, classificationSource: "agent", classification: agentClassification });
  await setStatus(row.id, "manual_action_needed", reason);
  return row.id;
}

/** discovered → … → awaiting_approval. */
async function seedAwaiting(n: number, score: number, classified: boolean) {
  const row = await upsert({
    ...card(n), status: "discovered", score,
    ...(classified ? { classificationSource: "agent" as const, classification: agentClassification } : { classificationSource: "regex" as const }),
  });
  await setStatus(row.id, "shortlisted", "fits");
  await setStatus(row.id, "drafted", "package assembled");
  await setStatus(row.id, "awaiting_approval", "package ready for review");
  return row.id;
}

try {
  const manualId = await seedManual(1, 90, "letter-critic blocked: unsupported claim about the lender engagement");
  const awaitingId = await seedAwaiting(2, 80, true);
  const unclassifiedId = await seedAwaiting(3, 60, false);

  // --- push: the Tray carries manual rows, ordered after awaiting rows ------
  {
    const { sheets, calls, tabs } = fakeSheets();
    const report = await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });

    assert.equal(report.ok, true);
    assert.equal(report.tray_rows, 3, "all three actionable rows reach the Tray");
    assert.equal(report.manual_rows, 1);
    assert.equal(report.dropped_unclassified, 1, "an awaiting row without agent classification is counted");

    const header = tabs.Tray[0] as string[];
    assert.deepEqual(header, TRAY_HEADER);
    const idIdx = header.indexOf("id");
    const statusIdx = header.indexOf("Status");
    const reasonIdx = header.indexOf("Reason");
    const sourceIdx = header.indexOf("classificationSource");
    const body = tabs.Tray.slice(1);

    assert.deepEqual(
      body.map((r) => r[idIdx]),
      [awaitingId, unclassifiedId, manualId],
      "awaiting rows first (score desc), manual rows after",
    );
    const manualRow = body.find((r) => r[idIdx] === manualId)!;
    assert.equal(manualRow[statusIdx], "manual_action_needed");
    assert.match(String(manualRow[reasonIdx]), /letter-critic blocked/, "the Tray explains why the row is stuck");

    // The unclassified row is COUNTED, not hidden: it is present in the Tray.
    const unclassifiedRow = body.find((r) => r[idIdx] === unclassifiedId)!;
    assert.equal(unclassifiedRow[sourceIdx], "regex");

    assert.ok(calls.some((c) => c.method === "values.update" && c.range === "Tray!A1"), "the Tray is rewritten");
  }

  // --- push carries the person's Action/Edits across the rewrite -----------
  {
    const { sheets, tabs } = fakeSheets();
    await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });
    const header = tabs.Tray[0] as string[];
    const idIdx = header.indexOf("id");
    const actionIdx = header.indexOf("Action");
    const editsIdx = header.indexOf("Edits");
    const target = tabs.Tray.findIndex((r, i) => i > 0 && r[idIdx] === awaitingId);
    tabs.Tray[target][actionIdx] = "approve";
    tabs.Tray[target][editsIdx] = "mention the migration";

    await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });
    const after = tabs.Tray.find((r, i) => i > 0 && r[idIdx] === awaitingId)!;
    assert.equal(after[actionIdx], "approve", "Action survives the clear + rewrite");
    assert.equal(after[editsIdx], "mention the migration", "Edits survive the clear + rewrite");
  }

  // --- a failed Tray read aborts the push before anything is cleared -------
  {
    const { sheets, calls } = fakeSheets({ failGetOn: /^Tray/ });
    await assert.rejects(
      () => runPush({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true }),
      /Tray read failed/,
      "a read error must surface, not be swallowed",
    );
    assert.equal(calls.filter((c) => c.method === "values.clear").length, 0, "nothing is cleared after a failed read");
    assert.equal(calls.filter((c) => c.method === "values.update").length, 0, "nothing is rewritten after a failed read");
  }

  // --- a Tray whose header lost the writable columns is an error ----------
  {
    const { sheets, tabs, calls } = fakeSheets();
    tabs.Tray = [["id", "company", "title"], [awaitingId, "Company 2", "Solution Architect 2"]];
    await assert.rejects(
      () => runPull({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true }),
      /missing Action, Edits/,
      "a short header is an error, not an empty Tray",
    );
    assert.equal(calls.filter((c) => c.method === "values.batchClear").length, 0);
  }

  // --- pull: retry / withdraw / unknown ------------------------------------
  {
    const { sheets, tabs, calls } = fakeSheets();
    await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });
    const header = tabs.Tray[0] as string[];
    const idIdx = header.indexOf("id");
    const actionIdx = header.indexOf("Action");
    const rowOf = (id: string) => tabs.Tray.find((r, i) => i > 0 && r[idIdx] === id)!;

    rowOf(manualId)[actionIdx] = "Retry";          // case-insensitive
    rowOf(awaitingId)[actionIdx] = "withdraw";
    rowOf(unclassifiedId)[actionIdx] = "escalate"; // not an action we know

    const report = await runPull({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });

    assert.equal(report.tray_rows, 3);
    assert.equal(report.manual_rows, 1, "pull counts the manual rows it read");
    assert.equal(report.dropped_unclassified, 1);
    assert.equal(report.actions_applied, 2, "retry + withdraw moved a row each");
    assert.deepEqual(report.unknown_actions, [{ id: unclassifiedId, action: "escalate" }]);
    assert.deepEqual(report.errors, []);
    assert.equal(report.ok, true);

    const retried = (await get(manualId))!;
    assert.equal(retried.status, "approved", "retry re-enters the autopilot path at approved");
    assert.equal(retried.history.at(-1)?.reason, "sheet: retry");
    assert.equal(retried.history.at(-1)?.from, "manual_action_needed");

    const withdrawn = (await get(awaitingId))!;
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.history.at(-1)?.reason, "sheet: withdraw");

    const untouched = (await get(unclassifiedId))!;
    assert.equal(untouched.status, "awaiting_approval", "an unknown action leaves the row alone");

    const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    assert.deepEqual(queue.map((q: any) => q.action).sort(), ["retry", "withdraw"]);
    assert.ok(queue.every((q: any) => q.edits === ""));

    const cleared = calls.find((c) => c.method === "values.batchClear")!;
    assert.equal(cleared.ranges?.length, 2, "only the two processed rows are cleared");
    assert.ok(cleared.ranges?.every((r) => r.startsWith("Tray!")));
  }

  // --- pull: a status move that the transition table refuses is reported ---
  {
    const rejectedId = await seedManual(4, 50, "unsupported portal");
    await setStatus(rejectedId, "rejected", "not pursuing");
    const { sheets, tabs, calls } = fakeSheets();
    await runPush({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });
    // A rejected row is not in the Tray; forge one to prove the failure path.
    const header = tabs.Tray[0] as string[];
    const row = new Array(header.length).fill("");
    row[header.indexOf("id")] = rejectedId;
    row[header.indexOf("Action")] = "retry";
    row[header.indexOf("Status")] = "rejected";
    tabs.Tray.push(row);

    const report = await runPull({ sheets, spreadsheetId: "sheet-1", queuePath: QUEUE_PATH, enabled: true });
    assert.equal(report.ok, false, "a refused transition makes the run non-ok");
    assert.equal(report.actions_applied, 0);
    assert.match(report.errors?.[0] ?? "", /invalid transition rejected → approved/);
    assert.equal((await get(rejectedId))!.status, "rejected");
    assert.equal(calls.filter((c) => c.method === "values.batchClear").length, 0, "a failed action leaves its cells for the person");
  }

  // --- helpers --------------------------------------------------------------
  {
    const long = "x".repeat(400);
    const truncated = reasonFor({ id: "a", channel: "seek", title: "t", company: "c", url: "u", status: "manual_action_needed", history: [], notes: long } as any);
    assert.equal(truncated.length, 160, "the Reason column is capped at 160 chars");
    assert.equal(trayRoles([]).length, 0);
  }

  console.log("sheets-sync tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
