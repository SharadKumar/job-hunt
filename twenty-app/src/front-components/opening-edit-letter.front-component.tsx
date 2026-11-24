import { defineFrontComponent } from 'twenty-sdk/define';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { DecisionForm } from 'src/front-components/components/decision-form';

const OpeningEditLetterButton = () => <DecisionForm buttonKey="openingEditLetter" />;

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.openingEditLetter.frontComponent,
  name: 'opening-edit-letter',
  description: 'Records the edited letter from the person',
  component: OpeningEditLetterButton,
});
