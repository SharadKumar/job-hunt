import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.proposals,
  name: 'Proposals',
  icon: 'IconBulb',
  color: 'orange',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: OBJECT_IDS.proposal,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 3,
});
