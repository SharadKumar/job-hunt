import { defineView, ViewSortDirection } from 'twenty-sdk/define';

import { FIELD_IDS, VIEW_IDS } from 'src/constants/universal-identifiers';
import { openingTableView } from 'src/views/utils/opening-table-view.util';

// The apply queue: shortlisted openings, best score first.
export default defineView(
  openingTableView({
    ids: VIEW_IDS.openingsQueue,
    name: 'Queue',
    icon: 'IconListNumbers',
    position: 1,
    statuses: ['SHORTLISTED'],
    sortFieldId: FIELD_IDS.opening.score,
    sortDirection: ViewSortDirection.DESC,
  }),
);
