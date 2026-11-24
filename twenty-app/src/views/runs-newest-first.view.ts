import { defineView, ViewSortDirection, ViewType } from 'twenty-sdk/define';

import {
  FIELD_IDS,
  OBJECT_IDS,
  VIEW_IDS,
} from 'src/constants/universal-identifiers';

const F = FIELD_IDS.run;
const V = VIEW_IDS.runsNewestFirst;

const COLUMNS = [
  F.name,
  F.kind,
  F.startedAt,
  F.finishedAt,
  F.exitCode,
  F.sentCount,
  F.escalationCount,
];

// Harness runs, newest first.
export default defineView({
  universalIdentifier: V.view,
  name: 'Newest first',
  objectUniversalIdentifier: OBJECT_IDS.run,
  type: ViewType.TABLE,
  icon: 'IconSortDescending',
  position: 0,
  fields: COLUMNS.map((fieldId, position) => ({
    universalIdentifier: V.fields[position],
    fieldMetadataUniversalIdentifier: fieldId,
    position,
    isVisible: true,
  })),
  sorts: [
    {
      universalIdentifier: V.sort,
      fieldMetadataUniversalIdentifier: F.startedAt,
      direction: ViewSortDirection.DESC,
    },
  ],
});
