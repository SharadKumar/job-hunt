import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.runs,
  name: 'Runs',
  icon: 'IconPlayerPlay',
  color: 'turquoise',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: OBJECT_IDS.run,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 6,
});
