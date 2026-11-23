import { defineLogicFunction } from 'twenty-sdk/define';

import { GROK_LIMITS, GROK_PROPOSAL_TYPES } from 'src/constants/grok-tools';
import { GROK_TOOL_IDS } from 'src/constants/universal-identifiers';
import { grokHandler } from 'src/utils/grok-handler.util';
import { propose } from 'src/utils/grok-tools.util';

// Grok tool: propose work for the person to confirm. Nothing happens until
// they tap Confirm on the proposal.
export default defineLogicFunction({
  universalIdentifier: GROK_TOOL_IDS.propose,
  name: 'propose',
  description:
    'Propose work for the person to confirm or decline, such as redrafting a letter or researching a company. Nothing runs until the person confirms.',
  timeoutSeconds: 30,
  toolTriggerSettings: {
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...GROK_PROPOSAL_TYPES], description: 'What to do' },
        openingId: { type: 'string', description: 'The opening it is about (a UUID), if any' },
        brief: {
          type: 'string',
          description: `What and why, for the person (at most ${GROK_LIMITS.brief} characters)`,
        },
      },
      required: ['type', 'brief'],
      additionalProperties: false,
    },
  },
  handler: grokHandler(propose),
});
