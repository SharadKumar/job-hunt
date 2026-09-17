import { tagDuplicateGroups } from "../tools/tag-duplicate-groups.ts";
import type { Opportunity } from "../tools/pipeline.ts";

const base = (id: string, company: string, approvalStatus?: "approved"): Opportunity => ({
  id,
  channel: "seek",
  title: "Lead Microservices and AI Technical Architect",
  company,
  url: `https://www.seek.com.au/job/${id}`,
  status: "shortlisted",
  history: [],
  tailoredResume: approvalStatus ? { approvalStatus } : undefined,
});

const result = tagDuplicateGroups(
  [base("canonical", "Agency A"), base("representative", "Agency B", "approved")],
  [{
    group: "DISR-LH-07526",
    titlePattern: "^(?=.*microservices)(?=.*ai)(?=.*architect).*$",
    endEmployer: "DISR",
    requisitionId: "LH-07526",
    canonicalOpportunityId: "canonical",
    applicationStrategy: "apply_each_representative",
    sharedDraftDir: "state/pipeline/archive/canonical/",
    sharedTailoredResume: {
      baseResumeId: "applied-ai",
      sourceOpportunityId: "canonical",
      docxPath: "state/pipeline/archive/canonical/resume.docx",
      pdfPath: "state/pipeline/archive/canonical/resume.pdf",
      approvalStatus: "pending",
    },
  }],
);

let failed = 0;
const canonical = result.opportunities.find((role) => role.id === "canonical")!;
const representative = result.opportunities.find((role) => role.id === "representative")!;

if (result.tagged !== 2 || canonical.duplicateOf !== undefined || representative.duplicateOf !== "canonical") {
  console.error("  ✗ duplicate group did not preserve canonical/representative linkage");
  failed++;
} else {
  console.log("  ✓ duplicate group preserves canonical/representative linkage");
}

if (representative.tailoredResume?.pdfPath !== "state/pipeline/archive/canonical/resume.pdf") {
  console.error("  ✗ duplicate group did not reuse the shared tailored resume");
  failed++;
} else {
  console.log("  ✓ duplicate group reuses the shared tailored resume for every representative");
}

if (canonical.tailoredResume?.approvalStatus !== "pending" || representative.tailoredResume?.approvalStatus !== "approved") {
  console.error("  ✗ duplicate group overwrote an existing per-row tailored-resume approval");
  failed++;
} else {
  console.log("  ✓ duplicate group preserves an existing per-row tailored-resume approval");
}

if (failed) process.exit(1);
