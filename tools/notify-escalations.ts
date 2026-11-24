#!/usr/bin/env tsx
/**
 * notify-escalations.ts — push the run's escalations to the person's phone.
 *
 * After a scheduled run the escalations sit in state/journal/summary/<date>.md,
 * which nobody reads unless they sit down at the Mac. This tool builds the same
 * escalation list (daily-summary's buildSummary), rewrites each one as a short
 * bullet grouped by what the person has to do, and posts it to a Slack incoming
 * webhook with a link to the local UI.
 *
 * With HARNESS_STORE=twenty the escalations live in Twenty instead
 * (tools/twenty/escalations.ts) and tools/twenty/deliver.ts posts them, once
 * each. This tool stays for the SQLite store and as the fallback when Twenty
 * cannot be reached (scripts/daily.sh calls it then).
 *
 * When it sends (scheduled runs fire several times a day):
 *   - the first notification of a local day lists every open escalation;
 *   - later runs that day send only when a new escalation appears, list the new
 *     ones, and count the rest as still waiting;
 *   - a failed run (--exit N, N != 0) always sends, with the failure on top.
 * Escalations that clear are dropped from the ledger, so one that comes back is
 * new again. The ledger is state/journal/notify/slack.json.
 *
 * Env (read from the process, then .env.local, then .env):
 *   SLACK_WEBHOOK_URL   incoming webhook url. Unset: skipped, exit 0.
 *   HARNESS_UI_URL      base url the links open, e.g. the Tailscale serve url.
 *                       Default http://localhost:7788.
 *
 * Usage:
 *   tsx tools/notify-escalations.ts [--date YYYY-MM-DD] [--exit N] [--dry-run] [--force]
 *
 * --dry-run prints the message and changes nothing. --force sends the full list
 * whatever the ledger says. Prints one JSON object. A failed POST exits 1 and
 * leaves the ledger untouched, so the next run retries; the run that called it
 * has already done its work, so daily.sh tolerates the exit.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Escalation } from "./daily-summary.ts";
import { loadLocalEnv } from "./jev/env.ts";
import { loadLocale } from "./profile.ts";
import { journalPath } from "./store/paths.ts";

const DEFAULT_UI_URL = "http://localhost:7788";

export type Ledger = { date: string; keys: string[] };

export function escalationKey(e: Escalation): string {
  return `${e.kind}:${e.id ?? e.reason}`;
}

type Group = { heading: string; kinds: Escalation["kind"][] };

export const GROUPS: Group[] = [
  { heading: "Blocking the harness", kinds: ["kill_switch", "cap", "channel", "gate", "submission_pending"] },
  { heading: "Answer a screening question", kinds: ["screening"] },
  { heading: "Approve, hold or reject", kinds: ["awaiting_approval"] },
  { heading: "Apply yourself", kinds: ["manual"] },
];

/** Slack mrkdwn treats &, < and > as control characters. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cut at a word boundary, with an ellipsis, so a bullet stays short on a phone. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`;
}

/**
 * What the person has to do, in a few words. The summary's reasons are written
 * for the journal (run tags, full sentences, file paths); a phone needs less.
 */
export function shortReason(e: Escalation): string {
  const reason = e.reason
    .replace(/^\s*\[[^\]]*\]\s*/, "") // "[daily 2026-11-17] " run tags
    .replace(/\.{3,}$/, "")           // the summary's own truncation
    .trim();
  const question = reason.match(/screening question:\s*"([^"]+)"/i);
  if (question) return `"${clip(question[1].replace(/\.{3,}$/, ""), 90)}"`;
  const ats = reason.match(/External ATS redirect to (\S+)/i);
  if (ats) return `apply on ${ats[1]}`;
  if (e.kind === "awaiting_approval") return "package ready";
  if (e.kind === "submission_pending") return "stuck mid-submission";
  const channel = reason.match(/channel '([^']+)' is not on autopilot/i);
  if (channel) {
    const names: Record<string, string> = { linkedin: "LinkedIn", seek: "SEEK" };
    const raw = channel[1].replace(/_jobs$/, "");
    return `${names[raw] ?? raw} is not on autopilot`;
  }
  // Row notes run on for sentences; the first clause says what it is.
  if (e.id) return clip(reason.split(/(?<=[a-z0-9)])[.;]\s/i)[0].replace(/\.$/, ""), 70);
  return clip(reason, 90);
}

