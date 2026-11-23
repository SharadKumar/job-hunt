import { useCallback, useEffect, useState } from 'react';
import { defineFrontComponent } from 'twenty-sdk/define';
import { AppPath, navigate } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components/feedback';
import { Section } from 'twenty-ui/components/layout';
import { Button } from 'twenty-ui/primitives/input';
import { Text } from 'twenty-ui/primitives/typography';
import { useTheme } from 'twenty-ui/theme';

import { TODAY_IDS } from 'src/constants/universal-identifiers';
import { createDecision } from 'src/front-components/utils/create-decision.util';
import { loadToday } from 'src/front-components/utils/load-today.util';
import { type TodaySnapshot } from 'src/types/today-snapshot';

type Row = TodaySnapshot['escalations'][number];

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: TodaySnapshot };

const RowList = ({
  rows,
  empty,
  objectNameSingular,
}: {
  rows: Row[];
  empty: string;
  objectNameSingular: string;
}) => {
  const theme = useTheme();

  if (rows.length === 0) {
    return <Text color="tertiary">{empty}</Text>;
  }

  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
      }}
    >
      {rows.map((row) => (
        <li key={row.id}>
          <Button
            variant="ghost"
            color="neutral"
            fullWidth
            onClick={() =>
              void navigate(AppPath.RecordShowPage, {
                objectNameSingular,
                objectRecordId: row.id,
              })
            }
          >
            <span
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: theme.spacing[2],
                width: '100%',
                minWidth: 0,
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.title}
              </span>
              <Text color="tertiary">{row.detail}</Text>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
};

// The person's landing page: what needs them now and what the harness did.
const Today = () => {
  const theme = useTheme();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    loadToday()
      .then((snapshot) => setState({ kind: 'ready', snapshot }))
      .catch((error: unknown) =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  const sections =
    state.kind === 'ready'
      ? [
          {
            title: 'Open escalations',
            rows: state.snapshot.escalations,
            empty: 'Nothing is escalated.',
            object: 'escalation',
          },
          {
            title: 'Proposals awaiting you',
            rows: state.snapshot.proposals,
            empty: 'No proposals are waiting.',
            object: 'proposal',
          },
          {
            title: 'Sent today',
            rows: state.snapshot.sentToday,
            empty: 'Nothing sent yet today.',
            object: 'application',
          },
          {
            title: 'Last run',
            rows: state.snapshot.lastRun ? [state.snapshot.lastRun] : [],
            empty: 'No runs recorded yet.',
            object: 'run',
          },
        ]
      : [];

  return (
    <main
      style={{
        boxSizing: 'border-box',
        height: '100%',
        overflow: 'auto',
        padding: theme.spacing[4],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[6],
        width: '100%',
      }}
    >
      <Section.Header
        level={1}
        title="Today"
        description="What needs you and what the harness did."
        actions={
          <div style={{ display: 'flex', gap: theme.spacing[2] }}>
            <HaltSendsButton />
            <Button
              variant="outline"
              color="neutral"
              onClick={refresh}
              loading={state.kind === 'loading'}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {state.kind === 'loading' && <Text color="tertiary">Loading</Text>}

      {state.kind === 'error' && (
        <Callout color="red" title="Today could not be read" description={state.message} />
      )}

      {sections.map((section) => (
        <section
          key={section.title}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing[2],
          }}
        >
          <Section.Header level={2} size="md" title={section.title} />
          <RowList
            rows={section.rows}
            empty={section.empty}
            objectNameSingular={section.object}
          />
        </section>
      ))}
    </main>
  );
};

// The safety control, labelled and one click from the start page. The first
// click arms it, the second records one HALT_SENDS decision as the viewer. A
// halt wins over any enable; resuming is a separate Enable autopilot decision.
const HaltSendsButton = () => {
  const [step, setStep] = useState<'idle' | 'armed' | 'saving' | 'done' | 'failed'>('idle');

  const onClick = useCallback(async () => {
    if (step === 'idle' || step === 'failed') {
      setStep('armed');
      return;
    }
    if (step !== 'armed') return;
    setStep('saving');
    try {
      await createDecision({ decisionType: 'HALT_SENDS' });
      setStep('done');
    } catch {
      setStep('failed');
    }
  }, [step]);

  const label =
    step === 'armed' ? 'Confirm: halt every send'
      : step === 'saving' ? 'Halting'
      : step === 'done' ? 'Sends halted'
      : step === 'failed' ? 'Halt failed, try again'
      : 'Halt sends';

  return (
    <Button
      variant={step === 'armed' ? 'solid' : 'outline'}
      color="danger"
      onClick={onClick}
      disabled={step === 'done'}
      loading={step === 'saving'}
    >
      {label}
    </Button>
  );
};

export default defineFrontComponent({
  universalIdentifier: TODAY_IDS.frontComponent,
  name: 'today',
  description: 'Open escalations, proposals awaiting you, sends today and the last run',
  component: Today,
});
