import { DECISION_TYPE_OPTIONS } from 'src/constants/select-options';
import { type DecisionInput } from 'src/types/decision-input';

const trimmed = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = value.trim();

  return text.length > 0 ? text : undefined;
};

// Turns a button's input into the create payload for one decision. Empty
// values are dropped, and consume fields are never set here: only the
// harness writes those.
export const buildDecisionData = (input: DecisionInput) => {
  const option = DECISION_TYPE_OPTIONS.find(
    (candidate) => candidate.value === input.decisionType,
  );

  if (option === undefined) {
    throw new Error(`Unknown decision type ${input.decisionType}`);
  }

  const data: Record<string, string> = {
    name: option.label,
    decisionType: option.value,
  };

  const optional: [string, string | null | undefined][] = [
    ['statusSeen', input.statusSeen],
    ['letterShaSeen', input.letterShaSeen],
    ['note', input.note],
    ['value', input.value],
    ['expiresAt', input.expiresAt],
    ['proposalId', input.proposalId],
    ['openingId', input.openingId],
    ['positioningId', input.positioningId],
  ];

  for (const [key, raw] of optional) {
    const value = trimmed(raw);

    if (value !== undefined) {
      data[key] = value;
    }
  }

  return data;
};
