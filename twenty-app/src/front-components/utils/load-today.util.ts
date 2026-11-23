import { CoreApiClient } from 'twenty-client-sdk/core';

import { type TodaySnapshot } from 'src/types/today-snapshot';
import { startOfLocalDay } from 'src/utils/start-of-local-day.util';

// Fields read below; the generated client types them once `twenty app apply` has run.
type TodayNode = Record<string, any> & { id: string };

const LIMIT = 20;

const label = (value: string | null | undefined, fallback: string) =>
  value && value.trim().length > 0 ? value : fallback;

// Reads the Today page as the signed-in member: open escalations, proposals
// awaiting confirmation, applications sent today and the latest run.
export const loadToday = async (now: Date = new Date()): Promise<TodaySnapshot> => {
  const client = new CoreApiClient();

  const result = await client.query({
    escalations: {
      __args: {
        first: LIMIT,
        filter: { status: { eq: 'OPEN' } },
        orderBy: [{ priority: 'AscNullsLast' }],
      },
      edges: { node: { id: true, name: true, priority: true, action: true } },
    },
    proposals: {
      __args: {
        first: LIMIT,
        filter: { status: { eq: 'PROPOSED' } },
        orderBy: [{ createdAt: 'DescNullsLast' }],
      },
      edges: { node: { id: true, summary: true, proposalType: true } },
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

  return {
    escalations: (result.escalations?.edges ?? []).map(({ node }: { node: TodayNode }) => ({
      id: node.id,
      title: label(node.name, 'Escalation'),
      detail: [node.priority, node.action].filter(Boolean).join(' · '),
    })),
    proposals: (result.proposals?.edges ?? []).map(({ node }: { node: TodayNode }) => ({
      id: node.id,
      title: label(node.summary, 'Proposal'),
      detail: node.proposalType ?? '',
    })),
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
