import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import { TODAY_IDS } from 'src/constants/universal-identifiers';

// Top level, outside the Job hunt section: Twenty opens the first item outside
// any section for Home and the root address, so this makes Today the home page.
export default defineNavigationMenuItem({
  universalIdentifier: TODAY_IDS.navigationMenuItem,
  name: 'Today',
  icon: 'IconSun',
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: TODAY_IDS.pageLayout,
  position: 0,
});
