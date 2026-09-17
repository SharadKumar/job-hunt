#!/usr/bin/env tsx
/**
 * sheets-sync.ts — bi-directional sync between local pipeline state and a
 * Google Sheet.
 *
 * Push (default): replaces tab contents for Pipeline, Tray, Followups,
 * Contacts, Market, leaving only the Tray's `Action` and `Edits` columns
 * intact (those are the user-writable surface). The Summary tab is owned by
 * tools/daily-summary.ts, which reuses the exported auth helpers below.
 *
 * Pull: reads the Tray's `Action` and `Edits` columns into a queue file
 * (state/pipeline/approval-queue.json) and clears those cells so the user
 * doesn't reprocess them next run.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS (service account JSON path) +
 * SHEETS_SPREADSHEET_ID env var. The service-account email must be added
 * to the Sheet as Editor.
 *
 * Usage:
 *   tsx tools/sheets-sync.ts            # push (default)
 *   tsx tools/sheets-sync.ts pull       # pull Tray.Action + Tray.Edits
 *   tsx tools/sheets-sync.ts init       # create missing tabs
 *
 * If credentials are missing, prints clear setup instructions and exits 0
 * with a warning (so the daily orchestrator doesn't crash when the user
 * hasn't wired up Sheets yet).
 */

import { promises as fs } from "node:fs";
import { google } from "googleapis";
import YAML from "yaml";
import { load as loadPipeline, type Opportunity } from "./pipeline.ts";
import { repoPath } from "./repo-root.ts";

export const TABS = ["Pipeline", "Tray", "Followups", "Contacts", "Market", "Summary"];
const APPROVAL_QUEUE_PATH = "state/pipeline/approval-queue.json";
const TRAY_HEADER = [
  "id", "channel", "company", "title", "score", "profileRelevance", "fitReason", "domain",
  "isContract", "workArrangement", "resumeId", "resumeReason", "topReasons", "redFlags",
  "endEmployer", "requisitionId", "duplicateGroup", "duplicateOf",
  "coverSnippet", "url", "draftDir", "classificationSource", "Action", "Edits", "Status",
  "SubmittedAt", "ConfirmationRef",
];

export async function loadLocalEnv(): Promise<void> {
  try {
    const raw = await fs.readFile(repoPath(".env"), "utf8");
    for (const sourceLine of raw.split(/\r?\n/)) {
      const line = sourceLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]] != null) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function authReady(): boolean {
  return !!(process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.SHEETS_SPREADSHEET_ID);
}

export function warnSetup(): void {
  console.error(`
[sheets-sync] Google Sheets not configured — skipping.
To enable:
  1. Create a Google Cloud service account, download the JSON key.
  2. Create an empty Google Sheet, share it with the service-account email as Editor.
  3. Set in .env:
       GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/service-account.json
       SHEETS_SPREADSHEET_ID=<spreadsheet-id-from-the-URL>
  4. Re-run: npm run sheets:sync init
`);
}

export async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() as any });
}

export async function ensureTabs(sheets: any, spreadsheetId: string): Promise<void> {
  const ss = await sheets.spreadsheets.get({ spreadsheetId });
  const have = new Set((ss.data.sheets ?? []).map((s: any) => s.properties.title));
  const missing = TABS.filter((t) => !have.has(t));
  if (!missing.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
  });
}

function rowFor(r: Opportunity): (string | number)[] {
  const reasons = (r.scoreReasons ?? []).slice(0, 3).join(" • ");
  const classification = r.classification;
  const flags = [
    ...(classification?.red_flags ?? []),
    ...(r.red_flag_blocker ? ["BLOCKER"] : []),
  ].join(" • ");
  return [
    r.id, r.channel, r.company, r.title,
    r.score != null ? r.score : "",         // number, not string — so Sheets can sort
    classification?.profile_relevance ?? "",
    classification?.profile_relevance_reason ?? "Pending agent classification",
    classification?.detected_domain ?? "",
    classification ? (classification.is_contract ? "yes" : "no") : "unknown",
    classification?.work_arrangement ?? r.workArrangement ?? "unknown",
    r.resumeId ?? classification?.matched_resume_id ?? "",
    classification?.resume_match_explanation ?? "",
    reasons,
    flags,
    r.endEmployer ?? "",
    r.requisitionId ?? "",
    r.duplicateGroup ?? "",
    r.duplicateOf ?? "",
    "",
    r.url,
    r.draftDir ?? "",
    r.classificationSource ?? classification?._classifier ?? "none",
    "", "", r.status, r.submittedAt ?? "", "",
  ];
}

