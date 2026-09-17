#!/usr/bin/env tsx
/**
 * tools/ui/server.ts — the local web UI: a dependency-free node:http server in
 * front of tools/ui/api.ts and the static front end in tools/ui/static/.
 *
 * It exists so the person can qualify roles, read a prepared package and drain
 * keyword questions from a browser on their own machine, without a Google
 * Sheet and without a phone. It is a decision surface, never a send surface:
 * every action it exposes is the Sheet's own Tray action, applied through
 * `applyTrayAction`, and nothing here contacts an external system.
 *
 * Binding is local by default and stays that way unless the person opts out
 * explicitly. A non-local host demands HARNESS_UI_TOKEN in the environment and
 * a matching `Authorization: Bearer <token>` on every /api request; without the
 * token the server refuses to start rather than putting the pipeline (and the
 * person's letters) on the network unauthenticated.
 *
 * Port and host also come from the environment, because that is how a
 * supervisor hands them over: `portless` (https://portless.sh) runs the server
 * with PORT, HOST and PORTLESS_URL set and proxies https://job-hunt.localhost
 * to it, so `npm run ui:portless` needs no flags at all. An explicit flag
 * always wins over the environment, and the environment always wins over the
 * built-in defaults. PORTLESS_URL is display only: it is the address the
 * person should open, while the socket stays exactly where it was bound.
 *
 * CLI:
 *   npm run ui -- [--port 7788] [--host 127.0.0.1] [--open]
 *   npm run ui:portless              # portless supplies PORT/HOST/PORTLESS_URL
 */

import http from "node:http";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../lib/args.ts";
import { handleApi, type ApiContext } from "./api.ts";

const DEFAULT_PORT = 7788;
const DEFAULT_HOST = "127.0.0.1";
/** A decision body is a few hundred bytes; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 1_000_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = path.join(HERE, "static");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Loopback only. Everything else is "on the network" and needs a token. */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * The reason this binding must not start, or null when it may. Separated from
 * `startUiServer` so the CLI can print it and exit 2 before opening a socket,
 * and so a test can assert the rule without binding anything.
 */
export function bindingError(host: string, token: string | null | undefined): string | null {
  if (isLocalHost(host) || token) return null;
  return `refusing to bind ${host}: a non-local host exposes the pipeline, so HARNESS_UI_TOKEN must be set `
    + "and every /api request must send Authorization: Bearer <token>. "
    + `Use --host ${DEFAULT_HOST} for local-only access.`;
}

/** True when the request may touch /api. A configured token is always required. */
export function authorised(authorization: string | undefined, token: string | null): boolean {
  if (!token) return true;
  return String(authorization ?? "").trim() === `Bearer ${token}`;
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

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`body is not JSON: ${error?.message ?? error}`);
  }
}

export type UiServerOptions = {
  port?: number;
  host?: string;
  open?: boolean;
  /** Null or undefined means no token is required (local binding only). */
  token?: string | null;
  staticDir?: string;
  ctx?: ApiContext;
};

export type UiServer = {
  server: http.Server;
  /** Where the socket actually is. */
  url: string;
  /** PORTLESS_URL when a proxy is in front of us, else null. */
  publicUrl: string | null;
  port: number;
  host: string;
  staticDir: string;
};

/** A non-empty environment variable, or null. An empty string is "unset". */
export function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * The port to bind: an explicit `--port` first, then PORT from the
 * environment (how portless and most supervisors pass it), then the default.
 * Returns null when what was given is not a port, so the CLI can say so and
 * exit rather than binding something surprising.
 */
