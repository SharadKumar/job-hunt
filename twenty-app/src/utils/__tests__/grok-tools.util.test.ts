import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GROK_PROPOSAL_TYPES } from 'src/constants/grok-tools';
import { PROPOSAL_TYPE_OPTIONS } from 'src/constants/select-options';
import {
  brief,
  CV_NOT_AVAILABLE,
  type Gql,
  openingSummary,
  autopilotChannels,
  openScreeningQuestions,
  request,
  rateText,
  requestFullText,
  summariseOpening,
} from 'src/utils/grok-tools.util';

const OPENING_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'SECRET-FULL-TEXT';

// A record as a careless query might return it: every forbidden field set.
const leakyOpening = {
  id: OPENING_ID,
  title: 'Platform lead',
  status: 'SHORTLISTED',
  channel: 'seek',
  fit: 'core',
  score: 8.5,
  reasons: 'Strong platform match',
  rateMin: { amountMicros: 900_000_000, currencyCode: 'AUD' },
  rateMax: { amountMicros: 1_100_000_000, currencyCode: 'AUD' },
  url: { primaryLinkUrl: 'https://example.com/job/1' },
  employer: { name: 'Acme Pty Ltd' },
  jd: { markdown: SECRET, blocknote: SECRET },
  harnessData: { notes: SECRET },
  classification: { reason: SECRET },
  letterMarkdown: SECRET,
  applications: [{ letterMarkdown: SECRET, composition: SECRET }],
};

type Call = { query: string; variables?: Record<string, unknown> };

// A fake GraphQL endpoint that records every call.
const fakeGql = (handlers: { match: RegExp; reply: (v?: Record<string, unknown>) => any }[]) => {
  const calls: Call[] = [];
  const gql: Gql = async (query, variables) => {
    calls.push({ query, variables });
    const handler = handlers.find((h) => h.match.test(query));

    if (!handler) {
      throw new Error(`unexpected query ${query.slice(0, 60)}`);
    }

    return handler.reply(variables);
  };

  return { gql, calls };
};

const FORBIDDEN_FIELDS = /\b(jd|harnessData|classification|letterMarkdown|composition|lettersSentUnattended|payload)\b/;

describe('allowlist', () => {
  it('matches the EXECUTORS keys in the harness proposals module', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../../tools/decisions/proposals.ts'),
      'utf8',
    );
    const block = source.match(/export const EXECUTORS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? '';
    const keys = [...block.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);

    expect(keys.length).toBeGreaterThan(0);
    expect([...GROK_PROPOSAL_TYPES].sort()).toEqual(keys.sort());
  });

  it('never includes DISCLOSURE and only uses known proposal types', () => {
    const known = PROPOSAL_TYPE_OPTIONS.map((o) => o.value as string);

    expect(GROK_PROPOSAL_TYPES as readonly string[]).not.toContain('DISCLOSURE');
    for (const type of GROK_PROPOSAL_TYPES) {
      expect(known).toContain(type);
    }
  });
});

