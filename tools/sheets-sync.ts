#!/usr/bin/env tsx
/**
 * sheets-sync.ts, bi-directional sync between local pipeline state and a
 * Google Sheet.
 *
 * Push (default): replaces tab contents for Pipeline and Tray, carrying over
 * only the Tray's `Action` and `Edits` columns (the user-writable surface).
 * The Summary tab is owned by tools/daily-summary.ts, which reuses the
 * exported auth helpers below.
 *
 * Tray: every row the person can act on, not just the well-classified ones.
 * `awaiting_approval` rows come first (approve / reject / hold), then
 * `manual_action_needed` rows (retry / reject / withdraw, user decision
 * 2026-09-17), each block sorted by score descending. An awaiting row without
 * an agent classification is still shown, and counted in
 * `dropped_unclassified` so nobody has to guess why the Tray is short.
 *
 * Pull: reads the Tray's `Action` and `Edits` columns into a queue file
 * (state/pipeline/approval-queue.json), applies the status moves the action
 * implies (`retry` → approved, `reject` → rejected, `withdraw` → withdrawn;
 * `approve` / `hold` are left to the consuming flow), then clears only the
 * cells it processed.
 *
 * Fail closed. Any error reading the Tray aborts before anything is cleared or
 * rewritten; a push aborts on the first API error with exit 1; missing
 * credentials exit 2 rather than looking like a successful no-op to /daily.
 *
 * The Google client is injected (`runPush` / `runPull` take `deps`), so the
 * tests drive a fake that records calls and never reaches the network. The CLI
 * builds the real client.
 *
 * Optional: `sheet.enabled: false` in the profile's submission-policy.yaml
 * switches the mirror off entirely. Every command then exits 0 with
 * `{ command, ok: true, skipped: "sheet.enabled=false" }` without building a
 * Google client or reading a single cell, so a person who approves in the
 * local UI (`npm run ui`) never needs Sheet credentials. A missing `sheet:`
 * block means enabled, so existing profiles keep mirroring.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS (service account JSON path) +
 * SHEETS_SPREADSHEET_ID env var. The service-account email must be added
 * to the Sheet as Editor.
 *
 * Usage:
 *   tsx tools/sheets-sync.ts            # push (default)
 *   tsx tools/sheets-sync.ts pull       # pull Tray.Action + Tray.Edits
 *   tsx tools/sheets-sync.ts init       # create missing tabs
 */

import { promises as fs } from "node:fs";
import { google } from "googleapis";
import { get as getOpportunity, load as loadPipeline, setStatus, type Opportunity, type PipelineStatus } from "./pipeline.ts";
import path from "node:path";
import { readYamlIfExists } from "./lib/fs.ts";
import { repoPath } from "./repo-root.ts";
import { resolveProfileContext } from "./profile-context.ts";

export const TABS = ["Pipeline", "Tray", "Followups", "Contacts", "Market", "Summary"];
const APPROVAL_QUEUE_PATH = repoPath("state/pipeline/approval-queue.json");
const SCORING_WEIGHTS_PATH = repoPath("state/profile/scoring-weights.yaml");
const REASON_MAX = 160;

export const TRAY_HEADER = [
  "id", "channel", "company", "title", "score", "profileRelevance", "fitReason", "domain",
  "isContract", "workArrangement", "resumeId", "resumeReason", "topReasons", "redFlags",
  "endEmployer", "requisitionId", "duplicateGroup", "duplicateOf",
  "coverSnippet", "url", "draftDir", "classificationSource", "Reason", "Action", "Edits", "Status",
  "SubmittedAt", "ConfirmationRef",
];

/** The Tray columns a pull cannot work without. */
const TRAY_REQUIRED_COLUMNS = ["id", "Action", "Edits"];

/** Statuses that earn a Tray row, in the order the blocks appear. */
const TRAY_STATUSES: PipelineStatus[] = ["awaiting_approval", "manual_action_needed"];

/**
 * What a Sheet `Action` means locally. `hold` is consumed downstream (the
 * daily flow owns it) and moves nothing here; the rest are status moves this
 * tool applies, each legal per VALID_TRANSITIONS from the status the row is
 * actually in.
 *
 * `approve` moves `awaiting_approval` to `approved`, and only from there. It
 * used to move nothing at all, so the person pressed Approve in the Sheet or
 * in the local UI, the row stayed where it was, and the next screen showed the
 * same question again. AGENTS.md section 2 is unchanged by the move: an
 * approve authorises preparation, never a send. On an autopilot channel the
 * daily run was going to send the row anyway; on every other channel
 * `approved` is where the row waits for an attended session, and
 * tools/submission-gate.ts refuses any unattended send on it.
 */
