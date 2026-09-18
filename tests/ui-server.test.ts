#!/usr/bin/env tsx
/**
 * ui-server.test.ts — how the UI server is told where to listen.
 *
 * tools/ui/api.ts is covered by ui-api.test.ts; what is left is the part that
 * only exists at the process boundary: the flag/environment precedence a
 * supervisor relies on. `portless` (https://portless.sh) runs the server with
 * PORT, HOST and PORTLESS_URL set and proxies a stable https name to it, so
 * PORT has to be honoured with no flag at all, an explicit --port still has to
 * win, PORTLESS_URL has to be the address printed, and the non-local bind must
 * still refuse without a token no matter who set HOST.
 *
 * Each case runs the real CLI in a child process, because that is the only
 * place argv and the environment meet. Ports are always 0 (an ephemeral port
 * the kernel picks), so the suite never fights another process for 7788.
 *
 * Run: npx tsx tests/ui-server.test.ts   (exit 0 = all pass)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "tools/ui/server.ts");
const DEFAULT_PORT = 7788;
const START_TIMEOUT_MS = 30_000;

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function tsxRunner(): { command: string; prefix: string[] } {
  const local = path.join(ROOT, "node_modules", ".bin", "tsx");
  return fs.existsSync(local) ? { command: local, prefix: [] } : { command: "npx", prefix: ["tsx"] };
}

type Run = { code: number | null; stdout: string; stderr: string };

/**
 * Start the CLI, wait until it has either printed its "ctrl-c to stop" banner
 * or exited, then kill it. The banner is the last line `main` prints, so
 * seeing it means every start line is already in `stdout`.
 */
function runServer(env: Record<string, string>, args: string[] = []): Promise<Run> {
  const { command, prefix } = tsxRunner();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, SERVER, ...args], {
      cwd: ROOT,
      // A clean-ish environment: PATH and HOME are needed to run node at all,
      // everything else is what the case is about.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group. `tsx` is a wrapper that re-executes node, so
      // signalling the pid we hold would leave the actual server alive, still
      // holding the port and this test's pipes open.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = () => {
      clearTimeout(timer);
      try { process.kill(-(child.pid as number), "SIGKILL"); } catch { /* already gone */ }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error(`server did not start within ${START_TIMEOUT_MS}ms\n${stdout}\n${stderr}`));
    }, START_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ctrl-c to stop")) finish(null);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => finish(code));
  });
}

/** The port in the `ui: http://host:port/` line the CLI prints. */
function boundPort(stdout: string): number {
  const line = stdout.split("\n").find((l) => /^ui: (bound )?http:\/\//.test(l));
  assert.ok(line, `no bound url in:\n${stdout}`);
  return Number(new URL(line.replace(/^ui: (bound )?/, "")).port);
}

await test("PORT is honoured when there is no --port", async () => {
  const run = await runServer({ PORT: "0" });
  const port = boundPort(run.stdout);
  assert.ok(port > 0, "the kernel gave it a port");
  assert.notEqual(port, DEFAULT_PORT, "PORT=0 was read, rather than falling through to the default");
});

await test("with no --port and no PORT it falls back to the default", async () => {
  // Nothing is bound here: asserting the *resolution* is enough, and binding
  // 7788 for real would collide with the person's own running UI.
  const { resolvePort, resolveHost } = await import("../tools/ui/server.ts");
  assert.equal(resolvePort(undefined, {}), DEFAULT_PORT);
  assert.equal(resolvePort(undefined, { PORT: "7799" }), 7799);
  assert.equal(resolvePort("7801", { PORT: "7799" }), 7801, "the flag wins");
  assert.equal(resolvePort("", { PORT: "7799" }), null, "an empty --port is an error, not the environment's turn");
  assert.equal(resolvePort("banana", {}), null);
  assert.equal(resolvePort(true, {}), null, "a bare --port has no value");
  assert.equal(resolveHost(undefined, {}), "127.0.0.1");
  assert.equal(resolveHost(undefined, { HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveHost("127.0.0.1", { HOST: "0.0.0.0" }), "127.0.0.1", "the flag wins");
});

await test("an explicit --port beats PORT", async () => {
  // --port 0 is still explicit: if PORT won, the server would be on 7788.
  const run = await runServer({ PORT: String(DEFAULT_PORT) }, ["--port", "0"]);
  const port = boundPort(run.stdout);
  assert.ok(port > 0);
  assert.notEqual(port, DEFAULT_PORT, "the flag decided the port, not the environment");
});

await test("PORTLESS_URL is the address the start line advertises", async () => {
  const run = await runServer({ PORT: "0", PORTLESS_URL: "https://job-hunt.localhost:8443" });
  assert.match(run.stdout, /^ui: https:\/\/job-hunt\.localhost:8443$/m, run.stdout);
  assert.match(run.stdout, /^ui: bound http:\/\/127\.0\.0\.1:\d+\/$/m, "the real socket is still named");

  const plain = await runServer({ PORT: "0" });
  assert.doesNotMatch(plain.stdout, /localhost:8443/);
  assert.doesNotMatch(plain.stdout, /^ui: bound /m, "with no proxy there is only one url to print");
});

await test("HOST alone cannot put the pipeline on the network", async () => {
  const run = await runServer({ PORT: "0", HOST: "0.0.0.0" });
  assert.equal(run.code, 2, `expected exit 2, got ${run.code}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /HARNESS_UI_TOKEN/, "it says what is missing");
  assert.doesNotMatch(run.stdout, /^ui: /m, "nothing was bound");

  const withToken = await runServer({ PORT: "0", HOST: "127.0.0.1", HARNESS_UI_TOKEN: "s3cret" });
  assert.match(withToken.stdout, /token required on \/api/, "a token is honoured on a local bind too");
});

console.log(`ui-server.test.ts: ${passed} assertions passed`);