describe('summaries', () => {
  it('keep rates and links and drop every full-text field', () => {
    const summary = summariseOpening(leakyOpening);

    expect(summary.rate).toBe('900 to 1100 AUD');
    expect(summary.link).toBe('https://example.com/job/1');
    expect(summary.employer).toBe('Acme Pty Ltd');
    expect(summary.scoreReasons).toBe('Strong platform match');
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('formats one-sided and missing rates', () => {
    const aud = (n: number) => ({ amountMicros: n * 1_000_000, currencyCode: 'AUD' });

    expect(rateText(aud(900), null)).toBe('from 900 AUD');
    expect(rateText(null, aud(1000))).toBe('up to 1000 AUD');
    expect(rateText(aud(950), aud(950))).toBe('950 AUD');
    expect(rateText(null, null)).toBeNull();
  });

  it('clip long free text', () => {
    const summary = summariseOpening({ ...leakyOpening, reasons: 'x'.repeat(5000) });

    expect(summary.scoreReasons?.length).toBeLessThanOrEqual(300);
  });
});

describe('brief and opening_summary', () => {
  it('select no forbidden field and return no full text', async () => {
    const { gql, calls } = fakeGql([
      {
        match: /GrokBrief/,
        reply: () => ({
          escalations: { edges: [{ node: { id: 'e1', name: 'Gate', kind: 'gate', priority: 'P1', reason: 'Blocked', harnessData: SECRET } }] },
          proposals: { edges: [{ node: { id: 'p1', summary: 'Redraft', proposalType: 'REDRAFT_LETTER', payload: SECRET } }] },
          openings: { edges: [{ node: leakyOpening }] },
          runs: { edges: [{ node: { id: 'r1', exitCode: 1, lettersSentUnattended: SECRET } }] },
          controls: { edges: [{ node: { name: 'autopilot off for now', autopilotEnabled: false, haltOpen: false } }] },
          documents: {
            edges: [
              { node: { id: 'd-pol', kind: 'SUBMISSION_POLICY', currentRevision: 2 } },
              { node: { id: 'd-scr', kind: 'SCREENING_ANSWERS', currentRevision: 1 } },
            ],
          },
        }),
      },
      {
        match: /GrokDone/,
        reply: () => ({ proposals: { edges: [{ node: { id: 'q1', summary: 'Answer a question', status: 'DONE', outcome: 'answered', payload: SECRET } }] } }),
      },
      {
        match: /GrokRevisions/,
        reply: () => ({
          documentRevisions: {
            edges: [
              { node: { documentId: 'd-pol', revision: 2, body: `# ${SECRET}\nautopilot:\n  channels: [seek]\n` } },
              { node: { documentId: 'd-scr', revision: 1, body: `answers:\n  - question: "${SECRET}"\n    answer: "x"\nunknown_questions:\n  - question: "Open one?"\n    answer: null\n` } },
            ],
          },
        }),
      },
      { match: /GrokOpening\(/, reply: () => ({ opening: leakyOpening }) },
    ]);
    const out = await brief(gql);
    const one = await openingSummary(gql, { id: OPENING_ID });

    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).toContain('https://example.com/job/1');
    expect(JSON.stringify(out)).toContain('900 to 1100 AUD');
    expect(JSON.stringify(one)).not.toContain(SECRET);
    expect(one.ok && (one.opening as { rate: string }).rate).toBe('900 to 1100 AUD');
    for (const call of calls) {
      expect(call.query).not.toMatch(FORBIDDEN_FIELDS);
    }
    expect(calls[0].variables?.queue).toEqual({ status: { in: ['SHORTLISTED', 'AWAITING_APPROVAL'] } });
    // The documents are read for their structure only: the switch, lanes and open questions.
    expect(out).toMatchObject({
      sendSwitch: { allowed: false, reason: 'autopilot off for now' },
      openScreeningQuestions: [{ question: 'Open one?' }],
      doneForYou: [{ id: 'q1', status: 'DONE', outcome: 'answered' }],
    });
  });

  it('refuse a malformed id without querying', async () => {
    const { gql, calls } = fakeGql([]);

    expect(await openingSummary(gql, { id: 'x" } } evil' })).toMatchObject({ ok: false });
    expect(await openingSummary(gql, null)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe('request_full_text', () => {
  const ok = () =>
    fakeGql([
      { match: /GrokOpeningExists/, reply: () => ({ opening: { id: OPENING_ID } }) },
      { match: /createProposal/, reply: () => ({ createProposal: { id: 'disclosure-1' } }) },
      { match: /GrokOpeningJd/, reply: () => ({ opening: { id: OPENING_ID, title: 'Platform lead', jd: { markdown: SECRET } } }) },
    ]);

  it('logs one DISCLOSURE proposal before it reads the text', async () => {
    const { gql, calls } = ok();
    const out = await requestFullText(gql, { id: OPENING_ID, kind: 'jd', reason: 'Compare with my notes' });

    expect(out).toMatchObject({ ok: true, disclosureId: 'disclosure-1', text: SECRET });
    const creates = calls.filter((c) => /createProposal/.test(c.query));

    expect(creates).toHaveLength(1);
    expect(creates[0].variables?.data).toMatchObject({
      proposalType: 'DISCLOSURE',
      proposer: 'GROK',
      status: 'DONE',
      summary: 'Compare with my notes',
      openingId: OPENING_ID,
    });
    const createAt = calls.findIndex((c) => /createProposal/.test(c.query));
    const readAt = calls.findIndex((c) => /jd \{/.test(c.query));

    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(createAt);
  });

  it('returns no text when the disclosure write fails', async () => {
    const { gql, calls } = fakeGql([
      { match: /GrokOpeningExists/, reply: () => ({ opening: { id: OPENING_ID } }) },
      { match: /createProposal/, reply: () => { throw new Error('forbidden'); } },
      { match: /GrokOpeningJd/, reply: () => ({ opening: { jd: { markdown: SECRET } } }) },
    ]);
    const out = await requestFullText(gql, { id: OPENING_ID, kind: 'jd', reason: 'r' });

    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(calls.some((c) => /jd \{/.test(c.query))).toBe(false);
  });

  it('refuses a CV, a missing reason and a bad kind without writing', async () => {
    const { gql, calls } = ok();

    expect(await requestFullText(gql, { id: OPENING_ID, kind: 'cv', reason: 'r' })).toEqual({ ok: false, error: CV_NOT_AVAILABLE });
    expect(await requestFullText(gql, { id: OPENING_ID, kind: 'jd', reason: '  ' })).toMatchObject({ ok: false });
    expect(await requestFullText(gql, { id: OPENING_ID, kind: 'letter', reason: 'r' })).toMatchObject({ ok: false });
    expect(await requestFullText(gql, { id: OPENING_ID, kind: 'jd', reason: 'r'.repeat(501) })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe('request', () => {
  const env = (open = 0) =>
    fakeGql([
      { match: /GrokOpeningExists/, reply: () => ({ opening: { id: OPENING_ID } }) },
      { match: /GrokOpenProposals/, reply: () => ({ proposals: { totalCount: open } }) },
      { match: /createProposal/, reply: () => ({ createProposal: { id: 'p-new' } }) },
    ]);

  it("records the person's request as REQUESTED, with its structured fields", async () => {
    const { gql, calls } = env();
    const out = await request(gql, {
      type: 'ANSWER_SCREENING',
      askedByPerson: true,
      question: 'Are you available to start soon?',
      answer: 'Yes, within two weeks.',
      brief: 'Answer the availability question',
    });

    expect(out).toMatchObject({ ok: true, proposalId: 'p-new', status: 'REQUESTED' });
    expect(calls.find((c) => /createProposal/.test(c.query))?.variables?.data).toEqual({
      summary: 'Answer the availability question',
      proposalType: 'ANSWER_SCREENING',
      proposer: 'GROK',
      status: 'REQUESTED',
      payload: { question: 'Are you available to start soon?', answer: 'Yes, within two weeks.', askedByPerson: true },
    });
  });

  it("keeps Grok's own suggestions as PROPOSED for the person", async () => {
    const { gql, calls } = env();

    expect(await request(gql, { type: 'RESEARCH_COMPANY', askedByPerson: false, openingId: OPENING_ID, brief: 'Look into the employer' })).toMatchObject({ status: 'PROPOSED' });
    expect(calls.find((c) => /createProposal/.test(c.query))?.variables?.data).toMatchObject({ status: 'PROPOSED', openingId: OPENING_ID });
  });

  it('needs the exact question and the final answer for screening answers', async () => {
    const { gql, calls } = env();

    expect(await request(gql, { type: 'ANSWER_SCREENING', askedByPerson: true, brief: 'b', answer: 'Yes' })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('rejects DISCLOSURE, unknown types and decision types without writing', async () => {
    for (const type of ['DISCLOSURE', 'OTHER', 'ENABLE_AUTOPILOT', 'APPROVE', 'HALT_SENDS', '', 42]) {
      const { gql, calls } = env();

      expect(await request(gql, { type, askedByPerson: true, brief: 'b' }), String(type)).toMatchObject({ ok: false });
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses when too many Grok items are open', async () => {
    const { gql, calls } = env(20);

    expect(await request(gql, { type: 'REDRAFT_LETTER', askedByPerson: true, brief: 'b' })).toMatchObject({ ok: false });
    expect(calls.some((c) => /createProposal/.test(c.query))).toBe(false);
  });

  it('strips control characters and caps the brief', async () => {
    const { gql, calls } = env();

    await request(gql, { type: 'REDRAFT_LETTER', askedByPerson: true, brief: 'Shorter\u0000 please' });
    expect(calls[calls.length - 1]?.variables?.data).toMatchObject({ summary: 'Shorter please' });
    expect(await request(gql, { type: 'REDRAFT_LETTER', askedByPerson: true, brief: 'b'.repeat(2001) })).toMatchObject({ ok: false });
  });
});

describe('brief helpers', () => {
  it('reads the autopilot channels from the policy', () => {
    expect(autopilotChannels('kill_switch: false\nautopilot:\n  enabled: true\n  channels: [seek]   # note\n  max_per_day: 30\n')).toEqual(['seek']);
    expect(autopilotChannels('autopilot:\n  channels: [seek, linkedin_jobs]\n')).toEqual(['seek', 'linkedin_jobs']);
    expect(autopilotChannels('nothing here')).toEqual([]);
  });

  it('lists only unanswered screening questions, with their exact text', () => {
    const body = [
      'answers: []',
      'unknown_questions:',
      '  - opportunity_id: seek-1',
      '    company: "Example Pty Ltd"',
      '    title: "Architect"',
      '    question: "How many years have you led teams?"',
      '    answer: null',
      '  - opportunity_id: seek-2',
      '    question: "Do you hold a licence?"',
      '    answer: "Yes."',
      '',
    ].join('\n');

    expect(openScreeningQuestions(body)).toEqual([
      { question: 'How many years have you led teams?', company: 'Example Pty Ltd', title: 'Architect' },
    ]);
  });
});
