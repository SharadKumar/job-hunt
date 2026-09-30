import { promises as fs } from "node:fs";
import { repoPath } from "../repo-root.ts";

let loading: Promise<void> | null = null;

/** Load the ignored local environment file without overwriting process env. */
export async function loadLocalEnv(): Promise<void> {
  loading ??= (async () => {
    for (const file of [repoPath(".env.local"), repoPath(".env")]) {
      let text: string;
      try { text = await fs.readFile(file, "utf8"); } catch { continue; }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match || process.env[match[1]] != null) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        process.env[match[1]] = value;
      }
    }
  })();
  await loading;
}

export async function gatewayCredential(): Promise<string | null> {
  await loadLocalEnv();
  return process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? null;
}
