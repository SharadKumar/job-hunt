import { defineFrontComponent } from 'twenty-sdk/define';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { DecisionForm } from 'src/front-components/components/decision-form';

const OpeningRequestRedraftButton = () => <DecisionForm buttonKey="openingRequestRedraft" />;

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingRequestRedraft.frontComponent,
  name: 'opening-request-redraft',
  description: 'Asks the harness to redraft the letter',
  component: OpeningRequestRedraftButton,
});
