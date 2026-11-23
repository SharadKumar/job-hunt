import { describe, expect, it } from 'vitest';

import { startOfLocalDay } from 'src/utils/start-of-local-day.util';

describe('startOfLocalDay', () => {
  it('returns local midnight of the same day', () => {
    const now = new Date(2026, 0, 15, 14, 30, 5);
    const start = new Date(startOfLocalDay(now));

    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(15);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
  });

  it('does not change the date it is given', () => {
    const now = new Date(2026, 5, 1, 9);
    const before = now.getTime();

    startOfLocalDay(now);
    expect(now.getTime()).toBe(before);
  });
});
