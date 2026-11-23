import { defineView, ViewSortDirection } from 'twenty-sdk/define';

import { FIELD_IDS, VIEW_IDS } from 'src/constants/universal-identifiers';
import { openingTableView } from 'src/views/utils/opening-table-view.util';

// Sent applications still in play, newest first.
export default defineView(
  openingTableView({
    ids: VIEW_IDS.openingsSubmitted,
    name: 'Submitted',
    icon: 'IconSend',
    position: 3,
    statuses: ['SUBMITTED', 'RESPONDED', 'INTERVIEW', 'OFFERED'],
    sortFieldId: FIELD_IDS.opening.submittedAt,
    sortDirection: ViewSortDirection.DESC,
  }),
);
