---
template: classic
font_family: EB Garamond
visual_identity: executive-editorial-serif
ats_safety: high
rendering: html+css (presentation) / shared docx (ats)
design_file: templates/resume/classic/styles.css
---

# classic — "Executive Editorial" serif CV

## Identity

The **design is `styles.css`** (the committed golden at `sample/golden*.png` is the target state). Editorial bones in a serif voice: **EB Garamond** throughout, a 28pt name over a hairline rule, uppercase letter-spaced section labels under thin rules, a single deep-navy accent, italic tabular dates. Gravitas and restraint — a senior-consulting CV authored deliberately.

## Rendering

Two flavours, two media. `presentation` is the designed PDF — shared HTML builder (`_html-resume.ts`) + this template's `styles.css` + bundled EB Garamond (`fonts/EBGaramond-*.woff2`) → headless-Chromium PDF. `ats` is the ONE shared plain single-column `.docx` (`_ats-docx.ts`). The design lives in `styles.css`; `resume-writer` composes content, never edits the template.

## Persona fit

- Solution Architect, Enterprise Architect, Digital Architect
- ServiceNow Architect, Salesforce Architect, Microsoft Consultant
- Delivery Manager, Program Manager, Engagement Manager
- Director / Principal Consultant tier
- Government, financial services, big-SI, big-4 consulting audiences

Not a great fit for: startup founders, IC engineers, design-led product teams (use `modern` or `minimalist` instead).

## Composition constraints

- Page target: **3 pages preferred, 3 pages hard max**. A 24-year career routinely fills 3pp.
- Featured experiences: 4–6 blocks. Bullets per featured: 3–7.
- Mentions: 0–4 one-liners.
- Highlights: 3–6.
- Skill blocks: 3–5 with 4–7 bullets each.
- Summary: 280–450 chars (2–3 sentences). Lead with `cover_letter_angle`.

## Section order (canonical)

1. header: name + headline + contact
2. Professional Summary
3. Career Highlights (highlights)
4. Professional Experience (featured)
5. Core Skills
6. Earlier Experience (mentions)

(Visual rhythm — type sizes, spacing, the navy accent, the hairlines — is defined exhaustively in `styles.css`; that file, not this prose, is the source of truth for the look.)

## What this template does NOT do

- No coloured accent rule (use `modern` for that).
- No bare-typography understatement (use `minimalist` for that).
- No two-column sidebars (ATS-hostile).
- No prose-heavy thought-leader summaries — keep the summary tight; the bullets do the work.
