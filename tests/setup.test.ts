/**
 * tests/setup.test.ts — tools/setup.ts scaffolds a profile from templates/profile
 * without overwriting, and setup:check reports the scaffolded profile as blocked
 * on placeholders (not on missing files).
 *
 *   npx tsx tests/setup.test.ts
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { repoPath } from "../tools/repo-root.ts";

const id = `setup-test-${process.pid}`;
const dir = repoPath(`state/profiles/${id}`);
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; }
function run(args: string[]): any {
  try { return JSON.parse(execFileSync("npx", ["tsx", "tools/setup.ts", ...args], { cwd: repoPath("."), encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp" } })); }
  catch (e: any) { const out = String(e.stdout || ""); try { return JSON.parse(out.slice(out.indexOf("{"))); } catch { throw e; } }
}

try {
  const s1 = run(["scaffold", "--profile", id]);
  check("scaffold creates the profile files", s1.created.includes("profile.md") && s1.created.includes("resumes.yaml"), `${s1.created.length} created`);
  check("scaffold writes under state/profiles/<id>", existsSync(path.join(dir, "profile.md")));

  await fs.writeFile(path.join(dir, "profile.md"), "---\nname: Someone Real\nemail: someone@real.test\ncitizenship: Test\nlocation: { city: X }\n---\n# kept\n");
  const s2 = run(["scaffold", "--profile", id]);
  check("scaffold never overwrites", s2.created.length === 0 && s2.skipped.includes("profile.md"));
  check("hand-edited profile.md survived", (await fs.readFile(path.join(dir, "profile.md"), "utf8")).includes("Someone Real"));

  const c1 = run(["check", "--stage", "1", "--profile", id]);
  const st = c1.stages[0];
  const files = st.checks.filter((c: any) => c.id.startsWith("file:"));
  check("stage 1: every profile file present", files.length === 12 && files.every((c: any) => c.ok));
  check("stage 1: frontmatter valid", st.checks.find((c: any) => c.id === "frontmatter")?.ok === true);
  check("stage 1: blocked on voice samples, not files", st.ok === false && st.checks.find((c: any) => c.id === "voice_samples")?.ok === false);
  check("check exits non-zero and names the next stage", c1.ready_for_autopilot === false && c1.next_stage?.stage === 1);

  const c3 = run(["check", "--stage", "3", "--profile", id]);
  check("stage 3: empty resumes.yaml parses but has no active positionings", c3.stages[0].ok === false && c3.stages[0].checks.find((c: any) => c.id === "resumes_yaml")?.ok === true);
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall setup tests passed");
process.exit(failures ? 1 : 0);
