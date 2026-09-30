/**
 * Deterministic opportunity expiry.
 *
 * A role leaves the working pipeline only when the advert states a closing
 * date that has passed, or a channel explicitly reports the advert expired.
 * Posted age is deliberately not used: an old advert may still be open.
 */

import { get, load, patch, setStatus, writeDigest, type Opportunity, type PipelineStatus } from "./pipeline.ts";
import { loadLocale } from "./profile.ts";

export type ClosingDateEvidence = {
  date: string;
  matchedText: string;
  source: "description";
};

export type ExpiryResult = {
  id: string;
  from: PipelineStatus;
  to: PipelineStatus | null;
  expired: boolean;
  closing_date: string | null;
  source: "description" | "channel";
  reason: string;
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const EXPLICIT_CLOSING = /(?:applications?\s+(?:will\s+)?(?:close|closing)|applications?\s+closing\s+date|application\s+closing(?:\s+date)?|job\s+closing\s+date|closing\s+date|the\s+role\s+closes|role\s+closes|closes\s+on|apply\s+by)\s*[:\-]?\s*([^\n.;]{0,120})/gi;

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function zonedDay(value: Date, timeZone: string): string {
  return value.toLocaleDateString("en-CA", { timeZone });
}

function referenceDay(postedAt: string | undefined, now: Date, timeZone: string): string {
  if (postedAt) {
    const posted = new Date(postedAt);
    if (!Number.isNaN(posted.getTime())) return zonedDay(posted, timeZone);
  }
  return zonedDay(now, timeZone);
}

function parseDate(fragment: string, refDay: string): string | null {
  const iso = fragment.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = fragment.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(20\d{2})\b/);
  if (numeric) return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));

  const named = fragment.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*,?\s*(20\d{2}))?\b/i);
  if (!named) return null;
  const month = MONTHS[named[2].toLowerCase()];
  if (!month) return null;
  const [refYear, refMonth, refDate] = refDay.split("-").map(Number);
  let year = named[3] ? Number(named[3]) : refYear;
  let date = isoDate(year, month, Number(named[1]));
  if (!date) return null;

  // A yearless January deadline in a late-year advert belongs to the next
  // year. We only roll forward when the candidate is over 120 days before the
  // advert/reference day, so an already-passed recent deadline stays passed.
  if (!named[3]) {
    const refMs = Date.UTC(refYear, refMonth - 1, refDate);
    const candidateMs = Date.UTC(year, month - 1, Number(named[1]));
    if ((refMs - candidateMs) / 86_400_000 > 120) {
      year += 1;
      date = isoDate(year, month, Number(named[1]));
    }
  }
  return date;
}

export function extractClosingDate(
  description: string | undefined,
  opts: { postedAt?: string; now?: Date; timeZone?: string } = {},
): ClosingDateEvidence | null {
  if (!description) return null;
  const timeZone = opts.timeZone ?? "Australia/Sydney";
  const refDay = referenceDay(opts.postedAt, opts.now ?? new Date(), timeZone);
  EXPLICIT_CLOSING.lastIndex = 0;
  const candidates: ClosingDateEvidence[] = [];
  for (const match of description.matchAll(EXPLICIT_CLOSING)) {
    const fragment = match[1] ?? "";
    const date = parseDate(fragment, refDay);
    if (date) candidates.push({ date, matchedText: match[0].trim().slice(0, 160), source: "description" });
  }
  // Adverts often append an extension while retaining the original deadline.
  // Prefer the latest explicit date so an old sentence cannot close a role
  // that the same current advert says remains open.
  return candidates.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

export const EXPIRABLE_STATUSES = new Set<PipelineStatus>([
  "discovered", "awaiting_external", "shortlisted", "parked", "drafted",
  "awaiting_approval", "approved", "manual_action_needed",
]);

function closedStatus(from: PipelineStatus): PipelineStatus {
  return from === "approved" ? "withdrawn" : "rejected";
}

export async function closeOpportunityAsExpired(
  id: string,
  signal: { source: "description" | "channel"; closingDate?: string; channelName?: string },
  opts: { apply?: boolean } = {},
): Promise<ExpiryResult | null> {
  let row = await get(id);
  if (!row || row.channelExpiredAt) return null;
  if (row.status === "rejected" && row.userSaved && signal.source === "channel") {
    if (!opts.apply) return { id, from: row.status, to: "rejected", expired: true, closing_date: null, source: signal.source, reason: `opening expired on ${signal.channelName ?? row.channel}` };
    // Saved rows may have been rejected by classification; channel evidence
    // supersedes that reason and needs a normal audited close transition.
    row = await setStatus(id, "discovered", "saved advert reopened for channel expiry", { actor: "pipeline.expiry" });
  }
  if (!EXPIRABLE_STATUSES.has(row.status)) return null;
  const to = closedStatus(row.status);
  const reason = signal.source === "channel"
    ? `opening expired on ${signal.channelName ?? row.channel}`
    : `opening closed after stated closing date ${signal.closingDate}`;
  if (opts.apply) {
    if (signal.closingDate && row.closingDate !== signal.closingDate) {
      await patch(id, { closingDate: signal.closingDate, closingDateSource: signal.source }, "pipeline.expiry", "explicit advert deadline");
    }
    await setStatus(id, to, reason, { actor: "pipeline.expiry", details: { expiry_source: signal.source, closing_date: signal.closingDate ?? null } });
    if (signal.source === "channel") await patch(id, { channelExpiredAt: new Date().toISOString() }, "pipeline.expiry", reason);
  }
  return { id, from: row.status, to, expired: true, closing_date: signal.closingDate ?? null, source: signal.source, reason };
}

export async function reconcileExpiredOpportunities(opts: {
  apply?: boolean;
  now?: Date;
  timeZone?: string;
  rows?: Opportunity[];
} = {}): Promise<{ ok: true; apply: boolean; today: string; scanned: number; dated: number; expired: number; untouched_later_stage: number; results: ExpiryResult[] }> {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? (await loadLocale()).timezone;
  const today = zonedDay(now, timeZone);
  const rows = opts.rows ?? await load();
  const results: ExpiryResult[] = [];
  let dated = 0;
  let untouchedLaterStage = 0;

  for (const row of rows) {
    const currentDescriptionEvidence = extractClosingDate(row.description, { postedAt: row.postedAt, now, timeZone });
    const evidence = row.closingDateSource === "channel"
      ? { date: row.closingDate!, source: "channel" as const }
      : currentDescriptionEvidence ?? (row.closingDate
        ? { date: row.closingDate, source: "description" as const }
        : null);
    if (!evidence) continue;
    dated += 1;
    if (!EXPIRABLE_STATUSES.has(row.status)) {
      if (["submitted", "responded", "interview", "offered", "won"].includes(row.status)) untouchedLaterStage += 1;
      continue;
    }
    if (evidence.date >= today) {
      if (opts.apply && row.closingDate !== evidence.date) {
        await patch(row.id, { closingDate: evidence.date, closingDateSource: evidence.source }, "pipeline.expiry", "explicit advert deadline");
      }
      continue;
    }
    const result = await closeOpportunityAsExpired(row.id, { source: evidence.source, closingDate: evidence.date }, { apply: opts.apply });
    if (result) results.push(result);
  }
  if (opts.apply && results.length) await writeDigest();
  return { ok: true, apply: opts.apply === true, today, scanned: rows.length, dated, expired: results.length, untouched_later_stage: untouchedLaterStage, results };
}
