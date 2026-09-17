import path from "node:path";
import { repoRoot } from "./repo-root.ts";

export type ProfileContext = {
  profileId: string | null;
  profileDir: string;
  profileMdPath: string;
  cvSourcePath: string;
  voiceSamplesPath: string;
  resumesPath: string;
  renderedResumesDir: string;
  marketConfirmationsPath: string;
};

export function resolveProfileContext(profileId?: string | null): ProfileContext {
  const id = profileId || process.env.HARNESS_PROFILE || null;
  const root = repoRoot();
  const profileDir = id ? path.join(root, "state", "profiles", id) : path.join(root, "state", "profile");
  return {
    profileId: id,
    profileDir,
    profileMdPath: path.join(profileDir, "profile.md"),
    cvSourcePath: path.join(profileDir, "cv-source.md"),
    voiceSamplesPath: path.join(profileDir, "voice-samples.md"),
    resumesPath: path.join(profileDir, "resumes.yaml"),
    renderedResumesDir: path.join(profileDir, "resumes"),
    marketConfirmationsPath: path.join(profileDir, "market-confirmations.yaml"),
  };
}
