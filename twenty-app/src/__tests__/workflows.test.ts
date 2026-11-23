import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadEntities } from 'src/__tests__/utils/load-entities';
import { OBJECT_IDS, WORKFLOW_IDS } from 'src/constants/universal-identifiers';

type Filter = { stepOutputKey: string; operand: string; value: string };
type Step = {
  universalIdentifier: string;
  type: string;
  input?: {
    stepFilters?: Filter[];
    workspaceMemberId?: string;
    [key: string]: unknown;
  };
  nextStepIds: string[];
};
type Workflow = {
  universalIdentifier: string;
  name: string;
  version: {
    trigger: {
      type: string;
      settings: {
        objectUniversalIdentifier?: string;
        action?: string;
        filter?: { stepFilters: Filter[] };
      };
      nextStepIds: string[];
    };
    steps: Step[];
  };
};

// Workflows only route on fields the harness set for routing (Principle 7).
// Anything else in a condition would be the workflow making a judgement.
const ROUTING_FIELDS = ['priority', 'migratedAt', 'deliveredAt', 'grokDeliveredAt', 'notifyMemberId'];

const SRC = path.resolve(__dirname, '..');

let workflows: { file: string; config: Workflow }[] = [];

beforeAll(async () => {
  workflows = await loadEntities<Workflow>('workflows');
});

const conditionKeys = (wf: Workflow): string[] => [
  ...(wf.version.trigger.settings.filter?.stepFilters ?? []),
  ...wf.version.steps.flatMap((s) => (s.type === 'FILTER' ? (s.input?.stepFilters ?? []) : [])),
].map((f) => f.stepOutputKey);

describe('workflows', () => {
  it('ship notify-new-escalation', () => {
    expect(workflows.map((w) => w.config.name)).toContain('notify-new-escalation');
  });

  it('use kebab-case, verb-first names', () => {
    for (const { config } of workflows) {
      expect(config.name).toMatch(/^[a-z]+(-[a-z]+)+$/);
    }
  });

  it('read nothing but routing fields in any condition', () => {
    for (const { file, config } of workflows) {
      for (const key of conditionKeys(config)) {
        const match = key.match(/^\{\{trigger\.properties\.after\.([A-Za-z]+)\}\}$/);

        expect(match, `${file}: ${key}`).not.toBeNull();
        expect(ROUTING_FIELDS, `${file}: ${key}`).toContain(match?.[1]);
      }
    }
  });

  it('never send email', () => {
    for (const { file, config } of workflows) {
      for (const step of config.version.steps) {
        expect(step.type, file).not.toBe('SEND_EMAIL');
      }
      expect(readFileSync(path.join(SRC, 'workflows', file), 'utf8')).not.toContain('SEND_EMAIL');
    }
  });

  it('notify the named member about new P1 escalations, never migrated ones', () => {
    const wf = workflows.find(
      (w) => w.config.universalIdentifier === WORKFLOW_IDS.notifyNewEscalation.workflow,
    )?.config as Workflow;
    const { trigger, steps } = wf.version;

    expect(trigger.type).toBe('DATABASE_EVENT');
    expect(trigger.settings).toMatchObject({ objectUniversalIdentifier: OBJECT_IDS.escalation, action: 'created' });

    const filter = steps.find((s) => s.type === 'FILTER') as Step;
    const send = steps.find((s) => s.type === 'SEND_CHAT_MESSAGE') as Step;

    expect(trigger.nextStepIds).toEqual([filter.universalIdentifier]);
    expect(filter.nextStepIds).toEqual([send.universalIdentifier]);
    const byKey = Object.fromEntries((filter.input?.stepFilters ?? []).map((f) => [f.stepOutputKey, f]));

    expect(byKey['{{trigger.properties.after.priority}}']).toMatchObject({ operand: 'IS', value: '["P1"]' });
    expect(byKey['{{trigger.properties.after.migratedAt}}']).toMatchObject({ operand: 'IS_EMPTY' });
    expect(send.input?.workspaceMemberId).toBe('{{trigger.properties.after.notifyMemberId}}');
  });
});
