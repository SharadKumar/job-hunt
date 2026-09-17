#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeneratedReportContent } from "../tools/profile-report.ts";

const root = mkdtempSync(path.join(tmpdir(), "profile-report-test-"));
const previousCwd = process.cwd();

// The fixture repo lives in a temp dir. Tools resolve state/ + templates/ paths
// through tools/repo-root.ts, so point that at the fixture BEFORE the module is
// evaluated (its module-level path constants are computed at import time).
process.env.HARNESS_REPO_ROOT = root;
const {
  buildProfileReportModel,
  buildTeamReportModel,
  escapeHtml,
  relativeLink,
  renderProfileReportHtml,
  renderTeamReportHtml,
} = await import("../tools/profile-report.ts");

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function composition(resumeId: string): string {
  return JSON.stringify({
    frontmatter: {
      name: "Example Person",
      email: "person@example.com",
      phone: "+61 400 000 000",
    },
    headline: "Example Consultant",
    summary: "Source-supported summary.",
    highlights: ["Delivered a useful thing."],
    skills: [{ name: "Delivery", summary: "Keeps delivery controlled.", bullets: ["Governance", "Execution"] }],
    experiences: [{
      placement: "feature",
      title: "Lead Consultant",
      company: "Example Co",
      start: "2024-01",
      end: "current",
      summary: "Led delivery.",
      bullets: ["Improved delivery quality."],
    }],
    source_provenance: {
      cv_source_hash: "abc123",
      profile_hash: "def456",
      evidence: {
        summary: [{ file: "state/profile/cv-source.md", lines: [1, 1] }],
        highlights: [[{ file: "state/profile/cv-source.md", lines: [1, 1] }]],
        skills: { Delivery: [{ file: "state/profile/cv-source.md", lines: [1, 1] }] },
        experiences: {
          "Lead Consultant|Example Co|2024-01|current": {
            summary: [{ file: "state/profile/cv-source.md", lines: [1, 1] }],
            bullets: [[{ file: "state/profile/cv-source.md", lines: [1, 1] }]],
          },
        },
      },
      unsupported_claims: [],
    },
    market_alignment: {
      applied_terms: ["delivery governance"],
      confirmation_needed: [{ signal: "formal PMO", question: "Was there a PMO?", reason: "Market signal." }],
      missing_signals: ["portfolio reporting"],
    },
    resumeId,
  }, null, 2);
}

function writeProfile(profileDir: string, resumeId: string, profileName: string): void {
  write(`${profileDir}/profile.md`, `---\nname: ${profileName}\nemail: ${profileName.toLowerCase().replaceAll(" ", ".")}@example.com\nphone: "+61 400 000 000"\n---\n\n# Profile\n`);
  write(`${profileDir}/cv-source.md`, "# CV\n\nLed delivery governance.\n");
  write(`${profileDir}/voice-samples.md`, "# Voice\n\nShort and direct.\n");
  write(`${profileDir}/market-confirmations.yaml`, "confirmations: []\n");
  write(`${profileDir}/resumes.yaml`, `resumes:\n  - id: ${resumeId}\n    active: true\n`);
  write(`${profileDir}/resumes/${resumeId}/metadata.json`, JSON.stringify({
    resume_id: resumeId,
    template: "classic",
    last_render_at: "2026-06-08T00:00:00.000Z",
    content_hash: "hash-current",
    approved_hash: "hash-current",
    approval_status: "approved",
    artefacts: {
      docx: `${profileDir}/resumes/${resumeId}/resume_${resumeId}.docx`,
      pdf: `${profileDir}/resumes/${resumeId}/missing.pdf`,
      html: `${profileDir}/resumes/${resumeId}/resume_${resumeId}.html`,
      md: `${profileDir}/resumes/${resumeId}/resume_${resumeId}.md`,
      composition_json: `${profileDir}/resumes/${resumeId}/resume_${resumeId}.composition.json`,
    },
  }, null, 2));
  write(`${profileDir}/resumes/${resumeId}/resume_${resumeId}.html`, "<html><body>Resume</body></html>");
  write(`${profileDir}/resumes/${resumeId}/resume_${resumeId}.md`, "# Resume\n");
  write(`${profileDir}/resumes/${resumeId}/resume_${resumeId}.docx`, "not-a-real-docx");
  write(`${profileDir}/resumes/${resumeId}/resume_${resumeId}-page-1.png`, "not-a-real-png");
  write(`${profileDir}/resumes/${resumeId}/resume_${resumeId}.composition.json`, composition(resumeId));
}

