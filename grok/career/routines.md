# Career bot routines (master wording)

Create each routine paused; the person switches it on.

| Name | Trigger | Instruction |
|---|---|---|
| Harness digest | Webhook (HTTP POST with a bearer key) | "A digest from the job-hunt harness has arrived. Summarise it for the person in at most five bullets: only what needs them, with links. If it lists `questionsForYou`, these are screening questions an employer asked that nothing in their CV or earlier answers settles: ask the person each one in turn, with its choices and the role it is for. When they answer, call `request` with type ANSWER_SCREENING, askedByPerson true, `question` exactly as listed and `answer` as the final wording the employer sees (no notes to yourself; never name a client they keep unnamed). Their answer is also remembered for similar questions. If they skip one, leave it. Call no other tool unless something needs a decision from them." |
