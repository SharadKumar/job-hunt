/**
 * tools/lib/args.ts — the shared CLI argument grammar.
 *
 * Grammar:
 *   --key value   → flags.key = "value"
 *   --key=value   → flags.key = "value"  (an empty `--key=` gives "")
 *   --flag        → flags.flag = true    (boolean, not the string "true")
 *   anything else → positionals, in order
 *
 * A lone `--` is NOT a passthrough separator here: it parses as an
 * empty-named flag. `npm run x -- --flag` strips npm's own `--` before argv,
 * so this has never mattered in practice.
 *
 * A flag whose next token also starts with `--` is boolean: `--json --out x`
 * yields `{ json: true, out: "x" }`. A trailing `--flag` is boolean too. So a
 * value that itself starts with `--` must be passed as `--key=--value`.
 *
 * Note for anyone migrating an older copy: much of this repo grew a variant
 * that returned `Record<string, string>` with the STRING "true" for a bare
 * flag and no `--key=value` support, and its callers test `args.x === "true"`.
 * Those are not this grammar; do not swap one for the other without rewriting
 * the call site's comparisons.
 */

export type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { positionals, flags };
}
