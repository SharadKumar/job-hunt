import {
  defineView,
  getFieldUniversalIdentifier,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  APPLICATION_UNIVERSAL_IDENTIFIER,
  FIELD_IDS,
  OBJECT_IDS,
  VIEW_IDS,
} from 'src/constants/universal-identifiers';

const F = FIELD_IDS.proposal;
const V = VIEW_IDS.proposalsNeedsYou;

const COLUMNS = [F.summary, F.proposalType, F.proposer, F.status, F.opening, F.outcome];

// Proposals awaiting Confirm or Decline, newest first.
export default defineView({
  universalIdentifier: V.view,
  name: 'Needs you',
  objectUniversalIdentifier: OBJECT_IDS.proposal,
  type: ViewType.TABLE,
  icon: 'IconHandFinger',
  position: 0,
  fields: COLUMNS.map((fieldId, position) => ({
    universalIdentifier: V.fields[position],
    fieldMetadataUniversalIdentifier: fieldId,
    position,
    isVisible: true,
  })),
  filters: [
    {
      universalIdentifier: V.filter,
      fieldMetadataUniversalIdentifier: F.status,
      operand: ViewFilterOperand.IS,
      value: ['PROPOSED'],
    },
  ],
  sorts: [
    {
      universalIdentifier: V.sort,
      fieldMetadataUniversalIdentifier: getFieldUniversalIdentifier({
        applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
        objectUniversalIdentifier: OBJECT_IDS.proposal,
        name: 'createdAt',
      }),
      direction: ViewSortDirection.DESC,
    },
  ],
});
