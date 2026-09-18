/**
 * tools/setup.ts — deterministic first-run checks and scaffolding.
 *
 * The `/setup` skill drives a new person from a fresh clone to autopilot. It
 * must not guess at machine state, so every prerequisite is a check here that
 * prints one JSON object the agent can act on. Nothing in this file asks a
 * question or edits a file the person owns, except `scaffold`, which only ever
 * copies a template into a path that does not yet exist.
 *
 *   npm run setup:check                 # every check, JSON, exit 0/1
 *   npm run setup:check -- --stage 3    # one stage only
 *   npm run setup:scaffold              # copy templates/profile/* into state/profile/ (never overwrites)
 *   npm run setup:scaffold -- --profile <id>   # team mode: state/profiles/<id>/
 *
 * Stages mirror the /setup skill and the README "Getting started":
 *   0 machine      node, poppler, playwright chromium, .env
 *   1 profile      state/profile files present, profile.md frontmatter valid, no TODO placeholders in required fields
 *   2 cv           cv-source.md present with experience headers
 *   3 positionings resumes.yaml has active entries
 *   4 baselines    each active resume has an approved baseline (metadata.json hash matches)
 *   5 channels     enabled channels have a persisted login
 *   6 sheet        env set, key file readable, spreadsheet reachable
 *   7 schedule     launchd job loaded (macOS only)
 *   8 autopilot    policy state and what would still block a send
 */

import { readYamlIfExists } from "./lib/fs.ts";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import YAML from "yaml";
import { huntScriptFor } from "./channels/_interface.ts";
import { repoPath } from "./repo-root.ts";
import { resolveProfileContext } from "./profile-context.ts";

const exec = promisify(execFile);

type Check = { id: string; ok: boolean; detail: string; fix?: string };
type Stage = {
  stage: number;
  name: string;
  ok: boolean;
  /** The stage does not apply to this profile at all (the Sheet, switched off). */
  skipped?: boolean;
  /** The stage reports but never blocks: a failing check here is information. */
  informational?: boolean;
  checks: Check[];
  /** Stage 9 only: the portless proxy, when it is on this machine. */
  portless?: { installed: boolean; url: string | null };
};

/** The local approval UI's launchd job and its default bind address. */
const UI_LABEL = "com.job-hunt-harness.ui";
/** The portless service name scripts/install-ui-launchd.sh registers. */
const UI_PORTLESS_NAME = "job-hunt";
const UI_HOST = "127.0.0.1";
const UI_PORT = Number(process.env.HARNESS_UI_PORT ?? 7788);
const UI_PROBE_MS = 300;

/** Is something answering on host:port? A short probe; any failure is a "no". */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer: boolean) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const PROFILE_FILES = [
  "profile.md", "channels.yaml", "submission-policy.yaml", "scoring-weights.yaml",
  "screening-answers.yaml", "skills-taxonomy.yaml", "voice-samples.md",
  "resume-editorial-rules.md", "editorial-bans.yaml", "market-confirmations.yaml", "resumes.yaml", "letter-critic-rules.yaml",
];

async function cmdOk(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try { const { stdout, stderr } = await exec(bin, args); return { ok: true, out: (stdout || stderr).trim().split("\n")[0] }; }
  catch (e: any) { return { ok: false, out: String(e?.message ?? e).split("\n")[0] }; }
}

/** Tolerant on purpose: setup reports a malformed config as "not configured yet". */
async function readYaml(p: string): Promise<any | null> {
  return readYamlIfExists(p).catch(() => null);
}

/* ------------------------------------------------------------ stages */

