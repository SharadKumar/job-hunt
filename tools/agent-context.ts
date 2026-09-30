/** Read-only, task-scoped context. Never an eligibility or submission gate. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { get, load, type Opportunity } from "./pipeline.ts";
import { getResume } from "./resumes.ts";
import { resolveProfileContext } from "./profile-context.ts";
import { repoPath } from "./repo-root.ts";

export function dailyIndex(rows: Opportunity[]) {
  const terminal = new Set(["submitted", "responded", "interview", "offered", "won", "withdrawn"]);
  const active = new Set(["shortlisted", "drafted", "awaiting_approval", "approved", "manual_action_needed", "submission_pending"]);
  const work = rows.filter(r => active.has(r.status) || (r.userSaved && !terminal.has(r.status)));
  return {
    total: rows.length,
    by_status: rows.reduce<Record<string, number>>((out, r) => { out[r.status] = (out[r.status] ?? 0) + 1; return out; }, {}),
    authority: "Navigation only. Read the current row and recheck all gates before acting. submission_pending requires reconciliation, never retry.",
    work: work.map(r => ({ id: r.id, title: r.title, status: r.status, channel: r.channel,
      score: r.score, user_saved: r.userSaved === true, apply_method: r.applyMethod,
      resume_id: r.classification?.matched_resume_id, draft_dir: r.draftDir,
      redraft_requested: r.redraftRequested })),
  };
}

export async function source(file: string, optional = false) {
  try {
    const text = await fs.readFile(file, "utf8");
    return { path: file, sha256: createHash("sha256").update(text).digest("hex"), text };
  } catch (error: any) {
    if (optional && error.code === "ENOENT") return { path: file, missing: true };
    throw error;
  }
}

export async function letterContext(id: string, template = "classic", profileId?: string) {
  for (const [key, value] of Object.entries({ id, template, profileId })) {
    if (value && !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid ${key}`);
  }
  const row = await get(id);
  if (!row) throw new Error(`Unknown opportunity: ${id}`);
  const resumeId = row.classification?.matched_resume_id;
  if (!resumeId) throw new Error("No matched resume; classify before writing");
  const resume = await getResume(resumeId, { profileId });
  if (!resume) throw new Error(`Unknown resume: ${resumeId}`);
  const profile = resolveProfileContext(profileId);
  const templateDir = repoPath("templates/cover-letter", template);
  const files: Array<[string, boolean]> = [
    [profile.profileMdPath, false],
    [repoPath("references/voice/voice-rules.md"), false],
    [repoPath("references/voice/slop-banlist.md"), false],
    [path.join(profile.profileDir, "voice-rules.md"), false],
    [profile.voiceSamplesPath, false],
    [repoPath("state/org/voice-rules.md"), true],
    [repoPath("state/org/slop-banlist.md"), true],
    [path.join(profile.profileDir, "resume-editorial-rules.md"), true],
    [path.join(profile.profileDir, "letter-critic-rules.yaml"), true],
    [path.join(profile.renderedResumesDir, resumeId, "cover-letter-editorial-rules.md"), true],
    [path.join(templateDir, "template.md"), false],
    [path.join(templateDir, "quality-checks.md"), true],
    [repoPath(".claude/skills/apply/references/cover-letter-quality.md"), false],
  ];
  return {
    opportunity: { id: row.id, title: row.title, company: row.company, url: row.url,
      location: row.location, description: row.description, classification: row.classification,
      user_saved: row.userSaved === true },
    resume: { id: resume.id, cover_letter_angle: resume.cover_letter_angle, could: resume.could, rate_band: resume.rate_band },
    cv_source_path: profile.cvSourcePath,
    evidence_instruction: "Search this canonical source and read surrounding passages for every claim. No evidence is implied by the JD or resume angle.",
    rules: await Promise.all(files.map(([file, optional]) => source(file, optional))),
    template_example_path: path.join(templateDir, "example.md"),
    archive_path: repoPath("state/pipeline/archive", id),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  if (args[0] === "daily") console.log(JSON.stringify(dailyIndex(await load())));
  else if (args[0] === "letter" && value("--id")) console.log(JSON.stringify(await letterContext(value("--id")!, value("--template"), value("--profile"))));
  else throw new Error("Usage: agent:context -- daily | letter --id <id> [--template <name>] [--profile <id>]");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