function writeTemplate(id: string): void {
  write(`templates/resume/${id}/render.ts`, "export default async () => ({ meta: { template: 'classic' } });\n");
  write(`templates/resume/${id}/styles.css`, "body { font-family: serif; }\n");
  write(`templates/resume/${id}/quality-checks.md`, "# Quality checks\n");
  write(`templates/resume/${id}/template.md`, "# Template\n");
  write(`templates/resume/${id}/rubric.yaml`, `template: ${id}\ndescription: Executive serif CV for senior consulting audiences.\nallowed_headings:\n  - Summary\n  - Experience\nsection_order:\n  - summary\n  - experience\npage_budget:\n  preferred: 3\n  hard_max: 3\n  reason: Senior profiles need enough evidence density.\n`);
  write(`templates/resume/${id}/sample/golden-page-1.png`, "not-a-real-png");
  write(`templates/resume/${id}/sample/golden.pdf`, "not-a-real-pdf");
  write(`templates/resume/${id}/sample/golden.html`, "<html><body>Sample</body></html>");
  write(`templates/resume/${id}/sample/golden.docx`, "not-a-real-docx");
  write(`templates/resume/${id}/sample/golden.md`, "# Sample\n");
}

const tests: [string, () => Promise<void>][] = [
  ["escapes HTML", async () => {
    assert.equal(escapeHtml("<script>alert('x')</script>"), "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  }],

  ["builds relative local links", async () => {
    assert.equal(
      relativeLink("/tmp/report/out/profile-report.html", "/tmp/report/out/resumes/example.pdf"),
      "resumes/example.pdf",
    );
  }],

  ["renders individual report with generated narrative and missing artefact warnings", async () => {
    process.chdir(root);
    const generated: GeneratedReportContent = {
      profile_overview: "Generated <profile> note.",
      resume_notes: {
        "example-resume": {
          narrative: "Generated resume note.",
          risks: ["Missing PDF"],
          next_actions: ["Re-render presentation artefact"],
        },
      },
    };
    const previousSheetId = process.env.SHEETS_SPREADSHEET_ID;
    process.env.SHEETS_SPREADSHEET_ID = "test_sheet_123";
    const model = await buildProfileReportModel(null, "state/profile/profile-report.html", generated);
    if (previousSheetId === undefined) delete process.env.SHEETS_SPREADSHEET_ID;
    else process.env.SHEETS_SPREADSHEET_ID = previousSheetId;
    const html = renderProfileReportHtml(model, "<title>{{TITLE}}</title><header>{{HEADER_TABS}}</header><main>{{BODY}}</main>");
    const mastheadHtml = renderProfileReportHtml(model, "<title>{{TITLE}}</title><header><div>{{KICKER}}</div><h1>{{HEADING}}</h1><div>{{HEADER_ACTIONS}}</div>{{HEADER_TABS}}</header><main>{{BODY}}</main>");
    assert.match(html, /Profile Report — Default Person/);
    assert.match(mastheadHtml, /<title>Profile Report — Default Person<\/title>/);
    assert.match(mastheadHtml, /<div>Profile Report<\/div>/);
    assert.match(mastheadHtml, /<h1>Default Person<\/h1>/);
    assert.match(mastheadHtml, /href="https:\/\/docs\.google\.com\/spreadsheets\/d\/test_sheet_123\/edit"/);
    assert.match(mastheadHtml, /Opportunities/);
    assert.match(model.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(model.generated_at_label, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(html, /Generated &lt;profile&gt; note/);
    assert.match(html, /overview-resumes/);
    assert.match(html, /tab-count/);
    assert.match(html, /data-page-tabs/);
    assert.match(html, /data-page-panel/);
    assert.match(html, /aria-label="Templates 1"><span>Templates<\/span>/);
    assert.ok(html.indexOf('aria-label="Source Files"') < html.indexOf('aria-label="Templates 1"'));
    assert.match(html, /template-browser/);
    assert.match(html, /template-preview-grid/);
    assert.match(html, /template-config-classic-rubric-yaml/);
    assert.match(html, /Executive serif CV for senior consulting audiences/);
    assert.doesNotMatch(html, /<main><div class="tab-set" data-tab-set>/);
    assert.match(html, /data-open-detail-target/);
    assert.match(html, /resume-date/);
    assert.match(html, /resume-date">\d{1,2} \w+ 2026/);
    assert.doesNotMatch(html, /resume-date">Generated/);
    assert.match(html, /resume-card-badges/);
    assert.doesNotMatch(html, /metric-grid/);
    assert.doesNotMatch(html, /Review queue/);
    assert.match(html, /Generated resume-specific notes/);
    assert.match(html, /Metadata references missing pdf/);
    assert.match(html, /Resumes/);
    assert.match(html, /Previews/);
    assert.match(html, /preview-switcher/);
    assert.match(html, /png-carousel/);
    assert.match(html, /<div class="png-carousel-actions">\s*<p class="png-carousel-status" data-carousel-status>/);
    assert.match(html, /data-carousel-prev/);
    assert.match(html, /data-carousel-next/);
    assert.match(html, /png-lightbox-trigger/);
    assert.doesNotMatch(html, /\.png-lightbox-trigger:hover img\s*\{[^}]*transform:/);
    assert.match(html, /data-lightbox-src=/);
    assert.match(html, /data-lightbox-caption=/);
    assert.match(html, /PDF/);
    assert.match(html, /Images/);
    assert.doesNotMatch(html, /PDF Preview/);
    assert.doesNotMatch(html, /Image Preview/);
    assert.doesNotMatch(html, /<h4>PDF preview<\/h4>/);
    assert.doesNotMatch(html, /<h4>Image preview<\/h4>/);
    assert.match(html, /aria-label="Overview"><span>Overview<\/span><\/button>/);
    assert.doesNotMatch(html, /aria-label="Snapshot"><span>Snapshot<\/span><\/button>/);
    assert.match(html, /snapshot-list-section/);
    assert.match(html, /Delivered a useful thing\./);
    assert.match(html, /snapshot-skill-block/);
    assert.match(html, /<h4>Skills<\/h4>/);
    assert.doesNotMatch(html, /<h4>Skill blocks<\/h4>/);
    assert.match(html, /Keeps delivery controlled\./);
    assert.match(html, /Governance/);
    assert.doesNotMatch(html, /<strong>Headline<\/strong>/);
    assert.doesNotMatch(html, /<strong>Highlights<\/strong>/);
    assert.doesNotMatch(html, /<strong>Skill blocks<\/strong>/);
    assert.doesNotMatch(html, /<strong>Featured experience<\/strong>/);
    assert.doesNotMatch(html, /<strong>Mentioned experience<\/strong>/);
    assert.doesNotMatch(html, /<strong>Dropped experience<\/strong>/);
    assert.doesNotMatch(html, /id="tab-preview-example-resume"/);
    assert.match(html, /Analysis/);
    assert.doesNotMatch(html, /Market fit/);
    assert.match(html, /rate-card/);
    assert.match(html, /<span>Target<\/span>/);
    assert.doesNotMatch(html, /<h4>Rate band<\/h4><pre class="json syntax-highlight">/);
    assert.match(html, /Configuration/);
    assert.match(html, /configuration-tabs/);
    assert.match(html, /config-evidence-/);
    assert.match(html, /config-metadata-/);
    assert.match(html, /config-composition-/);
    assert.match(html, /<pre class="json syntax-highlight"><code>/);
    assert.match(html, /<span class="sh-key">&quot;resume_id&quot;<\/span>:/);
    assert.match(html, /<pre class="yaml syntax-highlight"><code>/);
    assert.match(html, /<span class="sh-key">resumes<\/span>:/);
    assert.doesNotMatch(html, /id="tab-evidence-/);
    assert.doesNotMatch(html, /data-tab="evidence-/);
    assert.doesNotMatch(html, /raw-stack/);
    assert.doesNotMatch(html, />Raw<\/button>/);
    assert.match(html, /Source Files/);
    assert.match(html, /source-file-browser/);
    assert.match(html, /file-detail/);
    assert.match(html, /file-size-inline/);
    assert.match(html, /<p class="eyebrow">Source file · state\/org\/resume-types\.yaml<\/p>/);
    assert.doesNotMatch(html, /<p class="muted">state\/org\/resume-types\.yaml<\/p>/);
    assert.match(html, /file-status-icon good/);
    assert.match(html, /title="File found"/);
    assert.doesNotMatch(html, /<span class="badge good"><strong>Status<\/strong>found<\/span>/);
    assert.doesNotMatch(html, /input-card/);
    assert.match(html, /rail-header/);
    assert.match(html, /<div class="rail-header"><span>Source files<\/span><\/div>/);
    assert.doesNotMatch(html, /<div class="rail-header"><span>Source files<\/span><strong>/);
    assert.match(html, /rail-label/);
    assert.match(html, /<span class="rail-label">resume-types\.yaml<\/span>/);
    assert.doesNotMatch(html, /<span class="rail-label">state\/org\/resume-types\.yaml<\/span>/);
    assert.match(html, /rail-meta/);
    assert.match(html, /rail-meta"><span>\d{1,2} \w+ 2026<\/span><span>approved<\/span>/);
    assert.match(html, /rail-meta"><span>found<\/span><span>[\d.]+ (?:B|KB)<\/span>/);
    assert.match(html, /resume-status-strip/);
    assert.match(html, /resume-header-actions/);
    assert.match(html, /positioning-title-row/);
    assert.match(html, /<a class="button" href="resumes\/example-resume\/missing\.pdf" target="_blank" rel="noopener">PDF<\/a>/);
    assert.doesNotMatch(html, /button primary/);
    assert.match(html, /target="_blank" rel="noopener">DOCX<\/a>/);
    assert.match(html, /target="_blank" rel="noopener">HTML<\/a>/);
    assert.doesNotMatch(html, /Open PDF/);
    assert.doesNotMatch(html, /compact-actions/);
    assert.doesNotMatch(html, /side-panel/);
  }],

  ["renders team report bench, coverage, profiles, and config", async () => {
    process.chdir(root);
    const model = await buildTeamReportModel("state/org/team-report.html", { team_overview: "Generated team note." });
    const html = renderTeamReportHtml(model, "<title>{{TITLE}}</title><header>{{HEADER_TABS}}</header><main>{{BODY}}</main>");
    const mastheadHtml = renderTeamReportHtml(model, "<title>{{TITLE}}</title><header><div>{{HEADER_ACTIONS}}</div>{{HEADER_TABS}}</header><main>{{BODY}}</main>");
    assert.match(html, /Team Report/);
    assert.match(html, /Generated team note/);
    assert.doesNotMatch(mastheadHtml, /Opportunities/);
    assert.match(html, /aria-label="Bench"><span>Bench<\/span><\/button>/);
    assert.match(html, /aria-label="Coverage"><span>Coverage<\/span><\/button>/);
    assert.match(html, /aria-label="Profiles 1"><span>Profiles<\/span>/);
    assert.match(html, /aria-label="Templates 1"><span>Templates<\/span>/);
    assert.match(html, /aria-label="Configuration"><span>Configuration<\/span><\/button>/);
    assert.ok(html.indexOf('aria-label="Configuration"') < html.indexOf('aria-label="Templates 1"'));
    assert.match(html, /team-stat-strip/);
    assert.match(html, /coverage-table/);
    assert.match(html, /<thead><tr><th>Profile<\/th><th>Example Resume<\/th><\/tr><\/thead>/);
    assert.match(html, /<div class="rail-header"><span>Source Files<\/span><\/div>/);
    assert.match(html, /team-profile-browser/);
    assert.match(html, /team-profile-profile-alex/);
    assert.match(html, /data-profile-owner="profile-alex"/);
    assert.match(html, /href="#positioning-profile-alex-example-resume" data-open-detail-target="positioning-profile-alex-example-resume"/);
    assert.match(html, /positioning-profile-alex-example-resume/);
    assert.doesNotMatch(html, /Resume detail/);
    assert.doesNotMatch(html, /team-profile-resumes/);
    assert.doesNotMatch(html, /Profile Matrix/);
    assert.doesNotMatch(html, /Render Status/);
    assert.doesNotMatch(html, /Per-Profile Drilldown/);
    assert.doesNotMatch(html, /<details class="card">/);
    assert.match(html, /Alex Consultant/);
    assert.doesNotMatch(html, /Default Person/);
    assert.equal(model.profiles.length, 1);
    assert.equal(model.matrix.length, 1);
  }],
];

try {
  write("state/org/resume-types.yaml", `resume_types:\n  - id: example-resume\n    label: Example Resume\n    active: true\n    template: classic\n    search_keywords: [Example Consultant]\n    should: [delivery]\n    could: [governance]\n    flagged: [junior]\n    cover_letter_angle: Led delivery governance.\n    rate_band: { floor: 1000, target: 1200, ceiling: 1400, currency: AUD, billing_unit: day, gst_handling: + GST }\n    preferred_channels: [seek]\n`);
  write("state/org/team.yaml", `profiles:\n  - id: alex\n    label: Alex Consultant\n    active: true\n    profile_dir: state/profiles/alex\n`);
  writeTemplate("classic");
  writeProfile("state/profile", "example-resume", "Default Person");
  writeProfile("state/profiles/alex", "example-resume", "Alex Consultant");

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
    }
  }
  console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
} finally {
  process.chdir(previousCwd);
}
