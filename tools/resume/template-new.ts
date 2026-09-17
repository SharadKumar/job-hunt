#!/usr/bin/env tsx
/**
 * template-new.ts — scaffold a new CV template from an existing one.
 *
 * A template is now DATA (a design declaration consumed by
 * `templates/resume/_html-template.ts` `defineHtmlTemplate`), not code, so
 * creating one is a copy plus a handful of renames. Doing it by hand reliably
 * forgot something — the rubric's `template:` key, the golden, the smoke test —
 * and a half-scaffolded template fails late, inside a resume render.
 *
 * This copies the six files that define a template, rewrites the identity in
 * each, then immediately generates the golden and runs the template smoke check
 * so the new template is proven before anyone points a resume at it.
 *
 * Usage:
 *   npm run resume:template:new -- --name <new> --from <existing>
 *                                 [--layout single|skills-columns]
 *                                 [--font "Family=File.woff2"]   (repeatable)
 *                                 [--dpi 130]
 *
 * A `--font` value names a WOFF2 already bundled under `templates/resume/fonts/`
 * (drop the file there first). Style is inferred from the filename (`italic`);
 * the weight range defaults to `100 900` for a variable font. Repeat the flag
 * per face. Given any `--font`, the copied font list is replaced wholesale.
 *
 * Afterwards: edit `<name>/styles.css` (that IS the design), then re-run
 * `npm run resume:design:golden -- --template <name>` and commit the PNGs.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateGolden } from "./resume-golden.ts";
import { repoPath } from "../repo-root.ts";

const exec = promisify(execFile);
const TEMPLATES_DIR = repoPath("templates/resume");
const FONTS_DIR = path.join(TEMPLATES_DIR, "fonts");
const LAYOUTS = ["single", "skills-columns"] as const;

type Layout = (typeof LAYOUTS)[number];

export type ScaffoldArgs = {
  name: string;
  from: string;
  layout?: Layout;
  fonts?: string[];
  dpi?: number;
  /** Skip golden generation + smoke check (tests use this). */
  skipVerify?: boolean;
};

export type ScaffoldResult = {
  dir: string;
  files: string[];
  goldenPngs: string[];
  smoke?: string;
};

class ScaffoldError extends Error {}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** `Family=File.woff2` → a `FontFace` literal for the design object. */
function fontFaceLiteral(spec: string): { family: string; file: string; line: string } {
  const match = spec.match(/^\s*(.+?)\s*=\s*(\S+\.woff2)\s*$/i);
  if (!match) throw new ScaffoldError(`--font "${spec}" is malformed. Expected --font "Family Name=File.woff2".`);
  const family = match[1];
  const file = match[2];
  const style = /italic/i.test(file) ? "italic" : "normal";
  return {
    family,
    file,
    line: `    { family: ${JSON.stringify(family)}, style: "${style}", weightRange: "100 900", file: ${JSON.stringify(file)} },`,
  };
}

