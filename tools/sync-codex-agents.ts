#!/usr/bin/env tsx
/**
 * sync-codex-agents.ts — generate Codex agent wrappers from canonical agents.
 *
 * Claude Code reads `agents/*.md` directly. Codex agent definitions in
 * `.codex/agents/*.toml` are TOML wrappers, so they cannot be a direct symlink
 * to the Markdown files. This script makes the Markdown files the single
 * source of truth and keeps Codex wrappers deterministic.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

type Frontmatter = {
  name?: string;
  description?: string;
  model?: string;
  tools?: string;
};

const CLAUDE_MODEL_ALIASES = new Set(["haiku", "sonnet", "opus"]);

function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error("missing YAML frontmatter");

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    const [, key, rawValue] = field;
    frontmatter[key as keyof Frontmatter] = rawValue.trim().replace(/^"(.*)"$/, "$1");
  }

  return { frontmatter, body: text.slice(match[0].length) };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexModelLine(model: string | undefined): string {
  if (!model || CLAUDE_MODEL_ALIASES.has(model.toLowerCase())) return "";
  return `model = ${tomlString(model)}`;
}

function parseClaudeToolNames(rawTools: string | undefined): Set<string> {
  if (!rawTools) return new Set();

  const bracketed = rawTools.match(/^\[(.*)\]$/);
  const body = bracketed ? bracketed[1] : rawTools;
  return new Set(
    body
      .split(",")
      .map((tool) => tool.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean),
  );
}

function codexToolsLine(rawTools: string | undefined): string {
  const tools = parseClaudeToolNames(rawTools);
  const entries: string[] = [];

  // Claude Code's Bash/Read/Write/Edit/Glob/Grep tools are core Codex tools,
  // not fields in Codex's ToolsToml. AskUserQuestion is also Claude-specific;
  // Codex exec cannot request interactive input, so do not enable it here.
  if (tools.has("WebFetch")) entries.push("web_search = true");

  return entries.length ? `tools = { ${entries.join(", ")} }` : "";
}

async function generateOne(sourcePath: string, outDir: string): Promise<string> {
  const source = await fs.readFile(sourcePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(source);
  const name = frontmatter.name || path.basename(sourcePath, ".md");
  if (!frontmatter.description) throw new Error(`${sourcePath}: missing description`);

  const generated = [
    "# Generated from ../agents/" + path.basename(sourcePath) + " by `npm run codex:sync-agents`.",
    "# Do not edit by hand; edit the canonical Markdown agent instead.",
    `name = ${tomlString(name)}`,
    `description = ${tomlString(frontmatter.description)}`,
    codexModelLine(frontmatter.model),
    codexToolsLine(frontmatter.tools),
    `developer_instructions = ${tomlString(body.trim() + "\n")}`,
    "",
  ].filter(Boolean).join("\n");

  const outputPath = path.join(outDir, `${name}.toml`);
  await fs.writeFile(outputPath, generated);
  return outputPath;
}

async function main() {
  const agentsDir = "agents";
  const outDir = ".codex/agents";
  await fs.mkdir(outDir, { recursive: true });

  const generated = new Set<string>();
  for (const entry of await fs.readdir(agentsDir)) {
    if (!entry.endsWith(".md")) continue;
    const outputPath = await generateOne(path.join(agentsDir, entry), outDir);
    generated.add(path.basename(outputPath));
  }

  for (const entry of await fs.readdir(outDir)) {
    if (entry.endsWith(".toml") && !generated.has(entry)) {
      await fs.rm(path.join(outDir, entry));
    }
  }

  console.log(JSON.stringify({ outDir, generated: [...generated].sort() }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
