import { defineFrontComponent } from 'twenty-sdk/define';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { DecisionForm } from 'src/front-components/components/decision-form';

const EnableAutopilotButton = () => <DecisionForm buttonKey="enableAutopilot" />;

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.enableAutopilot.frontComponent,
  name: 'enable-autopilot',
  description: 'Enables unattended one-click sends with a daily cap',
  component: EnableAutopilotButton,
});
