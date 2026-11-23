import {
  AggregateOperations,
  definePageLayout,
  PageLayoutTabLayoutMode,
} from 'twenty-sdk/define';

import {
  FIELD_IDS,
  OBJECT_IDS,
  TODAY_IDS,
} from 'src/constants/universal-identifiers';

// Today: four native count tiles across the top, the Today front component
// (escalations, Halt sends, sent today, last run) on the left, and two native
// charts of the pipeline on the right. Everything except the front component
// is Twenty's own widgets, so the numbers stay live without harness code.

const IN_QUEUE = ['SHORTLISTED', 'DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMISSION_PENDING'];
const IN_CONVERSATION = ['RESPONDED', 'INTERVIEW', 'OFFERED'];
const SENT = ['SUBMITTED', 'RESPONDED', 'INTERVIEW', 'OFFERED', 'WON'];
// Work still moving: everything between shortlisting and an outcome, except
// the long tail of plain submissions, which would dwarf the rest.
const IN_FLIGHT = [...IN_QUEUE, 'MANUAL_ACTION_NEEDED', 'AWAITING_EXTERNAL', 'PARKED', ...IN_CONVERSATION];

const CHART = { timezone: 'Australia/Sydney', firstDayOfTheWeek: 1 } as const;

const grid = (row: number, column: number, rowSpan: number, columnSpan: number) => ({
  layoutMode: PageLayoutTabLayoutMode.GRID as const,
  row,
  column,
  rowSpan,
  columnSpan,
});

const isOneOf = (fieldMetadataUniversalIdentifier: string, values: string[]) => ({
  recordFilters: [
    { fieldMetadataUniversalIdentifier, operand: 'IS', value: JSON.stringify(values) },
  ],
});

// A count of openings in the given statuses.
const openingTile = (universalIdentifier: string, title: string, column: number, statuses: string[]) => ({
  universalIdentifier,
  title,
  type: 'GRAPH' as const,
  objectUniversalIdentifier: OBJECT_IDS.opening,
  position: grid(0, column, 2, 3),
  configuration: {
    configurationType: 'AGGREGATE_CHART' as const,
    aggregateFieldMetadataUniversalIdentifier: FIELD_IDS.opening.title,
    aggregateOperation: AggregateOperations.COUNT,
    displayDataLabel: true,
    filter: isOneOf(FIELD_IDS.opening.status, statuses),
    ...CHART,
  },
});

export default definePageLayout({
  universalIdentifier: TODAY_IDS.pageLayout,
  name: 'Today',
  type: 'STANDALONE_PAGE',
  tabs: [
    {
      universalIdentifier: TODAY_IDS.tab,
      title: 'Today',
      position: 0,
      icon: 'IconSun',
      layoutMode: PageLayoutTabLayoutMode.GRID,
      widgets: [
        {
          universalIdentifier: TODAY_IDS.needsYouTile,
          title: 'Needs you',
          type: 'GRAPH',
          objectUniversalIdentifier: OBJECT_IDS.escalation,
          position: grid(0, 0, 2, 3),
          configuration: {
            configurationType: 'AGGREGATE_CHART',
            aggregateFieldMetadataUniversalIdentifier: FIELD_IDS.escalation.name,
            aggregateOperation: AggregateOperations.COUNT,
            displayDataLabel: true,
            filter: isOneOf(FIELD_IDS.escalation.status, ['OPEN']),
            ...CHART,
          },
        },
        openingTile(TODAY_IDS.queueTile, 'In the queue', 3, IN_QUEUE),
        openingTile(TODAY_IDS.conversationTile, 'In conversation', 6, IN_CONVERSATION),
        openingTile(TODAY_IDS.sentTile, 'Applications sent', 9, SENT),
        {
          universalIdentifier: TODAY_IDS.widget,
          title: 'What needs you',
          type: 'FRONT_COMPONENT',
          position: grid(2, 0, 12, 7),
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: TODAY_IDS.frontComponent,
          },
        },
        {
          universalIdentifier: TODAY_IDS.pipelineChart,
          title: 'Work in flight',
          type: 'GRAPH',
          objectUniversalIdentifier: OBJECT_IDS.opening,
          position: grid(2, 7, 6, 5),
          configuration: {
            configurationType: 'BAR_CHART',
            aggregateFieldMetadataUniversalIdentifier: FIELD_IDS.opening.title,
            aggregateOperation: AggregateOperations.COUNT,
            primaryAxisGroupByFieldMetadataUniversalIdentifier: FIELD_IDS.opening.status,
            primaryAxisOrderBy: 'VALUE_DESC',
            omitNullValues: true,
            layout: 'HORIZONTAL',
            axisNameDisplay: 'NONE',
            color: 'auto',
            displayDataLabel: true,
            filter: isOneOf(FIELD_IDS.opening.status, IN_FLIGHT),
            ...CHART,
          },
        },
        {
          universalIdentifier: TODAY_IDS.channelChart,
          title: 'Applications by channel',
          type: 'GRAPH',
          objectUniversalIdentifier: OBJECT_IDS.opening,
          position: grid(8, 7, 6, 5),
          configuration: {
            configurationType: 'PIE_CHART',
            aggregateFieldMetadataUniversalIdentifier: FIELD_IDS.opening.title,
            aggregateOperation: AggregateOperations.COUNT,
            groupByFieldMetadataUniversalIdentifier: FIELD_IDS.opening.channel,
            displayLegend: true,
            showCenterMetric: true,
            hideEmptyCategory: true,
            filter: isOneOf(FIELD_IDS.opening.status, SENT),
            ...CHART,
          },
        },
      ],
    },
  ],
});
