import { defineFrontComponent } from 'twenty-sdk/define';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { DecisionForm } from 'src/front-components/components/decision-form';

const OpeningOutcomeButton = () => <DecisionForm buttonKey="openingOutcome" />;

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingOutcome.frontComponent,
  name: 'opening-outcome',
  description: 'Records what happened after a send',
  component: OpeningOutcomeButton,
});
