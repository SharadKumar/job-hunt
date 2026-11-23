import {
  defineObject,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  APPLY_METHOD_OPTIONS,
  ARRANGEMENT_OPTIONS,
  OPENING_STATUS_OPTIONS,
  PARKED_BY_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  booleanField,
  currencyField,
  dateField,
  dateTimeField,
  linksField,
  manyToOneField,
  numberField,
  oneToManyField,
  rawJsonField,
  richTextField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.opening;
const COMPANY = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier;
const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier;

// The pipeline row. Written by the harness only.
export default defineObject({
  universalIdentifier: OBJECT_IDS.opening,
  nameSingular: 'opening',
  namePlural: 'openings',
  labelSingular: 'Opening',
  labelPlural: 'Openings',
  description: 'A role the harness found, with its pipeline status',
  icon: 'IconBriefcase',
  labelIdentifierFieldMetadataUniversalIdentifier: F.title,
  fields: [
    textField({ universalIdentifier: F.title, name: 'title', label: 'Title', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.harnessId, name: 'harnessId', label: 'Harness id', icon: 'IconId' }),
    textField({ universalIdentifier: F.channel, name: 'channel', label: 'Channel', icon: 'IconBroadcast' }),
    linksField({ universalIdentifier: F.url, name: 'url', label: 'Advert', icon: 'IconLink' }),
    textField({ universalIdentifier: F.location, name: 'location', label: 'Location', icon: 'IconMapPin' }),
    selectField({ universalIdentifier: F.arrangement, name: 'arrangement', label: 'Arrangement', icon: 'IconBuilding', options: ARRANGEMENT_OPTIONS }),
    selectField({ universalIdentifier: F.applyMethod, name: 'applyMethod', label: 'Apply method', icon: 'IconSend', options: APPLY_METHOD_OPTIONS }),
    currencyField({ universalIdentifier: F.rateMin, name: 'rateMin', label: 'Rate from', icon: 'IconCurrencyDollar' }),
    currencyField({ universalIdentifier: F.rateMax, name: 'rateMax', label: 'Rate to', icon: 'IconCurrencyDollar' }),
    dateField({ universalIdentifier: F.postedAt, name: 'postedAt', label: 'Posted', icon: 'IconCalendar' }),
    dateField({ universalIdentifier: F.closesAt, name: 'closesAt', label: 'Closes', icon: 'IconCalendarDue' }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: OPENING_STATUS_OPTIONS, defaultValue: 'DISCOVERED' }),
    numberField({ universalIdentifier: F.score, name: 'score', label: 'Score', icon: 'IconChartBar' }),
    textField({ universalIdentifier: F.reasons, name: 'reasons', label: 'Score reasons', icon: 'IconListDetails' }),
    textField({ universalIdentifier: F.fit, name: 'fit', label: 'Fit', icon: 'IconTarget' }),
    textField({ universalIdentifier: F.redFlags, name: 'redFlags', label: 'Red flags', icon: 'IconFlag' }),
    booleanField({ universalIdentifier: F.redFlagBlocker, name: 'redFlagBlocker', label: 'Red flag blocks', icon: 'IconBan' }),
    booleanField({ universalIdentifier: F.userSaved, name: 'userSaved', label: 'Saved on channel', icon: 'IconBookmark' }),
    textField({ universalIdentifier: F.parkedReason, name: 'parkedReason', label: 'Parked reason', icon: 'IconParking' }),
    selectField({ universalIdentifier: F.parkedBy, name: 'parkedBy', label: 'Parked by', icon: 'IconUser', options: PARKED_BY_OPTIONS }),
    textField({ universalIdentifier: F.duplicateGroup, name: 'duplicateGroup', label: 'Duplicate group', icon: 'IconCopy' }),
    richTextField({ universalIdentifier: F.jd, name: 'jd', label: 'Job description', icon: 'IconFileDescription' }),
    rawJsonField({ universalIdentifier: F.classification, name: 'classification', label: 'Classification', icon: 'IconBraces' }),
    dateTimeField({ universalIdentifier: F.submittedAt, name: 'submittedAt', label: 'Submitted', icon: 'IconSend' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.employer, name: 'employer', label: 'Employer', icon: 'IconBuildingSkyscraper', targetObject: COMPANY, targetField: FIELD_IDS.company.employerOpenings }),
    manyToOneField({ universalIdentifier: F.agency, name: 'agency', label: 'Agency', icon: 'IconBuildingStore', targetObject: COMPANY, targetField: FIELD_IDS.company.agencyOpenings }),
    manyToOneField({ universalIdentifier: F.positioning, name: 'positioning', label: 'Positioning', icon: 'IconTarget', targetObject: OBJECT_IDS.positioning, targetField: FIELD_IDS.positioning.openings }),
    manyToOneField({ universalIdentifier: F.contact, name: 'contact', label: 'Contact', icon: 'IconUser', targetObject: PERSON, targetField: FIELD_IDS.person.contactOpenings }),
    oneToManyField({ universalIdentifier: F.applications, name: 'applications', label: 'Applications', icon: 'IconFileText', targetObject: OBJECT_IDS.application, targetField: FIELD_IDS.application.opening }),
    oneToManyField({ universalIdentifier: F.proposals, name: 'proposals', label: 'Proposals', icon: 'IconBulb', targetObject: OBJECT_IDS.proposal, targetField: FIELD_IDS.proposal.opening }),
    oneToManyField({ universalIdentifier: F.decisions, name: 'decisions', label: 'Decisions', icon: 'IconCheckbox', targetObject: OBJECT_IDS.decision, targetField: FIELD_IDS.decision.opening }),
    oneToManyField({ universalIdentifier: F.escalations, name: 'escalations', label: 'Escalations', icon: 'IconAlertTriangle', targetObject: OBJECT_IDS.escalation, targetField: FIELD_IDS.escalation.opening }),
    oneToManyField({ universalIdentifier: F.engagements, name: 'engagements', label: 'Engagements', icon: 'IconHeartHandshake', targetObject: OBJECT_IDS.engagement, targetField: FIELD_IDS.engagement.opening }),
    oneToManyField({ universalIdentifier: F.screeningQuestions, name: 'screeningQuestions', label: 'Screening questions', icon: 'IconQuestionMark', targetObject: OBJECT_IDS.screeningQuestion, targetField: FIELD_IDS.screeningQuestion.opening }),
    oneToManyField({ universalIdentifier: F.keywordQuestions, name: 'keywordQuestions', label: 'Keyword questions', icon: 'IconTags', targetObject: OBJECT_IDS.keywordQuestion, targetField: FIELD_IDS.keywordQuestion.opening }),
  ],
});
