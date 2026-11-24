import { describe, expect, it } from 'vitest';

import { type DecisionContext } from 'src/types/decision-context';
import { buildFormDecision } from 'src/utils/build-form-decision.util';

const opening: DecisionContext = {
  title: 'Example role',
  statusSeen: 'AWAITING_APPROVAL',
  letterShaSeen: 'sha-1',
  letterMarkdown: 'Dear team,\nOriginal.',
  openingId: 'opening-1',
};

describe('buildFormDecision', () => {
  it('confirms a proposal with an optional edited value', () => {
    const context: DecisionContext = {
      title: 'Answer a question',
      statusSeen: 'PROPOSED',
      proposalId: 'proposal-1',
    };

    expect(buildFormDecision('proposalConfirm', { text: 'Yes' }, context)).toEqual({
      decision: {
        decisionType: 'CONFIRM',
        statusSeen: 'PROPOSED',
        proposalId: 'proposal-1',
        openingId: undefined,
        positioningId: undefined,
        value: 'Yes',
        note: undefined,
      },
    });
  });

  it('requires a confirmation reference to mark sent', () => {
    expect(buildFormDecision('openingMarkSent', { text: ' ' }, opening)).toEqual({
      error: 'Enter the confirmation reference from the channel',
    });
    const built = buildFormDecision('openingMarkSent', { text: 'REF-1' }, opening);

    expect(built).toMatchObject({
      decision: { decisionType: 'MARK_SENT', value: 'REF-1', letterShaSeen: 'sha-1' },
    });
  });

  it('accepts only the listed outcomes', () => {
    expect(buildFormDecision('openingOutcome', { choice: 'APPROVE' }, opening)).toEqual({
      error: 'Choose an outcome',
    });
    expect(buildFormDecision('openingOutcome', { choice: 'OUTCOME_WON' }, opening)).toMatchObject({
      decision: { decisionType: 'OUTCOME_WON', statusSeen: 'AWAITING_APPROVAL' },
    });
  });

  it('requires a reason for a redraft', () => {
    expect(buildFormDecision('openingRequestRedraft', {}, opening)).toEqual({
      error: 'Say what the redraft should change',
    });
    expect(
      buildFormDecision('openingRequestRedraft', { note: 'Shorter' }, opening),
    ).toMatchObject({ decision: { decisionType: 'REQUEST_REDRAFT', note: 'Shorter', letterShaSeen: 'sha-1' } });
  });

  it('refuses an empty or unchanged letter edit', () => {
    expect(buildFormDecision('openingEditLetter', { text: '' }, opening)).toEqual({
      error: 'The letter cannot be empty',
    });
    expect(
      buildFormDecision('openingEditLetter', { text: 'Dear team,\nOriginal.\n' }, opening),
    ).toEqual({ error: 'The letter is unchanged' });
    expect(
      buildFormDecision('openingEditLetter', { text: 'Dear team,\nEdited.' }, opening),
    ).toMatchObject({
      decision: { decisionType: 'EDIT_LETTER', value: 'Dear team,\nEdited.', letterShaSeen: 'sha-1' },
    });
  });

  it('records the cap and optional expiry when enabling autopilot', () => {
    const context: DecisionContext = { title: 'Send switch', statusSeen: 'AUTOPILOT_OFF' };
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(buildFormDecision('enableAutopilot', { maxPerDay: '0' }, context, now)).toEqual({
      error: 'The daily cap must be a whole number of at least 1',
    });
    expect(
      buildFormDecision('enableAutopilot', { maxPerDay: '3', expiresInDays: 'x' }, context, now),
    ).toEqual({ error: 'Expiry must be a whole number of days, or empty' });
    expect(
      buildFormDecision('enableAutopilot', { maxPerDay: '3', expiresInDays: '7' }, context, now),
    ).toMatchObject({
      decision: {
        decisionType: 'ENABLE_AUTOPILOT',
        statusSeen: 'AUTOPILOT_OFF',
        value: '{"maxPerDay":3}',
        expiresAt: '2026-01-08T00:00:00.000Z',
      },
    });
    expect(
      buildFormDecision('enableAutopilot', { maxPerDay: '3' }, context, now),
    ).toMatchObject({ decision: { expiresAt: undefined } });
  });

  it('has no form for a headless button', () => {
    expect(buildFormDecision('haltSends', {}, opening)).toEqual({ error: 'Halt sends has no form' });
  });
});
