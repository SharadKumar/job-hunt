# Follow-up: what the extractor should stop emitting

The triage cleans up after `tools/resume/resume-keywords.ts`. It is worth fixing the source too, in a separate attended change, because a term that is never extracted costs nothing downstream. This file is the brief for that change. Nothing here is implemented yet.

## The root cause

`categoriseTerm` (around line 217) ends with:

```ts
if (isAcronymish(term)) return "tool";
return "concept";
```

So any candidate the taxonomy, the clouds, the search keywords and the title test all fail to recognise is still categorised, as `concept`, and any capitalised 2 to 6 letter string becomes a `tool`. Category is not a confidence signal, so a `must_have` cue in the JD then turns an unrecognised string into an askable question. That is how "Blayze Thomas", "WFH", "LGBTQ", "P1" and "Apply Now" reached the ledger as `tool` and `concept` rows.

## What to change

1. **Add an `unknown` category** (or a `recognised: boolean` on the candidate) so "we could not place this" stops being indistinguishable from "this is a concept". Only recognised categories should be askable.
2. **Never ask about an unrecognised term.** An unrecognised `must_have` term belongs in `gaps[]` with a reason, which is already the honest home for a term the plan cannot render. The question queue is for vocabulary the person could plausibly own.
3. **Drop the extraction candidates the triage rules already name**, at extraction time, so they never become plan terms: the section-heading shapes, the EEO and clearance wording, dates and durations, the advertiser's own name, and terms whose last token is a cut word or a function word. Reuse the rules from `tools/resume/keyword-triage.ts` rather than writing a second copy.
4. **Fix the sentence segmentation that produces glued tokens.** "Architectural GovernanceFacilitate" and "Dependency ManagementWork" are two JD lines with the newline eaten. `segmentJd` should split on a lower-to-upper transition when the tail is a sentence word, before candidates are cut.
5. **Stop emitting a term that is a strict prefix of another candidate in the same plan** ("Catalog De" alongside "Catalog Development").

## What must not change

- The JD stays a selection signal, never content (AGENTS.md section 5). Nothing here makes the extractor more generous.
- `gaps[]` stays visible. A dropped term is always a recorded decision, never a silent disappearance.
- The triage stays in place afterwards. It is defence in depth and it also covers the rows already in the ledger.
