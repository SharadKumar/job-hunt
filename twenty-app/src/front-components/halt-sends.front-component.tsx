import { defineFrontComponent } from 'twenty-sdk/define';
import { Command, useSelectedRecordIds } from 'twenty-sdk/front-component';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { runHeadlessDecision } from 'src/front-components/utils/run-headless-decision.util';

const HaltSendsButton = () => {
  const selectedRecordIds = useSelectedRecordIds();

  return (
    <Command execute={() => runHeadlessDecision('haltSends', selectedRecordIds)} />
  );
};

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.haltSends.frontComponent,
  name: 'halt-sends',
  description: 'Halts every send',
  component: HaltSendsButton,
  isHeadless: true,
});
