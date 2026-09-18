/**
 * Report syntax highlighting: HTML escaping plus the tiny JSON and YAML
 * colourisers the report's source-file panels use.
 *
 * No dependency on the report model: it takes text and gives back safe HTML,
 * which is why it can sit underneath both the model and the renderer.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function attr(value: unknown): string {
  return escapeHtml(value);
}

export function inferCodeLanguage(filePathOrLabel: string): string {
  const lower = filePathOrLabel.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return "";
}

export function highlightJson(text: string): string {
  const tokenPattern = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let highlighted = "";
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    highlighted += escapeHtml(text.slice(lastIndex, index));

    if (match[1]) {
      const className = match[2] ? "sh-key" : "sh-string";
      highlighted += `<span class="${className}">${escapeHtml(match[1])}</span>${escapeHtml(match[2] ?? "")}`;
    } else if (match[3]) {
      highlighted += `<span class="sh-${match[3] === "null" ? "null" : "boolean"}">${escapeHtml(match[3])}</span>`;
    } else {
      highlighted += `<span class="sh-number">${escapeHtml(match[0])}</span>`;
    }

    lastIndex = index + match[0].length;
  }

  return highlighted + escapeHtml(text.slice(lastIndex));
}

function highlightYamlValue(value: string): string {
  const commentMatch = value.match(/^(\s*)(#.*)$/);
  if (commentMatch) return `${escapeHtml(commentMatch[1])}<span class="sh-comment">${escapeHtml(commentMatch[2])}</span>`;

  const inlineComment = value.match(/^(.*?)(\s+#.*)$/);
  const body = inlineComment ? inlineComment[1] : value;
  const comment = inlineComment ? inlineComment[2] : "";
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|\b(true|false|null|yes|no|on|off)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gi;
  let highlighted = "";
  let lastIndex = 0;

  for (const match of body.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    highlighted += escapeHtml(body.slice(lastIndex, index));

    if (token.startsWith("\"") || token.startsWith("'")) highlighted += `<span class="sh-string">${escapeHtml(token)}</span>`;
    else if (/^-?\d/.test(token)) highlighted += `<span class="sh-number">${escapeHtml(token)}</span>`;
    else highlighted += `<span class="${token.toLowerCase() === "null" ? "sh-null" : "sh-boolean"}">${escapeHtml(token)}</span>`;

    lastIndex = index + token.length;
  }

  highlighted += escapeHtml(body.slice(lastIndex));
  return highlighted + (comment ? `<span class="sh-comment">${escapeHtml(comment)}</span>` : "");
}

export function highlightYaml(text: string): string {
  return text.split("\n").map((line) => {
    const commentMatch = line.match(/^(\s*)(#.*)$/);
    if (commentMatch) return `${escapeHtml(commentMatch[1])}<span class="sh-comment">${escapeHtml(commentMatch[2])}</span>`;

    const keyMatch = line.match(/^(\s*)(-\s+)?([A-Za-z0-9_.-]+)(\s*:\s*)(.*)$/);
    if (keyMatch) {
      const [, indent, marker = "", key, colon, value] = keyMatch;
      return `${escapeHtml(indent)}${marker ? `<span class="sh-yaml-marker">${escapeHtml(marker)}</span>` : ""}<span class="sh-key">${escapeHtml(key)}</span>${escapeHtml(colon)}${highlightYamlValue(value)}`;
    }

    const listMatch = line.match(/^(\s*-\s+)(.*)$/);
    if (listMatch) return `<span class="sh-yaml-marker">${escapeHtml(listMatch[1])}</span>${highlightYamlValue(listMatch[2])}`;

    return highlightYamlValue(line);
  }).join("\n");
}

export function highlightCode(text: string, language: string): string {
  if (language === "json") return highlightJson(text);
  if (language === "yaml" || language === "yml") return highlightYaml(text);
  return escapeHtml(text);
}
