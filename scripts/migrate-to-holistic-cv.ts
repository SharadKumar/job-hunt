#!/usr/bin/env tsx
/**
 * migrate-to-holistic-cv.ts — one-shot consolidation: atomic CV tree → single cv-source.md.
 *
 * Reads state/profile/cv/{experiences,summaries,skills}/*.md + highlights.md,
 * emits state/profile/cv-source.md as one holistic markdown document. Variant
 * tags on bullets are stripped (the resume-writer agent now decides positioning
 * fit holistically, not by tag filter). The architecture-variant summary is
 * promoted to THE professional summary; other per-positioning summaries are
 * preserved in the atomic tree for archive but not emitted (the agent composes
 * positioning-specific summaries at render time from cover_letter_angle +
 * featured-experience evidence).
 *
 * Idempotent: rerunning overwrites cv-source.md cleanly.
 *
 * After this script runs, state/profile/cv/{experiences,summaries,skills,highlights.md}
 * are no longer load-bearing — Step 8 of the migration archives them.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const CV_DIR = "state/profile/cv";
const PROFILE_MD = "state/profile/profile.md";
const OUT = "state/profile/cv-source.md";

type ProfileFrontmatter = {
  name: string;
  email?: string;
  phone?: string;
  citizenship?: string;
  location?: { city?: string; country?: string };
  linkedin_url?: string;
  github_url?: string;
};

type ExperienceMeta = {
  title: string;
  company: string;
  location?: string;
  start: string;
  end: string;
};

type Experience = ExperienceMeta & {
  slug: string;
  summary: string;
  bullets: string[]; // variant tags stripped
};

async function loadProfileFrontmatter(): Promise<ProfileFrontmatter> {
  const md = await fs.readFile(PROFILE_MD, "utf8");
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error(`${PROFILE_MD} missing frontmatter`);
  return YAML.parse(fm[1]) as ProfileFrontmatter;
}

async function loadExperiences(): Promise<Experience[]> {
  const dir = path.join(CV_DIR, "experiences");
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse(); // reverse-chrono: 2024-... first, 2003-... last
  const out: Experience[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fm) {
      console.warn(`skipping ${f}: no frontmatter`);
      continue;
    }
    const meta = YAML.parse(fm[1]) as ExperienceMeta;
    const body = fm[2];
    const summary = body.match(/##\s+Summary\s*\n+([\s\S]*?)(?=\n##|\n*$)/)?.[1]?.trim() ?? "";
    const bullets: string[] = [];
    const bMatch = body.match(/##\s+Bullets\s*\n+([\s\S]*?)$/);
    if (bMatch) {
      for (const line of bMatch[1].split("\n")) {
        // Match: - bullet text  <!-- variants: [a, b] -->
        const m = line.match(/^-\s+(.+?)\s*<!--\s*variants:\s*\[[^\]]*\]\s*-->\s*$/);
        if (m) {
          bullets.push(m[1].trim());
          continue;
        }
        // Fallback: bullet without variant tag (defensive — current parser always emits tags)
        const plain = line.match(/^-\s+(.+?)\s*$/);
        if (plain) bullets.push(plain[1].trim());
      }
    }
    out.push({
      slug: f.replace(/\.md$/, ""),
      ...meta,
      summary,
      bullets,
    });
  }
  return out;
}

async function loadHighlights(): Promise<string[]> {
  const p = path.join(CV_DIR, "highlights.md");
  const raw = await fs.readFile(p, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^-\s+/, "").trim());
}

async function loadProfessionalSummary(): Promise<string> {
  // Prefer architecture.md (the primary_variant in meta.yaml) as THE summary.
  // Other per-positioning summaries are kept in the atomic tree archive; the
  // resume-writer agent will compose positioning-specific summaries at render
  // time from cover_letter_angle + featured-experience evidence.
  const candidate = path.join(CV_DIR, "summaries", "architecture.md");
  const raw = await fs.readFile(candidate, "utf8").catch(() => "");
  if (!raw.trim()) throw new Error(`Cannot promote ${candidate} — file missing or empty`);
  return raw.trim();
}

type SkillBlock = { name: string; bullets: string[] };

async function loadSkills(): Promise<SkillBlock[]> {
  const dir = path.join(CV_DIR, "skills");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  // Preferred order: technology, leadership, consulting (most-relevant first
  // for the harness's senior-architect target families). The migration script
  // can't decide order universally — it picks an order that suits the user's
  // current 6 positionings. If onboarding for a different profile, adjust.
  const order = ["technology-and-design.md", "leadership-and-management.md", "consulting-and-delivery.md"];
  const sorted = [
    ...order.filter((o) => files.includes(o)),
    ...files.filter((f) => !order.includes(f)),
  ];
  const out: SkillBlock[] = [];
  for (const f of sorted) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    const name = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? f.replace(/\.md$/, "");
    const bullets = raw
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^-\s+/, "").trim());
    out.push({ name, bullets });
  }
  return out;
}

function renderContactLine(p: ProfileFrontmatter): string {
  const parts: string[] = [];
  if (p.email) parts.push(p.email);
  if (p.phone) parts.push(p.phone);
  if (p.location?.city || p.location?.country) {
    parts.push([p.location.city, p.location.country].filter(Boolean).join(", "));
  }
  if (p.linkedin_url && p.linkedin_url !== "TODO") parts.push(p.linkedin_url);
  if (p.github_url && p.github_url !== "TODO") parts.push(p.github_url);
  return parts.join(" · ");
}

function renderExperience(e: Experience): string {
  const header = `### ${e.start} – ${e.end} — ${e.title}, ${e.company}`;
  const loc = e.location ? `*${e.location}*\n\n` : "";
  const summary = e.summary ? `${e.summary}\n\n` : "";
  const bullets = e.bullets.map((b) => `- ${b}`).join("\n");
  return `${header}\n${loc}${summary}${bullets}\n`;
}

async function main() {
  const [profile, summary, highlights, experiences, skills] = await Promise.all([
    loadProfileFrontmatter(),
    loadProfessionalSummary(),
    loadHighlights(),
    loadExperiences(),
    loadSkills(),
  ]);

  const lines: string[] = [];
  lines.push(`# ${profile.name}`);
  lines.push("");
  const contact = renderContactLine(profile);
  if (contact) {
    lines.push(`**Contact:** ${contact}`);
    lines.push("");
  }
  if (profile.citizenship) {
    lines.push(`**Citizenship:** ${profile.citizenship}`);
    lines.push("");
  }

  lines.push("## Professional Summary");
  lines.push("");
  lines.push(summary);
  lines.push("");

  if (highlights.length > 0) {
    lines.push("## Career Highlights");
    lines.push("");
    for (const h of highlights) lines.push(`- ${h}`);
    lines.push("");
  }

  lines.push("## Professional Experience");
  lines.push("");
  for (const e of experiences) {
    lines.push(renderExperience(e));
  }

  if (skills.length > 0) {
    lines.push("## Skills");
    lines.push("");
    for (const s of skills) {
      lines.push(`### ${s.name}`);
      lines.push("");
      for (const b of s.bullets) lines.push(`- ${b}`);
      lines.push("");
    }
  }

  const content = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  await fs.writeFile(OUT, content + "\n", "utf8");

  const bulletCount = experiences.reduce((n, e) => n + e.bullets.length, 0);
  const skillBulletCount = skills.reduce((n, s) => n + s.bullets.length, 0);

  console.log(JSON.stringify({
    out: OUT,
    bytes: (await fs.stat(OUT)).size,
    experiences: experiences.length,
    experience_bullets: bulletCount,
    highlights: highlights.length,
    skill_blocks: skills.length,
    skill_bullets: skillBulletCount,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
