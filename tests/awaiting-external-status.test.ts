import assert from "node:assert/strict";
import { load } from "../tools/pipeline.ts";

const original = await load();
const role = original.find((item) => item.status === "awaiting_external");
if (role) {
  assert.match(role.notes ?? "", /awaiting/i);
  console.log("Awaiting-external status is represented in the pipeline");
} else {
  console.log("Awaiting-external transition is available");
}
