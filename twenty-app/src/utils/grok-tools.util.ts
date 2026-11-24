import {
  GROK_LIMITS,
  GROK_PROPOSAL_TYPES,
  GROK_QUEUE_STATUSES,
} from 'src/constants/grok-tools';

// The Grok tools (plan F15), written for an untrusted caller:
//   - every query selects its fields explicitly, so a job description,
//     harnessData, classification, a CV or a letter is never even fetched
//     (request_full_text's JD read is the one exception, and it runs only
//     after its DISCLOSURE proposal exists);
//   - every summary is built from an allowlist of fields, so a field added
//     to a query later still can't leak;
//   - input is validated and length-capped, and Grok text is stored as data;
//   - the only writes are proposal rows (the person's requests and Grok's
//     suggestions). No tool creates or edits a decision, an opening or
//     anything else; the harness checks and carries out requests.

// A GraphQL call: returns `data`, throws on any error.
export type Gql = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<Record<string, any>>;

export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Control characters (other than newline and tab) never reach a record.
const clean = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

const clip = (value: unknown, max: number = GROK_LIMITS.summaryText): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const text = clean(value);

  if (text.length === 0) {
    return null;
  }

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const args = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const nodes = (connection: any): Record<string, any>[] =>
  (connection?.edges ?? []).map((edge: any) => edge?.node).filter(Boolean);

// Field selections. Summaries only; never jd, harnessData, classification,
// letterMarkdown, composition, lettersSentUnattended or payload.
const MONEY = 'amountMicros currencyCode';
const OPENING_FIELDS = `id title status channel location arrangement fit score reasons closesAt
  rateMin { ${MONEY} } rateMax { ${MONEY} } url { primaryLinkUrl }
  employer { name } agency { name }`;
const ESCALATION_FIELDS = 'id name kind priority reason action createdAt opening { id title }';
const PROPOSAL_FIELDS = 'id summary proposalType proposer createdAt opening { id title }';
const RUN_FIELDS = 'id name kind startedAt finishedAt exitCode sentCount escalationCount summary';

const amount = (money: any): number | null => {
  const micros = money?.amountMicros;

  return typeof micros === 'number' && Number.isFinite(micros) ? Math.round(micros / 10_000) / 100 : null;
};

// "900 to 1100 AUD", "from 900 AUD", or null.
export const rateText = (rateMin: any, rateMax: any): string | null => {
  const low = amount(rateMin);
  const high = amount(rateMax);
  const currency = clip(rateMin?.currencyCode ?? rateMax?.currencyCode, 8) ?? '';
  const suffix = currency ? ` ${currency}` : '';

  if (low !== null && high !== null) {
    return low === high ? `${low}${suffix}` : `${low} to ${high}${suffix}`;
  }
  if (low !== null) {
    return `from ${low}${suffix}`;
  }
  if (high !== null) {
    return `up to ${high}${suffix}`;
  }

  return null;
};

export const summariseOpening = (rec: Record<string, any>) => ({
  id: String(rec.id),
  title: clip(rec.title),
  employer: clip(rec.employer?.name),
  agency: clip(rec.agency?.name),
  status: clip(rec.status, 40),
  channel: clip(rec.channel, 40),
  location: clip(rec.location),
  arrangement: clip(rec.arrangement, 40),
  rate: rateText(rec.rateMin, rec.rateMax),
  rateMin: amount(rec.rateMin),
  rateMax: amount(rec.rateMax),
  currency: clip(rec.rateMin?.currencyCode ?? rec.rateMax?.currencyCode, 8),
  link: clip(rec.url?.primaryLinkUrl, 1000),
  closesAt: clip(rec.closesAt, 40),
  fit: clip(rec.fit),
  score: typeof rec.score === 'number' ? rec.score : null,
  scoreReasons: clip(rec.reasons),
});

export const summariseEscalation = (rec: Record<string, any>) => ({
  id: String(rec.id),
  name: clip(rec.name),
  kind: clip(rec.kind, 40),
  priority: clip(rec.priority, 8),
  reason: clip(rec.reason),
  action: clip(rec.action),
  createdAt: clip(rec.createdAt, 40),
  opening: rec.opening?.id ? { id: String(rec.opening.id), title: clip(rec.opening.title) } : null,
});

export const summariseProposal = (rec: Record<string, any>) => ({
  id: String(rec.id),
  type: clip(rec.proposalType, 40),
  proposer: clip(rec.proposer, 40),
  summary: clip(rec.summary),
  createdAt: clip(rec.createdAt, 40),
  opening: rec.opening?.id ? { id: String(rec.opening.id), title: clip(rec.opening.title) } : null,
});

