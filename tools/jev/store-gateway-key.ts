#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import { repoPath } from "../repo-root.ts";

async function stdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

function findSecret(raw: string): string {
  const direct = raw.match(/\b(vck_[A-Za-z0-9_-]{20,})\b/)?.[1];
  if (direct) return direct;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {}
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string" && /^(?:vck_|ai_gateway_)[A-Za-z0-9_-]{20,}$/.test(value)) values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(parsed);
  if (values.length !== 1) throw new Error(`Expected exactly one gateway secret, found ${values.length}`);
  return values[0];
}

async function main(): Promise<void> {
  const secret = findSecret(await stdin());
  const file = repoPath(".env.local");
  let existing = "";
  try { existing = await fs.readFile(file, "utf8"); } catch {}
  const kept = existing.split(/\r?\n/).filter((line) => !/^\s*AI_GATEWAY_API_KEY=/.test(line) && line.trim() !== "");
  const next = [...kept, `AI_GATEWAY_API_KEY=${secret}`].join("\n") + "\n";
  await fs.writeFile(file, next, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  console.log(JSON.stringify({ stored: true, path: ".env.local", variable: "AI_GATEWAY_API_KEY", permissions: "0600" }));
}

main().catch((error) => { console.error(JSON.stringify({ stored: false, error: (error as Error).message })); process.exit(1); });
