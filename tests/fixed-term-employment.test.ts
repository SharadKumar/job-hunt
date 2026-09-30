import assert from "node:assert/strict";
import { makeTempRoot, repoFile } from "./helpers/temp-root.ts";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { classificationV2 } from "./fixtures/classification-v2.ts";
import type { Opportunity } from "../tools/pipeline.ts";

const { profileDir } = makeTempRoot("fixed-term-employment-");
for (const name of ["scoring-weights.yaml", "skills-taxonomy.yaml"]) {
  copyFileSync(repoFile("templates", "profile", name), path.join(profileDir, name));
}
const { scoreRole } = await import("../tools/score.ts");
const { rescoreStatusDecision } = await import("../tools/rescore-pipeline.ts");
const row: Opportunity = {
  id: "fixed-term", channel: "seek", title: "Solution Architect", company: "Example",
  url: "https://example.test/job", status: "shortlisted", history: [],
  description: "[Employment type: Contract/Temp] 12-month fixed-term contract. Competitive salary and employee benefits.",
  classification: classificationV2({ is_contract: true, red_flags: [] }),
};
const result = await scoreRole({ ...row, description: row.description! }, row.classification);
assert.equal(result.red_flag_blocker, true, "cached semantic core fit cannot override explicit employment terms");
assert.equal(result.ineligible_reason, "fixed-term employee engagement, not independent contracting");
assert.equal(rescoreStatusDecision(row, result, 55).status, "rejected");
assert.equal(rescoreStatusDecision({ ...row, userSaved: true }, result, 55).status, "shortlisted", "saved-job authority remains intact");
assert.equal(rescoreStatusDecision({ ...row, status: "submitted" }, result, 55).status, "submitted");
const contractor = await scoreRole({ ...row, description: "A six-month architecture contract at a daily rate via ABN." }, row.classification);
assert.equal(contractor.ineligible_reason, undefined);
console.log("Fixed-term employment scoring and saved-job override tests passed");
