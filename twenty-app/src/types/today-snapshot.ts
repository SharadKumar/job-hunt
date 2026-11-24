type Row = { id: string; title: string; detail: string; tag?: string };

// Everything the Today page shows, read in one pass as the viewer.
export type TodaySnapshot = {
  escalations: Row[];
  proposals: Row[];
  doneForYou: Row[];
  sendSwitch: Row | null;
  sentToday: Row[];
  lastRun: Row | null;
};
