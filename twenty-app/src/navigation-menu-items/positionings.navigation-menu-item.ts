import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.positionings,
  name: 'Positionings',
  icon: 'IconTarget',
  color: 'purple',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: OBJECT_IDS.positioning,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 4,
});
