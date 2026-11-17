/**
 * linkedin-throttle.ts: one daily budget and one minimum gap for every
 * LinkedIn page the harness loads (search pages, advert reads, Easy Apply).
 *
 * LinkedIn flagged the account on 2026-11-18 for "a high volume of LinkedIn
 * profile data" after bulk advert reads. The cap is shared across processes
 * through a small state file, so separate runs, manual commands and the
 * scheduler all draw on the same allowance. Part of the budget is held back
 * for applications, so reading adverts can never use up the day's sends.
 *
 * Env overrides: HARNESS_LINKEDIN_DAILY_LOADS (default 40),
 * HARNESS_LINKEDIN_SEND_RESERVE (10), HARNESS_LINKEDIN_MIN_GAP_MS (30000),
 * HARNESS_LINKEDIN_GAP_SPREAD_MS (30000), LINKEDIN_THROTTLE_PATH.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { repoPath } from "../repo-root.ts";

export type LinkedInLoadKind = "search" | "advert" | "apply";

export class LinkedInBudgetExhausted extends Error {
  constructor(message: string) { super(message); this.name = "LinkedInBudgetExhausted"; }
}

type State = { date: string; loads: number; last_at: number };

export type ThrottleConfig = { dailyLoads: number; sendReserve: number; minGapMs: number; gapSpreadMs: number };

export function throttleConfig(env: NodeJS.ProcessEnv = process.env): ThrottleConfig {
  const n = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    dailyLoads: n(env.HARNESS_LINKEDIN_DAILY_LOADS, 40),
    sendReserve: n(env.HARNESS_LINKEDIN_SEND_RESERVE, 10),
    minGapMs: n(env.HARNESS_LINKEDIN_MIN_GAP_MS, 30_000),
    gapSpreadMs: n(env.HARNESS_LINKEDIN_GAP_SPREAD_MS, 30_000),
  };
}

export function sydneyDate(now = Date.now()): string {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

/** Loads a kind may use today: reading stops short of the send reserve. */
export function allowanceFor(kind: LinkedInLoadKind, config: ThrottleConfig): number {
  return kind === "apply" ? config.dailyLoads : Math.max(0, config.dailyLoads - config.sendReserve);
}

const statePath = () => process.env.LINKEDIN_THROTTLE_PATH ?? repoPath("state/channels/linkedin-throttle.json");

async function readState(today: string): Promise<State> {
  try {
    const s = JSON.parse(await fs.readFile(statePath(), "utf8")) as State;
    return s.date === today ? s : { date: today, loads: 0, last_at: s.last_at ?? 0 };
  } catch { return { date: today, loads: 0, last_at: 0 }; }
}

async function writeState(s: State): Promise<void> {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, statePath());
}

/**
 * Call immediately before every LinkedIn page load. Waits out the minimum gap
 * since the last load by any process, then records the load. Throws
 * LinkedInBudgetExhausted when today's allowance for this kind is spent.
 */
export async function takeLinkedInLoad(
  kind: LinkedInLoadKind,
  opts: { config?: ThrottleConfig; now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<{ loads: number; allowance: number }> {
  const config = opts.config ?? throttleConfig();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let state = await readState(sydneyDate(now()));
  const allowance = allowanceFor(kind, config);
  if (state.loads >= allowance) {
    throw new LinkedInBudgetExhausted(`LinkedIn daily page budget reached (${state.loads}/${allowance} for ${kind}); stopping until tomorrow`);
  }
  const gap = config.minGapMs + Math.floor(random() * config.gapSpreadMs);
  const wait = state.last_at + gap - now();
  if (wait > 0) {
    await sleep(wait);
    state = await readState(sydneyDate(now()));
    if (state.loads >= allowance) {
      throw new LinkedInBudgetExhausted(`LinkedIn daily page budget reached (${state.loads}/${allowance} for ${kind}); stopping until tomorrow`);
    }
  }
  state = { date: sydneyDate(now()), loads: state.loads + 1, last_at: now() };
  await writeState(state);
  return { loads: state.loads, allowance };
}
