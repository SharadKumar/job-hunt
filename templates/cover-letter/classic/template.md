---
name: classic
description: Conservative AU consulting cover letter. 250-350 words, 2-4 paragraphs, no headers, AU English. Lead with the target's cover_letter_angle (a specific CV achievement). Anchor in JD specifics (company, role, distinctive hook). Direct, understated, no superlatives, no performed enthusiasm.
suitable_for:
  - enterprise-architect-transformation
  - servicenow-salesforce-architect
  - fractional-chief-architect
  - outcomes-based-delivery-partner
version: 1
added_at: 2026-05-27
last_updated: 2026-05-27

# Style constraints cover-letter-writer enforces
constraints:
  word_count_range: [250, 350]
  paragraph_count_range: [2, 4]
  salutation_style: "Dear {Hiring Manager or specific name if known},"
  sign_off_style: "Regards,\n\n{first_name}"   # first name from state/profile/profile.md
  opener_pattern: "lead with a specific credential, outcome, or relevance hook from cover_letter_angle"
  closer_pattern: "concrete next step (a question, a stated availability, a clear ask) — no platitudes"
  tone: "direct, AU understatement, no superlatives, dry humour acceptable"
  english_variant: en-AU
---

# Classic cover letter template

The default cover letter style. Reflects the user's actual writing voice: conservative, direct, AU English, achievement-led.

## Composition rules

1. **Salutation** — "Dear {name if known, else 'Hiring Manager'}," on its own line.
2. **Opening paragraph** — 1-3 sentences. Lead with the `cover_letter_angle` (specific CV achievement referenced verbatim or close to it). Ground in the JD's company name and role title. Why-this-target hook.
3. **Body paragraph(s)** — 1-2 paragraphs. Bridge the achievement to what the JD asks for. Reference 1-2 distinctive JD specifics (mission language, tech mentioned, team scope, recent news) to show you read it. Don't repeat the CV; complement it.
4. **Closing paragraph** — 1-2 sentences. Concrete next step: availability stated explicitly, OR a question for them, OR a direct sign-off. No "I look forward to discussing".
5. **Sign-off** — "Regards,\n\n{first_name}" on its own lines (the profile's first name).

## What it doesn't do

- No section headers / no bullet points / no bold.
- No generic company praise ("I admire your mission to…").
- No hollow openers ("I am writing to apply…").
- No performed enthusiasm ("I'm thrilled to…").
- No empty closers ("Please do not hesitate to reach out").
- No superlatives ("incredibly excited", "deeply passionate").
- No claims beyond what the canonical CV supports.

## See also

- `example.md` — a sample letter in this style (for reference, not a literal template).
- `.claude/skills/apply/references/cover-letter-quality.md` — universal quality checks (applied to every render of this template).
