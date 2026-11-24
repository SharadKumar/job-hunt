import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import { NAVIGATION_IDS } from 'src/constants/universal-identifiers';

// The sidebar section holding Today and the app's objects.
export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.section,
  name: 'Job hunt',
  icon: 'IconBriefcase',
  type: NavigationMenuItemType.SECTION,
  position: 0,
});
