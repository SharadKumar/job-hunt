import {
  enqueueSnackbar,
  openCommandConfirmationModal,
} from 'twenty-sdk/front-component';

import { BUTTONS, type ButtonKey } from 'src/constants/buttons';
import { createDecision } from 'src/front-components/utils/create-decision.util';
import { loadDecisionContext } from 'src/front-components/utils/load-decision-context.util';

// The whole flow of a headless button: read what is on screen, confirm in a
// modal, then write one decision carrying what was seen.
export const runHeadlessDecision = async (
  key: ButtonKey,
  selectedRecordIds: string[],
): Promise<void> => {
  const spec = BUTTONS[key];

  try {
    if (spec.target !== 'global' && selectedRecordIds.length !== 1) {
      throw new Error('Select exactly one record');
    }

    const context = await loadDecisionContext(spec.target, selectedRecordIds[0]);

    if ('confirm' in spec) {
      const answer = await openCommandConfirmationModal({
        title: spec.confirm.title,
        subtitle:
          spec.target === 'global'
            ? spec.confirm.subtitle
            : `${context.title}. ${spec.confirm.subtitle}`,
        confirmButtonText: spec.confirm.confirmButtonText,
        confirmButtonAccent: spec.confirm.accent,
      });

      if (answer !== 'confirm') {
        return;
      }
    }

    await createDecision({
      decisionType: spec.decisionTypes[0],
      statusSeen: context.statusSeen,
      letterShaSeen: context.letterShaSeen,
      value: context.contentHashSeen,
      openingId: context.openingId,
      proposalId: context.proposalId,
      positioningId: context.positioningId,
    });

    await enqueueSnackbar({
      message: `${spec.label}: recorded. The harness applies it on its next pass.`,
      variant: 'success',
    });
  } catch (error) {
    await enqueueSnackbar({
      message: `${spec.label} was not recorded`,
      detailedMessage: error instanceof Error ? error.message : String(error),
      variant: 'error',
    });
  }
};
