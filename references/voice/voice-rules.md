# Voice rules

Style guide derived from the user's CV + sample writing. The `voice-check.ts` tool tests drafts against these rules. The `slop-killer.ts` tool checks for the separate banlist in `slop-banlist.md`.

## English variant

- **AU English**: organisation, optimisation, prioritise, behaviour, programme/program, colour, customise, realise, analyse, modernisation, recognise.
- Never use US-only spellings (organize, prioritize, behavior, color, customize, realize, analyze). This is a `fail`.
- Date format: `DD/MM/YYYY` or `Mon YYYY`.

## Sentence length

- **Cover letters + DMs + LinkedIn comments**: target 12 to 22 words per sentence. Hard cap 30. Short and direct.
- **CV bullets**: target 18 to 28 words. Allowed up to 35 for outcome-rich bullets.
- **Avoid sentences over 35 words anywhere**. This is a `warn`.

## Openers (lead with the relevant credential or hook)

- ❌ "I am writing to express my interest in…"
- ❌ "I hope this message finds you well…"
- ❌ "I'm thrilled/excited to apply for…"
- ❌ "As a [job title] with X years of experience…"
- ✅ Lead with a specific credential, outcome, or relevance hook in sentence one. Examples: "Led the ServiceNow ESM transformation at NSW Dept of Education: 150K users, 350+ services, decommissioned Remedy."

## Dashes

- **No em dashes (U+2014) and no en dashes (U+2013), anywhere.** `AGENTS.md` section 3 rule 2 is absolute: they are banned in generated content and in replies to the person.
- `voice-check` reports any of either as a `fail`, and `letter-critic` blocks on them. There is no density allowance.
- Rewrite the clause rather than swapping the punctuation: use a colon, a semicolon, a comma, brackets, or a new sentence. For a numeric or date range use "to" ("12 to 22 words", "Mar 2026 to present").

## Structure

- **Cover letters**: 2 to 4 paragraphs, single flowing letter. **No section headers**. Target 250 to 350 words, no more than 1 page.
- **LinkedIn comment on a hiring post**: 1 to 3 sentences, contributes specific value, optionally suggests DM to continue.
- **Recruiter DM**: 5 lines or fewer, role-relevant credential up front, ends with a concrete next step.

## Tone

- Australian understatement: avoid superlatives. Let outcomes carry the weight.
- No unprompted praise of the company. Reference a specific thing only if you actually know about it.
- Don't perform enthusiasm. State interest and move on.

## Brand-name handling

- Use the user's actual brand-name shorthand from `state/profile/cv/`:
  - "CommBank" not "Commonwealth Bank of Australia" (unless first mention)
  - "Westfield" not "Scentre Group's shopping centres" (unless context demands)
  - "Service NSW" / "Revenue NSW" / "NSW Dept of Education" as written in the CV
- Acronyms expand on first use in a cover letter: "Enterprise Service Management (ESM)".

## Self-reference

- Use "I" sparingly in cover letters: describe outcomes, not feelings.
- Never use "passionate", "thrilled", "blessed", "humbled", "obsessed", "love"-as-engagement.

## Question / claim hedging

- No "perhaps", "might be able to", "potentially could".
- If you don't know, say "I'd want to confirm X before committing". Direct.
