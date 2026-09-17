#!/usr/bin/env tsx
/**
 * channel-adapters.test.ts — a channel id without a module is reported, not guessed.
 *
 * `channels.yaml` ships ids the harness has no scraper for (hays, talenza,
 * paxus, robert_half, peoplebank, wellfound), all `enabled: false`. There are
 * no placeholder modules for them: `HUNT_SCRIPTS` in tools/channels/_interface.ts
 * is the single registry of ids that do have one, and `huntScriptFor` says
 * plainly when an id does not.
 *
 * Covers: the registry matching the npm scripts and the files on disk; the
 * "no adapter for <channel>" answer; and the template shipping the
 * adapter-less ids disabled.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { HUNT_SCRIPTS, huntScriptFor } from "../tools/channels/_interface.ts";
import { repoPath } from "../tools/repo-root.ts";

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL  ${name}: ${e?.message ?? e}`); }
}

const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> };

check("every registered channel has its npm script", () => {
  for (const [id, script] of Object.entries(HUNT_SCRIPTS)) {
    assert.ok(pkg.scripts[script], `package.json has no "${script}" script (channel ${id})`);
  }
});

check("every hunt: npm script has a registry entry", () => {
  const scripts = new Set(Object.values(HUNT_SCRIPTS));
  for (const name of Object.keys(pkg.scripts)) {
    if (!name.startsWith("hunt:")) continue;
    // hunt:linkedin_jobs is an alias of hunt:linkedin-jobs for the underscore id.
    if (name === "hunt:linkedin_jobs") continue;
    assert.ok(scripts.has(name), `"${name}" is not in HUNT_SCRIPTS`);
  }
});

check("a registered channel resolves to its script", () => {
  assert.deepEqual(huntScriptFor("seek"), { ok: true, script: "hunt:seek" });
  assert.deepEqual(huntScriptFor("hn_who_is_hiring"), { ok: true, script: "hunt:hn" });
});

check("an unimplemented channel is reported, not guessed", () => {
  for (const id of ["hays", "talenza", "paxus", "robert_half", "peoplebank", "wellfound"]) {
    assert.deepEqual(huntScriptFor(id), { ok: false, reason: `no adapter for ${id}` });
  }
  assert.deepEqual(huntScriptFor("not_a_channel"), { ok: false, reason: "no adapter for not_a_channel" });
});

check("no placeholder modules are left behind", () => {
  for (const id of ["hays", "talenza", "paxus", "robert-half", "peoplebank", "wellfound"]) {
    assert.ok(!existsSync(repoPath(`tools/channels/${id}.ts`)), `tools/channels/${id}.ts should not exist`);
  }
});

check("the template ships the adapter-less ids disabled", () => {
  const parsed = YAML.parse(readFileSync(repoPath("templates/profile/channels.yaml"), "utf8"));
  const channels = (parsed?.channels ?? {}) as Record<string, { enabled?: boolean }>;
  for (const [id, cfg] of Object.entries(channels)) {
    if (huntScriptFor(id).ok) continue;
    assert.equal(cfg?.enabled, false, `${id} has no adapter and must ship disabled`);
  }
});

console.log(failures ? `\n${failures} failed` : "\nall channel adapter checks passed");
process.exit(failures ? 1 : 0);
