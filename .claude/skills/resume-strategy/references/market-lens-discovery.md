# Market Lens Discovery Rubric

Use this when creating or refreshing `market_lens` for a resume type. The purpose is not to collect generic resume keywords; it is to identify the capabilities the market rewards, then decide which of those can be safely expressed from the person's source CV.

## 1. Build the Search Brief First

Before searching, write a compact brief from the CV/resume combo:

- target id and label
- target market seniority
- platforms/domains already evidenced in `cv-source.md`
- current `cover_letter_angle`
- strongest 3 source anchors
- weakest-but-valuable suspected gaps

This brief drives search queries. Do not search only the broad role title.

## 2. Query Shape

Use 6-10 targeted queries per materially changed resume type:

- `<role title> responsibilities capabilities skills architecture governance`
- `<platform/tool> architect certification blueprint skills measured`
- `<role title> job description senior consultant contract <region>`
- `<domain/tool> production governance security evals cost observability`
- `<role title> resume keywords capabilities <platform/domain>`
- `<vendor/product> implementation guide adoption governance architecture`

For fast-moving areas, include the current platform/tool names from the CV, for example Claude Code, OpenAI, ServiceNow Virtual Agent, Microsoft 365 Copilot, Power Platform, or MCP.

## 3. Source Priority

Prefer sources in this order:

1. Official product docs, certification/exam blueprints, implementation/adoption guides.
2. Credible current job descriptions already in the pipeline or explicitly searched.
3. Recognised industry bodies or analyst/research firms.
4. High-quality practitioner material only when official sources are thin.
5. Generic SEO resume-keyword pages only as weak corroboration, never as the primary source.

## 4. Capability Map

Extract candidate signals into these buckets:

- role core: responsibilities that define the job
- platform/tool: named technologies, modules, frameworks, products
- operating model: governance, delivery cadence, risk, cost, quality, observability
- stakeholder/commercial: executive alignment, vendor, budget, buyer risk, advisory
- proof metrics: users, scale, budget, adoption, delivery time, quality, reliability
- compliance/risk: security, privacy, data handling, audit, certification

Score each candidate signal:

- market relevance: high / medium / low
- CV evidence proximity: explicit / implicit / weak / absent
- resume value: differentiating / expected / filler
- claim risk: low / medium / high

Only high-relevance signals should become `must_signal`. Medium signals belong in `could`, `keyword_aliases`, or proof questions. Low-value filler should be ignored.

## 5. Writing `keyword_aliases`

`acceptable_if_source_mentions` is an evidence-pattern list, not a keyword list.

Good patterns:

- named source phrases: `ServiceNow GenAI product licensing`, `Slack approval gates and GitHub branch flows`
- source-specific outcomes: `350+ services`, `150K users`, `Remedy decommission`
- concrete mechanisms: `TypeScript hooks for governance enforcement`, `daily artefact delivery into client GitHub`
- paired concepts: `vendor negotiations on licensing and costs`, `architecture review board approvals`

Weak patterns:

- single generic words: `governance`, `roadmap`, `architecture`, `stakeholder`, `cloud`
- broad tool-only names unless the market term is exactly that tool: `Azure`, `Mulesoft`, `OpenAI`
- resume-padding abstractions: `leadership`, `strategy`, `delivery`, `transformation`
- evidence that supports a different claim from the alias

Rules:

- Each alias should have at least two concrete source patterns unless it requires explicit source.
- Prefer exact CV phrase fragments over invented paraphrases.
- Use multi-word, source-specific patterns where possible.
- If support is plausible but not concrete, write a `proof_question`; do not create a weak alias.
- If a market term is high-risk or credential-like, put it in `forbidden_claims` unless explicitly sourced.

## 6. Filtering

Reject a candidate signal if:

- it would make the resume look current but cannot be tied to source
- it is a generic skill every senior candidate claims
- it would distract from the selected positioning
- it duplicates a stronger signal already in the lens
- it is mostly certification/credential language the source does not confirm

## 7. Output Shape

When proposing a lens change, show:

- research queries used
- 3-6 source themes discovered
- capability map with scoring
- lens fields to change
- proof questions to ask
- claims intentionally forbidden or ignored

Do not silently write `acceptable_if_source_mentions` from your own broad associations.
