// Guards templates/profile/: the public, neutral skeleton of state/profile/.
// Every file must exist, every YAML must parse, profile.md must carry parseable
// frontmatter with a `name`, and no file may leak a personal value from the
// owner's real profile.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { repoPath } from "../tools/repo-root.ts";

const root = repoPath("templates/profile");

const REQUIRED_FILES = [
  "profile.md",
  "channels.yaml",
  "submission-policy.yaml",
  "scoring-weights.yaml",
  "screening-answers.yaml",
  "skills-taxonomy.yaml",
  "voice-samples.md",
  "resume-editorial-rules.md",
  "editorial-bans.yaml",
  "market-confirmations.yaml",
  "resumes.yaml",
  "letter-critic-rules.yaml",
  "cv/meta.yaml",
];

// Personal values that must never appear in the published skeleton. Derived at
// test time from the live profile (state/profile is git-ignored, so nothing
// personal is hardcoded here): the frontmatter's name, email, phone, address
// and referee details, plus any extra terms in state/leak-terms.txt (one per
// line, optional, git-ignored). On a fresh clone with no profile the list is
// empty and only the structural checks run. Matched case-insensitively.
async function bannedStrings(): Promise<string[]> {
  const terms = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim().length >= 4) terms.add(v.trim().toLowerCase()); };
  try {
    const raw = await fs.readFile(path.join(root, "..", "..", "state", "profile", "profile.md"), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    const fm: any = m ? YAML.parse(m[1]) : {};
    for (const k of ["name", "email", "phone", "home_address", "linkedin_url", "github_url"]) add(fm?.[k]);
    if (typeof fm?.name === "string") for (const part of fm.name.split(/\s+/)) add(part);
    for (const r of fm?.referees ?? []) for (const k of ["name", "organisation", "mobile", "email"]) add(r?.[k]);
  } catch { /* no profile on this machine */ }
  try {
    for (const line of (await fs.readFile(path.join(root, "..", "..", "state", "leak-terms.txt"), "utf8")).split("\n")) add(line);
  } catch { /* optional */ }
  return [...terms];
}
const BANNED_STRINGS = await bannedStrings();

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => { failures += 1; console.error(`  ✗ ${msg}`); };

const contents = new Map<string, string>();

for (const rel of REQUIRED_FILES) {
  const full = path.join(root, rel);
  try {
    contents.set(rel, await fs.readFile(full, "utf8"));
    ok(`exists: templates/profile/${rel}`);
  } catch {
    fail(`missing: templates/profile/${rel}`);
  }
}

for (const [rel, text] of contents) {
  if (!rel.endsWith(".yaml")) continue;
  try {
    const parsed = YAML.parse(text);
    assert.ok(parsed && typeof parsed === "object", "top level is a mapping");
    ok(`parses: ${rel}`);
  } catch (e: any) {
    fail(`yaml parse error in ${rel}: ${e?.message ?? e}`);
  }
}

{
  const text = contents.get("profile.md") ?? "";
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) {
    fail("profile.md has no YAML frontmatter");
  } else {
    try {
      const fm = YAML.parse(m[1]);
      assert.equal(typeof fm?.name, "string", "frontmatter.name is a string");
      assert.ok(fm.name.length > 0, "frontmatter.name is non-empty");
      ok(`profile.md frontmatter parses with name="${fm.name}"`);
    } catch (e: any) {
      fail(`profile.md frontmatter: ${e?.message ?? e}`);
    }
  }
}

// Structural expectations the tools depend on.
{
  const policy = YAML.parse(contents.get("submission-policy.yaml") ?? "{}");
  if (policy.kill_switch !== false) fail("submission-policy.yaml kill_switch should default to false");
  else if (policy.autopilot?.enabled !== false) fail("submission-policy.yaml autopilot.enabled should default to false");
  else ok("submission-policy.yaml ships with autopilot off and kill switch off");

  const channels = YAML.parse(contents.get("channels.yaml") ?? "{}");
  const enabled = Object.entries(channels.channels ?? {}).filter(([, c]: any) => c?.enabled === true).map(([id]) => id);
  if (enabled.length) fail(`channels.yaml enables channels by default: ${enabled.join(", ")}`);
  else ok("channels.yaml ships with every channel disabled");

  const resumes = YAML.parse(contents.get("resumes.yaml") ?? "{}");
  if (!Array.isArray(resumes.resumes) || resumes.resumes.length !== 0) fail("resumes.yaml should ship with resumes: []");
  else if (!resumes.render_efficiency) fail("resumes.yaml should carry render_efficiency");
  else ok("resumes.yaml ships empty with render_efficiency");

  const screening = YAML.parse(contents.get("screening-answers.yaml") ?? "{}");
  if (!Array.isArray(screening.unknown_questions) || screening.unknown_questions.length !== 0) fail("screening-answers.yaml should ship with unknown_questions: []");
  else ok("screening-answers.yaml ships with unknown_questions: []");
}

for (const [rel, text] of contents) {
  const lower = text.toLowerCase();
  const hits = BANNED_STRINGS.filter((s) => lower.includes(s));
  if (hits.length) fail(`${rel} contains personal values: ${hits.join(", ")}`);
}
if (!failures) ok("no personal values in any template file");

if (failures) {
  console.error(`\n${failures} profile-template check(s) failed`);
  process.exit(1);
}
console.log("profile-template: all checks passed");
