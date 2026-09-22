/** Attended Jev calibration labels. This API never changes pipeline state. */

import { getAdjudicationQueue, recordAdjudication } from "../jev/adjudications.ts";
import type { ApiContext, ApiRequest, ApiResult } from "./api.ts";

const ROUTES: Record<string, "GET" | "POST"> = {
  "/api/jev/adjudications": "GET",
  "/api/jev/adjudications/record": "POST",
};

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResult | null> {
  const pathname = req.pathname.replace(/\/+$/, "") || "/";
  const wanted = ROUTES[pathname];
  if (!wanted) return null;
  const method = req.method.toUpperCase();
  if (method !== wanted) return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
  const adjudicationsFile = ctx.adjudicationsPath;
  if (pathname === "/api/jev/adjudications") {
    return { status: 200, body: await getAdjudicationQueue({ adjudicationsFile, now: ctx.now }) };
  }
  let label;
  try {
    label = await recordAdjudication({ ...(req.body as Record<string, unknown> ?? {}), actor: "user" }, {
      adjudicationsFile,
      now: ctx.now,
    });
  } catch (error: any) {
    return { status: 400, body: { error: String(error?.message ?? error) } };
  }
  const queue = await getAdjudicationQueue({ adjudicationsFile, now: ctx.now });
  return { status: 200, body: { ok: true, label, counts: queue.counts } };
}
