import { defineView, ViewType } from 'twenty-sdk/define';

import { OPENING_STATUS_OPTIONS } from 'src/constants/select-options';
import {
  FIELD_IDS,
  OBJECT_IDS,
  VIEW_IDS,
} from 'src/constants/universal-identifiers';

const F = FIELD_IDS.opening;
const V = VIEW_IDS.openingsBoard;

const CARD_FIELDS = [F.title, F.employer, F.status, F.score, F.rateMax, F.closesAt];

// Every opening on a board grouped by status; empty columns are hidden.
export default defineView({
  universalIdentifier: V.view,
  name: 'Openings',
  objectUniversalIdentifier: OBJECT_IDS.opening,
  type: ViewType.KANBAN,
  icon: 'IconLayoutKanban',
  position: 0,
  mainGroupByFieldMetadataUniversalIdentifier: F.status,
  shouldHideEmptyGroups: true,
  fields: CARD_FIELDS.map((fieldId, position) => ({
    universalIdentifier: V.fields[position],
    fieldMetadataUniversalIdentifier: fieldId,
    position,
    isVisible: true,
  })),
  groups: OPENING_STATUS_OPTIONS.map((option, position) => ({
    universalIdentifier: VIEW_IDS.openingsBoardGroups[option.value],
    fieldValue: option.value,
    position,
    isVisible: true,
  })),
});
