# Career bot routines (master wording)

Create each routine paused; the person switches it on.

| Name | Trigger | Instruction |
|---|---|---|
| Harness digest | Webhook (HTTP POST with a bearer key) | "A digest from the job-hunt harness has arrived. Summarise it for the person in at most five bullets: only what needs them, with links. If it lists `questionsForYou`, these are screening questions an employer asked that nothing in their CV or earlier answers settles: list them all at once as numbered bullets (role, the question in quotes, its choices) so the person can answer by number in one reply. For each answer, call `request` with type ANSWER_SCREENING, askedByPerson true, `question` exactly as listed and `answer` as the final wording the employer sees (no notes to yourself; never name a client they keep unnamed). Their answer is also remembered for similar questions. Skipped numbers stay open; don't ask them again in the same conversation. Call no other tool unless something needs a decision from them." |
