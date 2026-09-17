# Cover-letter templates (harness-level)

Unlike CV templates (which need code to render visual layout), cover letter templates are **declarative** — they describe constraints + style guidance. cover-letter-writer (the subagent) generates the actual letter inline using its own LLM context, conforming to the template's constraints.

## Structure per template

```
templates/cover-letter/<name>/
├── template.md          ← metadata + constraints (word range, paragraph range, opener style, closer style, salutation style, tone)
├── example.md           ← optional: a sample letter for the agent to reference
└── quality-checks.md    ← optional: per-template overrides for cover-letter-quality.md universal checks (rare)
```

## Why declarative not code

A CV is a visual artefact — different fonts, layouts, columns require different rendering engines (HTML + Playwright Chromium, the `docx` library). Templates need code.

A cover letter is text. The "style" is constraint-driven (length, structure, tone) which the LLM agent can match without a renderer. The agent IS the rendering engine.

If a future format genuinely requires custom rendering (e.g. a cover letter sent as a styled email HTML with embedded inline CSS, or a PDF letterhead with the user's logo), we can add `render.ts` to the template dir then. For now, markdown is enough.

## Universal quality checks

`.claude/skills/apply/references/cover-letter-quality.md` carries the universal checks cover-letter-writer applies to every letter. Template-specific overrides are optional.

## Currently shipped

- `classic` — conservative AU consulting style, 250-350 words, 2-4 paragraphs, direct + understated.

## Adding a template

1. Create `templates/cover-letter/<name>/template.md` with the constraints frontmatter + composition rules in the body.
2. Optionally add `example.md` showing a sample letter in the style.
3. Optionally add `quality-checks.md` for overrides (e.g. "narrative" template might allow 500-word letters; "punchy" might cap at 150 with stricter opener rules).
4. cover-letter-writer picks it up next invocation by name.
