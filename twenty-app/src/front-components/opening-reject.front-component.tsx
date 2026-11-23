import { defineFrontComponent } from 'twenty-sdk/define';
import { Command, useSelectedRecordIds } from 'twenty-sdk/front-component';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { runHeadlessDecision } from 'src/front-components/utils/run-headless-decision.util';

const OpeningRejectButton = () => {
  const selectedRecordIds = useSelectedRecordIds();

  return (
    <Command execute={() => runHeadlessDecision('openingReject', selectedRecordIds)} />
  );
};

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingReject.frontComponent,
  name: 'opening-reject',
  description: 'Rejects an opening',
  component: OpeningRejectButton,
  isHeadless: true,
});
