import { defineLogicFunction } from 'twenty-sdk/define';

import { GROK_LIMITS } from 'src/constants/grok-tools';
import { GROK_TOOL_IDS } from 'src/constants/universal-identifiers';
import { grokHandler } from 'src/utils/grok-handler.util';
import { requestFullText } from 'src/utils/grok-tools.util';

// Grok tool: the full job description, only after a DISCLOSURE proposal logs
// the request with its reason.
export default defineLogicFunction({
  universalIdentifier: GROK_TOOL_IDS.requestFullText,
  name: 'request_full_text',
  description:
    "Full text of an opening's job description. Every request is logged as a disclosure with your reason before any text is returned. The CV is not available through this tool.",
  timeoutSeconds: 30,
  toolTriggerSettings: {
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The opening id (a UUID)' },
        kind: { type: 'string', enum: ['jd', 'cv'], description: 'jd for the job description' },
        reason: {
          type: 'string',
          description: `Why you need the full text (at most ${GROK_LIMITS.reason} characters); logged`,
        },
      },
      required: ['id', 'kind', 'reason'],
      additionalProperties: false,
    },
  },
  handler: grokHandler(requestFullText),
});
