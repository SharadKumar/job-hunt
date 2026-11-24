import { CoreApiClient } from 'twenty-client-sdk/core';

import { type TodaySnapshot } from 'src/types/today-snapshot';
import { startOfLocalDay } from 'src/utils/start-of-local-day.util';

// Fields read below; the generated client types them once `twenty app apply` has run.
type TodayNode = Record<string, any> & { id: string };

const LIMIT = 20;

const label = (value: string | null | undefined, fallback: string) =>
  value && value.trim().length > 0 ? value : fallback;

// Reads the Today page as the signed-in member: the send switch, open
// escalations, proposals awaiting confirmation, what agents did on the
// person's requests, applications sent today and the latest run.
// A row says what needs the person in a few words; the record holds the rest.
const KIND_TITLES: Record<string, string> = {
  screening: 'Screening question to answer',
  awaiting_approval: 'Package to approve',
  manual: 'Apply yourself',
  submission_pending: 'Submission to check',
  channel: 'Channel needs attention',
  gate: 'Send gate blocked',
  cap: 'Daily cap reached',
  kill_switch: 'Sends halted',
};

export const shortReason = (reason: string): string => {
  const text = reason.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  const question = text.match(/screening question:\s*"([^"]+)"/i);
  if (question) return `"${question[1].replace(/\.{3,}$/, '')}"`;
  const ats = text.match(/External ATS redirect to (\S+)/i);
  if (ats) return `Apply on ${ats[1]}`;
  const first = text.split(/(?<=[a-z0-9)])[.;]\s/i)[0].replace(/\.$/, '');
  return first.length > 110 ? `${first.slice(0, 109).replace(/\s+\S*$/, '')}…` : first;
};

export const loadToday = async (now: Date = new Date()): Promise<TodaySnapshot> => {
  const client = new CoreApiClient();

  const result = await client.query({
    escalations: {
      __args: {
        first: LIMIT,
        filter: { status: { eq: 'OPEN' } },
        orderBy: [{ priority: 'AscNullsLast' }],
      },
      edges: { node: { id: true, name: true, priority: true, kind: true, reason: true } },
    },
    proposals: {
      __args: {
        first: LIMIT,
        filter: { status: { eq: 'PROPOSED' } },
        orderBy: [{ createdAt: 'DescNullsLast' }],
      },
      edges: { node: { id: true, summary: true, proposalType: true } },
    },
    controls: {
      __args: { first: 1, orderBy: [{ derivedAt: 'DescNullsLast' }] },
      edges: { node: { id: true, name: true, autopilotEnabled: true, haltOpen: true } },
    },
    applications: {
      __args: {
        first: LIMIT,
        filter: { submittedAt: { gte: startOfLocalDay(now) } },
        orderBy: [{ submittedAt: 'DescNullsLast' }],
      },
      edges: { node: { id: true, name: true, actor: true, submittedAt: true } },
    },
    runs: {
      __args: { first: 1, orderBy: [{ startedAt: 'DescNullsLast' }] },
      edges: {
        node: {
          id: true,
          name: true,
          startedAt: true,
          sentCount: true,
          escalationCount: true,
          exitCode: true,
        },
      },
    },
  });

  const run = result.runs?.edges?.[0]?.node;
  const control = result.controls?.edges?.[0]?.node;

  // What agents did for the person: their requests through Grok or AI chat,
  // carried out without a second confirmation. A separate read, because the
  // proposals list above is only what still needs the person.
  const done = await client.query({
    proposals: {
      __args: {
        first: 10,
        filter: {
          proposer: { in: ['GROK', 'AI_CHAT'] },
          status: { in: ['DONE', 'FAILED', 'CONFIRMED'] },
        },
        orderBy: [{ updatedAt: 'DescNullsLast' }],
      },
      edges: { node: { id: true, summary: true, status: true, outcome: true } },
    },
  });

  return {
    escalations: (result.escalations?.edges ?? []).map(({ node }: { node: TodayNode }) => ({
      id: node.id,
      title: label(node.name, KIND_TITLES[String(node.kind ?? '')] ?? 'Escalation'),
      detail: shortReason(String(node.reason ?? '')),
      tag: node.priority ?? undefined,
    })),
    proposals: (result.proposals?.edges ?? []).map(({ node }: { node: TodayNode }) => ({
      id: node.id,
      title: label(node.summary, 'Proposal'),
      detail: node.proposalType ?? '',
    })),
    doneForYou: (done.proposals?.edges ?? []).map(({ node }: { node: TodayNode }) => ({
      id: node.id,
      title: label(node.summary, 'Request'),
      detail: shortReason(String(node.outcome ?? '')),
      tag: node.status === 'CONFIRMED' ? 'QUEUED' : (node.status ?? undefined),
    })),
    sendSwitch: control
      ? {
          id: control.id,
          title: control.haltOpen ? 'Sends halted' : control.autopilotEnabled ? 'Autopilot on' : 'Autopilot off',
          detail: label(control.name, ''),
        }
      : null,
    sentToday: (result.applications?.edges ?? []).map(({ node }: { node: TodayNode }) => ({
      id: node.id,
      title: label(node.name, 'Application'),
      detail: node.actor ?? '',
    })),
    lastRun: run
      ? {
          id: run.id,
          title: label(run.name, 'Run'),
          detail: `Sent ${run.sentCount ?? 0}, escalations ${run.escalationCount ?? 0}, exit ${run.exitCode ?? 'unknown'}`,
        }
      : null,
  };
};
