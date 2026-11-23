import { defineLogicFunction } from 'twenty-sdk/define';

import { GROK_TOOL_IDS } from 'src/constants/universal-identifiers';
import { grokHandler } from 'src/utils/grok-handler.util';
import { openingSummary } from 'src/utils/grok-tools.util';

// Grok tool: one opening as a summary.
export default defineLogicFunction({
  universalIdentifier: GROK_TOOL_IDS.openingSummary,
  name: 'opening_summary',
  description:
    'One opening: title, employer, rates, advert link, status, fit and score reasons. Never the full job description.',
  timeoutSeconds: 30,
  toolTriggerSettings: {
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The opening id (a UUID)' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  handler: grokHandler(openingSummary),
});
