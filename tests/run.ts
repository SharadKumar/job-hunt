#!/usr/bin/env tsx
/**
 * tests/run.ts — the harness test runner.
 *
 *   npm test                      # tsc --noEmit, then every tests/*.test.ts
 *   tsx tests/run.ts resume       # only files whose name contains "resume"
 *   tsx tests/run.ts --serial     # one at a time (easier to read when debugging)
 *   tsx tests/run.ts --dir <path> # run the *.test.ts files in another directory
 *
 * Each test file is a standalone script run in its own child process, so a
 * process.exit, a chdir or a mutated env in one file cannot reach another.
 * Output is captured and only replayed for failures, so a green run stays short.
 *
 * Paths resolve through tools/repo-root.ts, never process.cwd(), so the runner
 * works from any directory (launchd, a git hook, an editor task).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../tools/repo-root.ts";

const DEFAULT_CONCURRENCY = 4;

type Options = {
  dir: string;
  filters: string[];
  serial: boolean;
  concurrency: number;
};

type Result = {
  file: string;
  name: string;
  code: number;
  ms: number;
  output: string;
};

export function parseArgs(argv: string[], root: string): Options {
  const opts: Options = {
    dir: path.join(root, "tests"),
    filters: [],
    serial: false,
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--serial") opts.serial = true;
    else if (arg === "--dir") opts.dir = path.resolve(argv[++i] ?? "");
    else if (arg === "--concurrency") opts.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else opts.filters.push(arg);
  }
  if (opts.serial) opts.concurrency = 1;
  return opts;
}

/** Test files in `dir`, sorted, narrowed by substring filters on the file name. */
export function collect(dir: string, filters: string[]): string[] {
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
  const kept = filters.length
    ? names.filter((name) => filters.some((f) => name.includes(f)))
    : names;
  return kept.map((name) => path.join(dir, name));
}

function runner(root: string): { command: string; prefix: string[] } {
  const local = path.join(root, "node_modules", ".bin", "tsx");
  return fs.existsSync(local) ? { command: local, prefix: [] } : { command: "npx", prefix: ["tsx"] };
}

function runOne(file: string, root: string): Promise<Result> {
  const { command, prefix } = runner(root);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, file], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => {
      resolve({ file, name: path.basename(file), code: 1, ms: Date.now() - started, output: `${output}\nfailed to spawn: ${String(error)}` });
    });
    child.on("close", (code) => {
      resolve({ file, name: path.basename(file), code: code ?? 1, ms: Date.now() - started, output });
    });
  });
}

/** Run every file with at most `concurrency` children alive, printing as they land. */
export async function runAll(files: string[], root: string, concurrency: number): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      const result = await runOne(files[index], root);
      results.push(result);
      const status = result.code === 0 ? "PASS" : "FAIL";
      console.log(`${status}  ${result.name.padEnd(40)} ${`${(result.ms / 1000).toFixed(1)}s`.padStart(7)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  const root = repoRoot();
  const opts = parseArgs(process.argv.slice(2), root);
  if (!fs.existsSync(opts.dir)) {
    console.error(`test dir not found: ${opts.dir}`);
    process.exit(2);
  }
  const files = collect(opts.dir, opts.filters);
  if (!files.length) {
    console.error(`no *.test.ts files in ${opts.dir}${opts.filters.length ? ` matching ${opts.filters.join(", ")}` : ""}`);
    process.exit(2);
  }

  console.log(`running ${files.length} test file(s) from ${opts.dir}${opts.concurrency > 1 ? ` (concurrency ${opts.concurrency})` : " (serial)"}\n`);
  const started = Date.now();
  const results = await runAll(files, root, opts.concurrency);
  const failed = results.filter((r) => r.code !== 0).sort((a, b) => a.name.localeCompare(b.name));

  for (const result of failed) {
    console.log(`\n${"-".repeat(72)}\nFAIL ${result.name} (exit ${result.code})\n${"-".repeat(72)}`);
    console.log(result.output.trimEnd() || "(no output)");
  }

  const total = ((Date.now() - started) / 1000).toFixed(1);
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${results.length - failed.length}/${results.length} passed in ${total}s`);
  console.log(`slowest: ${slowest.map((r) => `${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(", ")}`);
  if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(", ")}`);
  console.log("=".repeat(72));

  process.exit(failed.length ? 1 : 0);
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
