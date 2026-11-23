import { type Gql } from 'src/utils/grok-tools.util';

// GraphQL as the app role, from inside a logic function. Twenty passes the
// API url and the app's access token in the environment (the same variables
// CoreApiClient reads). Raw queries keep every field selection explicit.
export const appGql: Gql = async (query, variables) => {
  const base = process.env.TWENTY_INTERNAL_API_URL || process.env.TWENTY_API_URL || '';
  const token = process.env.TWENTY_APP_ACCESS_TOKEN || process.env.TWENTY_API_KEY || '';
  const response = await fetch(`${base.replace(/\/+$/, '')}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: Record<string, any>;
    errors?: { message?: string }[];
  } | null;

  if (!response.ok || !body || body.errors?.length) {
    const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;

    throw new Error(`Twenty GraphQL failed: ${message}`.slice(0, 300));
  }

  return body.data ?? {};
};
