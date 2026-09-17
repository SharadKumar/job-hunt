---
template: modern-columns
version: 1
added_at: 2026-09-10
last_updated: 2026-09-10
design_file: templates/resume/modern-columns/styles.css
notes: Scaffolded from 'modern'; styles.css and composition constraints not yet reviewed.
font_family: Inter
visual_identity: editorial-contemporary-blue
ats_safety: high
rendering: html+css (presentation) / shared docx (ats)
---

# modern-columns — scaffolded from `modern`

## Scaffold status

Created 2026-09-10 by `npm run resume:template:new -- --name modern-columns --from modern`.
Layout: `skills-columns` — the skills block renders in CSS columns and is marked `data-flow="secondary"`, so page-fit arithmetic counts primary-flow lines only.

The design, persona fit and composition constraints below are INHERITED FROM `modern` and are not yet a signed-off identity for this template. Edit `styles.css` (the design), then this file, then regenerate the golden.


## Identity

The **design is `styles.css`** (signed off 2026-05-31; the committed golden at `sample/golden*.png` is the target state). Single-column "Editorial" restraint in **Inter**: a 25pt name over a hairline rule, uppercase letter-spaced section labels, a single professional-blue accent (tagline + bullet dots), tabular right-aligned dates, italic role summaries. Contemporary without being decorative.

## Rendering

Two flavours, two media. `presentation` is the designed PDF — shared HTML builder (`_html-resume.ts`) + this template's `styles.css` + bundled Inter (`fonts/Inter-*.woff2`, embedded as @font-face) → headless-Chromium PDF. `ats` is the ONE shared plain single-column `.docx` (`_ats-docx.ts`), identical across all templates. The design lives in `styles.css`; `resume-writer` composes content, never edits the template.

## Persona fit

- Agentic AI Engineering Lead, AI Solutions Architect, GenAI Engineering Lead
- Fractional CTO, Technical Advisor, CTO-as-a-Service
- Hands-on tech leads at scale-ups and founder-led startups
- Audiences: tech recruiters, VC-backed founders, agency operators

Not a great fit for: NSW Gov, big-4 consulting, traditional financial-services hiring panels (use `classic`).

## Composition constraints

- Page target: **2 pages preferred, 3 pages hard max**.
- Featured experiences: 3–6 blocks. Bullets per featured: 3–7.
- Mentions: 0–3 one-liners.
- Selected Impact: 3–5 highlight bullets.
- Skill blocks: 2–4 with 3–6 bullets each.
- Summary: 240–400 chars (2 sentences). Lead with `cover_letter_angle`.

## Section order (canonical)

1. header: name + headline + contact
2. Summary, unheaded
3. Selected Impact bullets, unheaded
4. Skills
5. Experience, with earlier mentions continuing unheaded
6. Education, when credentials are present

## What this template does NOT do

- No serif typography (use `classic`).
- No multi-column sidebar in the ATS docx (the designed PDF is single logical column too).
- No icons, no logos, no profile photo.
- One accent only (professional blue); everything else is charcoal or muted slate.
