# Resume Research Pack

This directory turns external resume guidance into local harness rules.

The operating principle is:

- Research-backed rules live here as dated claims.
- Per-template rubrics decide how those claims apply to a visual/rendering context.
- `resume-writer` applies the rubric with judgement at composition time.
- `npm run resume:evaluate` enforces the deterministic parts after rendering.

Do not ask the model to rediscover resume theory on every render. The model should use these rules as constraints, then exercise judgement inside them.

## Current Source Set

The current claims draw from:

- Purdue OWL guidance on grouping skills into job-related categories and ordering them by relevance.
- NACE career readiness competency language for broad evidence categories such as communication, critical thinking, leadership, professionalism, teamwork, and technology.
- Ladders' 2018 eye-tracking release on short initial recruiter scans, page discipline, keywords in context, and short accomplishment statements.
- Harvard FAS guidance on specific action verbs and natural, achievement-focused bullet language.
- University career-service ATS guidance on standard headings and simple parse-safe structure.

Each source-backed rule is encoded in `claims.yaml` with a checked date and an implementation hook.

## Screener model (2026-09-10)

The first reader of a resume is now usually a parser, then an AI/LLM ranking
layer, then a recruiter's Boolean search; a human reads only the shortlist. The
`screener-*` claims in `claims.yaml` capture what those readers reward: the
JD's exact spelling of skills, tools and titles; both acronym and full forms;
a clearly labelled Skills surface; verbatim certification names; quantified,
recent outcomes; parse-safe structure.

The boundary is fixed: the screener model changes **wording and placement**
of facts the corpus already holds. It never creates a fact. `npm run
resume:keywords` classifies every JD or market term against `cv-source.md`
(grounded / alias_grounded / confirmed / preppable / needs_confirmation /
foreign) and `resume:term-grounding --keyword-plan` enforces that only
grounded, alias-grounded, or source-confirmed terms render as claims. Terms
that are plausible but unproven go to the user as a question, never into the
CV.

