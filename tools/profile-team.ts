import { exists } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveProfileContext } from "./profile-context.ts";
import { fileProfileDir, isTwentyStore } from "./store/documents.ts";
import { repoPath } from "./repo-root.ts";

export type ProfileRef = { id: string | null; label: string };

export type TeamFile = {
  default_resume_format?: string | null;
  profiles?: Array<string | { id: string; active?: boolean; label?: string }>;
};

export function profileIdFromArg(value?: string): string | null {
  if (!value || value === "default" || value === "current") return null;
  return value;
}

export function profileLabel(id: string | null): string {
  return id ?? "default";
}

export async function loadTeamConfig(filePath = repoPath("state/org/team.yaml")): Promise<TeamFile | null> {
  const teamRaw = await fs.readFile(filePath, "utf8").catch(() => "");
  return teamRaw ? YAML.parse(teamRaw) as TeamFile : null;
}

function dedupeProfiles(refs: ProfileRef[]): ProfileRef[] {
  const seen = new Set<string>();
  const out: ProfileRef[] = [];
  for (const ref of refs) {
    const key = profileLabel(ref.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export async function discoverProfiles(args: Record<string, string>): Promise<ProfileRef[]> {
  if (args.profile && args.profile !== "all") {
    const id = profileIdFromArg(args.profile);
    return [{ id, label: profileLabel(id) }];
  }

  const refs: ProfileRef[] = [];
  const team = await loadTeamConfig();
  if (team) {
    for (const entry of team.profiles ?? []) {
      if (typeof entry === "string") refs.push({ id: entry, label: entry });
      else if (entry.active !== false) refs.push({ id: entry.id, label: entry.label ?? entry.id });
    }
    return dedupeProfiles(refs);
  }

  // A Twenty workspace holds one person: the default profile, from the run's documents.
  if (isTwentyStore()) return [{ id: null, label: "default" }];

  if (await exists(path.join(fileProfileDir(null), "resumes.yaml"))) refs.push({ id: null, label: "default" });

  const teamDir = path.dirname(fileProfileDir("_"));
  const entries = await fs.readdir(teamDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (await exists(path.join(teamDir, entry.name, "resumes.yaml"))) {
      refs.push({ id: entry.name, label: entry.name });
    }
  }
  return dedupeProfiles(refs);
}

export async function loadMetadataStatus(profileId: string | null, resumeId: string): Promise<Record<string, unknown>> {
  const context = resolveProfileContext(profileId);
  const metaPath = path.join(context.renderedResumesDir, resumeId, "metadata.json");
  const meta = await fs.readFile(metaPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
  return {
    render_status: meta?.approval_status ?? "missing",
    approved_at: meta?.approved_at ?? null,
    last_render_at: meta?.last_render_at ?? null,
    metadata_path: meta ? metaPath : null,
  };
}
