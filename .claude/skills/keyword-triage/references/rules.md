# Keyword triage rules

`npm run resume:keyword-triage` decides every pending `kind: keyword` row `keep` or `reject`, and names the rule. The rules are pure functions in `tools/resume/keyword-triage.ts`, each unit-tested against its own examples in `tests/keyword-triage.test.ts`. They decide mechanical facts only. Whether the person HAS a skill is never decided here.

## Order

1. The curated vocabularies win first. A term that is an exact taxonomy synonym or an exact keyword-cloud term (or alias) is screener vocabulary by construction, so no stoplist may throw it away.
2. Then the reject rules, in the order below. First match wins, and its name is written into the ledger note.
3. Then the keep rules. A term that matches no rule at all is kept as `residue`: the skill decides it against the corpus.

## Reject rules

| Rule | Fires when | Examples it is for | Deliberately not caught |
|---|---|---|---|
| `jd_boilerplate` | the term is a stoplist phrase, starts with an ad-furniture prefix, or has the section-heading shape `<lead> <tail>` (Key Skills, Primary Skills, Key Criteria8) | ad furniture | a heading-shaped term whose lead or tail is not on the list; it becomes residue |
| `eeo_or_diversity` | any diversity, inclusion or EEO phrase appears in the term | employer statements | nothing; these are never capabilities |
| `clearance_or_logistics` | clearance, vetting or work-arrangement wording (substring list), or the whole term is a logistics word (exact list) | profile facts owned by `profile.md`, `screening-answers.yaml` and the red-flag rules | "hybrid cloud", "remote sensing": the logistics words match the whole term only |
| `date_or_number` | a month, a calendar year, `Initial 12` / `Minimum N`, a bare `P1` / `P2`, or numerals only | durations, start dates, priority codes | "Microsoft 365", "Dynamics 365": a number inside a product name is not a year |
| `person_name` | two or three name-shaped tokens, none of them (or their stems) known to the taxonomy, the clouds, cv-source or the generic vocabulary | recruiters, hiring managers | "Microsoft Fabric", "Flow Designer": one known token is enough to save the term |
| `truncated_fragment` | the term ends on a single letter, a two-letter lowercase part-word, or a function word; a sentence word is glued onto a token ("GovernanceFacilitate"); the last token is a cut form of a word the corpus or the vocabularies know; the term is a cut prefix of another pending term; or the term appears in its own context as the prefix of a longer word | scraper damage | camel-cased product names: only a SENTENCE word counts as glue, so IntegrationHub, LlamaIndex and ServiceNow survive |
| `employer_or_program` | an ASX index band, the advertiser on the row's own opportunity, or a question that expands the acronym into an organisation name | employer and program names that appear in one JD only | a vendor whose name is in the taxonomy or a cloud (caught by the curated short-circuit first) |
| `generic_phrase` | the term starts with a JD qualifier ("Strong ITSM", "Excellent Azure Cloud") or a delivery verb ("Facilitate Agile"), or it is longer than three words, carries a qualifier or verb, and contains no curated tool, platform, method or certification | responsibility lines and puffery | the bare noun: "ITSM" and "Azure Cloud" are kept, only the qualified form is refused |

## Keep rules

| Rule | Meaning |
|---|---|
| `taxonomy_synonym` | exact match in `skills-taxonomy.yaml` or a keyword cloud (term or alias) |
| `category` | the extractor categorised it `tool`, `platform`, `methodology` or `certification` |
| `acronym_shape` | 2 to 6 capitals, which is how tools and standards are written |
| `in_cv_source` | the term already appears in `cv-source.md` |
| `residue` | no rule fired; the skill decides it semantically |

## What a reject means

`--apply` records a reject as `status: not_applicable`, `origin: triage`, `notes: "triage: <rule>"`. That is reversible and it only stops the resume claiming the term. It is never a statement about the person.

At `queue` time the same rules run BEFORE the row is created, and a refused term is appended to `state/profile/keyword-rejects.jsonl` (`{at, term, rule, opportunity_id, resume_id}`) instead of entering the ledger, so the same junk cannot come back.

## Changing a rule

Edit the stoplist in `references/boilerplate.yaml` for vocabulary, the rule function for shape. Add the example to `tests/keyword-triage.test.ts` in the same change: a rule with no example is a rule nobody can trust. Keep the stoplist generic. A person, an employer, a client or a profile fact never goes in it.
