import { useEffect, useState } from 'react';
import {
  closeSidePanel,
  enqueueSnackbar,
  useSelectedRecordIds,
} from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components/feedback';
import {
  Button,
  Field,
  Input,
  Radio,
  RadioGroup,
  Textarea,
} from 'twenty-ui/primitives/input';
import { Heading, Text } from 'twenty-ui/primitives/typography';
import { useTheme } from 'twenty-ui/theme';

import { BUTTONS, type ButtonKey } from 'src/constants/buttons';
import { DECISION_TYPE_OPTIONS } from 'src/constants/select-options';
import { createDecision, recordedMessage } from 'src/front-components/utils/create-decision.util';
import { loadDecisionContext } from 'src/front-components/utils/load-decision-context.util';
import { type DecisionContext } from 'src/types/decision-context';
import { type DecisionFormValues } from 'src/types/decision-form-values';
import { buildFormDecision } from 'src/utils/build-form-decision.util';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; context: DecisionContext };

const optionLabel = (value: string) =>
  DECISION_TYPE_OPTIONS.find((option) => option.value === value)?.label ??
  value;

// The side panel for a button that needs a value before it records its one
// decision. Decisions are immutable, so the value is collected first.
export const DecisionForm = ({ buttonKey }: { buttonKey: ButtonKey }) => {
  const theme = useTheme();
  const spec = BUTTONS[buttonKey];
  const selectedRecordIds = useSelectedRecordIds();
  const recordId = selectedRecordIds.length === 1 ? selectedRecordIds[0] : undefined;

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [values, setValues] = useState<DecisionFormValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (spec.target !== 'global' && recordId === undefined) {
      setLoad({ kind: 'error', message: 'Select exactly one record' });

      return;
    }

    loadDecisionContext(spec.target, recordId)
      .then((context) => {
        if (cancelled) {
          return;
        }
        setLoad({ kind: 'ready', context });
        if (buttonKey === 'openingEditLetter') {
          setValues({ text: context.letterMarkdown ?? '' });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoad({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [buttonKey, recordId, spec.target]);

  const set = (key: keyof DecisionFormValues) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (context: DecisionContext) => {
    const built = buildFormDecision(buttonKey, values, context);

    if ('error' in built) {
      setFormError(built.error);

      return;
    }

    setFormError(null);
    setSaving(true);

    try {
      const recorded = await createDecision(built.decision);
      await enqueueSnackbar(recordedMessage(spec.label, String(built.decision.decisionType ?? ''), recorded));
      await closeSidePanel();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  const stack = {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    boxSizing: 'border-box' as const,
    width: '100%',
  };

  if (load.kind === 'loading') {
    return (
      <div style={stack}>
        <Text color="tertiary">Loading</Text>
      </div>
    );
  }

  if (load.kind === 'error') {
    return (
      <div style={stack}>
        <Callout
          color="red"
          title={`${spec.label} is not available`}
          description={load.message}
        />
      </div>
    );
  }

  const { context } = load;

  const textLabel: Partial<Record<ButtonKey, string>> = {
    proposalConfirm: 'Edited value (optional)',
    openingMarkSent: 'Confirmation reference',
    openingEditLetter: 'Letter',
  };
  const noteLabel: Partial<Record<ButtonKey, string>> = {
    openingRequestRedraft: 'What should change',
  };

  return (
    <form
      style={stack}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(context);
      }}
    >
      <div>
        <Heading level={2} size="lg">
          {spec.label}
        </Heading>
        <Text color="secondary">{context.title}</Text>
      </div>

      {buttonKey === 'openingOutcome' && (
        <Field.Root>
          <Field.Label>Outcome</Field.Label>
          <RadioGroup
            value={values.choice ?? null}
            onValueChange={(value) => set('choice')(String(value))}
            orientation="vertical"
          >
            {spec.decisionTypes.map((type) => (
              <Radio key={type} value={type}>
                {optionLabel(type)}
              </Radio>
            ))}
          </RadioGroup>
        </Field.Root>
      )}

      {buttonKey === 'enableAutopilot' && (
        <>
          <Field.Root>
            <Field.Label>Daily cap</Field.Label>
            <Input
              inputMode="numeric"
              value={values.maxPerDay ?? ''}
              onValueChange={set('maxPerDay')}
              placeholder="For example 5"
            />
            <Field.Description>
              The most one-click sends the harness may make in a day.
            </Field.Description>
          </Field.Root>
          <Field.Root>
            <Field.Label>Expires after days (optional)</Field.Label>
            <Input
              inputMode="numeric"
              value={values.expiresInDays ?? ''}
              onValueChange={set('expiresInDays')}
              placeholder="Leave empty for no expiry"
            />
            <Field.Description>
              After this many days you confirm again before sends resume.
            </Field.Description>
          </Field.Root>
        </>
      )}

      {textLabel[buttonKey] !== undefined && (
        <Field.Root>
          <Field.Label>{textLabel[buttonKey]}</Field.Label>
          {buttonKey === 'openingMarkSent' ? (
            <Input value={values.text ?? ''} onValueChange={set('text')} />
          ) : (
            <Textarea
              value={values.text ?? ''}
              onValueChange={set('text')}
              autoResize
              maxRows={buttonKey === 'openingEditLetter' ? 24 : 8}
            />
          )}
        </Field.Root>
      )}

      <Field.Root>
        <Field.Label>{noteLabel[buttonKey] ?? 'Note (optional)'}</Field.Label>
        <Textarea
          value={values.note ?? ''}
          onValueChange={set('note')}
          autoResize
          maxRows={6}
        />
      </Field.Root>

      {formError !== null && (
        <Callout color="red" title="Not recorded" description={formError} />
      )}

      <div style={{ display: 'flex', gap: theme.spacing[2] }}>
        <Button type="submit" variant="solid" color="accent" loading={saving}>
          {spec.label}
        </Button>
        <Button
          type="button"
          variant="ghost"
          color="neutral"
          disabled={saving}
          onClick={() => void closeSidePanel()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};
