---
template: minimalist
font_family: Arimo
visual_identity: bare-typography-restraint
ats_safety: high
rendering: html+css (presentation) / shared docx (ats)
design_file: templates/resume/minimalist/styles.css
---

# minimalist — "Bare" CV

## Identity

The **design is `styles.css`** (the committed golden at `sample/golden*.png` is the target state). Maximum restraint in **Arimo** (Helvetica-metric, libre): monochrome — no accent colour, no rules — the **name at regular weight** (the understatement IS the statement), generous air between sections, muted en-dash bullets. The reader feels they're looking at a CV from someone who has nothing to prove with design; the work does that.

## Rendering

Two flavours, two media. `presentation` is the designed PDF — shared HTML builder (`_html-resume.ts`) + this template's `styles.css` + bundled Arimo (`fonts/Arimo-*.woff2`) → headless-Chromium PDF. `ats` is the ONE shared plain single-column `.docx` (`_ats-docx.ts`). The design lives in `styles.css`; `resume-writer` composes content, never edits the template.

## Persona fit

- Design-aware companies (agencies, scale-ups with strong design culture)
- Founder-network advisory and fractional roles
- Senior IC engineers at design-led companies
- Audiences: founders, design partners, head-of-platform types

Not a great fit for: traditional consulting, NSW Gov, big-4, financial services (use `classic`); keyword-scanning recruiters (use `modern`).

## Composition constraints

- Page target: **2 pages preferred, 2 pages hard max** (strict). Restraint is the point.
- Featured experiences: 3–5 blocks. Bullets per featured: 3–5 (tighter than classic/modern).
- Mentions: 0–3 one-liners.
- Highlights: 0–4.
- Skill blocks: 2–3 with 3–5 bullets each.
- Summary: 200–360 chars (1–2 sentences). The summary IS the lead.

## Section order (canonical)

1. header: name + headline + contact
2. Summary
3. Highlights
4. Experience (featured)
5. Skills
6. Earlier (mentions)

(All HTML templates share one section order and one ATS-readable DOM; the visual difference is entirely in `styles.css`. Spacing, the regular-weight name, the en-dash bullets, the monochrome palette — all defined there.)

## What this template does NOT do

- No serif (use `classic`). No coloured accents (use `modern`).
- No rules, no header underline — air does the separating.
- No 3+ page render — 2pp strict; if you need 3pp, pick `classic`.
