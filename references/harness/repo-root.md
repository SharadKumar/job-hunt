# Resolving the repository root

`AGENTS.md` section 1 is the rule; this page is the one-liner every skill and agent links to.

Never trust the current working directory. Resolve the root first and treat its output as the base for every path in the workflow:

- Shell: `bash .claude/hooks/repo-root.sh`
- TypeScript: `repoRoot()` from `tools/repo-root.ts`
- Profile-scoped paths: `resolveProfileContext()` from `tools/profile-context.ts` (`HARNESS_PROFILE=<id>` or `--profile <id>` switches to `state/profiles/<id>/`)

Under the sandbox, prefix npm calls with `TMPDIR=/tmp`.