async function push() {
  if (!authReady()) { warnSetup(); return; }
  const sheets = await sheetsClient();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID!;
  await ensureTabs(sheets, spreadsheetId);

  const all = await loadPipeline();
  const scoringWeights = YAML.parse(await fs.readFile("state/profile/scoring-weights.yaml", "utf8"));
  const pipelineSheetMinScore = scoringWeights.thresholds?.pipeline_sheet_min_score ?? 0;

  // Keep the operational view useful without requiring a manual Sheet sort:
  // actionable buckets first, then highest score. Rejected/noisy discoveries
  // remain available for audit, but do not obscure the strongest matches.
  const statusRank: Record<string, number> = {
    awaiting_approval: 0,
    approved: 1,
    submission_pending: 2,
    shortlisted: 3,
    parked: 4,
    awaiting_external: 4,
    drafted: 4,
    manual_action_needed: 5,
    submitted: 6,
    responded: 7,
    interview: 8,
    offered: 9,
    won: 10,
    discovered: 11,
    rejected: 12,
    withdrawn: 13,
  };
  const pipelineView = all.filter((role) =>
    role.status !== "discovered" || (role.score ?? 0) >= pipelineSheetMinScore,
  ).sort((a, b) =>
    (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99)
    || (b.score ?? -1) - (a.score ?? -1)
    || a.company.localeCompare(b.company)
    || a.title.localeCompare(b.title),
  );

  // Pipeline tab — everything. Score is a number (so the user can sort/filter).
  const pipelineHeader = [
    "id", "channel", "status", "company", "title", "score", "classificationSource",
    "profileRelevance", "disciplineFit", "fitReason", "domain", "isContract", "workArrangement", "location", "locationFlex", "locationFlexQuote", "resumeId",
    "resumeReason", "endEmployer", "requisitionId", "duplicateGroup", "duplicateOf",
    "redFlags", "topReasons", "url", "submittedAt",
  ];
  const pipelineRows: (string | number)[][] = [pipelineHeader, ...pipelineView.map((r) => [
    r.id, r.channel, r.status, r.company, r.title,
    r.score != null ? r.score : "",
    r.classificationSource ?? r.classification?._classifier ?? "none",
    r.classification?.profile_relevance ?? "",
    (r.classification as { discipline_fit?: string } | undefined)?.discipline_fit ?? "",
    r.classification?.profile_relevance_reason ?? "Pending agent classification",
    r.classification?.detected_domain ?? "",
    r.classification ? (r.classification.is_contract ? "yes" : "no") : "unknown",
    r.classification?.work_arrangement ?? r.workArrangement ?? "unknown",
    r.location ?? "",
    (r.classification as { location_flexibility?: string } | undefined)?.location_flexibility ?? "",
    (r.classification as { location_flexibility_quote?: string } | undefined)?.location_flexibility_quote ?? "",
    r.resumeId ?? r.classification?.matched_resume_id ?? "",
    r.classification?.resume_match_explanation ?? "",
    r.endEmployer ?? "",
    r.requisitionId ?? "",
    r.duplicateGroup ?? "",
    r.duplicateOf ?? "",
    [...(r.classification?.red_flags ?? []), ...(r.red_flag_blocker ? ["BLOCKER"] : [])].join(" • "),
    (r.scoreReasons ?? []).slice(0, 3).join(" • "),
    r.url,
    r.submittedAt ?? "",
  ])];
  // A values.update only overwrites the addressed cells. If the refreshed
  // pipeline is shorter than the previous one, stale rows otherwise remain
  // visible below the new data. Clear the managed range before replacing it.
  await sheets.spreadsheets.values.clear({
    spreadsheetId, range: "Pipeline!A:AD",
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "Pipeline!A1", valueInputOption: "RAW",
    requestBody: { values: pipelineRows },
  });

  // Tray tab — only `awaiting_approval` (the user qualifies here)
  // Preserve any existing Action/Edits on rows still in awaiting_approval.
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Tray!A1:AD" }).catch(() => ({ data: { values: [] as (string | number)[][] } }));
  const existingHeader = (existing.data.values?.[0] ?? []) as (string | number)[];
  const existingById = new Map<string, (string | number)[]>();
  if (existingHeader.length) {
    const idIdx = existingHeader.findIndex((v) => v === "id");
    for (const row of (existing.data.values ?? []).slice(1)) existingById.set(String(row[idIdx]), row);
  }
  const trayRoles = all.filter((r) => r.status === "awaiting_approval" && (r.classificationSource ?? r.classification?._classifier) === "agent");
  const trayRows: (string | number)[][] = [TRAY_HEADER, ...trayRoles.map((r) => {
    const row = rowFor(r);
    const prev = existingById.get(r.id);
    if (prev) {
      const newActionIdx = TRAY_HEADER.indexOf("Action");
      const newEditsIdx = TRAY_HEADER.indexOf("Edits");
      const oldActionIdx = existingHeader.findIndex((v) => v === "Action");
      const oldEditsIdx = existingHeader.findIndex((v) => v === "Edits");
      if (oldActionIdx >= 0) row[newActionIdx] = (prev[oldActionIdx] as string | undefined) ?? "";
      if (oldEditsIdx >= 0) row[newEditsIdx] = (prev[oldEditsIdx] as string | undefined) ?? "";
    }
    return row;
  })];
  await sheets.spreadsheets.values.clear({
    spreadsheetId, range: "Tray!A:AD",
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "Tray!A1", valueInputOption: "RAW",
    requestBody: { values: trayRows },
  });

  // Apply basic filter + format header on each tab so the Sheet is usable.
  await applyHeadersAndFilters(sheets, spreadsheetId, {
    Pipeline: {
      headerCols: pipelineHeader.length,
      rowCount: pipelineRows.length,
      columnWidths: { 0: 150, 1: 70, 2: 115, 3: 190, 4: 340, 5: 70, 6: 120, 7: 90, 8: 360, 9: 190, 10: 90, 11: 120, 12: 140, 13: 360, 14: 250, 15: 110, 16: 130, 17: 150, 18: 220, 19: 220, 20: 320, 21: 260, 22: 150 },
    },
    Tray: {
      headerCols: TRAY_HEADER.length,
      rowCount: trayRows.length,
      columnWidths: { 0: 150, 1: 70, 2: 190, 3: 340, 4: 70, 5: 90, 6: 360, 7: 190, 8: 90, 9: 120, 10: 140, 11: 360, 12: 320, 13: 220, 14: 220, 15: 260, 18: 110, 19: 220, 20: 130 },
    },
  });

  // Read back the managed ranges. This catches auth/range errors and, most
  // importantly, proves that a shorter refresh did not leave stale rows.
  const [pipelineCheck, trayCheck] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: "Pipeline!A1:AD" }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: "Tray!A1:AD" }),
  ]);
  const actualPipelineRows = pipelineCheck.data.values?.length ?? 0;
  const actualTrayRows = trayCheck.data.values?.length ?? 0;
  if (actualPipelineRows !== pipelineRows.length || actualTrayRows !== trayRows.length) {
    throw new Error(
      `[sheets-sync] verification failed: Pipeline ${actualPipelineRows}/${pipelineRows.length} rows, `
      + `Tray ${actualTrayRows}/${trayRows.length} rows`,
    );
  }

  console.error(
    `[sheets-sync] pushed and verified ${pipelineView.length} visible Pipeline roles from ${all.length} local roles, `
    + `${trayRoles.length} in Tray (Sheet minimum score ${pipelineSheetMinScore})`,
  );
}