const ACTION_STATUS: Record<string, PipelineStatus | null> = {
  approve: "approved",
  hold: null,
  retry: "approved",
  reject: "rejected",
  withdraw: "withdrawn",
  reopen: "discovered",
};

/**
 * The one status an `approve` moves a row out of. An approve on a row that is
 * anywhere else (already approved, sent, parked, blocked) is not a move: the
 * decision it records was made about a package that is no longer waiting, and
 * walking the row from there would be the Tray inventing a transition nobody
 * asked for.
 */
const APPROVE_FROM: PipelineStatus = "awaiting_approval";

/**
 * The two statuses a `reopen` puts back at `discovered`. A reopen is an undo of
 * an exit, not a promotion: the row has to earn `shortlisted` again
 * (docs/pipeline-state-machine.md). From anywhere else there is nothing to
 * undo, and the caller is told so in words rather than handed the transition
 * table's own error.
 */
const REOPEN_FROM: PipelineStatus[] = ["rejected", "withdrawn"];

/** Every action the Tray (and the local UI) accepts, for a caller that validates before acting. */
export const TRAY_ACTIONS: string[] = Object.keys(ACTION_STATUS);

export type TrayActionResult = {
  /** False when the action is unknown, or when the status move was refused. */
  ok: boolean;
  /** The normalised action (trimmed, lower-cased). */
  action: string;
  /** False for an action outside ACTION_STATUS; the caller reports it and leaves the row alone. */
  known: boolean;
  /** True when this action actually moved the row, so a caller can count moves. */
  moved: boolean;
  /** True when the move was refused: the state machine's no, or this table's.
   * A caller turns it into a 409 rather than a 500, because nothing broke. */
  refused?: boolean;
  /** The row's status after the action, or null when the row could not be read. */
  status_after: PipelineStatus | null;
  /** Why the move was refused, in the Sheet pull's wording. */
  error?: string;
};

/**
 * Apply one Tray action to one row. This is the whole meaning of an `Action`
 * cell in one place: `hold` moves nothing here (the consuming flow owns it),
 * the rest are status moves, each legal per VALID_TRANSITIONS from the status
 * the row is actually in, and `approve` only from `awaiting_approval`.
 *
 * Both the Sheet pull and the local web UI go through it, so a decision made
 * on the phone and the same decision made in the browser cannot diverge.
 * Neither sends anything: a decision only ever prepares.
 *
 * `opts.reason` is the caller's own words for what happened ("approved in the
 * local UI", "approved in the Sheet Tray"), because the history is read by a
 * person who wants to know which surface they were holding at the time.
 */
export async function applyTrayAction(
  id: string,
  rawAction: string,
  opts: { actor?: string; reason?: string } = {},
): Promise<TrayActionResult> {
  const action = String(rawAction ?? "").trim().toLowerCase();
  if (action && !(action in ACTION_STATUS)) return { ok: false, action, known: false, moved: false, status_after: null };

  const nextStatus = action ? ACTION_STATUS[action] : null;
  const current = await getOpportunity(id).catch(() => null);
  // hold / edits-only, and an approve on a row that is no longer waiting on
  // one: nothing moves, report where the row stands.
  if (!nextStatus || (action === "approve" && current?.status !== APPROVE_FROM)) {
    return { ok: true, action, known: true, moved: false, status_after: current?.status ?? null };
  }
  // A reopen from anywhere but an exit is refused in the person's own words.
  if (action === "reopen" && current && !REOPEN_FROM.includes(current.status)) {
    return {
      ok: false, action, known: true, moved: false, refused: true, status_after: current.status,
      error: `only a closed row can be reopened: this one is ${current.status}, and a reopen puts a rejected or withdrawn row back at discovered`,
    };
  }
  try {
    const row = await setStatus(id, nextStatus, opts.reason ?? `sheet: ${action}`, { actor: opts.actor ?? "sheets-sync:pull" });
    return { ok: true, action, known: true, moved: true, status_after: row.status };
  } catch (error: any) {
    const message = String(error?.message ?? error);
    return {
      ok: false, action, known: true, moved: false, status_after: null,
      refused: /invalid transition/.test(message),
      error: `${action} → ${nextStatus} failed: ${message}`,
    };
  }
}

