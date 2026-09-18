---
name: rate-check
description: Snapshot the market: median/p25/p75 day-rates for the user's target role families plus top in-demand skills, computed from the harness's recent role scrapes. Use when the user asks "what's the going rate", "rate intel", "what skills are hot right now", "is my rate competitive", "what's the market doing", or wants to know whether to adjust their target band. Arg: `[--days=30]`.
---

# /rate-check: market intel snapshot

Look across the recent role scrapes for what the market is actually paying for the user's target role-family, and what skills it's asking for.

## What to do

Resolve the repo root first (`references/harness/repo-root.md`).

Invoke the `research` subagent with `--mode market`. It produces:

- `state/market/rate-intel.md`: median, p25, p75, count for stated day-rates over the window, broken down by role-family keyword.
- `state/market/skills-trends.md`: top 20 most-mentioned skills/keywords.
- A "what's changed" callout if there's a previous snapshot to diff against.

Surface a 5-line summary in the conversation (medians by family, two notable trends, anything anomalous).

## When to ask

- < 10 data points for a role family → ask: "Show low-confidence partial / widen to 60 days / skip?"
- Median has moved > 10% vs previous snapshot → ask after surfacing: "Update your profile target rate to track / save the observation but keep current target / no-op?"

## Boundaries

- Read-only against state. Doesn't change profile unless the user explicitly opts in.
- Don't recommend rate changes from a small sample.
