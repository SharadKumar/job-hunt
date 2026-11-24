import { describe, expect, it } from 'vitest';

import { buildDecisionData } from 'src/utils/build-decision-data.util';

describe('buildDecisionData', () => {
  it('names the decision after its type and keeps what was seen', () => {
    expect(
      buildDecisionData({
        decisionType: 'APPROVE',
        statusSeen: 'AWAITING_APPROVAL',
        letterShaSeen: 'abc123',
        openingId: 'opening-1',
      }),
    ).toEqual({
      name: 'Approve',
      decisionType: 'APPROVE',
      statusSeen: 'AWAITING_APPROVAL',
      letterShaSeen: 'abc123',
      openingId: 'opening-1',
    });
  });

  it('drops empty and blank values', () => {
    expect(
      buildDecisionData({
        decisionType: 'HALT_SENDS',
        statusSeen: 'AUTOPILOT_ON',
        note: '   ',
        value: '',
        proposalId: null,
        openingId: undefined,
      }),
    ).toEqual({ name: 'Halt sends', decisionType: 'HALT_SENDS', statusSeen: 'AUTOPILOT_ON' });
  });

  it('never writes the consume fields', () => {
    const data = buildDecisionData({ decisionType: 'CONFIRM', value: 'answer' });

    expect(Object.keys(data)).not.toContain('consumedAt');
    expect(Object.keys(data)).not.toContain('result');
    expect(Object.keys(data)).not.toContain('resultReason');
  });

  it('rejects an unknown type', () => {
    expect(() => buildDecisionData({ decisionType: 'NOPE' as never })).toThrow(
      'Unknown decision type NOPE',
    );
  });
});
