# Profile resume editorial rules

resume-writer reads this file before composing any resume for this profile.
These are durable profile-specific preferences, not reusable harness rules
(those live in `references/voice/`).

Append-only unless you explicitly ask to revise or remove a rule. Date each
section. When the resume-critic raises the same finding twice, the critique
skill appends it here as a new dated rule so the next composition starts from
it; when a rule is decidable from the text alone, mirror it in
`editorial-bans.yaml` so the audit enforces it mechanically.

<!-- The rules below are generic starting points. Add your own: how each
     employer or engagement may be framed, which clients are never named,
     which titles to use, what a side project may and may not claim. -->

## Starting rules - No em dashes

- **Never use an em dash in any rendered resume content.** This covers the summary, highlights, skill blocks and ledes, experience titles, locations, prose summaries, bullets, mention one-liners, and credentials.
- Rewrite instead of substituting punctuation blindly. A clause that leans on an em dash is usually two sentences, a comma clause, or a colon. Prefer splitting the sentence or using a comma or colon over swapping in an en dash or a spaced hyphen.
- Date ranges rendered by the template (`Jun 2026 - Present`) are template chrome, not authored content, and are out of scope for this rule.

## Starting rules - Spelling and register

- Use the spelling variant set in `profile.md` (`locale.english_variant`) consistently across every rendered field.
- Do not use bare internal acronyms a recruiter outside your niche would not read; spell them out on first mention.
- Harness vocabulary never renders: the words screener, keyword plan, capability surface, ATS and harness are banned in every rendered field.

## Starting rules - Claims need source support

- Claim-bearing verbs such as "shipped", "delivered", "launched", "in production" are used only where `cv-source.md` shows the thing reaching that state. Work that is designed, scoped or in delivery is described as such.
- Never name a client that the source marks confidential; use the agreed descriptor from the source instead.
- Numbers, dates and titles must agree across summary, highlights, skills and bullets. When two figures exist in the source, use the one the source marks current.
- Audit or control findings about a client's environment render as capability delivered, never as a count or proportion of how broken the environment was.

## Starting rules - Structure

- One chronological list: rendered CVs keep a single reverse-chronological Experience section. Side ventures and applied practice sit in it by date, featured or as a one-line mention per the placement rule for that positioning; they never get a separate section.
- Career Highlights never feature side ventures; ventures appear only in their experience blocks and, at most, one summary clause.
- Employer blocks always carry more bullets than any side venture on the same page.
- The Education / credentials section carries only what still matters for the positioning: degrees, recent and relevant certifications, prominent recognition. Retired credentials are dropped on every positioning.

## Learned from review

<!-- The resume-critique skill appends dated entries below this line. -->
