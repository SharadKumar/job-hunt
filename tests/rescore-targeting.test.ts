import assert from "node:assert/strict";
import type { Opportunity } from "../tools/pipeline.ts";
import { selectOpportunitiesForRescore } from "../tools/rescore-pipeline.ts";

const role = (id: string, status: Opportunity["status"]): Opportunity => ({
  id,
  channel: "seek",
  title: `Role ${id}`,
  company: "Example",
  url: `https://example.test/${id}`,
  status,
  history: [],
});

const roles = [
  role("new-a", "discovered"),
  role("old-b", "discovered"),
  role("existing-shortlist", "shortlisted"),
  role("already-submitted", "submitted"),
];

const selected = selectOpportunitiesForRescore(
  roles,
  ["discovered", "shortlisted"],
  new Set(["new-a", "already-submitted"]),
  Infinity,
);

assert.deepEqual(selected.map((item) => item.id), ["new-a"]);
console.log("Targeted rescore selection test passed");