/** The slice of the googleapis sheets client this tool actually uses. */
export type SheetsApi = {
  spreadsheets: {
    get(params: { spreadsheetId: string }): Promise<{ data: { sheets?: any[] } }>;
    batchUpdate(params: { spreadsheetId: string; requestBody: any }): Promise<unknown>;
    values: {
      get(params: { spreadsheetId: string; range: string }): Promise<{ data: { values?: any[][] } }>;
      update(params: { spreadsheetId: string; range: string; valueInputOption: string; requestBody: any }): Promise<unknown>;
      clear(params: { spreadsheetId: string; range: string }): Promise<unknown>;
      batchClear(params: { spreadsheetId: string; requestBody: { ranges: string[] } }): Promise<unknown>;
    };
  };
};

export type SyncDeps = {
  sheets: SheetsApi;
  spreadsheetId: string;
  /** Overridable so a test never writes into state/. */
  queuePath?: string;
  /**
   * Overrides the `sheet.enabled` lookup. Left unset by the CLI, which reads
   * the profile; a test that is exercising the mirror itself pins it so the
   * result never depends on whether this machine's profile still mirrors.
   */
  enabled?: boolean;
};

export type SyncReport = {
  command: "push" | "pull";
  ok: boolean;
  /** Present only when the Sheet is switched off: nothing was read or written. */
  skipped?: string;
  pipeline_rows?: number;
  tray_rows?: number;
  manual_rows?: number;
  dropped_unclassified?: number;
  actions_applied?: number;
  queued?: number;
  unknown_actions?: { id: string; action: string }[];
  errors?: string[];
};

/** The reason every command prints when the mirror is switched off. */
export const SHEET_DISABLED = "sheet.enabled=false";

/**
 * Is the Google Sheet mirror switched on for this profile?
 *
 * `sheet.enabled: false` in submission-policy.yaml retires the Sheet in favour
 * of the local UI. A missing block, a missing file or an unreadable one all
 * mean enabled: the Sheet is the older surface, so the flag only ever turns it
 * off deliberately, never by accident.
 */
export async function sheetEnabled(profileId?: string | null): Promise<boolean> {
  const policyPath = path.join(resolveProfileContext(profileId).profileDir, "submission-policy.yaml");
  const policy = await readYamlIfExists<any>(policyPath, {}).catch(() => ({}));
  return policy?.sheet?.enabled !== false;
}

/** The report every command returns when the mirror is switched off. */
function skippedReport(command: "push" | "pull"): SyncReport {
  return { command, ok: true, skipped: SHEET_DISABLED };
}

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

/** The one-line reason auth is not usable, or null when it is. */
export function authBlocker(): string | null {
  const missing = ["GOOGLE_APPLICATION_CREDENTIALS", "SHEETS_SPREADSHEET_ID"].filter((k) => !process.env[k]);
  return missing.length ? `Google Sheets not configured: ${missing.join(" and ")} unset (see npm run sheets:sync init)` : null;
}

