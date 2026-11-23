import { defineView, ViewSortDirection } from 'twenty-sdk/define';

import { FIELD_IDS, VIEW_IDS } from 'src/constants/universal-identifiers';
import { openingTableView } from 'src/views/utils/opening-table-view.util';

// Openings that reached an end state.
export default defineView(
  openingTableView({
    ids: VIEW_IDS.openingsClosed,
    name: 'Closed',
    icon: 'IconArchive',
    position: 4,
    statuses: ['WON', 'REJECTED', 'WITHDRAWN'],
    sortFieldId: FIELD_IDS.opening.closesAt,
    sortDirection: ViewSortDirection.DESC,
  }),
);
