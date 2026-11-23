import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  TODAY_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: TODAY_IDS.navigationMenuItem,
  name: 'Today',
  icon: 'IconSun',
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: TODAY_IDS.pageLayout,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 0,
});
