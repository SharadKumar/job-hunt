---
name: hunt
description: Search the user's enabled job channels for new roles, classify them in-agent, score with persisted agent classification, and ingest the keepers. Use whenever the user asks to "find roles", "scan jobs", "check Seek/LinkedIn/HN", "look for new contracts", "see what's out there", or wants fresh roles for a specific channel. Args: `[channel|all] [--since=Nd]`, defaulting to `all` and `--since=7d`.
---

# /hunt — discover new roles

Search the user's enabled job channels for fresh roles, classify them with agent judgement, then score and ingest the keepers.

## What to do

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

Invoke the `opportunity-finder` subagent. Pass it any channel filter from the arguments. It:

1. Reads `state/profile/channels.yaml`.
2. Runs `npm run hunt:<channel> -- --upsert` for each enabled (or filtered) channel.
3. Dedups against `state/pipeline/opportunities.json`.
4. Classifies each new discovered role in-agent, writes `state/pipeline/classifications.json`, then runs `npm run pipeline:rescore -- --classifications state/pipeline/classifications.json`.
5. Hands off to `state-syncer` to mirror to the Sheet.

## Surface to the user

A short summary: per-channel counts, total new roles, top 5 by score (title + company + score + top match reason + URL), and any channels that need attention (login expired, search failed). If a channel returns > 50 results, ask via `AskUserQuestion` whether to show top-10-by-score, top-10-by-recency, or all — don't flood.

## Boundaries

- Read-only. Hunt never submits, never sends.
- If invoked just after a previous hunt (within the rate-limit window in `channels.yaml`), skip channels that ran recently and tell the user.
