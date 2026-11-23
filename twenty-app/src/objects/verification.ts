import { defineObject } from 'twenty-sdk/define';

import { VERIFICATION_RESULT_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.verification;

// Private evidence for a verification check. The public log holds only
// pass or fail lines.
export default defineObject({
  universalIdentifier: OBJECT_IDS.verification,
  nameSingular: 'verification',
  namePlural: 'verifications',
  labelSingular: 'Verification',
  labelPlural: 'Verifications',
  description: 'Private evidence for one verification check',
  icon: 'IconShieldCheck',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.check, name: 'check', label: 'Check', icon: 'IconListCheck' }),
    selectField({ universalIdentifier: F.result, name: 'result', label: 'Result', icon: 'IconFlag', options: VERIFICATION_RESULT_OPTIONS, defaultValue: 'PENDING' }),
    textField({ universalIdentifier: F.evidence, name: 'evidence', label: 'Evidence', icon: 'IconFileText' }),
    textField({ universalIdentifier: F.commitRef, name: 'commitRef', label: 'Commit', icon: 'IconGitCommit' }),
    dateTimeField({ universalIdentifier: F.checkedAt, name: 'checkedAt', label: 'Checked', icon: 'IconClock' }),
  ],
});
