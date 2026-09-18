/**
 * composition-io.ts — read/write a composition and its provenance sidecar.
 *
 * WHY
 * ---
 * `source_provenance` is ~17 KB of a ~55 KB composition and nothing that reads
 * a composition for content purposes (renderer, fit ops, profile report body,
 * keyword tooling) needs it. Splitting it out keeps `<prefix>.composition.json`
 * small enough for a model to read whole, while the audit trail stays beside it
 * at `<prefix>.provenance.json`.
 *
 * Contract:
 *   - `<prefix>.composition.json` NEVER carries an inline `source_provenance`.
 *   - `<prefix>.provenance.json` carries it, and only it.
 *   - `loadComposition()` accepts BOTH shapes: sidecar when present, otherwise
 *     the inline field on older artefacts. Callers therefore need no migration.
 */

import { sha256 } from "../../lib/hash.ts";
import { readJsonIfExists } from "../../lib/fs.ts";
import { promises as fs } from "node:fs";
import type { ResumeContent, ResumeSourceProvenance } from "../../../templates/resume/_interface.ts";

export type LoadedComposition = {
  /** The composition. `source_provenance` is attached from whichever source won. */
  content: ResumeContent;
  /** Provenance from the sidecar, else the inline field, else null. */
  provenance: ResumeSourceProvenance | null;
  /** Path of the sidecar actually read; null when provenance was inline or absent. */
  provenancePath: string | null;
  /** Raw text of the composition file as read (without provenance merged in). */
  raw: string;
  compositionPath: string;
};

/** `<prefix>.composition.json` → `<prefix>.provenance.json`. Any other name gets `.provenance.json` appended to its stem. */
export function provenanceSidecarPath(compositionPath: string): string {
  if (compositionPath.endsWith(".composition.json")) return compositionPath.replace(/\.composition\.json$/, ".provenance.json");
  return compositionPath.replace(/\.json$/, "") + ".provenance.json";
}

/** Tolerant on purpose: a missing or corrupt sidecar falls back to inline provenance. */
async function readJson(file: string): Promise<any | null> {
  return readJsonIfExists(file).catch(() => null);
}

/**
 * Load a composition, resolving provenance from the sidecar when it exists and
 * falling back to the inline field otherwise. The returned `content` always has
 * `source_provenance` populated when provenance was found anywhere, so
 * downstream validators (resume-provenance, profile-report) work unchanged.
 */
export async function loadComposition(compositionPath: string): Promise<LoadedComposition> {
  const raw = await fs.readFile(compositionPath, "utf8");
  const content = JSON.parse(raw) as ResumeContent;
  const sidecarPath = provenanceSidecarPath(compositionPath);
  const sidecar = (await readJson(sidecarPath)) as ResumeSourceProvenance | null;
  const provenance = sidecar ?? content.source_provenance ?? null;
  if (provenance) content.source_provenance = provenance;
  else delete content.source_provenance;
  return { content, provenance, provenancePath: sidecar ? sidecarPath : null, raw, compositionPath };
}

/** Strip provenance off a composition without mutating the input. */
export function splitProvenance(content: ResumeContent): { content: ResumeContent; provenance: ResumeSourceProvenance | null } {
  const { source_provenance, ...rest } = content;
  return { content: rest as ResumeContent, provenance: source_provenance ?? null };
}

export type WrittenComposition = { compositionPath: string; provenancePath: string | null };

/**
 * Write `<prefix>.composition.json` WITHOUT `source_provenance` plus the
 * sidecar when there is provenance to persist. `provenance` overrides the
 * inline field (fit ops hand back a pruned copy).
 */
export async function writeComposition(
  compositionPath: string,
  content: ResumeContent,
  opts: { provenance?: ResumeSourceProvenance | null } = {},
): Promise<WrittenComposition> {
  const split = splitProvenance(content);
  const provenance = opts.provenance !== undefined ? opts.provenance : split.provenance;
  await fs.writeFile(compositionPath, `${JSON.stringify(split.content, null, 2)}\n`);
  const sidecarPath = provenanceSidecarPath(compositionPath);
  if (provenance) {
    await fs.writeFile(sidecarPath, `${JSON.stringify(provenance, null, 2)}\n`);
    return { compositionPath, provenancePath: sidecarPath };
  }
  // No provenance to write: remove a stale sidecar rather than leave it lying.
  await fs.rm(sidecarPath, { force: true }).catch(() => undefined);
  return { compositionPath, provenancePath: null };
}

/**
 * Hash of a composition's CONTENT, provenance excluded.
 *
 * WHY provenance is excluded: this hash answers one question only: "is the
 * document the critic read still the document on disk?". `source_provenance`
 * is an audit trail about where lines came from. Re-anchoring it (which the
 * audit does on every pass) changes no word of the CV, yet folding it into the
 * hash made every post-review audit look like a content change and stranded
 * `resume:approve` behind a false "the critic reviewed a different composition".
 *
 * Excluding it also makes the hash identical whether provenance lives in the
 * sidecar or inline on an older artefact, which is what the sidecar migration
 * needed anyway.
 */
export function compositionHash(content: ResumeContent): string {
  const { content: stripped } = splitProvenance(content);
  return sha256(JSON.stringify(stripped));
}

/**
 * Hash of the composition AS PERSISTED at `compositionPath`, provenance excluded.
 *
 * Reads the file rather than a caller's in-memory object on purpose: every
 * producer (critic-apply) and every consumer (resume-approve) must hash the
 * exact same input, and the only input both can agree on is the bytes on disk.
 * Parsing first (rather than hashing the raw text) keeps the hash insensitive
 * to formatting and to a legacy inline `source_provenance`.
 */
export async function compositionContentHash(compositionPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(compositionPath, "utf8");
    return compositionHash(JSON.parse(raw) as ResumeContent);
  } catch {
    return null;
  }
}