function bullet(e: Escalation, uiUrl: string): string {
  const reason = slackEscape(shortReason(e));
  if (!e.title) return `• ${reason}`;
  const label = slackEscape(`${clip(e.title, 60)} at ${e.company ?? "?"}`);
  // No row link without the local UI (on the Twenty store the records carry their own links).
  const who = e.id && uiUrl ? `<${uiUrl}/#/row/${encodeURIComponent(e.id)}|${label}>` : label;
  return `• ${who}: ${reason}`;
}

/**
 * Bullets under a heading per group of kinds, in GROUPS order. Each group
 * starts with a blank line. Shared with the Twenty delivery (tools/twenty/deliver.ts).
 */
export function groupLines<T>(items: T[], kindOf: (t: T) => string, line: (t: T) => string): string[] {
  const L: string[] = [];
  for (const g of GROUPS) {
    const inGroup = items.filter((t) => (g.kinds as string[]).includes(kindOf(t)));
    if (!inGroup.length) continue;
    L.push("", `*${g.heading}*`);
    for (const t of inGroup) L.push(line(t));
  }
  // A kind added to Escalation later still reaches the person.
  const grouped = new Set<string>(GROUPS.flatMap((g) => g.kinds));
  const other = items.filter((t) => !grouped.has(kindOf(t)));
  if (other.length) {
    L.push("", "*Other*");
    for (const t of other) L.push(line(t));
  }
  return L;
}

export type Message = { text: string; newKeys: string[]; keys: string[] };

/**
 * Decide what to send. Returns null when there is nothing new and the run did
 * not fail. `keys` is the ledger to write after a successful POST: every open
 * escalation, so cleared ones fall out.
 */
export function compose(opts: {
  date: string;
  escalations: Escalation[];
  ledger: Ledger | null;
  exitCode: number;
  uiUrl: string;
  /** Where "Open today" goes; defaults to the local UI's Today page. */
  todayUrl?: string;
  timeLabel: string;
  force?: boolean;
}): Message | null {
  const { date, escalations, exitCode, uiUrl, timeLabel } = opts;
  const keys = escalations.map(escalationKey);
  const known = !opts.force && opts.ledger?.date === date ? new Set(opts.ledger.keys) : new Set<string>();
  const fresh = escalations.filter((e) => !known.has(escalationKey(e)));
  const waiting = escalations.length - fresh.length;
  const failed = exitCode !== 0;
  if (!fresh.length && !failed) return null;

  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const L: string[] = [];
  if (known.size === 0) L.push(`*Job hunt, ${timeLabel}: ${escalations.length ? `${count(escalations.length, "item")} need you` : "nothing needs you"}*`);
  else L.push(`*Job hunt, ${timeLabel}: ${fresh.length ? `${count(fresh.length, "new item")} need you` : "run failed"}*`);
  if (failed) L.push("", `:warning: The run failed (exit ${exitCode}). Sent totals are unverified until you check the pipeline; never retry an uncertain send.`);

  L.push(...groupLines(fresh, (e) => e.kind, (e) => bullet(e, opts.todayUrl ? "" : uiUrl)));

  if (waiting) L.push("", `Plus ${waiting} still waiting from earlier today.`);
  L.push("", `<${opts.todayUrl ?? `${uiUrl}/#/today`}|Open today in the harness>`);
  return { text: L.join("\n"), newKeys: fresh.map(escalationKey), keys };
}

/** POST one message to a Slack incoming webhook. Throws on a non-2xx reply. */
export async function postSlack(webhook: string, text: string): Promise<void> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
}

