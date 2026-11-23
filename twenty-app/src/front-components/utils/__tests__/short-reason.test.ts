import { describe, expect, it } from 'vitest';

import { shortReason } from 'src/front-components/utils/load-today.util';

describe('shortReason', () => {
  it('shows a screening question as the question', () => {
    expect(shortReason('Unanswered screening question: "Are you available to start in two weeks?"')).toBe('"Are you available to start in two weeks?"');
  });
  it('turns an external portal into where to apply', () => {
    expect(shortReason('External ATS redirect to jobs.example.com')).toBe('Apply on jobs.example.com');
  });
  it('drops run tags and keeps the first sentence', () => {
    expect(shortReason('[daily 2026-11-18] External portal, attended only. Package in archive has an approved CV.')).toBe('External portal, attended only');
  });
  it('caps long text', () => {
    expect(shortReason('word '.repeat(60)).length).toBeLessThanOrEqual(110);
  });
});
