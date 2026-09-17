---
# Frontmatter is parsed by tools/profile.ts (loadProfile). `name` is required;
# everything else is optional but the harness works much better when filled in.
# Copy this file to state/profile/profile.md and replace every placeholder.
name: Jane Citizen
email: jane@example.com
phone: "+61 400 000 000"
# date_of_birth and home_address feed recruiter response forms only.
# They are never rendered on a CV or cover letter. Delete them if you would
# rather type them by hand when a form asks.
date_of_birth: 1980-01-01
home_address: "TODO street, <your suburb> <your state> <postcode>"
# Referees are for recruiter response forms only and are never rendered on a
# CV. Confirm with each person before naming them. Leave the list empty ([])
# until you have that permission.
referees: []
#  - name: TODO
#    position: TODO
#    organisation: TODO
#    relationship: TODO (how you worked together, e.g. "engagement lead on the X programme")
#    mobile: "TODO"
#    email: TODO
citizenship: TODO                      # e.g. "Australian Citizen", "Permanent Resident", "Work visa (subclass ...)"
security_clearance:
  current: none                        # none | Baseline | NV1 | NV2 | PV (only what you actually hold today)
  willing_to_obtain: Baseline          # highest level you are eligible for and willing to apply for
location:
  city: <your city>
  country: AU                          # ISO country code
  timezone: Australia/Sydney           # IANA tz; drives the daily scheduler and locale defaults
locale:
  english_variant: en-AU               # en-AU | en-GB | en-US; drives spelling checks in voice-check
  date_format: DD/MM/YYYY
cv_source_dir: ~/Documents/Resume     # directory holding your master CV .docx (see cv/meta.yaml)
linkedin_url: https://www.linkedin.com/in/your-handle/
github_url: https://github.com/your-handle
---

# Profile

The agents read the prose sections below before classifying, scoring or
drafting anything. Write each one in plain sentences; bullet points are fine.
Keep facts here and keep style rules in `references/voice/` and
`voice-samples.md`. Replace every TODO.

## Engagement targets

<!-- What kind of work you want and how the scorer should rank it.
     - Engagement type: contract / fixed-term / permanent / fractional. Be explicit
       about what to exclude; the classifier treats exclusions as blockers.
     - Resume role families in priority order. These should line up with the
       positionings in resumes.yaml.
     - Any "exact-fit" signal: a role pattern that should always rank high, with
       the evidence in your CV that backs it.
     - Boundaries: role families that look adjacent but are not a fit for you.
     - Rate: last achieved, typical band, acceptance floor, and how much weight
       the scorer should give rate versus arrangement. The screening-answers
       file carries the number you quote on forms.
     - Notice period and availability date. -->

- **Engagement type**: TODO
- **Resume role families** (in priority order):
  1. TODO
  2. TODO
- **Exact-fit signal**: TODO
- **Boundaries**: TODO
- **Day rate** (currency, ex tax):
  - **Last achieved**: TODO
  - **Typical band**: TODO
  - **Acceptance floor**: TODO
  - **Note for scoring**: TODO (is rate a low-weight or high-weight signal for you?)
- **Notice period**: TODO
- **Availability date**: TODO

## Standing apply rules

<!-- Decisions that let the harness act without asking again. Examples:
     whether autopilot channels may submit unattended (must match
     submission-policy.yaml), and whether a job you save on a channel is an
     order to apply regardless of score. Date each decision. -->

- **Autopilot**: TODO (off until you have reviewed a few prepared packages)
- **Saved listings**: TODO

## Work arrangement

<!-- Remote / hybrid / onsite preferences and the reason behind them, the
     maximum onsite days per week you accept, how interstate or overseas roles
     should be treated (apply, park, exclude), and any travel you are happy to
     do occasionally but not weekly. The scorer's work_arrangement_fit weight
     reads from this. -->

- **Preference**: TODO
- **Hybrid tolerance**: TODO days/week onsite max
- **Location priority**: TODO
- **Interstate / relocation**: TODO
- **Overseas clients**: TODO

## Government eligibility

<!-- Work rights and clearance status, stated so the screening answers can be
     derived from it. Distinguish "eligible to obtain" from "currently hold";
     the harness never implies an active clearance you do not have. -->

- **Work rights**: TODO
- **Current clearance**: TODO
- **Willing to obtain**: TODO
- **Rule**: "Must be able to obtain <level>" is eligible; "Must currently hold <level>" is a blocker unless the advertiser confirms sponsorship.

## Industry / domain preferences

<!-- Industries where you have strong evidence (name them), industries you are
     open to, and industries or companies you never want surfaced. -->

- Strong: TODO
- Open to: TODO
- Avoid: TODO

## Technical context (canonical signals)

<!-- The platforms, stacks, methodologies and recent emphasis that identify your
     work. Keep it to headline terms; the detail lives in cv-source.md and
     skills-taxonomy.yaml. -->

- Platforms: TODO
- Stacks: TODO
- Methodologies: TODO
- Recent emphasis: TODO

## Communication style

<!-- One or two lines on register (direct, formal, dry). Spelling variant comes
     from the frontmatter locale. The operational writing rules live in
     references/voice/voice-rules.md; your samples live in voice-samples.md. -->

- TODO
- See `references/voice/voice-rules.md` for the operational rules and `voice-samples.md` for tone examples.

## Red flags (auto-deprioritise / surface as warning)

<!-- Phrases in an ad that should push a role down or block it, with the reason
     so the classifier can reason about near-misses. These pair with the
     red_flag_penalties in scoring-weights.yaml. -->

- "TODO phrase" - TODO reason
- "TODO phrase" - TODO reason

## Push channels (optional, off by default)

- `ntfy_topic`: TODO (set to enable mobile push on top-decile-fit roles)
- `email_digest_to`: TODO (daily digest address, or remove)

## TODOs to resolve on first interactive session

Marked TODO above. Run `/onboarding` to be walked through them.
