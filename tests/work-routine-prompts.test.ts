import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const repoRoot = process.cwd();
const skillNames = [
  "my-contracting-discovery-import",
  "my-contracting-application-progress",
] as const;

for (const skillName of skillNames) {
  const skillPath = path.join(repoRoot, ".claude", "skills", skillName, "SKILL.md");
  const contents = fs.readFileSync(skillPath, "utf8");
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${skillName} must have YAML frontmatter`);
  const frontmatter = parse(match[1]);
  const compact = contents.replace(/\s+/g, " ");

  assert.equal(frontmatter.name, skillName);
  assert.equal(typeof frontmatter.description, "string");
  assert.ok(frontmatter.description.length > 20);

  assert.match(compact, /prepared manual queue/i);
  assert.match(compact, /approve that exact application at the action point/i);
  assert.match(contents, /submission-runner/);
  assert.match(compact, /state validation and Sheet synchronization/i);

  assert.doesNotMatch(contents, /routines\.yaml|REGISTERING\.md/);
  assert.doesNotMatch(contents, /\bcron\b|Australia\/Sydney|maxTurns|inactivitySeconds/);
  assert.doesNotMatch(contents, /Hermes|Slack|gateway/i);
}

const discovery = fs.readFileSync(
  path.join(repoRoot, ".claude", "skills", skillNames[0], "SKILL.md"),
  "utf8",
);
assert.match(discovery, /canonicalize and deduplicate/i);
assert.match(discovery, /Enrichment may add evidence but must not silently advance workflow state/i);

const progress = fs.readFileSync(
  path.join(repoRoot, ".claude", "skills", skillNames[1], "SKILL.md"),
  "utf8",
);
const compactProgress = progress.replace(/\s+/g, " ");
assert.match(compactProgress, /terminal tool or session result is evidence to inspect, not completion/i);
assert.match(compactProgress, /return `\[SILENT\]` if the caller requested quiet operation/i);

console.log("My Contracting routine prompt contracts passed");
