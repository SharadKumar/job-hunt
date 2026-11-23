import { defineFrontComponent } from 'twenty-sdk/define';
import { Command, useSelectedRecordIds } from 'twenty-sdk/front-component';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { runHeadlessDecision } from 'src/front-components/utils/run-headless-decision.util';

const PositioningApproveBaselineButton = () => {
  const selectedRecordIds = useSelectedRecordIds();

  return (
    <Command execute={() => runHeadlessDecision('positioningApproveBaseline', selectedRecordIds)} />
  );
};

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.positioningApproveBaseline.frontComponent,
  name: 'positioning-approve-baseline',
  description: 'Approves a positioning baseline CV',
  component: PositioningApproveBaselineButton,
  isHeadless: true,
});
