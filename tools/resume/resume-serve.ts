#!/usr/bin/env tsx
/**
 * resume-serve.ts — tiny dependency-free static server for state/profile/.
 *
 * Exists so the resume index (and the PDFs / PNGs it links) can be browsed in a
 * real browser: file:// URLs will not render a PDF inline consistently, and the
 * index is regenerated in-process on every request to /resumes/index.html so
 * what you see is always current.
 *
 * Localhost only (127.0.0.1) — these are personal artefacts, never expose them.
 *
 * CLI:
 *   tsx tools/resume/resume-serve.ts [--port 4173] [--profile <id>] [--open]
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProfileContext } from "../profile-context.ts";
import { writeResumeIndex } from "./resume-index.ts";

const HOST = "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Resolve a URL path inside `root`, refusing anything that escapes it. */
export function resolveWithinRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const target = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function directoryListing(root: string, dir: string, urlPath: string): Promise<string> {
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  const base = urlPath.endsWith("/") ? urlPath : `${urlPath}/`;
  const rows = entries.map((e) => {
    const href = encodeURI(base + e.name + (e.isDirectory() ? "/" : ""));
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(e.name)}${e.isDirectory() ? "/" : ""}</a></li>`;
  });
  const parent = base === "/" ? "" : `<li><a href="${escapeHtml(encodeURI(path.posix.dirname(base.replace(/\/$/, "")) || "/"))}">../</a></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(path.relative(root, dir) || "/")}</title>`
    + `<style>:root{color-scheme:light dark}body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:24px}`
    + `ul{list-style:none;padding:0}li{padding:2px 0}</style></head><body>`
    + `<h1>${escapeHtml("/" + (path.relative(root, dir) || ""))}</h1><ul>${parent}${rows.join("")}</ul></body></html>`;
}

export type ServeOptions = { port?: number; profileId?: string | null; root?: string; open?: boolean };

export async function startResumeServer(options: ServeOptions = {}): Promise<{ server: http.Server; url: string; port: number; root: string }> {
  const context = resolveProfileContext(options.profileId ?? null);
  const root = path.resolve(options.root ?? context.profileDir);
  const indexPath = path.join(context.renderedResumesDir, "index.html");
  const indexUrlPath = "/" + (path.relative(root, indexPath).split(path.sep).join("/"));

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`500 ${String(error)}`);
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = (req.url ?? "/").split("?")[0];
    if (urlPath === "/" || urlPath === "") {
      res.writeHead(302, { location: indexUrlPath });
      res.end();
      return;
    }

    // Always rebuild the index so a reload reflects the current state files.
    if (urlPath === indexUrlPath) {
      await writeResumeIndex({ profileId: options.profileId ?? null, outPath: indexPath });
    }

    const target = resolveWithinRoot(root, urlPath);
    if (!target) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("403 forbidden");
      return;
    }

    const stat = await fs.stat(target).catch(() => null);
    if (!stat) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 not found");
      return;
    }

    if (stat.isDirectory()) {
      const dirIndex = path.join(target, "index.html");
      if (await fs.stat(dirIndex).then(() => true).catch(() => false)) {
        res.writeHead(302, { location: (urlPath.endsWith("/") ? urlPath : urlPath + "/") + "index.html" });
        res.end();
        return;
      }
      const body = await directoryListing(root, target, urlPath);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
      return;
    }

    const type = contentTypeFor(target);
    const headers: Record<string, string> = {
      "content-type": type,
      "content-length": String(stat.size),
      "cache-control": "no-store",
    };
    // Office documents can't render in-browser; hand them over as a download.
    if (type.includes("wordprocessingml") || type === "application/msword") {
      headers["content-disposition"] = `attachment; filename="${path.basename(target)}"`;
    }
    res.writeHead(200, headers);
    res.end(await fs.readFile(target));
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : (options.port ?? 0));
    });
  });

  const url = `http://${HOST}:${port}${indexUrlPath}`;
  if (options.open && process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }
  return { server, url, port, root };
}

/* -------------------------------------------------------------------- cli */

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [flag, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) { args[flag] = inline; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[flag] = next; i += 1; } else { args[flag] = true; }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = typeof args.port === "string" ? Number(args.port) : 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port '${String(args.port)}'`);
    process.exit(2);
  }
  const profileId = typeof args.profile === "string" && args.profile !== "default" ? args.profile : null;
  const { url, root } = await startResumeServer({ port, profileId, open: Boolean(args.open) });
  console.log(`resume-serve: serving ${root}`);
  console.log(`resume-serve: ${url}`);
  console.log("resume-serve: ctrl-c to stop");
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
