// What a button showed the person when they decided, plus the links the
// decision carries.
export type DecisionContext = {
  title: string;
  statusSeen: string;
  letterShaSeen?: string;
  letterMarkdown?: string;
  contentHashSeen?: string;
  openingId?: string;
  proposalId?: string;
  positioningId?: string;
};
