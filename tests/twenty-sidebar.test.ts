#!/usr/bin/env tsx
/** twenty-sidebar.test.ts — keep the suite's objects, drop the rest, section first. */

import assert from "node:assert/strict";
import { planSidebar } from "../tools/twenty/sidebar.ts";

const names = { o1: "company", o2: "opportunity", o3: "workflowRun", o4: "task" };
const items = [
  { id: "c", type: "OBJECT", targetObjectMetadataId: "o1", position: 0, applicationId: "std" },
  { id: "op", type: "OBJECT", targetObjectMetadataId: "o2", position: 1, applicationId: "std" },
  { id: "t", type: "OBJECT", targetObjectMetadataId: "o4", position: 2, applicationId: "std" },
  { id: "wf", type: "FOLDER", name: "Workflows", position: 3, applicationId: "std" },
  { id: "wfr", type: "OBJECT", targetObjectMetadataId: "o3", parentId: "wf", position: 0, applicationId: "std" },
  { id: "mine", type: "OBJECT", targetObjectMetadataId: "o2", position: 4, applicationId: "std", userWorkspaceId: "u1" },
  { id: "sec", type: "SECTION", name: "Job hunt", position: 0, applicationId: "app" },
];
const plan = planSidebar(items, names, "app", ["company", "person", "task", "note"]);
// By default nothing standard is kept: the app section links company, person and task itself.
assert.deepEqual(planSidebar(items, names, "app").remove.map((r) => r.id), ["wfr", "c", "op", "t", "wf"]);
assert.deepEqual(plan.remove.map((r) => r.id), ["wfr", "op", "wf"], "children first; kept objects and a person's own items untouched");
assert.deepEqual(plan.sectionToTop, { id: "sec", position: -1 });
const clean = planSidebar([items[0], { ...items[6], position: -1 }], names, "app", ["company", "person", "task", "note"]);
assert.deepEqual(clean, { remove: [], sectionToTop: null }, "already clean");
console.log("twenty-sidebar: ok");