/** Swap the leading block comment, the identity fields, the fonts and the layout. */
function rewriteRender(source: string, args: { name: string; from: string; layout?: Layout; fontLines?: string[] }): string {
  if (!/defineHtmlTemplate\s*\(/.test(source)) {
    throw new ScaffoldError(
      `Template '${args.from}' does not use defineHtmlTemplate(); it cannot be scaffolded from. ` +
      `Migrate it to templates/resume/_html-template.ts first, or pick another --from.`,
    );
  }

  const header = `/**
 * ${args.name} / render.ts — scaffolded from '${args.from}' on ${today()}.
 *
 *   - presentation → shared HTML builder + ${args.name}/styles.css + bundled
 *     fonts → Playwright PDF (the designed artefact a human reads).
 *   - ats → the ONE shared plain single-column .docx (_ats-docx.ts).
 *
 * The render body is shared (\`_html-template.ts\`); this file is the design.
 * Edit styles.css for the visual identity, template.md for persona fit and
 * composition constraints, and rubric.yaml for the line-unit budgets — then
 * regenerate the golden.
 */`;
  let out = source.replace(/^\/\*\*[\s\S]*?\*\//, header);

  const before = out;
  out = out.replace(/(\n\s*name:\s*)"[^"]*"/, `$1${JSON.stringify(args.name)}`);
  out = out.replace(/(\n\s*design:\s*)"[^"]*"/, `$1${JSON.stringify(args.name)}`);
  if (out === before) throw new ScaffoldError(`Could not rewrite the name/design fields in ${args.from}/render.ts.`);

  if (args.fontLines?.length) {
    const replaced = out.replace(/\n\s*fonts:\s*\[[\s\S]*?\n\s*\],/, `\n  fonts: [\n${args.fontLines.join("\n")}\n  ],`);
    if (replaced === out) throw new ScaffoldError(`Could not locate the fonts array in ${args.from}/render.ts to replace.`);
    out = replaced;
  }

  if (args.layout) {
    out = out.replace(/\n\s*layout:\s*"[^"]*",/g, "");
    const anchored = out.replace(/(\n};\n\nexport default defineHtmlTemplate)/, `\n  layout: "${args.layout}",$1`);
    if (anchored === out) throw new ScaffoldError(`Could not locate the design object terminator in ${args.from}/render.ts to add a layout.`);
    out = anchored;
  }

  return out;
}

function rewriteRubric(source: string, args: { name: string; from: string }): string {
  const out = source.replace(/^template:\s*.+$/m, `template: ${args.name}`);
  if (out === source) throw new ScaffoldError(`Could not find a 'template:' key in ${args.from}/rubric.yaml.`);
  return `${out.replace(/\s*$/, "")}\n`;
}

function rewriteTemplateMd(source: string, args: { name: string; from: string; layout?: Layout }): string {
  const stamp = today();
  const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) throw new ScaffoldError(`${args.from}/template.md has no YAML frontmatter to rewrite.`);

  const keep = frontmatterMatch[1]
    .split("\n")
    .filter((line) => !/^(template|version|added_at|last_updated|design_file|notes):/.test(line));
  const frontmatter = [
    `template: ${args.name}`,
    "version: 1",
    `added_at: ${stamp}`,
    `last_updated: ${stamp}`,
    `design_file: templates/resume/${args.name}/styles.css`,
    `notes: Scaffolded from '${args.from}'; styles.css and composition constraints not yet reviewed.`,
    ...keep,
  ].join("\n");

  const body = source
    .slice(frontmatterMatch[0].length)
    .replace(new RegExp(`templates/resume/${args.from}/`, "g"), `templates/resume/${args.name}/`)
    .replace(/^#\s+.*$/m, `# ${args.name} — scaffolded from \`${args.from}\``);

  const scaffoldNote = [
    "",
    "## Scaffold status",
    "",
    `Created ${stamp} by \`npm run resume:template:new -- --name ${args.name} --from ${args.from}\`.`,
    args.layout && args.layout !== "single"
      ? `Layout: \`${args.layout}\` — the skills block renders in CSS columns and is marked \`data-flow="secondary"\`, so page-fit arithmetic counts primary-flow lines only.`
      : "Layout: `single` — one semantic column, every rendered line counts toward page fit.",
    "",
    `The design, persona fit and composition constraints below are INHERITED FROM \`${args.from}\` and are not yet a signed-off identity for this template. Edit \`styles.css\` (the design), then this file, then regenerate the golden.`,
    "",
  ].join("\n");

  // Slot the note directly under the H1 so the file still reads as a document.
  const withNote = body.replace(/^(#\s+.*)$/m, `$1\n${scaffoldNote}`);
  return `---\n${frontmatter}\n---\n${withNote === body ? scaffoldNote + body : withNote}`;
}

function rewriteQualityChecks(source: string, args: { name: string; from: string }): string {
  // ONE pass. Rewriting paths and then bare names would double-substitute when
  // the new name contains the old one (modern → modern-columns → …-columns-columns).
  return source.replace(new RegExp(`\\b${args.from}\\b`, "g"), args.name);
}

/** Copy + rewrite the six files that define a template, then prove it renders. */
export async function scaffoldTemplate(args: ScaffoldArgs): Promise<ScaffoldResult> {
  const { name, from } = args;

  if (!name) throw new ScaffoldError("--name is required.");
  if (!from) throw new ScaffoldError("--from is required (an existing template to copy).");
  if (name.startsWith("_")) throw new ScaffoldError(`Refusing '${name}': names starting with '_' are reserved for shared infra files.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ScaffoldError(`Refusing '${name}': use lowercase letters, digits and hyphens.`);
  if (args.layout && !LAYOUTS.includes(args.layout)) throw new ScaffoldError(`--layout must be one of: ${LAYOUTS.join(", ")}.`);

  const sourceDir = path.join(TEMPLATES_DIR, from);
  const targetDir = path.join(TEMPLATES_DIR, name);
  if (!(await exists(path.join(sourceDir, "render.ts")))) throw new ScaffoldError(`Source template '${from}' not found at ${sourceDir}/render.ts.`);
  if (await exists(targetDir)) throw new ScaffoldError(`Refusing to overwrite: ${targetDir} already exists.`);

  const fontLines: string[] = [];
  for (const spec of args.fonts ?? []) {
    const face = fontFaceLiteral(spec);
    if (!(await exists(path.join(FONTS_DIR, face.file)))) {
      throw new ScaffoldError(`Font file ${face.file} is not bundled at ${FONTS_DIR}/. Copy the WOFF2 there first.`);
    }
    fontLines.push(face.line);
  }

  const read = (file: string) => fs.readFile(path.join(sourceDir, file), "utf8");
  const renderSource = await read("render.ts");
  const stylesSource = await read("styles.css");
  const rubricSource = await read("rubric.yaml");
  const qualitySource = await read("quality-checks.md").catch(() => "");
  const templateMdSource = await read("template.md");
  const sampleSource = await fs.readFile(path.join(sourceDir, "sample", "sample-content.json"), "utf8").catch(() => null);

  // Rewrite everything BEFORE creating the directory, so a malformed source
  // leaves no half-built template behind.
  const written: Array<[string, string]> = [
    ["render.ts", rewriteRender(renderSource, { name, from, layout: args.layout, fontLines })],
    ["styles.css", stylesSource],
    ["rubric.yaml", rewriteRubric(rubricSource, { name, from })],
    ["template.md", rewriteTemplateMd(templateMdSource, { name, from, layout: args.layout })],
  ];
  if (qualitySource) written.push(["quality-checks.md", rewriteQualityChecks(qualitySource, { name, from })]);
  if (sampleSource) written.push([path.join("sample", "sample-content.json"), sampleSource]);

  await fs.mkdir(path.join(targetDir, "sample"), { recursive: true });
  for (const [file, contents] of written) await fs.writeFile(path.join(targetDir, file), contents);

  const files = written.map(([file]) => path.join(targetDir, file));
  for (const file of files) console.log(`[template:new] wrote ${file}`);

  if (args.skipVerify) return { dir: targetDir, files, goldenPngs: [] };

  // Prove it: the golden is the visual sign-off surface, the smoke check is the
  // structural one. A template that cannot do both is not a template.
  const goldenPngs = sampleSource ? await generateGolden(name, args.dpi ?? 130) : [];
  if (!sampleSource) console.warn(`[template:new] ${from} has no sample/sample-content.json — no golden generated.`);

  let smoke: string | undefined;
  try {
    const { stdout } = await exec("npx", ["tsx", "tools/resume/check-templates.ts", "--template", name]);
    smoke = stdout.trim();
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    smoke = (e.stdout ?? "").trim() || (e.stderr ?? "").trim();
  }
  if (smoke) console.log(`[template:new] smoke: ${smoke}`);

  return { dir: targetDir, files, goldenPngs, smoke };
}

function parseArgs(argv: string[]): ScaffoldArgs {
  const out: Record<string, string> = {};
  const fonts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (key === "font") fonts.push(value);
    else out[key] = value;
  }
  return {
    name: out.name ?? "",
    from: out.from ?? "",
    layout: out.layout as Layout | undefined,
    fonts,
    dpi: out.dpi ? Number(out.dpi) : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name || !args.from) {
    console.error('Usage: npm run resume:template:new -- --name <new> --from <existing> [--layout single|skills-columns] [--font "Family=File.woff2"] [--dpi 130]');
    process.exit(2);
  }
  const result = await scaffoldTemplate(args);
  console.log(`[template:new] ${args.name} ready at ${result.dir}. Next: edit styles.css, then re-run \`npm run resume:design:golden -- --template ${args.name}\`.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof ScaffoldError ? `[template:new] ${error.message}` : error);
    process.exit(1);
  });
}