function parseArgs(argv: string[]) {
  const out = { date: "", exit: 0, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i] ?? "";
    else if (a === "--exit") out.exit = Number(argv[++i] ?? "0");
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error(`bad --date: ${out.date}`);
  if (!Number.isInteger(out.exit)) throw new Error("bad --exit");
  return out;
}

function ledgerPath(): string {
  return journalPath("notify", "slack.json");
}

async function readLedger(): Promise<Ledger | null> {
  try {
    const v = JSON.parse(await fs.readFile(ledgerPath(), "utf8"));
    return typeof v?.date === "string" && Array.isArray(v?.keys) ? v : null;
  } catch { return null; }
}

async function writeLedger(l: Ledger): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath()), { recursive: true });
  await fs.writeFile(ledgerPath(), JSON.stringify(l, null, 2) + "\n");
}

/** On the Twenty store the link goes to the workspace (the local UI is retired). */
async function storeUrl(): Promise<string | null> {
  if ((process.env.HARNESS_STORE ?? "").toLowerCase() !== "twenty") return null;
  try {
    const { twentyConfig } = await import("./store/twenty-backend.ts");
    return (await twentyConfig()).url;
  } catch { return null; }
}

async function main(): Promise<number> {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e: any) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    return 2;
  }
  await loadLocalEnv();
  // This is the fallback alert for when the store can't be read, so nothing
  // here may depend on it: without the profile it uses the machine's time
  // zone, and without the summary it reports the failed run with no list.
  const timezone = await loadLocale().then((l) => l.timezone).catch(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const now = new Date();
  const date = args.date || new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const timeLabel = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(now);
  // On the Twenty store the local UI is retired: the link opens the
  // workspace, whose Home is Today.
  const workspace = await storeUrl();
  const uiUrl = (workspace || process.env.HARNESS_UI_URL || DEFAULT_UI_URL).replace(/\/+$/, "");
  const todayUrl = workspace ? `${uiUrl}/` : undefined;
  const webhook = process.env.SLACK_WEBHOOK_URL || "";

  let summary: { escalations: Escalation[] };
  try {
    // Loaded here: the summary's imports read the profile, which on the
    // Twenty store fails when the workspace is down.
    const { buildSummary } = await import("./daily-summary.ts");
    summary = await buildSummary(date);
  } catch (e: any) {
    if (!args.exit) throw e;
    summary = { escalations: [] };
    console.error(`notify-escalations: summary unavailable (${e?.message ?? e}); alerting the failed run only`);
  }
  const ledger = await readLedger();
  const msg = compose({ date, escalations: summary.escalations, ledger, exitCode: args.exit, uiUrl, todayUrl, timeLabel, force: args.force });
  const base = { date, escalations: summary.escalations.length };

  if (!msg) {
    // Prune cleared escalations, so one that comes back later counts as new.
    if (!args.dryRun && ledger?.date === date) {
      const open = new Set(summary.escalations.map(escalationKey));
      await writeLedger({ date, keys: ledger.keys.filter((k) => open.has(k)) });
    }
    console.log(JSON.stringify({ ok: true, sent: false, reason: "nothing new", ...base }));
    return 0;
  }
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, sent: false, dryRun: true, ...base, new: msg.newKeys.length, text: msg.text }));
    return 0;
  }
  if (!webhook) {
    console.log(JSON.stringify({ ok: true, sent: false, skipped: "SLACK_WEBHOOK_URL not set", ...base }));
    return 0;
  }
  try {
    await postSlack(webhook, msg.text);
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, sent: false, error: `Slack POST failed: ${e?.message ?? e}`, ...base }));
    return 1;
  }
  await writeLedger({ date, keys: msg.keys });
  console.log(JSON.stringify({ ok: true, sent: true, ...base, new: msg.newKeys.length }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  });
}
