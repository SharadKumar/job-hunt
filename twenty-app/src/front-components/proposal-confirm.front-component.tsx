import { defineFrontComponent } from 'twenty-sdk/define';

import { BUTTON_IDS } from 'src/constants/universal-identifiers';
import { DecisionForm } from 'src/front-components/components/decision-form';

const ProposalConfirmButton = () => <DecisionForm buttonKey="proposalConfirm" />;

export default defineFrontComponent({
  universalIdentifier: BUTTON_IDS.proposalConfirm.frontComponent,
  name: 'proposal-confirm',
  description: 'Confirms a proposal with an optional edited value',
  component: ProposalConfirmButton,
});
