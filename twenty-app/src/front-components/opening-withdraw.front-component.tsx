import { defineFrontComponent } from 'twenty-sdk/define';
import { Command, useSelectedRecordIds } from 'twenty-sdk/front-component';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { runHeadlessDecision } from 'src/front-components/utils/run-headless-decision.util';

const OpeningWithdrawButton = () => {
  const selectedRecordIds = useSelectedRecordIds();

  return (
    <Command execute={() => runHeadlessDecision('openingWithdraw', selectedRecordIds)} />
  );
};

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingWithdraw.frontComponent,
  name: 'opening-withdraw',
  description: 'Withdraws from an opening',
  component: OpeningWithdrawButton,
  isHeadless: true,
});