export function resolvePort(flag: string | boolean | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = flag === undefined ? envValue("PORT", env) : flag;
  if (raw === null) return DEFAULT_PORT;
  // A bare `--port` and an empty `--port=` are both mistakes, and `Number("")`
  // is 0, which would quietly bind an ephemeral port instead of saying so.
  if (typeof raw === "boolean" || !raw.trim()) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/** The host to bind: `--host` first, then HOST, then loopback. */
export function resolveHost(flag: string | boolean | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof flag === "string" && flag.trim()) return flag.trim();
  return envValue("HOST", env) ?? DEFAULT_HOST;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const host = options.host ?? DEFAULT_HOST;
  const token = options.token ?? process.env.HARNESS_UI_TOKEN ?? null;
  const staticDir = path.resolve(options.staticDir ?? DEFAULT_STATIC_DIR);
  const ctx = options.ctx ?? {};

  const blocker = bindingError(host, token);
  if (blocker) throw new Error(blocker);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    void handle(req, res)
      .catch((error) => {
        if (!res.headersSent) send(res, 500, { error: String(error?.message ?? error) });
        else res.end();
      })
      .finally(() => {
        console.error(`[ui] ${req.method ?? "?"} ${req.url ?? "/"} ${res.statusCode} ${Date.now() - started}ms`);
      });
  });

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? null);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = url.pathname;

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (!authorised(req.headers.authorization, token)) {
        send(res, 401, { error: "unauthorised: send Authorization: Bearer <HARNESS_UI_TOKEN>" });
        return;
      }
      let body: unknown = {};
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        try {
          body = await readBody(req);
        } catch (error: any) {
          send(res, 400, { error: String(error?.message ?? error) });
          return;
        }
      }
      const result = await handleApi({ method: req.method ?? "GET", pathname, query: url.searchParams, body }, ctx);
      // A handler that names a file gets it written out as itself: a page PNG
      // or a PDF is not JSON. The gate above has already run, so a streamed
      // artefact is as protected as every other /api response.
      if (result.stream) {
        const data = await fsp.readFile(result.stream).catch(() => null);
        if (!data) {
          send(res, 404, { error: `not found: ${pathname}` });
          return;
        }
        res.writeHead(result.status, {
          "content-type": "application/octet-stream",
          ...(result.headers ?? {}),
          "content-length": data.length,
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : data);
        return;
      }
      send(res, result.status, result.body);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: `${req.method} not allowed on ${pathname}` });
      return;
    }
    await serveStatic(res, pathname);
  }

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    // An extensionless path is a front-end route, so it falls back to the app
    // shell. A path that names a file (.js, .css, .png) does not: a missing
    // asset must read as 404, not as a page of HTML with the wrong mime type.
    const wantsShell = pathname === "/" || pathname === "" || path.extname(pathname) === "";
    const target = wantsShell
      ? path.join(staticDir, "index.html")
      : resolveWithinRoot(staticDir, pathname);

    if (!target) {
      send(res, 403, { error: "forbidden" });
      return;
    }

    let data: Buffer;
    try {
      data = await fsp.readFile(target);
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") {
        send(res, 404, {
          error: wantsShell
            ? `no front end at ${path.join(staticDir, "index.html")}; the API is still served under /api`
            : `not found: ${pathname}`,
        });
        return;
      }
      throw error;
    }

    res.writeHead(200, {
      "content-type": contentTypeFor(target),
      "content-length": data.length,
      "cache-control": "no-store",
    });
    res.end(data);
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : (options.port ?? DEFAULT_PORT));
    });
  });

  const url = `http://${host}:${port}/`;
  // Behind portless the loopback URL still works, but it is not the one the
  // person's browser should hold: cookies, storage and the certificate all
  // belong to the proxied name.
  const publicUrl = envValue("PORTLESS_URL");
  if (options.open && process.platform === "darwin") {
    spawn("open", [publicUrl ?? url], { stdio: "ignore", detached: true }).unref();
  }
  return { server, url, publicUrl, port, host, staticDir };
}

/* -------------------------------------------------------------------- cli */

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const port = resolvePort(flags.port);
  if (port === null) {
    console.error(`[ui] invalid port '${String(flags.port ?? process.env.PORT)}'`);
    process.exit(2);
  }
  const host = resolveHost(flags.host);
  const token = process.env.HARNESS_UI_TOKEN ?? null;

  const blocker = bindingError(host, token);
  if (blocker) {
    console.error(`[ui] ${blocker}`);
    process.exit(2);
  }

  const { url, publicUrl, staticDir } = await startUiServer({ port, host, token, open: Boolean(flags.open) });
  console.log(`ui: serving ${staticDir}`);
  console.log(`ui: ${publicUrl ?? url}`);
  if (publicUrl) console.log(`ui: bound ${url}`);
  console.log(token ? "ui: token required on /api (HARNESS_UI_TOKEN)" : "ui: local only, no token required");
  console.log("ui: ctrl-c to stop");
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`[ui] ${error?.message ?? error}`);
    process.exit(1);
  });
}
