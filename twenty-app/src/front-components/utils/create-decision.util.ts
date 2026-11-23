import { CoreApiClient } from 'twenty-client-sdk/core';

import { type DecisionInput } from 'src/types/decision-input';
import { buildDecisionData } from 'src/utils/build-decision-data.util';

// Writes exactly one decision as the signed-in member. The record is
// create-only: nothing in the app updates or deletes it afterwards.
export const createDecision = async (input: DecisionInput): Promise<string> => {
  const client = new CoreApiClient();

  const result = await client.mutation({
    createDecision: {
      __args: { data: buildDecisionData(input) as never },
      id: true,
    },
  });

  const id = result.createDecision?.id;

  if (typeof id !== 'string') {
    throw new Error('The decision was not recorded');
  }

  return id;
};
