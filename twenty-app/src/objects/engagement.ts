import {
  defineObject,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENGAGEMENT_STATUS_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  currencyField,
  dateField,
  manyToOneField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.engagement;

// Work after a win. Owned by the person.
export default defineObject({
  universalIdentifier: OBJECT_IDS.engagement,
  nameSingular: 'engagement',
  namePlural: 'engagements',
  labelSingular: 'Engagement',
  labelPlural: 'Engagements',
  description: 'A contract the person won and is delivering',
  icon: 'IconHeartHandshake',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    dateField({ universalIdentifier: F.startDate, name: 'startDate', label: 'Start', icon: 'IconCalendar' }),
    dateField({ universalIdentifier: F.endDate, name: 'endDate', label: 'End', icon: 'IconCalendarDue' }),
    currencyField({ universalIdentifier: F.rate, name: 'rate', label: 'Rate', icon: 'IconCurrencyDollar' }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: ENGAGEMENT_STATUS_OPTIONS, defaultValue: 'ACTIVE' }),
    textField({ universalIdentifier: F.notes, name: 'notes', label: 'Notes', icon: 'IconNotes' }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.engagements }),
    manyToOneField({ universalIdentifier: F.client, name: 'client', label: 'Client', icon: 'IconBuildingSkyscraper', targetObject: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier, targetField: FIELD_IDS.company.engagements }),
  ],
});
