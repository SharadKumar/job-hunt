import { defineFrontComponent } from 'twenty-sdk/define';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { DecisionForm } from 'src/front-components/components/decision-form';

const OpeningMarkSentButton = () => <DecisionForm buttonKey="openingMarkSent" />;

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingMarkSent.frontComponent,
  name: 'opening-mark-sent',
  description: 'Records a send the person made by hand',
  component: OpeningMarkSentButton,
});
