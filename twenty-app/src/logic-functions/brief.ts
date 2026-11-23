import { defineLogicFunction } from 'twenty-sdk/define';

import { GROK_TOOL_IDS } from 'src/constants/universal-identifiers';
import { grokHandler } from 'src/utils/grok-handler.util';
import { brief } from 'src/utils/grok-tools.util';

// Grok tool: what needs the person now, as short summaries with rates and links.
export default defineLogicFunction({
  universalIdentifier: GROK_TOOL_IDS.brief,
  name: 'brief',
  description:
    'Job hunt brief: open escalations, proposals awaiting the person, the apply queue and the last run. Summaries with rates and advert links; never full job descriptions, CVs or letters.',
  timeoutSeconds: 30,
  toolTriggerSettings: {
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  handler: grokHandler((gql) => brief(gql)),
});
