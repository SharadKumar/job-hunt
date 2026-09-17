import { promises as fs } from "node:fs";
import YAML from "yaml";
import { repoPath } from "./repo-root.ts";
import { loadTeamConfig } from "./profile-team.ts";
import type { Resume } from "./resumes.ts";

export type ResumeFormat = {
  id: string;
  label: string;
  active?: boolean;
  audience?: string;
  purpose?: string;
  template?: string;
  render_policy?: {
    show_contact_line?: boolean;
    show_experience_dates?: boolean;
  };
  page_policy?: Resume["page_policy"];
  content_policy?: Resume["content_policy"] & {
    section_policy?: Record<string, unknown>;
    heading_policy?: Record<string, unknown>;
  };
  section_policy?: Record<string, unknown>;
  heading_policy?: Record<string, unknown>;
  writer_instructions?: string[];
  notes?: string;
};

type ResumeFormatsFile = {
  resume_formats?: ResumeFormat[];
  formats?: ResumeFormat[];
};

const DEFAULT_ORG_RESUME_FORMATS_PATH = repoPath("state/org/resume-formats.yaml");

async function readYamlIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return YAML.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadResumeFormats(filePath = DEFAULT_ORG_RESUME_FORMATS_PATH): Promise<ResumeFormat[]> {
  const file = await readYamlIfExists<ResumeFormatsFile>(filePath);
  return (file?.resume_formats ?? file?.formats ?? []).filter((format) => format.active !== false);
}

export async function getResumeFormat(id: string | null | undefined, filePath = DEFAULT_ORG_RESUME_FORMATS_PATH): Promise<ResumeFormat | null> {
  if (!id) return null;
  const formats = await loadResumeFormats(filePath);
  return formats.find((format) => format.id === id) ?? null;
}

export async function defaultTeamResumeFormatId(): Promise<string | null> {
  const team = await loadTeamConfig();
  return typeof team?.default_resume_format === "string" && team.default_resume_format.trim()
    ? team.default_resume_format.trim()
    : null;
}
