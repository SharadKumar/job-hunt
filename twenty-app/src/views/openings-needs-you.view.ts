import { defineView, ViewSortDirection } from 'twenty-sdk/define';

import { FIELD_IDS, VIEW_IDS } from 'src/constants/universal-identifiers';
import { openingTableView } from 'src/views/utils/opening-table-view.util';

// Openings waiting on the person, soonest closing first.
export default defineView(
  openingTableView({
    ids: VIEW_IDS.openingsNeedsYou,
    name: 'Needs you',
    icon: 'IconHandFinger',
    position: 2,
    statuses: ['AWAITING_APPROVAL', 'MANUAL_ACTION_NEEDED'],
    sortFieldId: FIELD_IDS.opening.closesAt,
    sortDirection: ViewSortDirection.ASC,
  }),
);
