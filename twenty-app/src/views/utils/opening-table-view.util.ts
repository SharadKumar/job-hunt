import {
  type defineView,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import { type OpeningStatus } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';

type ViewConfig = Parameters<typeof defineView>[0];

const F = FIELD_IDS.opening;

const TABLE_FIELDS = [
  F.title,
  F.employer,
  F.status,
  F.score,
  F.rateMin,
  F.rateMax,
  F.closesAt,
  F.channel,
];

// A table of openings filtered to a set of statuses.
export const openingTableView = ({
  ids,
  name,
  icon,
  position,
  statuses,
  sortFieldId,
  sortDirection,
}: {
  ids: { view: string; fields: readonly string[]; filter: string; sort: string };
  name: string;
  icon: string;
  position: number;
  statuses: readonly OpeningStatus[];
  sortFieldId: string;
  sortDirection: ViewSortDirection;
}): ViewConfig => ({
  universalIdentifier: ids.view,
  name,
  objectUniversalIdentifier: OBJECT_IDS.opening,
  type: ViewType.TABLE,
  icon,
  position,
  fields: TABLE_FIELDS.map((fieldId, index) => ({
    universalIdentifier: ids.fields[index],
    fieldMetadataUniversalIdentifier: fieldId,
    position: index,
    isVisible: true,
  })),
  filters: [
    {
      universalIdentifier: ids.filter,
      fieldMetadataUniversalIdentifier: F.status,
      operand: ViewFilterOperand.IS,
      value: [...statuses],
    },
  ],
  sorts: [
    {
      universalIdentifier: ids.sort,
      fieldMetadataUniversalIdentifier: sortFieldId,
      direction: sortDirection,
    },
  ],
});
