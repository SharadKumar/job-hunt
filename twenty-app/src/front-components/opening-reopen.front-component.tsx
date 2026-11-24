import { defineFrontComponent } from 'twenty-sdk/define';
import { Command, useSelectedRecordIds } from 'twenty-sdk/front-component';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { runHeadlessDecision } from 'src/front-components/utils/run-headless-decision.util';

const OpeningReopenButton = () => {
  const selectedRecordIds = useSelectedRecordIds();

  return (
    <Command execute={() => runHeadlessDecision('openingReopen', selectedRecordIds)} />
  );
};

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingReopen.frontComponent,
  name: 'opening-reopen',
  description: 'Reopens a rejected or withdrawn opening',
  component: OpeningReopenButton,
  isHeadless: true,
});
