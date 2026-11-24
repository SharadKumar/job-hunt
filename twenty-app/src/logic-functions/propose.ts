import { defineLogicFunction } from 'twenty-sdk/define';

import { GROK_LIMITS, GROK_PROPOSAL_TYPES } from 'src/constants/grok-tools';
import { GROK_TOOL_IDS } from 'src/constants/universal-identifiers';
import { grokHandler } from 'src/utils/grok-handler.util';
import { request } from 'src/utils/grok-tools.util';

// Grok tool: hand the harness work the person asked for. It runs without a
// second confirmation, after the harness's checks; package approvals and
// document edits still wait for the person's button. A suggestion the person
// did not ask for is sent with askedByPerson false and waits for them.
export default defineLogicFunction({
  universalIdentifier: GROK_TOOL_IDS.propose,
  name: 'request',
  description:
    'Hand the harness work the person asked for in this conversation (answer a screening question, research a company, redraft a letter and so on). It runs without asking the person again; the outcome appears in brief under doneForYou. Set askedByPerson false only for your own suggestions, which wait for the person to confirm.',
  timeoutSeconds: 30,
  toolTriggerSettings: {
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...GROK_PROPOSAL_TYPES], description: 'What to do' },
        askedByPerson: {
          type: 'boolean',
          description: 'True when the person asked for this in the conversation; false for your own suggestion',
        },
        openingId: { type: 'string', description: 'The opening it is about (a UUID), if any' },
        question: {
          type: 'string',
          description: 'ANSWER_SCREENING: the exact question text from openScreeningQuestions in brief',
        },
        answer: {
          type: 'string',
          description:
            'ANSWER_SCREENING: the final wording the employer will see. No notes to self; never name a client the profile keeps unnamed',
        },
        term: { type: 'string', description: 'CONFIRM_KEYWORD: the keyword term' },
        brief: {
          type: 'string',
          description: `What and why, in a sentence (at most ${GROK_LIMITS.brief} characters)`,
        },
      },
      required: ['type', 'askedByPerson', 'brief'],
      additionalProperties: false,
    },
  },
  handler: grokHandler(request),
});
