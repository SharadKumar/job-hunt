import path from "node:path";
import { currentProfileDir, fileProfileDir } from "./store/documents.ts";

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

/**
 * The profile's paths. In file mode they sit under the on-disk profile
 * directory (state/profile, or state/profiles/<id> in team mode); with
 * HARNESS_STORE=twenty they sit in the run's materialised document cache
 * (tools/store/documents.ts), so callers read the same file names either way.
 * `files: true` forces the on-disk profile, for the one-time migration.
 */
export function resolveProfileContext(profileId?: string | null, opts: { files?: boolean } = {}): ProfileContext {
  const id = profileId || process.env.HARNESS_PROFILE || null;
  const profileDir = opts.files ? fileProfileDir(id) : currentProfileDir(id);
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

/**
 * A file in the default profile directory: state/profile in file mode (never
 * HARNESS_PROFILE's, as the callers always hard-coded), the run cache in
 * Twenty mode. Team-aware callers use resolveProfileContext(profileId).
 */
export function profilePath(...segments: string[]): string {
  return path.join(currentProfileDir(null), ...segments);
}

/**
 * Provenance keys stored in compositions and critic findings. They name the
 * evidence file and open nothing, so they stay stable across stores.
 */
export const CV_SOURCE_REF = "state/profile/cv-source.md"; // scan:label
export const PROFILE_REF = "state/profile/profile.md"; // scan:label
