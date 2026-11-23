import {
  definePageLayout,
  PageLayoutTabLayoutMode,
  PageLayoutWidgetVerticalListHeightBehavior,
} from 'twenty-sdk/define';

import { TODAY_IDS } from 'src/constants/universal-identifiers';

// A standalone page hosting the Today front component.
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
      layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      widgets: [
        {
          universalIdentifier: TODAY_IDS.widget,
          title: 'Today',
          type: 'FRONT_COMPONENT',
          heightBehavior: PageLayoutWidgetVerticalListHeightBehavior.TAB_VIEWPORT,
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: TODAY_IDS.frontComponent,
          },
        },
      ],
    },
  ],
});
