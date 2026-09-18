---
name: keyword-triage
description: Clear the pending keyword ledger down to the few questions a human should actually answer. ALWAYS use this before asking the person anything about keywords, market confirmations, pending terms or the ledger, and whenever they say there are too many keyword questions, the queue is huge, "why is it asking me about this", or a pending term is obviously not a skill. /daily invokes it after the keyword plans are queued; /review-drafts and /resume-review invoke it before their drain step. Also use when a term looks like a recruiter name, JD boilerplate, a date, a clearance, an employer, or a cut-off word.
---

# /keyword-triage: answer the keyword queue before the person has to

## Why

Keywords exist for two jobs: positioning a resume and matching an opportunity (AGENTS.md section 3 principle 5). So a keyword has to be a skill, a tool, a platform, a methodology, a certification or a domain concept. The JD extractor is greedy on purpose, so most of what reaches the ledger is none of those: recruiter names, ad furniture ("Apply Now", "Key Skills"), diversity statements, dates, clearance and logistics wording, employer and program names, and half-words the scraper cut. Every one becomes a `pending` row, and the drain skills then ask the person "did you use or deliver <junk> in any role?".

A human question costs attention, and attention is the scarcest thing in this harness. Two rules follow:

1. A question that cannot be about a skill must never reach the person.
2. A wrong `confirm` is worse than a missed term. Confirming a term the corpus does not carry is how a JD term gets faked (AGENTS.md section 5, and the term-grounding gate will fail the render anyway). **Never answer `confirm` for a term that is not in `cv-source.md`.**

`not_applicable` is cheap and reversible: it only stops the resume claiming the term. That is what most of this queue deserves.

## Step 1: the deterministic pass (always first)

```
TMPDIR=/tmp npm run -s resume:keyword-triage -- --format table
```

Read the `by_rule` counts and skim the reject list. Each reject names the rule that refused it (`references/rules.md` has the table). If a reject looks wrong, say so in your report rather than arguing it down; the fix is a rule or stoplist change, not an exception.

Then apply it:

```
TMPDIR=/tmp npm run -s resume:keyword-triage -- --apply
```

Every reject lands as `status: not_applicable`, `origin: triage`, `notes: "triage: <rule>"`, in one ledger write. Answered rows are never touched.

## Step 2: read the residue

```
TMPDIR=/tmp npm run -s resume:keyword-confirm -- pending --group-by term --format json --limit 300
```

Then read, once: `state/profile/cv-source.md`, `state/profile/skills-taxonomy.yaml`, and the clouds in `state/org/keyword-clouds.yaml` that the busiest resumes reference. Everything from here is a judgement about evidence, which is why it is an agent and not the tool.

## Step 3: decide each residual term

In this order, first match wins:

1. **Already evidenced.** The term, or a taxonomy synonym of it, appears in a role bullet, a skills line or a credential in `cv-source.md`. Answer `confirm`, note `"already in cv-source.md line N"`. No source patch is needed: the fact is already there, and the note says so.
2. **Same family as an evidenced skill.** The term sits in a taxonomy category or cloud the person is expert or practitioner in, next to something the corpus does carry (a neighbouring service in the same vendor stack, a sibling method in the same practice). Answer `familiarity`, note the evidenced neighbour by name: `"adjacent to <evidenced term>, cv-source.md line N"`. Familiarity renders once, framed as familiarity, never as delivered work.
3. **A real skill with no evidence and no family link.** Answer `na`, note `"no evidence in corpus"`. Reversible; it only stops the resume claiming it.
4. **Surface to the person.** Only these, and aim for under 10 percent of what came in:
   - a `must_have` term with a family link where `confirm` versus `familiarity` changes what the CV claims;
   - a certification, clearance or qualification the person may actually hold (the corpus cannot answer this and guessing it is a fabrication);
   - anything you cannot place in about 30 seconds.

Write every non-surfaced decision to one YAML file and record it in a single pass:

```
TMPDIR=/tmp npm run -s resume:keyword-confirm -- record --file /tmp/keyword-triage-<date>.yaml --origin triage
```

The file is `term: {answer, note}` per row, answers `confirm | na | familiarity | pending`. Read `unmatched` and `invalid` in the output rather than assuming it landed.

Surfaced terms are asked by the calling skill, through `AskUserQuestion`, at most 4 per question, with the four fixed options in order: `Confirm and update source (Recommended)` / `Not applicable` / `Bring in as familiarity` / `Unsure / keep pending`. If nothing is calling you, ask them yourself the same way.

## Step 4: report

- counts: pending in, rejected by rule, confirmed from the corpus, familiarity, na, surfaced;
- the surfaced list, one line of reasoning each;
- any reject you think the rules got wrong, by term and rule;
- append a **"Keyword triage"** block with the same content to `state/journal/<today>.md`.

Then invoke `state-syncer` if any other state changed in this session.

## Boundaries

- A `confirm` authorises nothing until `cv-source.md` carries the fact. A confirm under rule 1 is the exception only because the fact is already there; if it is not, use `apply-patch` or do not confirm.
- Never edit `cv-source.md`, `market-confirmations.yaml` or `keyword-rejects.jsonl` by hand. Everything goes through `resume:keyword-confirm`.
- Never re-open a term the person already answered.
- The tool's verdicts are mechanical facts and are not narrated into something else (AGENTS.md section 3 principles 7 and 8).

## References

- `references/rules.md`: the reject and keep rule table, with what each one is for and what it deliberately does not catch.
- `references/boilerplate.yaml`: the shipped stoplist the tool loads. Generic ad vocabulary only, never a profile fact.
- `references/extractor-followup.md`: what `resume-keywords.ts` should stop emitting, so this triage has less to clean up.
