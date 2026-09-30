import { spawn } from "node:child_process";

/** Bound the whole child process group, not just npm's parent process. */
export async function boundedCommand(command: string, args: string[], opts: {
  cwd: string; timeoutMs: number; graceMs?: number;
}): Promise<{ stdout: string; stderr: string; exit_code: number; timed_out: boolean }> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const cap = 20 * 1024 * 1024;
    child.stdout.on("data", b => { stdout = (stdout + b).slice(-cap); });
    child.stderr.on("data", b => { stderr = (stderr + b).slice(-cap); });
    const signal = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, sig); } catch (error: any) {
        if (error.code !== "ESRCH") child.kill(sig);
      }
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      grace = setTimeout(() => signal("SIGKILL"), opts.graceMs ?? 5000);
    }, opts.timeoutMs);
    child.once("error", error => { clearTimeout(timer); if (grace) clearTimeout(grace); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      // Even if the parent exits first, ensure grandchildren cannot keep writing.
      if (timedOut) signal("SIGKILL");
      if (grace) clearTimeout(grace);
      resolve({ stdout, stderr, exit_code: timedOut ? 124 : code ?? 1, timed_out: timedOut });
    });
  });
}
