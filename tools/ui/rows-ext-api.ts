/**
 * Extension API module (rows-ext). Owned by one work package; the dispatcher in
 * api.ts calls `handle` before its own routes and takes the first non-null
 * result. Return null for any request this module does not own.
 */
import type { ApiContext, ApiRequest, ApiResult } from "./api.ts";

export async function handle(_req: ApiRequest, _ctx: ApiContext): Promise<ApiResult | null> {
  return null;
}
