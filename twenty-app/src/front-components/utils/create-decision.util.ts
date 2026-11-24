import { CoreApiClient } from 'twenty-client-sdk/core';

import { type DecisionInput } from 'src/types/decision-input';
import { buildDecisionData } from 'src/utils/build-decision-data.util';

export type RecordedDecision = {
  id: string;
  // Who Twenty stamped as the author, and whether that is the owner whose
  // confirmation counts (null when the harness has not recorded the owner yet).
  recordedBy: string | null;
  byOwner: boolean | null;
  ownerName: string | null;
};

// Writes exactly one decision as the signed-in member. The record is
// create-only: nothing in the app updates or deletes it afterwards. It then
// reads back Twenty's stamp, so the button can say plainly when the decision
// was recorded under an account whose confirmation the harness will refuse.
export const createDecision = async (input: DecisionInput): Promise<RecordedDecision> => {
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

  try {
    const check = await client.query({
      decision: {
        __args: { filter: { id: { eq: id } } },
        createdBy: { workspaceMemberId: true, name: true },
      },
      controls: {
        __args: { first: 1 },
        edges: { node: { ownerMemberId: true, ownerName: true } },
      },
    });
    const by = check.decision?.createdBy;
    const control = check.controls?.edges?.[0]?.node;
    const ownerId = control?.ownerMemberId ?? null;

    return {
      id,
      recordedBy: by?.name ?? null,
      byOwner: ownerId ? by?.workspaceMemberId === ownerId : null,
      ownerName: control?.ownerName ?? null,
    };
  } catch {
    return { id, recordedBy: null, byOwner: null, ownerName: null };
  }
};

// What a button says after recording. A halt counts whoever records it; every
// other decision counts only from the owner's own account.
export const recordedMessage = (
  label: string,
  decisionType: string,
  recorded: RecordedDecision,
): { message: string; variant: 'success' | 'warning' } => {
  if (recorded.byOwner === false && decisionType !== 'HALT_SENDS') {
    const who = recorded.recordedBy ?? 'another account';
    const owner = recorded.ownerName ?? 'the owner';

    return {
      message: `${label} was recorded under ${who}, not ${owner}'s own account, so the harness will refuse it. Sign out, sign in as ${owner}, and try again.`,
      variant: 'warning',
    };
  }

  return { message: `${label}: recorded. The harness applies it within five minutes.`, variant: 'success' };
};
