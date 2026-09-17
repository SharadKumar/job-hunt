---
name: setup
description: Guided first-run setup on a new machine, from a fresh clone to autopilot. Use when the user says "set me up", "get this running", "new machine", "configure the harness", "connect my Google Sheet", "log in to SEEK / LinkedIn", "turn on autopilot", or when `npm run setup:check` reports a blocked stage, or when session start finds no profile. Checks the machine, scaffolds the profile, asks the questions the profile needs, ingests the CV, hands off to /onboarding and /resume-review, logs the channels in, connects the Sheet, installs the daily schedule, and switches autopilot on. Works the same under Claude Code and Codex.
---

# /setup — from clone to autopilot

You are walking a person through their first run. They may know nothing about this repo. Be brief, ask in batches with the structured question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex; fall back to a numbered plain-text list only if neither exists), and never guess at machine state: `npm run setup:check` is the source of truth for what is done and what is next.

Resolve the repo root first (`bash .claude/hooks/repo-root.sh`) and treat it as the base for every path.

## Loop

```
TMPDIR=/tmp npm run -s setup:check
```

Read `next_stage`. Do that stage (below), re-run the check, continue until `ready_for_autopilot: true`. Never skip a stage because it "looks done"; the check decides. If the person wants to stop early, tell them the command to resume (`/setup`) and which stage they are at.

If the check itself fails to run (missing `node_modules`), run `npm install` first.

## Stage 0: machine

For each failing check, show the `fix` command and ask the person to run it themselves (`! brew install poppler`, `! npx playwright install chromium`). These need their shell and sometimes a password; do not run package installs on their behalf without asking. `cp .env.example .env` you may do.

## Stage 1: profile

1. `npm run setup:scaffold` (idempotent; copies `templates/profile/*` into `state/profile/`, never overwrites).
2. Ask, in two batches of at most four questions each, for the facts `profile.md` needs. Batch A: full name, email, phone, city and country. Batch B: citizenship / work rights, current security clearance (none is a fine answer), target day rate (or salary) and floor, work arrangement (remote / hybrid with a days-onsite cap / onsite). Then one more batch: role families they want (2 to 3, in priority order), engagement type (contract / permanent / both), industries to avoid, LinkedIn URL.
3. Write the answers into `state/profile/profile.md`: frontmatter fields and the prose sections. Replace every `TODO` you have an answer for. Leave a `TODO` only where the person said "skip", and tell them it stays flagged.
4. Voice samples: ask them to paste 3 to 5 emails or posts they wrote (at least 200 words total) into `state/profile/voice-samples.md` between the fences, or paste them into the chat and you place them. Explain in one sentence why (the letters are written in their voice, checked against these).
5. Re-run the check. `profile_todos` and `voice_samples` must pass before moving on.

## Stage 2: CV

Ask for the path to their master CV `.docx`. Run `npm run markdownify:cv -- --source "<path>"`. Open `state/profile/cv-source.md`, show them the role headers the parser found, and ask whether any role is missing or mangled. Fix by editing the markdown (not the .docx). This file is the only evidence every CV and letter may draw on; say so once.

## Stage 3: positionings

Invoke the `onboarding` skill. It proposes 3 to 6 positionings from the CV and writes `resumes.yaml`. Return here when it finishes.

## Stage 4: baselines

Invoke the `resume-review` skill. It renders every active positioning through `resume-writer`, runs the audit and the critic, and walks the person through approval. This is the longest stage (several minutes per positioning); tell them that up front. Return here when every baseline is approved.

## Stage 5: channels

1. Ask which channels to enable: SEEK (Australia), LinkedIn Jobs, LinkedIn hiring posts, HN Who is Hiring. Set `enabled: true` in `state/profile/channels.yaml` for the chosen ones; set the `location` / `geo` fields from the profile.
2. For SEEK and LinkedIn, the login is theirs to do: tell them to run `! npm run login:seek` and `! npm run login:linkedin`. Each opens a browser; they log in once; the session persists under `state/channels/`. Wait for them to say it is done, then re-run the check.
3. Ask whether they use SEEK's "save job" feature and explain the rule: a saved job is an order to apply, regardless of score.

## Stage 6: Google Sheet (optional)

Ask whether they want the phone-side Tray. If no, skip; the check treats an unconfigured Sheet as fine. If yes, guide them through it in order, one step per message, waiting for each:

1. Google Cloud console: create a project (or use one), enable the Google Sheets API.
2. IAM > Service accounts: create one, then Keys > Add key > JSON. Save the file somewhere outside the repo.
3. Create an empty Google Sheet. Share it with the service account's email (the `client_email` field in the JSON) as Editor.
4. Put the JSON path in `.env` as `GOOGLE_APPLICATION_CREDENTIALS` and the Sheet id (the long segment of the URL) as `SHEETS_SPREADSHEET_ID`. You may edit `.env` for them if they paste the values.
5. Re-run the check; `sheet_reachable` reports the Sheet's title when it works. Then `npm run sheets:sync` to create the tabs.

The most common failure is step 3 (Sheet not shared with the service-account email); say so when `sheet_reachable` fails with a 403.

## Stage 7: schedule

Set `HARNESS_CLI=claude` or `codex` in `.env` (ask which CLI they use). On macOS run `bash scripts/install-launchd.sh` and re-run the check. On another OS, show them the cron line for `scripts/daily.sh` at 07:00 local and mark the stage as theirs to finish.

Before enabling any schedule, make sure they have done at least one attended application: run `/hunt seek` (or their channel), then `/apply <id>` for one row, together. This is where they see a package, the critic, and the journal entry for the first time.

## Stage 8: autopilot

Explain the two lanes in three sentences: one-click channels (SEEK Quick Apply, LinkedIn Easy Apply) can send unattended once the letter-critic and the gate pass; everything else stops at a prepared package for them; the kill switch in `submission-policy.yaml` stops everything. Then ask, as one structured question: "Turn autopilot on now?" with options: On for SEEK and LinkedIn (Recommended after an attended run) / On for SEEK only / Not yet. Write `autopilot.enabled` and `autopilot.channels` accordingly, keep `max_per_day` at the template default unless they ask, and re-run the check.

When `ready_for_autopilot: true`, print the closing brief:

- what runs at 07:00 and where the journal lands (`state/journal/YYYY-MM-DD.md`, "Sent unattended" / "Parked by autopilot")
- how to stop everything (`kill_switch: true`)
- the three commands they will use most: `/pipeline`, `/review-drafts`, `/manual-applications`
- that `state/` is git-ignored and never leaves the machine

Write a journal entry summarising what was configured (no secrets, no key paths).

## Rules

- Never paste, log or journal credentials, key-file contents, or session cookies.
- Never run a login on the person's behalf; the browser session is theirs.
- Never enable autopilot without the person's explicit answer in this session.
- Do not invent profile facts to clear a TODO; leave it flagged and say so.
- Under Codex, the same steps apply; where a subagent skill (`onboarding`, `resume-review`) runs inline, warn that it will be slower and keep the main thread short.
