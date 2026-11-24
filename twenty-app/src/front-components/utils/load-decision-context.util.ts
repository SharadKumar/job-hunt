import { CoreApiClient } from 'twenty-client-sdk/core';

import { type DecisionContext } from 'src/types/decision-context';
import { type DecisionTarget } from 'src/types/decision-target';

// Reads, as the member, the state a button is about to decide on, so the
// decision records exactly what was on screen.
export const loadDecisionContext = async (
  target: DecisionTarget,
  recordId: string | undefined,
): Promise<DecisionContext> => {
  const client = new CoreApiClient();

  if (target === 'global') {
    const result = await client.query({
      controls: {
        __args: { first: 1, orderBy: [{ derivedAt: 'DescNullsLast' }] },
        edges: { node: { autopilotEnabled: true, haltOpen: true } },
      },
    });
    const control = result.controls?.edges?.[0]?.node;
    const statusSeen =
      control === undefined
        ? 'UNKNOWN'
        : control.haltOpen
          ? 'HALTED'
          : control.autopilotEnabled
            ? 'AUTOPILOT_ON'
            : 'AUTOPILOT_OFF';

    return { title: 'Send switch', statusSeen };
  }

  if (recordId === undefined) {
    throw new Error('Select one record first');
  }

  if (target === 'opening') {
    const result = await client.query({
      opening: {
        __args: { filter: { id: { eq: recordId } } },
        id: true,
        title: true,
        status: true,
        applications: {
          __args: { first: 1, orderBy: [{ createdAt: 'DescNullsLast' }] },
          edges: { node: { letterSha: true, letterMarkdown: true } },
        },
      },
    });
    const opening = result.opening;

    if (!opening) {
      throw new Error('That opening could not be read');
    }

    const application = opening.applications?.edges?.[0]?.node;

    return {
      title: opening.title ?? 'Opening',
      statusSeen: opening.status ?? 'UNKNOWN',
      letterShaSeen: application?.letterSha ?? undefined,
      letterMarkdown: application?.letterMarkdown ?? undefined,
      openingId: opening.id,
    };
  }

  if (target === 'proposal') {
    const result = await client.query({
      proposal: {
        __args: { filter: { id: { eq: recordId } } },
        id: true,
        summary: true,
        status: true,
        openingId: true,
      },
    });
    const proposal = result.proposal;

    if (!proposal) {
      throw new Error('That proposal could not be read');
    }

    return {
      title: proposal.summary ?? 'Proposal',
      statusSeen: proposal.status ?? 'UNKNOWN',
      proposalId: proposal.id,
      openingId: proposal.openingId ?? undefined,
    };
  }

  const result = await client.query({
    resumeVersion: {
      __args: { filter: { id: { eq: recordId } } },
      id: true,
      name: true,
      approvalStatus: true,
      contentHash: true,
      positioningId: true,
    },
  });
  const version = result.resumeVersion;

  if (!version?.positioningId) {
    throw new Error('That CV version could not be read');
  }

  // The decision names the positioning and the exact hash on screen; the
  // harness approves only if that hash is still the current version.
  return {
    title: version.name ?? 'CV version',
    statusSeen: version.approvalStatus ?? 'UNKNOWN',
    contentHashSeen: version.contentHash ?? undefined,
    positioningId: version.positioningId,
  };
};
