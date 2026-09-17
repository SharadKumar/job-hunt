/**
 * cv-templates.ts — utilities for the harness-level CV template library.
 *
 * Templates live at `templates/resume/<name>/`. Each has:
 *   render.ts             — renderer implementation
 *   template.md           — metadata (name, description, suitable_for, version)
 *   quality-checks.md     — optional per-template checks
 *
 * The library is shared across all profiles. Profile `resumes.yaml` entries
 * pick a template by name via the `template:` field. Improving a template
 * helps every profile that references it (compounding pattern).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { repoPath } from "./repo-root.ts";

export const TEMPLATES_ROOT = repoPath("templates/resume");

export type TemplateMeta = {
  name: string;
  description: string;
  suitable_for?: string[];
  version: number;
  added_at?: string;
  last_updated?: string;
  notes?: string;
};

export async function listTemplates(): Promise<string[]> {
  try {
    const entries = await fs.readdir(TEMPLATES_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

export async function templateExists(name: string): Promise<boolean> {
  try { await fs.access(path.join(TEMPLATES_ROOT, name, "render.ts")); return true; }
  catch { return false; }
}

export async function templateRenderPath(name: string): Promise<string> {
  const p = path.join(TEMPLATES_ROOT, name, "render.ts");
  if (!(await templateExists(name))) throw new Error(`Template '${name}' not found at ${p}. Run \`ls templates/resume/\` to see available.`);
  return p;
}

export async function loadTemplateMeta(name: string): Promise<TemplateMeta | null> {
  try {
    const md = await fs.readFile(path.join(TEMPLATES_ROOT, name, "template.md"), "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    // Minimal YAML parse — meta files are simple
    const meta: any = { name };
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim();
      if (key === "version") meta[key] = Number(val);
      else meta[key] = val;
    }
    return meta as TemplateMeta;
  } catch {
    return null;
  }
}

async function collectTemplateFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Samples are documentation artefacts. They must not invalidate approved
      // baselines; render.ts/template.md/quality-checks.md/rubric.yaml do.
      if (entry.name === "sample") continue;
      out.push(...await collectTemplateFiles(p));
    }
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/** Hash all files that influence a template render. Used in baseline
 *  content_hash so swapping or upgrading the template invalidates approvals. */
export async function templateContentHash(name: string): Promise<string> {
  await templateRenderPath(name);
  const h = createHash("sha256");
  const root = path.join(TEMPLATES_ROOT, name);
  for (const file of await collectTemplateFiles(root)) {
    h.update(`${path.relative(root, file)}\n`);
    h.update(await fs.readFile(file));
    h.update("\n");
  }
  return h.digest("hex");
}
