import { BUTTONS, type ButtonKey } from 'src/constants/buttons';
import { type DecisionContext } from 'src/types/decision-context';
import { type DecisionFormValues } from 'src/types/decision-form-values';
import { type DecisionInput } from 'src/types/decision-input';

const DAY_MS = 24 * 60 * 60 * 1000;

const isBlank = (value: string | undefined) =>
  value === undefined || value.trim().length === 0;

// Validates a form button's values and turns them into the one decision it
// writes. Returns an error message for the person instead when a required
// value is missing or malformed.
export const buildFormDecision = (
  key: ButtonKey,
  values: DecisionFormValues,
  context: DecisionContext,
  now: Date = new Date(),
): { decision: DecisionInput } | { error: string } => {
  const spec = BUTTONS[key];
  const links = {
    statusSeen: context.statusSeen,
    openingId: context.openingId,
    proposalId: context.proposalId,
    positioningId: context.positioningId,
  };

  switch (key) {
    case 'proposalConfirm':
      return {
        decision: {
          ...links,
          decisionType: 'CONFIRM',
          value: values.text,
          note: values.note,
        },
      };
    case 'openingMarkSent':
      if (isBlank(values.text)) {
        return { error: 'Enter the confirmation reference from the channel' };
      }

      return {
        decision: {
          ...links,
          decisionType: 'MARK_SENT',
          letterShaSeen: context.letterShaSeen,
          value: values.text,
          note: values.note,
        },
      };
    case 'openingOutcome': {
      const choice = spec.decisionTypes.find((type) => type === values.choice);

      if (choice === undefined) {
        return { error: 'Choose an outcome' };
      }

      return { decision: { ...links, decisionType: choice, note: values.note } };
    }
    case 'openingRequestRedraft':
      if (isBlank(values.note)) {
        return { error: 'Say what the redraft should change' };
      }

      return {
        decision: {
          ...links,
          decisionType: 'REQUEST_REDRAFT',
          letterShaSeen: context.letterShaSeen,
          note: values.note,
        },
      };
    case 'openingEditLetter':
      if (isBlank(values.text)) {
        return { error: 'The letter cannot be empty' };
      }

      if (values.text?.trim() === context.letterMarkdown?.trim()) {
        return { error: 'The letter is unchanged' };
      }

      return {
        decision: {
          ...links,
          decisionType: 'EDIT_LETTER',
          letterShaSeen: context.letterShaSeen,
          value: values.text,
          note: values.note,
        },
      };
    case 'enableAutopilot': {
      const maxPerDay = Number(values.maxPerDay);

      if (!Number.isInteger(maxPerDay) || maxPerDay < 1) {
        return { error: 'The daily cap must be a whole number of at least 1' };
      }

      let expiresAt: string | undefined;

      if (!isBlank(values.expiresInDays)) {
        const days = Number(values.expiresInDays);

        if (!Number.isInteger(days) || days < 1) {
          return { error: 'Expiry must be a whole number of days, or empty' };
        }

        expiresAt = new Date(now.getTime() + days * DAY_MS).toISOString();
      }

      return {
        decision: {
          ...links,
          decisionType: 'ENABLE_AUTOPILOT',
          value: JSON.stringify({ maxPerDay }),
          expiresAt,
          note: values.note,
        },
      };
    }
    default:
      return { error: `${spec.label} has no form` };
  }
};