async function stageMachine(): Promise<Stage> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node", ok: major >= 20, detail: `node ${process.versions.node}`, fix: "install Node 20 or newer" });
  const pdfinfo = await cmdOk("pdfinfo", ["-v"]);
  checks.push({ id: "poppler", ok: pdfinfo.ok, detail: pdfinfo.out, fix: "brew install poppler" });
  const pdftoppm = await cmdOk("pdftoppm", ["-v"]);
  checks.push({ id: "poppler_pdftoppm", ok: pdftoppm.ok, detail: pdftoppm.out, fix: "brew install poppler" });
  let chromium = false; let chromiumDetail = "not found";
  try {
    const { chromium: c } = await import("playwright");
    const p = c.executablePath();
    chromium = existsSync(p); chromiumDetail = chromium ? p : `missing ${p}`;
  } catch (e: any) { chromiumDetail = String(e?.message ?? e).split("\n")[0]; }
  checks.push({ id: "playwright_chromium", ok: chromium, detail: chromiumDetail, fix: "npx playwright install chromium" });
  const envExists = existsSync(repoPath(".env"));
  checks.push({ id: "env_file", ok: envExists, detail: envExists ? ".env present" : ".env missing", fix: "cp .env.example .env" });
  return { stage: 0, name: "machine", ok: checks.every((c) => c.ok), checks };
}

