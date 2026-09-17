#!/usr/bin/env tsx
/**
 * onboarding.ts — deterministic utilities supporting the /onboarding skill.
 *
 * All LLM reasoning (analyse the CV + URLs, propose resume positionings,
 * draft each resume entry) happens IN-AGENT. This script is only the
 * deterministic glue around that reasoning.
 *
 * CLI:
 *   tsx tools/onboarding.ts context [--urls a,b,c]
 *     → prints the full CV-and-URLs blob the agent should reason over.
 *       Reads state/profile/cv-source.md (single holistic CV) plus any
 *       URLs the caller provides.
 *   tsx tools/onboarding.ts write-resume --json '{...}'
 *     → validates and appends a resume entry to resumes.yaml.
 *
 * Post-migration (2026-05-28): the legacy `apply-tags` command was removed
 * along with the per-bullet variant tagging system. resume-writer now
 * composes positioning-specific resumes holistically from cv-source.md +
 * the positioning brief in resumes.yaml.
 */

import { promises as fs } from "node:fs";
import YAML from "yaml";
import { fetch } from "undici";
import { repoPath } from "./repo-root.ts";

async function loadCvContext(): Promise<string> {
  try {
    const src = (await fs.readFile(repoPath("state/profile/cv-source.md"), "utf8")).trim();
    return src;
  } catch {
    return "(cv-source.md missing — run 'npm run markdownify:cv' first)";
  }
}

async function loadUrlContent(urls: string[]): Promise<string> {
  if (!urls.length) return "";
  const parts: string[] = ["# Supplementary URLs (public sites / products / portfolio)"];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 onboarding" } });
      if (!res.ok) { parts.push(`\n## ${url}\n(fetch failed: HTTP ${res.status})`); continue; }
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
      parts.push(`\n## ${url}\n${text}`);
    } catch (e) {
      parts.push(`\n## ${url}\n(fetch error: ${(e as Error).message})`);
    }
  }
  return parts.join("\n\n");
}

async function loadHarnessContext(): Promise<string> {
  const parts: string[] = [];
  try {
    const profile = await fs.readFile(repoPath("state/profile/profile.md"), "utf8");
    const rateBand = profile.match(/Day rate[\s\S]*?(?=\n##|$)/i)?.[0]?.trim();
    if (rateBand) parts.push(`# User's rate band (anchor for any target's rate_band field)\n${rateBand}`);
    const workArr = profile.match(/Work arrangement[\s\S]*?(?=\n##|$)/i)?.[0]?.trim();
    if (workArr) parts.push(`# User's work arrangement\n${workArr}`);
    const redFlags = profile.match(/Red flags[\s\S]*?(?=\n##|$)/i)?.[0]?.trim();
    if (redFlags) parts.push(`# User's red flags\n${redFlags}`);
  } catch {}
  try {
    const channels = await fs.readFile(repoPath("state/profile/channels.yaml"), "utf8");
    const channelIds = YAML.parse(channels)?.channels;
    if (channelIds) {
      parts.push(`# Valid channel ids for preferred_channels (use ONLY these; never invent)\n${Object.keys(channelIds).join(", ")}`);
    }
  } catch {}
  return parts.join("\n\n");
}

async function cmdContext(urls: string[]): Promise<void> {
  const harness = await loadHarnessContext();
  const cv = await loadCvContext();
  const urlContent = await loadUrlContent(urls);
  console.log(`${harness}\n\n# CV (state/profile/cv-source.md)\n${cv}\n\n${urlContent}`);
}

async function cmdWriteResume(resumeJson: string): Promise<void> {
  const t = JSON.parse(resumeJson);
  // Required-field validation. Post-migration schema: no resume_tag or
  // summary_file. cover_letter_angle carries the positioning lead-hook;
  // resume-writer composes the actual summary at render time.
  const required = ["id", "label", "search_keywords", "should", "cover_letter_angle", "rate_band"];
  for (const f of required) {
    if (!(f in t)) { console.error(`missing required field: ${f}`); process.exit(2); }
  }
  const original = await fs.readFile(repoPath("state/profile/resumes.yaml"), "utf8");
  const existing = YAML.parse(original) ?? {};
  existing.resumes = existing.resumes ?? [];
  const idx = existing.resumes.findIndex((x: any) => x.id === t.id);
  if (idx >= 0) existing.resumes[idx] = t;
  else existing.resumes.push(t);
  const yaml = YAML.stringify(existing);
  // Preserve the header comments
  const headerMatch = original.match(/^([\s\S]*?)(?=\nresumes:|\s*$)/);
  const header = headerMatch ? headerMatch[1].trimEnd() : "";
  await fs.writeFile(repoPath("state/profile/resumes.yaml"), `${header}\n\n${yaml}`);
  console.log(JSON.stringify({ id: t.id, wrote_resume: true }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a: Record<string, string> = {};
  let useStdin = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--stdin") useStdin = true;
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }

  if (cmd === "context") {
    const urls = (a.urls || "").split(",").filter(Boolean);
    await cmdContext(urls);
  } else if (cmd === "write-resume") {
    let json = a.json || "";
    if (!json && useStdin) {
      json = await new Promise<string>((res) => { let acc = ""; process.stdin.on("data", (d) => (acc += d.toString())); process.stdin.on("end", () => res(acc)); });
    }
    if (!json) { console.error("--json or --stdin required"); process.exit(2); }
    await cmdWriteResume(json);
  } else {
    console.error("Usage: tsx tools/onboarding.ts (context [--urls a,b,c] | write-resume --json '{...}')");
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