/**
 * Bold + freeze the header row and apply a basic filter so the user can
 * sort/filter on any column. Idempotent — re-running just refreshes the filter
 * range to the new row count.
 */
export async function applyHeadersAndFilters(
  sheets: any,
  spreadsheetId: string,
  tabs: Record<string, { headerCols: number; rowCount: number; columnWidths?: Record<number, number> }>,
): Promise<void> {
  const ss = await sheets.spreadsheets.get({ spreadsheetId });
  const tabIdByTitle = new Map<string, number>();
  for (const s of ss.data.sheets ?? []) tabIdByTitle.set(s.properties.title, s.properties.sheetId);

  const requests: any[] = [];
  for (const [title, { headerCols, rowCount, columnWidths }] of Object.entries(tabs)) {
    const sheetId = tabIdByTitle.get(title);
    if (sheetId == null) continue;
    // Bold + freeze header row
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headerCols },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    });
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    });
    // Remove any existing basic filter, then add a fresh one covering current rows
    requests.push({ clearBasicFilter: { sheetId } });
    if (rowCount > 1) {
      requests.push({
        setBasicFilter: {
          filter: {
            range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: headerCols },
          },
        },
      });
    }
    for (const [columnIndexText, pixelSize] of Object.entries(columnWidths ?? {})) {
      const columnIndex = Number(columnIndexText);
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: columnIndex,
            endIndex: columnIndex + 1,
          },
          properties: { pixelSize },
          fields: "pixelSize",
        },
      });
    }
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