async function stageProfile(profileId: string | null): Promise<Stage> {
  const ctx = resolveProfileContext(profileId);
  const checks: Check[] = [];
  for (const f of PROFILE_FILES) {
    const p = path.join(ctx.profileDir, f);
    checks.push({ id: `file:${f}`, ok: existsSync(p), detail: existsSync(p) ? "present" : "missing", fix: "npm run setup:scaffold" });
  }
  try {
    const raw = await fs.readFile(ctx.profileMdPath, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    const fm = m ? YAML.parse(m[1]) : null;
    const required = ["name", "email", "citizenship", "location"] as const;
    const missing = required.filter((k) => !fm?.[k]);
    const placeholders = required.filter((k) => typeof fm?.[k] === "string" && /TODO|Jane Citizen|example\.com/i.test(fm[k]));
    checks.push({ id: "frontmatter", ok: !!fm && missing.length === 0, detail: fm ? (missing.length ? `missing ${missing.join(", ")}` : "valid") : "no frontmatter", fix: "fill the frontmatter in profile.md" });
    checks.push({ id: "frontmatter_filled", ok: placeholders.length === 0, detail: placeholders.length ? `placeholder values in ${placeholders.join(", ")}` : "no placeholders", fix: "replace the placeholder values in profile.md" });
    // Only live lines count: commented-out examples and the "replace every TODO" instruction do not.
    const todos = raw.split("\n").filter((l) => !/^\s*#/.test(l) && !/every TODO/i.test(l) && /\bTODO\b/.test(l)).length;
    checks.push({ id: "profile_todos", ok: todos === 0, detail: `${todos} TODO marker(s) in profile.md`, fix: "resolve each TODO in profile.md (the /setup skill asks about them)" });
  } catch {
    checks.push({ id: "frontmatter", ok: false, detail: "profile.md unreadable", fix: "npm run setup:scaffold" });
  }
  // Words the person added beyond the skeleton: total minus the template's own instructions.
  const voice = await fs.readFile(path.join(ctx.profileDir, "voice-samples.md"), "utf8").catch(() => "");
  const tmpl = await fs.readFile(repoPath("templates/profile/voice-samples.md"), "utf8").catch(() => "");
  const words = (t: string) => t.replace(/\[paste[^\]]*\]/g, "").split(/\s+/).filter(Boolean).length;
  const sampleWords = Math.max(0, words(voice) - words(tmpl));
  checks.push({ id: "voice_samples", ok: sampleWords >= 200, detail: `${sampleWords} words of pasted samples`, fix: "paste at least 200 words of your own emails / posts into voice-samples.md" });
  return { stage: 1, name: "profile", ok: checks.every((c) => c.ok), checks };
}

async function stageCv(profileId: string | null): Promise<Stage> {
  const ctx = resolveProfileContext(profileId);
  const checks: Check[] = [];
  const raw = await fs.readFile(ctx.cvSourcePath, "utf8").catch(() => "");
  const headers = (raw.match(/^### /gm) || []).length;
  checks.push({ id: "cv_source", ok: raw.length > 0, detail: raw ? `${raw.length} chars` : "missing", fix: "npm run markdownify:cv -- --source /path/to/master-cv.docx" });
  checks.push({ id: "cv_experiences", ok: headers >= 3, detail: `${headers} role header(s)`, fix: "the parsed CV needs at least 3 '### ' role headers; check the .docx headings" });
  const meta = await readYaml(path.join(ctx.profileDir, "cv", "meta.yaml"));
  checks.push({ id: "cv_meta", ok: !!meta?.source_file, detail: meta?.source_file ? `source ${meta.source_file}` : "cv/meta.yaml missing source_file", fix: "markdownify:cv writes this; or set source_file by hand" });
  return { stage: 2, name: "cv", ok: checks.every((c) => c.ok), checks };
}

async function stagePositionings(profileId: string | null): Promise<Stage> {
  const ctx = resolveProfileContext(profileId);
  const y = await readYaml(ctx.resumesPath);
  const list: any[] = Array.isArray(y?.resumes) ? y.resumes : [];
  const active = list.filter((r) => r?.active !== false && r?.id);
  const checks: Check[] = [
    { id: "resumes_yaml", ok: !!y, detail: y ? "parses" : "missing or invalid", fix: "npm run setup:scaffold, then /onboarding" },
    { id: "active_positionings", ok: active.length > 0, detail: `${active.length} active`, fix: "run /onboarding to create positionings from your CV" },
  ];
  return { stage: 3, name: "positionings", ok: checks.every((c) => c.ok), checks };
}

async function stageBaselines(profileId: string | null): Promise<Stage> {
  const ctx = resolveProfileContext(profileId);
  const y = await readYaml(ctx.resumesPath);
  const active: any[] = (Array.isArray(y?.resumes) ? y.resumes : []).filter((r: any) => r?.active !== false && r?.id);
  const checks: Check[] = [];
  for (const r of active) {
    const meta = await readYaml(path.join(ctx.renderedResumesDir, r.id, "metadata.json")).catch(() => null)
      ?? await fs.readFile(path.join(ctx.renderedResumesDir, r.id, "metadata.json"), "utf8").then(JSON.parse).catch(() => null);
    const approved = !!meta && meta.approval_status === "approved" && meta.content_hash && meta.content_hash === meta.approved_hash;
    checks.push({ id: `baseline:${r.id}`, ok: approved, detail: meta ? `${meta.approval_status ?? "unknown"}${meta.content_hash && meta.content_hash !== meta.approved_hash ? " (stale)" : ""}` : "not rendered", fix: `/resume-review (or /resume-render ${r.id})` });
  }
  if (active.length === 0) checks.push({ id: "baselines", ok: false, detail: "no active positionings", fix: "complete stage 3 first" });
  return { stage: 4, name: "baselines", ok: checks.every((c) => c.ok), checks };
}

async function stageChannels(profileId: string | null): Promise<Stage> {
  const ctx = resolveProfileContext(profileId);
  const y = await readYaml(path.join(ctx.profileDir, "channels.yaml"));
  const channels = y?.channels ?? {};
  const checks: Check[] = [];
  const sessions: Record<string, string[]> = {
    seek: ["state/channels/storage-state/seek.json", "state/channels/chrome-profile/seek"],
    linkedin_jobs: ["state/channels/chrome-profile/linkedin/Default/Cookies", "state/channels/chrome-profile/linkedin"],
    linkedin_posts: ["state/channels/chrome-profile/linkedin"],
  };
  const enabled = Object.entries(channels).filter(([, v]: any) => v?.enabled).map(([k]) => k);
  checks.push({ id: "channels_enabled", ok: enabled.length > 0, detail: enabled.length ? enabled.join(", ") : "none enabled", fix: "enable seek and/or linkedin_jobs in channels.yaml" });
  for (const id of enabled) {
    const adapter = huntScriptFor(id);
    if (!adapter.ok) {
      checks.push({ id: `adapter:${id}`, ok: false, detail: adapter.reason, fix: `disable ${id} in channels.yaml or write tools/channels/${id}.ts` });
      continue;
    }
    const paths = sessions[id];
    if (!paths) { checks.push({ id: `session:${id}`, ok: true, detail: "no login needed" }); continue; }
    const ok = paths.some((p) => existsSync(repoPath(p)));
    const login = id.startsWith("linkedin") ? "npm run login:linkedin" : `npm run login:${id}`;
    checks.push({ id: `session:${id}`, ok, detail: ok ? "session present" : "no saved session", fix: login });
  }
  return { stage: 5, name: "channels", ok: checks.every((c) => c.ok), checks };
}

async function stageSheet(profileId: string | null): Promise<Stage> {
  // The Sheet is optional and, from WP4.3, retirable: `sheet.enabled: false`
  // in submission-policy.yaml means the local UI is the approval surface and
  // there is nothing here to configure. Skipped, not blocked.
  const policy = await readYaml(path.join(resolveProfileContext(profileId).profileDir, "submission-policy.yaml"));
  if (policy?.sheet?.enabled === false) {
    return {
      stage: 6, name: "sheet", ok: true, skipped: true,
      checks: [{ id: "sheet", ok: true, detail: "disabled (sheet.enabled: false); the local UI is the approval surface", fix: "set sheet.enabled: true in submission-policy.yaml to mirror to a Google Sheet again" }],
    };
  }
  const checks: Check[] = [];
  const env = await fs.readFile(repoPath(".env"), "utf8").catch(() => "");
  const get = (k: string) => (process.env[k] || env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] || "").trim();
  // .env.example ships placeholder values; treat them as unset so the Sheet stays optional until real values land.
  const unset = (v: string) => !v || /\/path\/to\//.test(v) || /^<.*>$/.test(v);
  const cred = unset(get("GOOGLE_APPLICATION_CREDENTIALS")) ? "" : get("GOOGLE_APPLICATION_CREDENTIALS");
  const sid = unset(get("SHEETS_SPREADSHEET_ID")) ? "" : get("SHEETS_SPREADSHEET_ID");
  const credOk = !!cred && existsSync(cred.replace(/^~/, process.env.HOME || ""));
  checks.push({ id: "sheet_credentials", ok: credOk, detail: cred ? (credOk ? "key file readable" : `key file not found at ${cred}`) : "GOOGLE_APPLICATION_CREDENTIALS unset", fix: "download the service-account JSON and set GOOGLE_APPLICATION_CREDENTIALS in .env" });
  checks.push({ id: "sheet_id", ok: !!sid, detail: sid ? "set" : "SHEETS_SPREADSHEET_ID unset", fix: "create an empty Sheet, share it with the service-account email as Editor, set SHEETS_SPREADSHEET_ID in .env" });
  if (credOk && sid) {
    try {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = cred.replace(/^~/, process.env.HOME || "");
      const { google } = await import("googleapis");
      const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
      const sheets = google.sheets({ version: "v4", auth: (await auth.getClient()) as any });
      const r = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: "properties.title,sheets.properties.title" });
      const tabs = (r.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
      checks.push({ id: "sheet_reachable", ok: true, detail: `"${r.data.properties?.title}" tabs: ${tabs.join(", ") || "(none yet)"}`, fix: "npm run sheets:sync creates the tabs" });
    } catch (e: any) {
      checks.push({ id: "sheet_reachable", ok: false, detail: String(e?.message ?? e).split("\n")[0], fix: "share the Sheet with the service-account email (client_email in the JSON key) as Editor" });
    }
  }
  const optional = !cred && !sid;
  return { stage: 6, name: "sheet", ok: optional || checks.every((c) => c.ok), checks: optional ? [{ id: "sheet", ok: true, detail: "not configured (optional; phone Tray disabled)" }] : checks };
}

async function stageSchedule(): Promise<Stage> {
  const checks: Check[] = [];
  if (process.platform !== "darwin") {
    return { stage: 7, name: "schedule", ok: true, checks: [{ id: "launchd", ok: true, detail: "not macOS; schedule scripts/daily.sh with cron yourself" }] };
  }
  const label = "com.job-hunt-harness.daily";
  const plist = path.join(process.env.HOME || "", "Library", "LaunchAgents", `${label}.plist`);
  const plistText = existsSync(plist) ? await fs.readFile(plist, "utf8") : "";
  const pointsHere = plistText.includes(repoPath("."));
  checks.push({ id: "plist", ok: existsSync(plist) && pointsHere, detail: !existsSync(plist) ? "not installed" : pointsHere ? plist : `installed but points at another checkout, not ${repoPath(".")}`, fix: "bash scripts/install-launchd.sh" });
  const loaded = await cmdOk("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/${label}`]);
  checks.push({ id: "loaded", ok: loaded.ok, detail: loaded.ok ? "loaded" : "not loaded", fix: "bash scripts/install-launchd.sh" });
  const env = await fs.readFile(repoPath(".env"), "utf8").catch(() => "");
  const cli = env.match(/^HARNESS_CLI=(.*)$/m)?.[1]?.trim();
  checks.push({ id: "harness_cli", ok: cli === "claude" || cli === "codex", detail: cli ? `HARNESS_CLI=${cli}` : "HARNESS_CLI unset (daily.sh defaults to codex)", fix: "set HARNESS_CLI=claude or codex in .env" });
  return { stage: 7, name: "schedule", ok: checks.every((c) => c.ok), checks };
}

async function stageAutopilot(profileId: string | null): Promise<Stage> {
  const ctx = resolveProfileContext(profileId);
  const y = await readYaml(path.join(ctx.profileDir, "submission-policy.yaml"));
  const checks: Check[] = [];
  checks.push({ id: "policy", ok: !!y, detail: y ? "parses" : "missing", fix: "npm run setup:scaffold" });
  if (y) {
    checks.push({ id: "kill_switch", ok: y.kill_switch !== true, detail: `kill_switch: ${y.kill_switch}`, fix: "set kill_switch: false when ready" });
    checks.push({ id: "autopilot_enabled", ok: y.autopilot?.enabled === true, detail: `autopilot.enabled: ${y.autopilot?.enabled ?? "unset"}`, fix: "set autopilot.enabled: true after a few attended applications" });
    const ch: string[] = y.autopilot?.channels ?? [];
    checks.push({ id: "autopilot_channels", ok: ch.length > 0, detail: ch.length ? ch.join(", ") : "none", fix: "list seek and/or linkedin_jobs under autopilot.channels" });
  }
  return { stage: 8, name: "autopilot", ok: checks.every((c) => c.ok), checks };
}

/**
 * Stage 9: the local approval UI (`npm run ui`).
 *
 * Informational on purpose. The UI is a convenience, not a prerequisite, so a
 * missing plist or a silent port must never block `ready_for_autopilot`; the
 * stage reports what is true and the /setup skill offers to install it.
 */
async function stageUi(): Promise<Stage> {
  const checks: Check[] = [];
  const plist = path.join(process.env.HOME || "", "Library", "LaunchAgents", `${UI_LABEL}.plist`);
  if (process.platform !== "darwin") {
    checks.push({ id: "plist", ok: true, detail: "not macOS; run `npm run ui` yourself, or supervise it with your init system" });
  } else {
    const plistText = existsSync(plist) ? await fs.readFile(plist, "utf8").catch(() => "") : "";
    const pointsHere = plistText.includes(repoPath("."));
    checks.push({
      id: "plist",
      ok: !!plistText && pointsHere,
      detail: !plistText ? "not installed" : pointsHere ? plist : `installed but points at another checkout, not ${repoPath(".")}`,
      fix: "bash scripts/install-ui-launchd.sh",
    });
  }
  const answering = await tcpProbe(UI_HOST, UI_PORT, UI_PROBE_MS);
  checks.push({
    id: "port",
    ok: answering,
    detail: `${UI_HOST}:${UI_PORT} ${answering ? "answering" : `not answering (${UI_PROBE_MS} ms probe)`}`,
    fix: `npm run ui -- --port ${UI_PORT}`,
  });
  // portless is a nicety, never a requirement: it swaps the port for a stable
  // https://job-hunt.localhost name. Report it when it is here, say nothing
  // more than "not installed" when it is not, and never fail on it.
  const portlessVersion = await cmdOk("portless", ["--version"]);
  const portlessUrl = portlessVersion.ok ? await cmdOk("portless", ["get", UI_PORTLESS_NAME]) : { ok: false, out: "" };
  const portless = {
    installed: portlessVersion.ok,
    url: portlessVersion.ok && portlessUrl.ok && portlessUrl.out.startsWith("http") ? portlessUrl.out : null,
  };
  checks.push({
    id: "portless",
    ok: true,
    detail: !portless.installed
      ? "not installed (optional; https://portless.sh gives the UI a stable https name)"
      : portless.url
        ? portless.url
        : `installed, no route named ${UI_PORTLESS_NAME}`,
    fix: portless.installed && !portless.url ? "bash scripts/install-ui-launchd.sh" : undefined,
  });
  return { stage: 9, name: "ui", ok: true, informational: true, checks, portless };
}

/* ------------------------------------------------------------ scaffold */

async function scaffold(profileId: string | null): Promise<{ created: string[]; skipped: string[] }> {
  const ctx = resolveProfileContext(profileId);
  const src = repoPath("templates/profile");
  const created: string[] = []; const skipped: string[] = [];
  async function walk(rel: string) {
    for (const e of await fs.readdir(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { await walk(r); continue; }
      const dest = path.join(ctx.profileDir, r);
      if (existsSync(dest)) { skipped.push(r); continue; }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(src, r), dest);
      created.push(r);
    }
  }
  await walk("");
  for (const d of ["state/pipeline/archive", "state/audit", "state/journal/launchd", "state/channels/chrome-profile", "state/channels/storage-state", path.relative(repoPath("."), path.join(ctx.renderedResumesDir))]) {
    await fs.mkdir(repoPath(d), { recursive: true });
  }
  if (!existsSync(repoPath(".env")) && existsSync(repoPath(".env.example"))) { await fs.copyFile(repoPath(".env.example"), repoPath(".env")); created.push(".env"); }
  return { created, skipped };
}

/* ------------------------------------------------------------ main */

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "check";
  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  const profileId = args.profile ?? process.env.HARNESS_PROFILE ?? null;

  if (cmd === "scaffold") {
    const r = await scaffold(profileId);
    console.log(JSON.stringify({ profile_dir: resolveProfileContext(profileId).profileDir, ...r, next: "fill state/profile/profile.md, then npm run setup:check" }, null, 2));
    return;
  }
  if (cmd !== "check") { console.error("Usage: tsx tools/setup.ts (check|scaffold) [--stage N] [--profile <id>]"); process.exit(2); }

  const all = [
    () => stageMachine(), () => stageProfile(profileId), () => stageCv(profileId), () => stagePositionings(profileId),
    () => stageBaselines(profileId), () => stageChannels(profileId), () => stageSheet(profileId), () => stageSchedule(),
    () => stageAutopilot(profileId), () => stageUi(),
  ];
  const wanted = args.stage !== undefined ? [Number(args.stage)] : all.map((_, i) => i);
  const stages: Stage[] = [];
  for (const i of wanted) stages.push(await all[i]());
  const firstBlocked = stages.find((s) => !s.ok);
  const out = {
    profile_dir: resolveProfileContext(profileId).profileDir,
    ready_for_autopilot: stages.every((s) => s.ok),
    next_stage: firstBlocked ? { stage: firstBlocked.stage, name: firstBlocked.name, fixes: firstBlocked.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.fix ?? c.detail}`) } : null,
    stages,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ready_for_autopilot ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
