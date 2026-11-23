// Midnight at the start of the viewer's local day, as an ISO timestamp.
export const startOfLocalDay = (now: Date = new Date()): string => {
  const start = new Date(now);

  start.setHours(0, 0, 0, 0);

  return start.toISOString();
};