async function pull() {
  if (!authReady()) { warnSetup(); return; }
  const sheets = await sheetsClient();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID!;
  const got = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Tray!A1:AD" });
  const values = got.data.values ?? [];
  if (!values.length) {
    await fs.writeFile(APPROVAL_QUEUE_PATH, JSON.stringify([], null, 2));
    return;
  }
  const header = values[0];
  const idIdx = header.indexOf("id");
  const actionIdx = header.indexOf("Action");
  const editsIdx = header.indexOf("Edits");
  if (idIdx === -1 || actionIdx === -1 || editsIdx === -1) {
    console.error(`[sheets-sync] Tray header missing required columns; ignoring pull`);
    return;
  }
  const queue: { id: string; action: string; edits: string }[] = [];
  const clearRanges: string[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const action = (row[actionIdx] ?? "").trim();
    const edits = (row[editsIdx] ?? "").trim();
    if (action || edits) {
      queue.push({ id: row[idIdx], action: action.toLowerCase(), edits });
      // Range row indices are 1-based; header is row 1; data starts at row 2.
      const sheetRow = r + 1;
      clearRanges.push(`Tray!${colLetter(actionIdx + 1)}${sheetRow}:${colLetter(editsIdx + 1)}${sheetRow}`);
    }
  }
  await fs.writeFile(APPROVAL_QUEUE_PATH, JSON.stringify(queue, null, 2));
  if (clearRanges.length) {
    await sheets.spreadsheets.values.batchClear({ spreadsheetId, requestBody: { ranges: clearRanges } });
  }
  console.error(`[sheets-sync] pulled ${queue.length} approvals/edits into ${APPROVAL_QUEUE_PATH}`);
}

function colLetter(col1: number): string {
  let s = ""; let n = col1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function init() {
  if (!authReady()) { warnSetup(); return; }
  const sheets = await sheetsClient();
  await ensureTabs(sheets, process.env.SHEETS_SPREADSHEET_ID!);
  console.error(`[sheets-sync] tabs ready`);
}

async function main() {
  await loadLocalEnv();
  const cmd = process.argv[2] || "push";
  if (cmd === "push") await push();
  else if (cmd === "pull") await pull();
  else if (cmd === "init") await init();
  else { console.error(`Unknown command: ${cmd}`); process.exit(2); }
}

// Guarded so tools/daily-summary.ts can import the auth + tab helpers without
// triggering a push.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
