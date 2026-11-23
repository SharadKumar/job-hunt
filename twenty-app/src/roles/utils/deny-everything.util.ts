import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

import { OBJECT_IDS } from 'src/constants/universal-identifiers';
import { objectGrant } from 'src/roles/utils/object-grant.util';

// A role with no grants still reads system objects (messages, attachments,
// timeline), so a role meant to read nothing denies every standard object and
// every app object explicitly.
export const denyEverything = () => {
  const standard = Object.values(
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS as Record<
      string,
      { universalIdentifier?: string }
    >,
  )
    .map((entry) => entry?.universalIdentifier)
    .filter((id): id is string => typeof id === 'string');

  return [...new Set([...standard, ...Object.values(OBJECT_IDS)])].map((id) =>
    objectGrant(id, {}),
  );
};