export const summariseRun = (rec: Record<string, any>) => ({
  id: String(rec.id),
  name: clip(rec.name),
  kind: clip(rec.kind, 40),
  startedAt: clip(rec.startedAt, 40),
  finishedAt: clip(rec.finishedAt, 40),
  exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : null,
  sentCount: typeof rec.sentCount === 'number' ? rec.sentCount : null,
  escalationCount: typeof rec.escalationCount === 'number' ? rec.escalationCount : null,
  summary: clip(rec.summary),
});

const BRIEF_QUERY = `query GrokBrief($esc: EscalationFilterInput, $prop: ProposalFilterInput, $queue: OpeningFilterInput, $docs: DocumentFilterInput) {
  escalations(filter: $esc, first: ${GROK_LIMITS.listSize}, orderBy: [{ createdAt: DescNullsLast }]) { edges { node { ${ESCALATION_FIELDS} } } }
  proposals(filter: $prop, first: ${GROK_LIMITS.listSize}, orderBy: [{ createdAt: DescNullsLast }]) { edges { node { ${PROPOSAL_FIELDS} } } }
  openings(filter: $queue, first: ${GROK_LIMITS.listSize}, orderBy: [{ score: DescNullsLast }]) { edges { node { ${OPENING_FIELDS} } } }
  runs(first: 1, orderBy: [{ startedAt: DescNullsLast }]) { edges { node { ${RUN_FIELDS} } } }
  controls(first: 1, orderBy: [{ derivedAt: DescNullsLast }]) { edges { node { name autopilotEnabled haltOpen derivedAt } } }
  documents(filter: $docs) { edges { node { id kind currentRevision } } }
}`;

// Twenty allows one root field of a name per query, so this is its own read.
const DONE_QUERY = `query GrokDone($done: ProposalFilterInput) {
  proposals(filter: $done, first: 10, orderBy: [{ updatedAt: DescNullsLast }]) { edges { node { id summary proposalType status outcome updatedAt } } }
}`;

const REVISIONS_QUERY = `query GrokRevisions($f: DocumentRevisionFilterInput) {
  documentRevisions(filter: $f, first: 10) { edges { node { documentId revision body } } }
}`;

