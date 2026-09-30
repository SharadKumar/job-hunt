# Jev decision layer final implementation

Status: final production architecture
Last updated: 22 September 2026

## Final decision

Jev is the live bounded semantic classifier for the job-hunt harness. It is no longer a shadow trial and there is no percentage rollout path.

Jev may:

- classify primary discipline, evidence strength and resume positioning;
- resolve genuinely ambiguous employment and work-arrangement language after deterministic extraction;
- feed the deterministic scorer when the result is automatic;
- move an automatic result between `discovered`, `shortlisted` and `parked` through the normal transition rules;
- suggest fuzzy duplicate and banked screening-answer matches after deterministic matching fails.

Jev may not:

- generate CV, letter, outreach or research prose;
- invent facts, answers or evidence;
- decide arithmetic, scores, hashes, transition rules or mechanical gates;
- suppress a saved job;
- authorise an unattended application.

The final unattended path requires an automatic ClassificationV2 decision from the bounded in-agent verification path. That verification runs for positive candidates selected for unattended preparation or submission and for a small, deterministic near-miss parachute. It is never run over all Jev rejections.

## Why this is the final boundary

The corrected 115-role cohort showed a mixed result:

| Measure | Before | Revised Jev |
|---|---:|---:|
| Automatic decisions | 57 | 34 |
| Uncertain decisions | 58 | 81 |
| Operational-proxy calibration error | not measured on the corrected basis | 0.0309 |
| False-high apply decisions | 9 under the earlier rule | 0 under the production rule |
| False-low apply decisions | not measured under the production rule | 1 |
| Selected role would have been submitted historically | not measured | `seek-b58722fbc180` |

Repeatability was 0.9652 for discipline and resume selection. Jev was approximately 7.7 times faster and 99.55 percent cheaper per role than the retained generic-agent comparator.

The earlier false-low definition counted adjacent and platform-gap as a successful promotion even though production promotion requires `core` plus a resume match. Correcting that definition exposed one consequential near miss. The evidence still supports Jev as a cheap, fast and conservative bulk classifier, but not as a sole consequential decision-maker. The permanent boundary therefore captures the operational benefit while requiring generative verification on the much smaller positive and high-scoring near-miss set.

## Runtime flow

1. Channel adapters ingest or update a role with `--upsert`.
2. Deterministic expiry closes active, unsent openings whose explicit closing date has passed, or whose channel reports expiry. Posting age is not evidence and submitted history is untouched.
3. Deterministic code extracts explicit facts.
4. Jev answers the remaining bounded semantic questions through Vercel AI Gateway.
5. An `automatic` result is scored and may move through the early pipeline states.
6. An `uncertain`, `degraded` or `insufficient_input` result cannot enter or remain in an active queue. Reconciliation returns an unsubmitted row to `discovered`, except for a saved job.
7. `jev:verification-queue` selects saved jobs regardless of Jev certainty, positive candidates, and only high-scoring adjacent or platform-gap near misses for bounded in-agent verification. In-flight one-click rows remain eligible so an interrupted application can regain the prerequisite without returning to discovery.
8. Deterministic package, critic, channel, cap and submission gates retain final authority.

Attended applications may use an automatic Jev classification because the person supplies fresh action authority. Unattended applications may not.

## Provider contract

- Route all Jev calls through Vercel AI Gateway using `typesafe-ai/jev`.
- Request zero data retention.
- Disable provider and model fallbacks.
- Pin and record the Gateway route identity.
- Record the resolved model version when the provider exposes it. Vercel currently exposes only the route alias, and the harness reports that limitation honestly.
- Persist full probability distributions, TypeSafe confidence, latency, token usage and estimated cost.
- Enforce the local daily spend cap and fail closed on provider or credential failure.

## Confidence contract

- Choice and Score confidence comes from `providerMetadata.typesafe.confidence`.
- Winning-option probability is retained as distribution evidence and is not relabelled as confidence.
- Boolean questions have probability but no separate confidence value.
- Every consequential Choice or Score question must also clear the configured winner-to-runner-up operational margin.
- Thresholds are conservative because automatic classification can change the work queue.
- Any question, criterion, profile or active-resume change invalidates the cached decision through its content hashes.
- Calibration uses the probability of the selected option against correctness. TypeSafe confidence remains provider metadata and is not treated as an empirical probability.

## Failure behaviour

- A degraded classification batch applies no pipeline state changes.
- Classification degradation blocks autopilot until healthy or explicitly acknowledged.
- Screening-match and fuzzy-dedup degradation is advisory because those paths already fail closed.
- Uncertain results remain in retained evidence for attended review or individual verification, but not in an operational queue.
- Jev rejection does not trigger a general generic-LLM second pass. Only the deterministic high-scoring near-miss parachute is reviewed, because monitoring established one production-rule false rejection.

## Legacy retirement

The final runtime contains one ClassificationV2 architecture. The following are removed and covered by architecture tests:

- the parallel classifications JSON store;
- `tools/merge-classifications.ts` and the merge command;
- the old regex semantic classifier;
- the duplicated `classificationSource` field;
- the old model-fingerprint claims;
- percentage rollout and canary policy fields.

Historical benchmark and replay artefacts remain because they are evidence, not runtime paths. The `--shadow` command option remains a read-only diagnostic facility and is not a production mode.

## Monitoring, not trial

The frozen benchmark, adjudication evidence, repeatability report and Guardrails comparison remain available for regression monitoring. Stale labels and resolved critic findings stay in the audit archive, not the live Guardrails worklists. They do not control a future promotion because the production boundary is now fixed.

Rerun the benchmark when any of these change:

- the effective model or Gateway route;
- question schema or confidence thresholds;
- profile evidence;
- active resume set;
- deterministic score or transition rules.

Monitor false-high decisions, false-low decisions, uncertainty rate, repeatability, cost, latency and human overrides. A regression may disable live state application, but it does not create an automatic path to wider authority.

## Evidence files

- `docs/benchmarks/jev-confidence-correction-before.json`
- `docs/benchmarks/jev-confidence-correction-after.json`
- `docs/benchmarks/jev-repeatability.json`
- `docs/benchmarks/jev-comparison.json`
- `docs/benchmarks/jev-shadow-500.json`
- `docs/benchmarks/jev-agent-comparator.json`

## Definition of done

The final implementation is complete when:

1. live classification state application is enabled;
2. Jev automatic decisions may feed deterministic scoring and early queue movement;
3. uncertain and degraded decisions fail closed and are reconciled out of active queues;
4. Jev unattended send authority is impossible in code;
5. positive candidates have a supported bounded in-agent verification path;
6. high-scoring near misses have a bounded parachute without expanding to all rejections;
7. expired active openings leave operational queues before classification while submitted history remains intact;
8. percentage rollout and old classification paths have no runtime references;
9. setup, health, UI, skills and documentation describe the same architecture;
10. typecheck, architecture tests and the full harness suite pass;
11. pipeline integrity and the enabled Sheet mirror are synchronised.
