---
name: hunt
description: Search the user's enabled job channels for new roles, classify them through Jev, score deterministically, and ingest the keepers. Use whenever the user asks to "find roles", "scan jobs", "check Seek/LinkedIn/HN", "look for new contracts", "see what's out there", or wants fresh roles for a specific channel. Args: `[channel|all] [--since=Nd]`, defaulting to `all` and `--since=7d`.
---

Paths: `<profile>/` is the profile directory (`npm run -s profile:path`), `<archive>/` the per-opportunity package folders (`npm run -s store:path -- archive`), `<pipeline>/` pipeline side files (`npm run -s store:path -- pipeline`) and `<journal>/` run reports and logs (`npm run -s store:path -- journal`). In file mode they are the folders under `state/`; on the Twenty store they are the run's materialised cache and log folders, and edits to `<profile>/` documents are saved when the run finishes (`npm run -s store:finish`): machine documents as new revisions, the person's documents as proposals they confirm in Twenty. Append to the day's journal with `npm run -s journal -- append --from <file>`.

# /hunt: discover new roles

Search the user's enabled job channels for fresh roles, classify them through the bounded decision layer, then score and ingest the keepers.

## What to do

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

Invoke the `opportunity-finder` subagent. Pass it any channel filter from the arguments. It:

1. Reads `<profile>/channels.yaml`.
2. Runs `npm run hunt:<channel> -- --upsert` for each enabled (or filtered) channel. A `hunt:` script exists only for `seek`, `linkedin-jobs` (alias `linkedin_jobs`), `linkedin-posts` and `hn`; any other enabled channel has no scraper and is reported, not improvised.
3. Dedups against the pipeline store, read through `npm run pipeline -- list` / `get`.
4. Runs `npm run jev:classify`. This persists ClassificationV2 directly in SQLite, leaves uncertain rows unpromoted, and applies deterministic scoring.
5. Hands off to `state-syncer` to mirror to the Sheet.

## Surface to the user

A short summary: per-channel counts, total new roles, top 5 by score (title + company + score + top match reason + URL), and any channels that need attention (login expired, search failed). If a channel returns > 50 results, ask via `AskUserQuestion` whether to show top-10-by-score, top-10-by-recency, or all; don't flood.

## Boundaries

- Read-only. Hunt never submits, never sends.
- If invoked just after a previous hunt (within the rate-limit window in `channels.yaml`), skip channels that ran recently and tell the user.