// Channels one-click autopilot may send on, from the submission policy's
// autopilot block (for example "channels: [seek]"). Everything else is the
// attended lane: approving it only prepares, and the person applies.
export const autopilotChannels = (policy: string): string[] => {
  const block = policy.match(/^autopilot:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
  const list = block.match(/^[ \t]+channels:\s*\[([^\]]*)\]/m)?.[1];

  return list === undefined ? [] : list.split(',').map((c) => c.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};

// Open questions in the screening answers' unknown_questions block, with the
// exact text the request tool needs to answer them.
export const openScreeningQuestions = (body: string) => {
  const out: { question: string; company: string | null; title: string | null }[] = [];
  const block = body.match(/^unknown_questions:\s*\n((?:(?:[ \t]+.*|\s*)\n?)*)/m)?.[1] ?? '';

  for (const entry of block.split(/\n(?=[ \t]*-\s)/)) {
    const field = (name: string) => {
      const raw = entry.match(new RegExp(`(?:^|\\n)[ \\t-]*${name}:\\s*(.*)`))?.[1]?.trim();
      if (raw === undefined || raw === '' || raw === 'null' || raw === '~') return null;
      try {
        return String(JSON.parse(raw));
      } catch {
        return raw.replace(/^['"]|['"]$/g, '');
      }
    };
    const question = field('question');
    if (question && field('answer') === null && out.length < GROK_LIMITS.listSize) {
      out.push({ question: clip(question, 500) ?? question, company: clip(field('company')), title: clip(field('title')) });
    }
  }

  return out;
};

export const brief = async (gql: Gql): Promise<ToolResult> => {
  const data = await gql(BRIEF_QUERY, {
    esc: { status: { eq: 'OPEN' } },
    prop: { status: { eq: 'PROPOSED' } },
    queue: { status: { in: [...GROK_QUEUE_STATUSES] } },
    docs: { kind: { in: ['SUBMISSION_POLICY', 'SCREENING_ANSWERS'] } },
  });
  const [lastRun] = nodes(data.runs).map(summariseRun);
  const control = nodes(data.controls)[0];
  const done = await gql(DONE_QUERY, {
    done: { proposer: { in: ['GROK', 'AI_CHAT'] }, status: { in: ['DONE', 'FAILED', 'CONFIRMED', 'REQUESTED'] } },
  });

  // The two documents' current revisions, read for their structure only.
  const docs = nodes(data.documents);
  const revisions = docs.length
    ? nodes((await gql(REVISIONS_QUERY, { f: { documentId: { in: docs.map((d) => d.id) } } })).documentRevisions)
    : [];
  const current = (kind: string): string => {
    const doc = docs.find((d) => d.kind === kind);
    const rev = revisions.find((r) => doc && r.documentId === doc.id && Number(r.revision) === Number(doc.currentRevision));

    return typeof rev?.body === 'string' ? rev.body : '';
  };
  const autopilot = autopilotChannels(current('SUBMISSION_POLICY'));
  const sendsAllowed = Boolean(control?.autopilotEnabled) && !control?.haltOpen;

  const queue = nodes(data.openings).map((rec) => {
    const lane = autopilot.includes(String(rec.channel ?? '').toLowerCase()) ? 'autopilot' : 'attended';

    return {
      ...summariseOpening(rec),
      lane,
      nextStep:
        lane === 'attended'
          ? 'attended lane: approving only prepares the package; the person applies on the portal'
          : sendsAllowed
            ? 'autopilot sends it once its checks pass'
            : 'ready for autopilot, which is off',
    };
  });

  const notes: string[] = [];
  if (!control) notes.push('The send switch has not been recorded yet; treat autopilot as off.');
  else if (!sendsAllowed) notes.push(`Autopilot is not sending: ${clip(control.name) ?? 'off'}. The person turns it on with Enable autopilot from their own Twenty account.`);
  if (autopilot.length) notes.push(`One-click autopilot channels: ${autopilot.join(', ')}. Every other channel is attended.`);

  return {
    ok: true,
    sendSwitch: control ? { allowed: sendsAllowed, reason: clip(control.name), checkedAt: clip(control.derivedAt, 40) } : null,
    notes,
    escalations: nodes(data.escalations).map(summariseEscalation),
    openScreeningQuestions: openScreeningQuestions(current('SCREENING_ANSWERS')),
    proposalsAwaitingYou: nodes(data.proposals).map(summariseProposal),
    doneForYou: nodes(done.proposals).map((rec) => ({
      id: String(rec.id),
      type: clip(rec.proposalType, 40),
      summary: clip(rec.summary),
      status: rec.status === 'CONFIRMED' ? 'QUEUED' : clip(rec.status, 20),
      outcome: clip(rec.outcome),
    })),
    queue,
    lastRun: lastRun ?? null,
  };
};

const OPENING_QUERY = `query GrokOpening($id: UUID!) { opening(filter: { id: { eq: $id } }) { ${OPENING_FIELDS} } }`;

const readId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;

export const openingSummary = async (gql: Gql, payload: unknown): Promise<ToolResult> => {
  const id = readId(args(payload).id);

  if (!id) {
    return { ok: false, error: 'id must be an opening id (a UUID)' };
  }

  const data = await gql(OPENING_QUERY, { id });

  return data.opening
    ? { ok: true, opening: summariseOpening(data.opening) }
    : { ok: false, error: 'no opening with that id' };
};

const CREATE_PROPOSAL = `mutation GrokProposal($data: ProposalCreateInput!) { createProposal(data: $data) { id } }`;
const OPENING_EXISTS = `query GrokOpeningExists($id: UUID!) { opening(filter: { id: { eq: $id } }) { id } }`;
const OPENING_JD = `query GrokOpeningJd($id: UUID!) { opening(filter: { id: { eq: $id } }) { id title jd { markdown } } }`;

export const CV_NOT_AVAILABLE =
  'The CV is not available through this tool. Ask the person to share it, or use opening_summary for the role.';

// The full text of one opening's job description. The DISCLOSURE proposal is
// written first and the text is read only if that write succeeded: a logged
// disclosure is the point (plan F15, owner Q1).
export const requestFullText = async (gql: Gql, payload: unknown): Promise<ToolResult> => {
  const input = args(payload);
  const id = readId(input.id);
  const kind = input.kind;
  const reason = typeof input.reason === 'string' ? clean(input.reason) : '';

  if (kind !== 'jd' && kind !== 'cv') {
    return { ok: false, error: 'kind must be "jd" or "cv"' };
  }
  if (kind === 'cv') {
    return { ok: false, error: CV_NOT_AVAILABLE };
  }
  if (!id) {
    return { ok: false, error: 'id must be an opening id (a UUID)' };
  }
  if (reason.length === 0) {
    return { ok: false, error: 'reason is required: it is logged with the disclosure' };
  }
  if (reason.length > GROK_LIMITS.reason) {
    return { ok: false, error: `reason must be at most ${GROK_LIMITS.reason} characters` };
  }

  const exists = await gql(OPENING_EXISTS, { id });

  if (!exists.opening) {
    return { ok: false, error: 'no opening with that id' };
  }

  let disclosureId: string | undefined;

  try {
    const created = await gql(CREATE_PROPOSAL, {
      data: {
        summary: reason,
        proposalType: 'DISCLOSURE',
        proposer: 'GROK',
        // DONE: a log entry, never a queue item for the executor.
        status: 'DONE',
        outcome: 'Job description disclosed to Grok',
        payload: { kind: 'jd' },
        openingId: id,
      },
    });

    disclosureId = created.createProposal?.id;
  } catch {
    disclosureId = undefined;
  }
  if (!disclosureId) {
    return { ok: false, error: 'the disclosure could not be logged, so the text was not returned' };
  }

  const data = await gql(OPENING_JD, { id });

  return {
    ok: true,
    disclosureId,
    id,
    title: clip(data.opening?.title),
    kind: 'jd',
    text: typeof data.opening?.jd?.markdown === 'string' ? data.opening.jd.markdown : '',
  };
};

const OPEN_GROK_PROPOSALS = `query GrokOpenProposals($f: ProposalFilterInput) { proposals(filter: $f) { totalCount } }`;

export const isGrokProposalType = (value: unknown): value is (typeof GROK_PROPOSAL_TYPES)[number] =>
  typeof value === 'string' && (GROK_PROPOSAL_TYPES as readonly string[]).includes(value);

// The person's request, made through Grok. It runs without a second
// confirmation: the harness checks it (answer wording, never-named rules,
// the matching question) and records the outcome. Reserved kinds (package
// approvals, document edits, outcomes) still wait for the person's button.
// When Grok suggests something the person did not ask for, it is a proposal
// for them to confirm instead.
export const request = async (gql: Gql, payload: unknown): Promise<ToolResult> => {
  const input = args(payload);
  const type = input.type;
  const text = typeof input.brief === 'string' ? clean(input.brief) : '';
  const askedByPerson = input.askedByPerson === true;

  if (type === 'DISCLOSURE' || !isGrokProposalType(type)) {
    return { ok: false, error: `type must be one of ${GROK_PROPOSAL_TYPES.join(', ')}` };
  }
  if (text.length === 0) {
    return { ok: false, error: 'brief is required' };
  }
  if (text.length > GROK_LIMITS.brief) {
    return { ok: false, error: `brief must be at most ${GROK_LIMITS.brief} characters` };
  }

  const structured: Record<string, string> = {};
  for (const key of ['question', 'answer', 'term'] as const) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || clean(value).length > GROK_LIMITS.reason) {
      return { ok: false, error: `${key} must be text of at most ${GROK_LIMITS.reason} characters` };
    }
    structured[key] = clean(value);
  }
  if (type === 'ANSWER_SCREENING' && (!structured.question || !structured.answer)) {
    return { ok: false, error: 'ANSWER_SCREENING needs question (the exact text from openScreeningQuestions in brief) and answer (the final wording the employer sees)' };
  }

  let openingId: string | null = null;

  if (input.openingId !== undefined && input.openingId !== null && input.openingId !== '') {
    openingId = readId(input.openingId);
    if (!openingId) {
      return { ok: false, error: 'openingId must be an opening id (a UUID)' };
    }
    if (!(await gql(OPENING_EXISTS, { id: openingId })).opening) {
      return { ok: false, error: 'no opening with that id' };
    }
  }

  const open = await gql(OPEN_GROK_PROPOSALS, {
    f: { proposer: { eq: 'GROK' }, status: { in: ['PROPOSED', 'REQUESTED'] } },
  });

  if ((open.proposals?.totalCount ?? 0) >= GROK_LIMITS.openProposals) {
    return { ok: false, error: 'too many Grok items are open; try again after they are handled' };
  }

  const status = askedByPerson ? 'REQUESTED' : 'PROPOSED';
  const created = await gql(CREATE_PROPOSAL, {
    data: {
      summary: text,
      proposalType: type,
      proposer: 'GROK',
      status,
      payload: { ...structured, askedByPerson },
      ...(openingId ? { openingId } : {}),
    },
  });

  return {
    ok: true,
    proposalId: created.createProposal?.id ?? null,
    status,
    next: askedByPerson
      ? 'The harness carries it out within five minutes, or in the next daily run for agent work; check doneForYou in brief for the outcome. Package approvals and document edits still need the person to tap Confirm.'
      : 'This is a suggestion: the person confirms or declines it in Twenty.',
  };
};