export function warnSetup(): void {
  console.error(`
[sheets-sync] Google Sheets not configured.
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

/** True when an agent (not regex triage, not nothing) classified the row. */
export function isAgentClassified(r: Opportunity): boolean {
  return (r.classificationSource ?? r.classification?._classifier) === "agent";
}

/**
 * Why this row needs the person: the most recent history reason, else the
 * note the tool left when it parked the row. Truncated so the Tray stays
 * readable.
 */
export function reasonFor(r: Opportunity): string {
  const fromHistory = [...(r.history ?? [])].reverse().find((h) => (h.reason ?? "").trim())?.reason ?? "";
  const text = (fromHistory || r.notes || r.parkedReason || "").replace(/\s+/g, " ").trim();
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

/**
 * The Tray, in the order the person reads it: everything they can act on now
 * (`awaiting_approval`) above everything the harness could not finish
 * (`manual_action_needed`), each block by score descending.
 */
export function trayRoles(all: Opportunity[]): Opportunity[] {
  const rank = new Map(TRAY_STATUSES.map((s, i) => [s, i] as const));
  return all
    .filter((r) => rank.has(r.status))
    .sort((a, b) =>
      (rank.get(a.status)! - rank.get(b.status)!)
      || (b.score ?? -1) - (a.score ?? -1)
      || a.company.localeCompare(b.company)
      || a.title.localeCompare(b.title),
    );
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
    r.score != null ? r.score : "",         // number, not string, so Sheets can sort
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
    reasonFor(r),
    "", "", r.status, r.submittedAt ?? "", "",
  ];
}

/**
 * Read the Tray as a header plus rows, failing closed.
 *
 * A tab with no values at all is only acceptable on a push (a freshly
 * initialised Sheet); anywhere else an empty read is indistinguishable from a
 * failed read, and a header missing the columns we write is a broken Tray, not
 * an empty one. Both are errors so nothing downstream clears the person's work.
 */
export async function readTray(
  deps: SyncDeps,
  opts: { allowEmpty?: boolean } = {},
): Promise<{ header: string[]; rows: any[][] }> {
  let got: { data: { values?: any[][] } };
  try {
    got = await deps.sheets.spreadsheets.values.get({ spreadsheetId: deps.spreadsheetId, range: "Tray!A1:AD" });
  } catch (error: any) {
    throw new Error(`Tray read failed: ${error?.message ?? error}`);
  }
  const values = got.data.values ?? [];
  if (!values.length) {
    if (opts.allowEmpty) return { header: [], rows: [] };
    throw new Error("Tray read returned no rows at all (expected at least the header row); refusing to act on it");
  }
  const header = (values[0] ?? []).map((v) => String(v));
  const missing = TRAY_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`Tray header is missing ${missing.join(", ")} (read ${header.length} columns); refusing to act on it`);
  }
  return { header, rows: values.slice(1) };
}

export async function runPush(deps: SyncDeps): Promise<SyncReport> {
  // Defence in depth: the CLI checks first, but nothing that reaches here with
  // the Sheet switched off may touch a cell.
  if (!(deps.enabled ?? await sheetEnabled())) return skippedReport("push");
  const { sheets, spreadsheetId } = deps;
  await ensureTabs(sheets, spreadsheetId);

  const all = await loadPipeline();
  const scoringWeights = (await readYamlIfExists<any>(SCORING_WEIGHTS_PATH, {})) ?? {};
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

  // Pipeline tab, everything. Score is a number (so the user can sort/filter).
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

  // Read the Tray BEFORE clearing anything: the person's Action/Edits live
  // there and a failed read must abort the whole push, never fall through to
  // the clear + rewrite below with an empty carry-over map.
  const { header: existingHeader, rows: existingRows } = await readTray(deps, { allowEmpty: true });
  const existingById = new Map<string, any[]>();
  if (existingHeader.length) {
    const idIdx = existingHeader.indexOf("id");
    for (const row of existingRows) existingById.set(String(row[idIdx]), row);
  }

  // A values.update only overwrites the addressed cells. If the refreshed
  // pipeline is shorter than the previous one, stale rows otherwise remain
  // visible below the new data. Clear the managed range before replacing it.
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Pipeline!A:AD" });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "Pipeline!A1", valueInputOption: "RAW",
    requestBody: { values: pipelineRows },
  });

  // Tray tab, awaiting_approval (the person qualifies here) plus
  // manual_action_needed (the person unblocks here).
  const tray = trayRoles(all);
  const manualCount = tray.filter((r) => r.status === "manual_action_needed").length;
  const droppedUnclassified = tray.filter((r) => r.status === "awaiting_approval" && !isAgentClassified(r)).length;
  const trayRows: (string | number)[][] = [TRAY_HEADER, ...tray.map((r) => {
    const row = rowFor(r);
    const prev = existingById.get(r.id);
    if (prev) {
      const oldActionIdx = existingHeader.indexOf("Action");
      const oldEditsIdx = existingHeader.indexOf("Edits");
      if (oldActionIdx >= 0) row[TRAY_HEADER.indexOf("Action")] = (prev[oldActionIdx] as string | undefined) ?? "";
      if (oldEditsIdx >= 0) row[TRAY_HEADER.indexOf("Edits")] = (prev[oldEditsIdx] as string | undefined) ?? "";
    }
    return row;
  })];
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Tray!A:AD" });
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
      columnWidths: { 0: 150, 1: 70, 2: 190, 3: 340, 4: 70, 5: 90, 6: 360, 7: 190, 8: 90, 9: 120, 10: 140, 11: 360, 12: 320, 13: 220, 14: 220, 15: 260, 18: 110, 19: 220, 20: 130, 22: 320 },
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
      `verification failed: Pipeline ${actualPipelineRows}/${pipelineRows.length} rows, `
      + `Tray ${actualTrayRows}/${trayRows.length} rows`,
    );
  }

  console.error(
    `[sheets-sync] pushed and verified ${pipelineView.length} visible Pipeline roles from ${all.length} local roles, `
    + `${tray.length} in Tray (${manualCount} manual, ${droppedUnclassified} awaiting without agent classification, `
    + `Sheet minimum score ${pipelineSheetMinScore})`,
  );

  return {
    command: "push",
    ok: true,
    pipeline_rows: pipelineView.length,
    tray_rows: tray.length,
    manual_rows: manualCount,
    dropped_unclassified: droppedUnclassified,
    actions_applied: 0,
  };
}

/**
 * Bold + freeze the header row and apply a basic filter so the user can
 * sort/filter on any column. Idempotent, re-running just refreshes the filter
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

export async function runPull(deps: SyncDeps): Promise<SyncReport> {
  if (!(deps.enabled ?? await sheetEnabled())) return skippedReport("pull");
  const { sheets, spreadsheetId } = deps;
  const queuePath = deps.queuePath ?? APPROVAL_QUEUE_PATH;

  // Fail closed: a read error throws out of here, before any clear.
  const { header, rows } = await readTray(deps);
  const idIdx = header.indexOf("id");
  const actionIdx = header.indexOf("Action");
  const editsIdx = header.indexOf("Edits");
  const statusIdx = header.indexOf("Status");
  const sourceIdx = header.indexOf("classificationSource");

  const queue: { id: string; action: string; edits: string }[] = [];
  const clearRanges: string[] = [];
  const unknownActions: { id: string; action: string }[] = [];
  const errors: string[] = [];
  let manualRows = 0;
  let droppedUnclassified = 0;
  let actionsApplied = 0;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const id = String(row[idIdx] ?? "").trim();
    if (!id) continue;
    const status = statusIdx >= 0 ? String(row[statusIdx] ?? "").trim() : "";
    if (status === "manual_action_needed") manualRows++;
    if (status === "awaiting_approval" && sourceIdx >= 0 && String(row[sourceIdx] ?? "").trim() !== "agent") {
      droppedUnclassified++;
    }

    const action = String(row[actionIdx] ?? "").trim().toLowerCase();
    const edits = String(row[editsIdx] ?? "").trim();
    if (!action && !edits) continue;

    const applied = await applyTrayAction(id, action, {
      actor: "sheets-sync:pull",
      ...(action === "approve" ? { reason: "approved in the Sheet Tray" } : {}),
    });
    if (!applied.known) {
      // Reported, row left alone: the cells stay so the person can correct it.
      unknownActions.push({ id, action });
      continue;
    }
    if (!applied.ok) {
      // Leave the cells intact so the person sees the action did not land.
      errors.push(`${id}: ${applied.error}`);
      continue;
    }
    if (applied.moved) actionsApplied++;

    queue.push({ id, action, edits });
    // Range row indices are 1-based; header is row 1; data starts at row 2.
    const sheetRow = r + 2;
    clearRanges.push(`Tray!${colLetter(actionIdx + 1)}${sheetRow}:${colLetter(editsIdx + 1)}${sheetRow}`);
  }

  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2));
  if (clearRanges.length) {
    await sheets.spreadsheets.values.batchClear({ spreadsheetId, requestBody: { ranges: clearRanges } });
  }

  console.error(
    `[sheets-sync] pulled ${queue.length} approvals/edits into ${queuePath}; `
    + `${actionsApplied} status move(s) applied, ${unknownActions.length} unknown action(s), ${errors.length} error(s)`,
  );

  return {
    command: "pull",
    ok: errors.length === 0,
    pipeline_rows: 0,
    tray_rows: rows.length,
    manual_rows: manualRows,
    dropped_unclassified: droppedUnclassified,
    actions_applied: actionsApplied,
    queued: queue.length,
    unknown_actions: unknownActions,
    errors,
  };
}

function colLetter(col1: number): string {
  let s = ""; let n = col1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function realDeps(): Promise<SyncDeps> {
  return { sheets: await sheetsClient() as unknown as SheetsApi, spreadsheetId: process.env.SHEETS_SPREADSHEET_ID! };
}

async function main() {
  await loadLocalEnv();
  const cmd = process.argv[2] || "push";
  if (!["push", "pull", "init"].includes(cmd)) {
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
  }
  if (!(await sheetEnabled())) {
    // Exit 0: switched off is a choice, and /daily must read it as "nothing to do".
    console.log(JSON.stringify(skippedReport(cmd === "pull" ? "pull" : "push")));
    return;
  }
  const blocker = authBlocker();
  if (blocker) {
    // Exit 2, not 0: a silent no-op reads as success to /daily.
    console.error(`[sheets-sync] ${blocker}`);
    process.exit(2);
  }
  const deps = await realDeps();
  let report: SyncReport;
  if (cmd === "pull") {
    report = await runPull(deps);
  } else if (cmd === "init") {
    await ensureTabs(deps.sheets, deps.spreadsheetId);
    report = { command: "push", ok: true, pipeline_rows: 0, tray_rows: 0, manual_rows: 0, dropped_unclassified: 0, actions_applied: 0 };
  } else {
    report = await runPush(deps);
  }
  console.log(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}

// Guarded so tools/daily-summary.ts can import the auth + tab helpers without
// triggering a push.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[sheets-sync] ${e?.message ?? e}`);
    process.exit(1);
  });
}
