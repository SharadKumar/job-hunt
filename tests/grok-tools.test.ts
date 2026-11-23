#!/usr/bin/env tsx
/**
 * grok-tools.test.ts: the Grok app tools on /mcp?mode=direct (plan F15, V15).
 *
 * Integration only (the tool logic has vitest unit tests in twenty-app). Runs
 * against a disposable local Twenty test instance with the app applied, and
 * skips otherwise. Needs:
 *   TWENTY_TEST_URL       http://127.0.0.1:2021
 *   TWENTY_TEST_KEY       a Harness-role API key (seeds and inspects records)
 *   TWENTY_TEST_GROK_KEY  a Grok-role API key (calls the tools)
 *
 * Checks: the four tools are listed; summaries carry rates and links and no
 * job description; request_full_text writes exactly one DISCLOSURE proposal
 * before it returns the text, and refuses the CV; propose refuses DISCLOSURE
 * and unknown types; the Grok key reads nothing on /rest and /graphql.
 * Synthetic data only.
 */

import assert from "node:assert/strict";

const env = (k: string) => process.env[k] ?? "";
const url = env("TWENTY_TEST_URL");
if (!url || !env("TWENTY_TEST_KEY") || !env("TWENTY_TEST_GROK_KEY")) {
  console.log("grok-tools: skipped (set TWENTY_TEST_URL, TWENTY_TEST_KEY, TWENTY_TEST_GROK_KEY)");
  process.exit(0);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("runs only against a local test instance");

const H = env("TWENTY_TEST_KEY"), G = env("TWENTY_TEST_GROK_KEY");
const SECRET = `SECRET-FULL-TEXT-${Date.now()}`;

async function rest(token: string, method: string, p: string, body?: unknown) {
  const r = await fetch(`${url}${p}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : {} };
}

let rpcId = 0;
async function mcp(method: string, params?: unknown): Promise<any> {
  const r = await fetch(`${url}/mcp?mode=direct`, {
    method: "POST",
    headers: { Authorization: `Bearer ${G}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  return JSON.parse(line.replace(/^data: /, ""));
}

/** Calls one tool; returns { raw, result } where result is the handler's object (or null when refused upstream). */
async function tool(name: string, args: Record<string, unknown>) {
  const res = await mcp("tools/call", { name: `app_${name}`, arguments: args });
  const raw = JSON.stringify(res);
  const text = res.result?.content?.[0]?.text;
  let result: any = null;
  try { result = text ? JSON.parse(text).result ?? null : null; } catch { result = null; }
  return { raw, result, isError: Boolean(res.error || res.result?.isError) };
}

const proposalsFor = async (openingId: string, type?: string) => {
  const f = type ? `and(openingId[eq]:${openingId},proposalType[eq]:${type})` : `openingId[eq]:${openingId}`;
  return (await rest(H, "GET", `/rest/proposals?filter=${encodeURIComponent(f)}&limit=100`)).json.data.proposals as any[];
};

// 1. The tools are listed for the Grok key.
const names = ((await mcp("tools/list")).result?.tools ?? []).map((t: any) => t.name);
for (const n of ["app_brief", "app_opening_summary", "app_request_full_text", "app_propose"]) assert.ok(names.includes(n), `${n} listed`);

// Seed one queued opening with full text in every forbidden field.
const tag = `grok-tools-${Date.now()}`;
const created = await rest(H, "POST", "/rest/openings", {
  title: `Solutions lead ${tag}`, status: "SHORTLISTED", score: 9.9,
  rateMin: { amountMicros: 1_000_000_000, currencyCode: "AUD" }, rateMax: { amountMicros: 1_200_000_000, currencyCode: "AUD" },
  url: { primaryLinkUrl: `https://example.com/${tag}`, primaryLinkLabel: "Advert" },
  jd: { markdown: `${SECRET} job description` }, classification: { why: SECRET }, harnessData: { notes: SECRET },
  reasons: "Strong match on integration work",
});
const oid = created.json.data?.createOpening?.id;
assert.ok(oid, created.text.slice(0, 200));

try {
  // 2. brief and opening_summary: rates and links, never full text.
  const b = await tool("brief", {});
  assert.equal(b.result?.ok, true, b.raw.slice(0, 300));
  assert.ok(!b.raw.includes(SECRET), "brief carries no full text");
  const queued = b.result.queue.find((o: any) => o.id === oid);
  assert.ok(queued, "the seeded opening is in the queue");
  assert.equal(queued.rate, "1000 to 1200 AUD");
  assert.equal(queued.link, `https://example.com/${tag}`);
  assert.ok("lastRun" in b.result && Array.isArray(b.result.escalations) && Array.isArray(b.result.proposalsAwaitingYou));

  const s = await tool("opening_summary", { id: oid });
  assert.equal(s.result?.ok, true, s.raw.slice(0, 300));
  assert.ok(!s.raw.includes(SECRET), "summary carries no full text");
  assert.equal(s.result.opening.rate, "1000 to 1200 AUD");
  assert.equal(s.result.opening.link, `https://example.com/${tag}`);
  assert.equal(s.result.opening.scoreReasons, "Strong match on integration work");

  // 3. request_full_text: one DISCLOSURE first, then the text; never the CV.
  assert.equal((await proposalsFor(oid, "DISCLOSURE")).length, 0);
  const cv = await tool("request_full_text", { id: oid, kind: "cv", reason: "Tailor my pitch" });
  assert.equal(cv.result?.ok, false);
  assert.match(cv.result.error, /not available/);
  assert.equal((await proposalsFor(oid, "DISCLOSURE")).length, 0, "a refused CV request logs nothing");

  const jd = await tool("request_full_text", { id: oid, kind: "jd", reason: "Compare the role with my notes" });
  assert.equal(jd.result?.ok, true, jd.raw.slice(0, 300));
  assert.ok(jd.result.text.includes(SECRET), "the full text after the disclosure");
  const disclosures = await proposalsFor(oid, "DISCLOSURE");
  assert.equal(disclosures.length, 1, "exactly one DISCLOSURE proposal");
  assert.equal(disclosures[0].id, jd.result.disclosureId);
  assert.equal(disclosures[0].proposer, "GROK");
  assert.equal(disclosures[0].status, "DONE", "never queued for the executor");
  assert.equal(disclosures[0].summary, "Compare the role with my notes");
  assert.ok(Date.parse(disclosures[0].createdAt) <= Date.now());

  // 4. propose: allowlisted types only, never DISCLOSURE.
  const before = (await proposalsFor(oid)).length;
  for (const type of ["DISCLOSURE", "OTHER", "ENABLE_AUTOPILOT", "NOT_A_TYPE"]) {
    const r = await tool("propose", { type, openingId: oid, brief: "Do something" });
    assert.ok(r.isError || r.result?.ok === false, `${type} refused: ${r.raw.slice(0, 200)}`);
  }
  assert.equal((await proposalsFor(oid)).length, before, "refused proposals create nothing");
  const p = await tool("propose", { type: "RESEARCH_COMPANY", openingId: oid, brief: "Research the employer before the interview" });
  assert.equal(p.result?.ok, true, p.raw.slice(0, 300));
  const proposal = (await rest(H, "GET", `/rest/proposals/${p.result.proposalId}`)).json.data.proposal;
  assert.equal(proposal.status, "PROPOSED");
  assert.equal(proposal.proposer, "GROK");
  assert.equal(proposal.proposalType, "RESEARCH_COMPANY");
  assert.equal(proposal.openingId, oid);
  await rest(H, "PATCH", `/rest/proposals/${proposal.id}`, { status: "DECLINED" });

  // 5. The Grok key reads nothing through the generic endpoints.
  for (const p2 of ["/rest/openings", `/rest/openings/${oid}`, "/rest/proposals", "/rest/decisions", "/rest/companies"]) {
    const r = await rest(G, "GET", p2);
    assert.ok(r.status === 403 || !r.text.includes(oid), `${p2}: ${r.status}`);
    assert.ok(r.status === 403 || r.status === 401, `${p2} refused (${r.status})`);
  }
  const g = await rest(G, "POST", "/graphql", { query: `{ openings(first: 5) { edges { node { id title jd { markdown } } } } }` });
  assert.ok(!g.text.includes(SECRET) && !g.text.includes(oid), "GraphQL returns no data");
  assert.ok(g.status === 403 || g.json.errors?.length, `GraphQL refused (${g.status})`);
  const gw = await rest(G, "POST", "/rest/proposals", { summary: "direct", proposalType: "RESEARCH_COMPANY" });
  assert.equal(gw.status, 403, "no direct writes");
} finally {
  await rest(H, "DELETE", `/rest/openings/${oid}?soft_delete=true`).catch(() => null);
}

console.log("grok-tools: ok");
