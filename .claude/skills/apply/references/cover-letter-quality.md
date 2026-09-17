# Cover-letter quality checks (universal)

The checks cover-letter-writer runs against every cover letter, regardless of template. Template-agnostic — they describe what makes any cover letter fit-to-send.

cover-letter-writer reads this file on every invocation, then optionally overlays per-template overrides from `templates/cover-letter/<name>/quality-checks.md` (rare).

Each check declares:
- **id**: machine-readable identifier (becomes a key in the subagent's `checks` report)
- **what**: human description
- **how**: how to check
- **auto_fix**: action when auto-fixable
- **severity**: `pass | warn | fail` — fail means human review needed; warn is logged

---

## Tool-driven (deterministic)

### slop
- **what**: no phrases from `references/voice/slop-banlist.md` appear in the letter
- **how**: `npm run slop:check -- --file <path>`
- **auto_fix**: regenerate the letter with the hit list as explicit "do not use" instructions
- **severity**: fail (slop is a hard signal of low-effort writing)

### voice
- **what**: sentence length, English variant (AU), opener pattern, em-dash density all match the user's voice samples
- **how**: `npm run voice:check -- --file <path> --kind cover_letter`
- **auto_fix**: regenerate matching specific voice-rule violations
- **severity**: fail

---

## Content-structural (parse the letter, judge)

### length
- **what**: word count within template's range. Universal default: 200-400 words. The classic template targets 250-350.
- **how**: count words in the letter body (excluding salutation and sign-off)
- **auto_fix**: regenerate with adjusted target; if persistently over, trim a paragraph; if under, expand the lead-with hook
- **severity**: warn

### paragraph_count
- **what**: 2-4 paragraphs. Letters with 1 paragraph feel terse and ungrounded; 5+ feel like an essay.
- **how**: count paragraph breaks
- **auto_fix**: regenerate with target count
- **severity**: warn

### no_section_headers
- **what**: no markdown headers (`# `, `## `) in the letter body. Cover letters are flowing prose.
- **how**: grep for `^#`
- **auto_fix**: regenerate without headers
- **severity**: fail (any reader sees this as wrong)

### opener_pattern
- **what**: the first sentence leads with a specific credential, outcome, or relevance hook — NOT one of the forbidden hollow openers ("I am writing to…", "I hope this message finds you well…", "I'm thrilled to…", "I'm excited to apply…", "I'm reaching out to…", "As a [job title] with X years of experience…")
- **how**: regex the first sentence against the forbidden patterns; also judge whether it leads with substance
- **auto_fix**: regenerate with explicit instruction on what to lead with (the target's `cover_letter_angle`)
- **severity**: fail (hollow openers are the strongest AI-tell)

### closer_pattern
- **what**: no empty closers ("Please do not hesitate to reach out", "Thank you for your time and consideration", "I look forward to the opportunity to discuss", "Eager to hear back")
- **how**: regex the last paragraph against forbidden patterns
- **auto_fix**: regenerate with a more concrete closer (a specific question, a stated next step, or a direct sign-off without the platitudes)
- **severity**: warn (less severe than opener; some users still want a polite close)

### no_placeholders
- **what**: no leaked template variables (`<name>`, `<company>`, `[TBD]`, `[insert here]`, `XXX`)
- **how**: regex for `<[a-z]+>`, `\[.*\]`, `XXX`, etc.
- **auto_fix**: regenerate with the missing values supplied from opportunity context
- **severity**: fail

---

## Opportunity-grounded (uses opportunity + target context)

### jd_hooks_present
- **what**: the letter mentions the company name AND the role title AT LEAST ONCE, and references at least one distinctive thing from the JD (mission language, specific tech mentioned, team scope, recent news). If the JD is pure boilerplate with nothing distinctive, this can pass without the third item.
- **how**: grep for the opportunity's `company` and `title`; for the third item, judge by reading both letter + JD
- **auto_fix**: regenerate with explicit hooks from the JD listed in the prompt
- **severity**: warn (if zero hooks present → fail; if 1-2 → warn)

### cover_letter_angle_reflected
- **what**: the target's `cover_letter_angle` (a specific CV achievement, e.g. "Lead with the NSW DoE ServiceNow ESM win") is reflected in the opening or early body of the letter. Verbatim copy is fine; paraphrase is better.
- **how**: judge by reading the letter against the target's `cover_letter_angle` text
- **auto_fix**: regenerate with the angle as the explicit lead-with instruction
- **severity**: fail (the angle is the whole point of the per-resume positioning)

### no_unsupported_claims
- **what**: every concrete claim in the letter (years of experience, specific platforms, specific industries) is supported by the user's actual CV. No "5 years of React" if the user has 2; no "Kubernetes expert" if the user has only adjacency.
- **how**: read the letter + the canonical CV (`state/profile/cv/`); cross-check each numerical/expertise claim
- **auto_fix**: none — fabricated claims are an integrity issue; regenerate with explicit instruction to stick to verifiable claims
- **severity**: fail

### profile_editorial_rules
- **what**: the letter honours durable profile-specific presentation, confidentiality, and terminology rules in `state/profile/resume-editorial-rules.md`.
- **how**: read the profile rule file and check the final letter for every explicit prohibition or required framing. This includes context-sensitive combinations, not only isolated banned words.
- **auto_fix**: rewrite the violating sentence while preserving supported evidence and the role-specific hook.
- **severity**: fail

---

## Tone (judgement-based)

### voice_match
- **what**: cadence + register match the user's voice samples beyond just word-level slop. Australian understatement (no superlatives), direct (no hedging stacks), no performed enthusiasm.
- **how**: read voice-samples.md + the letter; judge similarity
- **auto_fix**: regenerate with explicit cadence instructions ("shorter sentences", "no superlatives", "drop the enthusiasm")
- **severity**: warn

### no_generic_company_praise
- **what**: no unprompted "I admire your commitment to innovation", "I'm impressed by your mission". These signal you didn't read the JD; you just copy-pasted boilerplate.
- **how**: regex against the known patterns; also judge by reading
- **auto_fix**: regenerate; remove generic praise; replace with a SPECIFIC thing if the user has actual knowledge
- **severity**: warn

---

## Per-template overrides

A template can override a check id (relaxed/strict thresholds, severity, or `skip`) by declaring `templates/cover-letter/<name>/quality-checks.md`. When ids collide, per-template wins. Per-template can also add new checks unique to its style.
