/**
 * tools/lib/fs.ts — filesystem helpers shared by the harness tools.
 *
 * Every tool used to carry its own three-line `exists`, `readJson` and
 * `readYaml`. They were identical apart from whitespace, so a fix to one never
 * reached the others. These are the canonical copies.
 *
 * Tolerance contract, because it is the one thing that differs between call
 * sites: the `*IfExists` readers return the fallback when the file is not
 * there (ENOENT) and throw on anything else, including malformed content. A
 * caller that also wants to swallow a parse error appends `.catch(() => null)`
 * at the call site, so that choice stays visible where it is made.
 */

import fs from "node:fs/promises";
import YAML from "yaml";

/** True when the path exists and is readable. Nullish paths are false. */
export async function exists(p: string | null | undefined): Promise<boolean> {
  if (!p) return false;
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse a JSON file. Throws when the file is missing or malformed. */
export async function readJson<T = any>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}

/**
 * Parse a JSON file, returning `fallback` when it does not exist.
 * Malformed JSON still throws; see the tolerance contract above.
 */
export async function readJsonIfExists<T = any>(p: string, fallback: T | null = null): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Parse a YAML file. Throws when the file is missing or malformed. */
export async function readYaml<T = any>(p: string): Promise<T> {
  return YAML.parse(await fs.readFile(p, "utf8")) as T;
}

/**
 * Parse a YAML file, returning `fallback` when it does not exist.
 * Malformed YAML still throws; see the tolerance contract above.
 */
export async function readYamlIfExists<T = any>(p: string, fallback: T | null = null): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  return YAML.parse(text) as T;
}

/**
 * Write via a sibling temp file plus a rename, so a reader never sees a
 * half-written file and a crash mid-write leaves the previous content intact.
 * The temp name carries the pid so two processes cannot collide.
 *
 * The parent directory must already exist; callers that cannot assume that
 * run their own `mkdir` first (the directory policy is theirs, not ours).
 */
export async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

/** `YYYY-MM-DD` for `date` (default: now), in UTC, matching `toISOString()`. */
export function todayStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
