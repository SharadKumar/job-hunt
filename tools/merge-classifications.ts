#!/usr/bin/env tsx
/** Merge one or more classification maps into the canonical map atomically. */

import { writeAtomic } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Classification } from "./classify-jd.ts";
import { repoPath } from "./repo-root.ts";

function parseArgs(): { target: string; sources: string[] } {
  const argv = process.argv.slice(2);
  let target = repoPath("state/pipeline/classifications.json");
  const sources: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--target") {
      if (!argv[index + 1]) throw new Error("--target requires a path");
      target = argv[++index];
    } else if (!argv[index].startsWith("--")) {
      sources.push(argv[index]);
    }
  }
  if (!sources.length) throw new Error("Usage: classifications:merge -- [--target path] source-a.json source-b.json");
  return { target, sources };
}

async function readMap(file: string): Promise<Record<string, Classification>> {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${file} is not a classification map`);
  for (const [id, value] of Object.entries(parsed)) {
    if (!(value as Classification)?._classifier) throw new Error(`${file}: ${id} has no _classifier`);
  }
  return parsed;
}

/**
 * The canonical map is the whole prior history of classification. A missing
 * file is a legitimate first run; anything else (malformed JSON, a map with a
 * row that has no `_classifier`, a permissions error) means we cannot see what
 * is already there, and merging onto `{}` would silently delete all of it.
 */
async function readCanonical(target: string): Promise<{ map: Record<string, Classification>; existed: boolean }> {
  try {
    return { map: await readMap(target), existed: true };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { map: {}, existed: false };
    throw new Error(
      `refusing to merge: canonical classification map ${target} exists but could not be read (${error?.message ?? error}). ` +
        "Repair it or move it aside; merging onto an empty map would drop every prior classification.",
    );
  }
}

async function main(): Promise<void> {
  const { target, sources } = parseArgs();
  const { map: canonical, existed } = await readCanonical(target);
  const replaced = new Set<string>();
  for (const source of sources) {
    const incoming = await readMap(source);
    for (const [id, classification] of Object.entries(incoming)) {
      canonical[id] = classification;
      replaced.add(id);
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, `${JSON.stringify(canonical, null, 2)}\n`);
  console.log(JSON.stringify({
    target,
    target_existed: existed,
    ...(existed ? {} : { note: `${target} did not exist; started from an empty map` }),
    total: Object.keys(canonical).length,
    merged: replaced.size,
    sources,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
