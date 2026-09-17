---
name: prep-interview
description: Produce a one-page interview brief for an upcoming interview — company snapshot, 3–5 STAR scenarios from the user's CV, likely questions, questions to ask. Use when the user mentions "interview tomorrow", "prep for X interview", "got an interview with company Y", "brief me for this one", "interview prep", or supplies an opportunity-id with interview-prep intent. Argument is the opportunity-id.
---

# /prep-interview — one-page brief for an upcoming interview

## What to do

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

Invoke the `research` subagent with `--mode interview --opportunity-id <id>`. It produces `state/pipeline/archive/<opportunity-id>/interview-brief.md` containing:

- **Company snapshot**: size, focus, recent news, why they're hiring (sourced from the company's own pages first).
- **STAR scenarios** (3–5): drawn from `state/profile/cv-source.md`, mapped to likely themes for this opportunity. Each in the user's voice (calibrated against `state/profile/voice-samples.md`), slop- and voice-checked.
- **Likely questions** (6–10): technical + behavioural for this seniority + role family.
- **Questions to ask them** (5): scope, team, success measures, gaps in the role, budget reality.

Optionally surface the brief in the conversation or just give the path.

## When to ask

Before kicking off:
- Multiple likely interview formats for this opportunity → ask: "Focus brief on panel format (most common) / take-home prep / live coding exercise / all three (longer)?"
- If the company has more than one obvious online identity (consultancy vs end-user with same name) → confirm with the URL of which one to research.

## Boundaries

- Don't fabricate STAR scenarios. Every claim ties to an actual CV bullet.
- Don't recommend lying about experience to fit the JD better. If there's a real gap, surface it so the user can address it head-on in the interview.
