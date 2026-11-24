import { defineFrontComponent } from 'twenty-sdk/define';
import { Command, useSelectedRecordIds } from 'twenty-sdk/front-component';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { runHeadlessDecision } from 'src/front-components/utils/run-headless-decision.util';

const OpeningApproveButton = () => {
  const selectedRecordIds = useSelectedRecordIds();

  return (
    <Command execute={() => runHeadlessDecision('openingApprove', selectedRecordIds)} />
  );
};

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingApprove.frontComponent,
  name: 'opening-approve',
  description: 'Approves the package shown on an opening',
  component: OpeningApproveButton,
  isHeadless: true,
});
