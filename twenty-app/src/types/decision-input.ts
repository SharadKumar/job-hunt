import { type DecisionType } from 'src/constants/select-options';

// What a button records. Exactly one of these becomes one decision record.
export type DecisionInput = {
  decisionType: DecisionType;
  statusSeen?: string | null;
  letterShaSeen?: string | null;
  note?: string | null;
  value?: string | null;
  expiresAt?: string | null;
  proposalId?: string | null;
  openingId?: string | null;
  positioningId?: string | null;
};
