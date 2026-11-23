import { appGql } from 'src/utils/grok-gql.util';
import { type Gql, type ToolResult } from 'src/utils/grok-tools.util';

// Wraps one Grok tool: runs it as the app role and turns any failure into a
// short error, so no stack or server message reaches the caller.
export const grokHandler =
  (tool: (gql: Gql, payload: unknown) => Promise<ToolResult>) =>
  async (payload: unknown): Promise<ToolResult> => {
    try {
      return await tool(appGql, payload);
    } catch {
      return { ok: false, error: 'the tool failed; try again later' };
    }
  };
