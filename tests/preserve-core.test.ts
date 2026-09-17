/**
 * preserve-core.test.ts — the preservation gate, on synthetic fixtures only.
 *
 * No personal data: the fixture corpus below is a fictional candidate.
 */

import assert from "node:assert/strict";
import type { Frontmatter, ResumeContent, ResumeSourceProvenance } from "../templates/resume/_interface.ts";
import { checkPreservation, parseHeadingDates, parseSourceExperiences, normaliseDate } from "../tools/resume/lib/preserve-core.ts";

const CV_SOURCE = `# Jamie Rivers

## Professional Summary

Platform engineer with a decade of delivery across regulated environments.

## Career Highlights

- Cut mean deploy time from four hours to twelve minutes across nine teams.

## Professional Experience

### 2022-04 – present — Platform Lead, Northwind Systems

Leads the platform group.

- Rebuilt the deployment pipeline for eleven product teams.

#### Internal notes (not for CVs)

Jamie left the previous employer after an unresolved dispute with payroll.

### 2019-01 – 2022-03 — Senior Engineer, Contoso Pty Ltd

- Migrated the billing service onto managed Kubernetes.

### 2016-05 – 2018-12 — Engineer, Fabrikam

- Wrote the first automated regression suite.

## Skills

### Engineering

- Kubernetes, Terraform, GitHub Actions

## Education

- BSc Computer Science, University of Example
`;

const PROFILE: Partial<Frontmatter> = {
  name: "Jamie Rivers",
  email: "jamie.rivers@example.com",
  phone: "+61 400 111 222",
  citizenship: "Australian Citizen",
  location: { city: "Melbourne", country: "AU" },
  linkedin_url: "https://www.linkedin.com/in/jamie-rivers-example",
};

const PROVENANCE: ResumeSourceProvenance = {
  evidence: { summary: [], highlights: [], skills: {}, experiences: {} },
};

function baseContent(): ResumeContent {
  return {
    frontmatter: {
      name: "Jamie Rivers",
      email: "jamie.rivers@example.com",
      phone: "+61 400 111 222",
      citizenship: "Australian Citizen",
      location: { city: "Melbourne", country: "AU" },
      linkedin_url: "https://www.linkedin.com/in/jamie-rivers-example",
    },
    summary: "Platform engineer with a decade of delivery across regulated environments.",
    highlights: ["Cut mean deploy time from four hours to twelve minutes across nine teams."],
    skills: [{ name: "Engineering", bullets: ["Kubernetes, Terraform, GitHub Actions"] }],
    credentials: ["BSc Computer Science, University of Example"],
    experiences: [
      {
        placement: "feature",
        title: "Platform Lead",
        company: "Northwind Systems",
        start: "2022-04",
        end: "current",
        summary: "Leads the platform group.",
        bullets: ["Rebuilt the deployment pipeline for eleven product teams."],
      },
      {
        placement: "mention",
        title: "Senior Engineer",
        company: "Contoso Pty Ltd",
        start: "2019-01",
        end: "2022-03",
        one_liner: "Migrated the billing service onto managed Kubernetes.",
      },
    ],
    dropped_experiences: [{ id: "Engineer|Fabrikam|2016-05|2018-12", reason: "pre-dates the target positioning" }],
    resumeId: "fixture",
  };
}

function run(content: ResumeContent, over: Partial<Parameters<typeof checkPreservation>[0]> = {}) {
  return checkPreservation({ content, provenance: PROVENANCE, cvSourceText: CV_SOURCE, profileFrontmatter: PROFILE, ...over });
}

const rules = (r: ReturnType<typeof checkPreservation>) => r.issues.map((i) => i.rule);

// --- parsing ---------------------------------------------------------------
const parsed = parseSourceExperiences(CV_SOURCE);
assert.equal(parsed.length, 3, "three experience headings, and the 'not for CVs' subtree is not one");
assert.deepEqual(
  parsed.map((p) => [p.title, p.company, p.start, p.end]),
  [
    ["Platform Lead", "Northwind Systems", "2022-04", "current"],
    ["Senior Engineer", "Contoso Pty Ltd", "2019-01", "2022-03"],
    ["Engineer", "Fabrikam", "2016-05", "2018-12"],
  ],
);
assert.equal(normaliseDate("present"), "current");
assert.equal(normaliseDate("2022-4"), "2022-04");
console.log("  ✓ cv-source headings parse into title / company / start / end");

// --- happy path ------------------------------------------------------------
const clean = run(baseContent());
assert.equal(clean.verdict, "pass", `expected pass, got ${clean.verdict}: ${JSON.stringify(clean.issues)}`);
assert.equal(clean.stats.source_experiences, 3);
assert.equal(clean.stats.dropped_with_reason, 1);
console.log("  ✓ a faithful composition passes");

// --- skip ------------------------------------------------------------------
assert.equal(run(baseContent(), { provenance: null }).verdict, "skip", "no provenance → skip, never fail");
assert.equal(run(baseContent(), { cvSourceText: "" }).verdict, "skip", "no cv-source → skip");
assert.equal(run(baseContent(), { profileFrontmatter: null }).verdict, "skip", "no profile frontmatter → skip");
assert.ok(run(baseContent(), { provenance: null }).stats.skipped_reason);
console.log("  ✓ skips (never fails) when no corpus is resolvable");

// --- (a) identity ----------------------------------------------------------
{
  const c = baseContent();
  c.frontmatter.email = "jamie@personal.example";
  c.frontmatter.location = { city: "Sydney", country: "AU" };
  delete (c.frontmatter as { citizenship?: string }).citizenship;
  const r = run(c);
  assert.equal(r.verdict, "fail");
  const identity = r.issues.filter((i) => i.rule === "preserve_identity_changed");
  assert.equal(identity.length, 3, `expected email + city + citizenship failures, got ${JSON.stringify(identity)}`);
  assert.ok(identity.some((i) => i.detail.includes("citizenship") && i.detail.includes("(missing)")));
  console.log("  ✓ (a) identity block must equal profile.md frontmatter exactly");
}

// --- (b) every source experience accounted for -----------------------------
{
  const c = baseContent();
  c.dropped_experiences = [];
  const r = run(c);
  assert.equal(r.verdict, "fail");
  assert.ok(rules(r).includes("preserve_experience_unaccounted"));
  assert.deepEqual(r.stats.unaccounted.length, 1);
  assert.ok(r.issues[0].detail.includes("Fabrikam"));
  console.log("  ✓ (b) a source experience that is neither featured, mentioned nor dropped fails");
}
{
  const c = baseContent();
  c.dropped_experiences = [{ id: "Engineer|Fabrikam|2016-05|2018-12", reason: "  " }];
  const r = run(c);
  assert.equal(r.verdict, "fail");
  assert.ok(rules(r).includes("preserve_dropped_without_reason"));
  console.log("  ✓ (b) dropping without a reason fails");
}
{
  // Punctuation and legal-suffix tolerance: source says "Contoso Pty Ltd".
  const c = baseContent();
  (c.experiences[1] as { company: string }).company = "Contoso";
  assert.equal(run(c).verdict, "pass", "company match is punctuation/suffix tolerant");
  console.log("  ✓ (b) company matching tolerates punctuation and legal suffixes");
}

// --- (c) composed experience with no source block --------------------------
{
  const c = baseContent();
  c.experiences.push({
    placement: "mention",
    title: "Principal Engineer",
    company: "Initech",
    start: "2014-01",
    end: "2015-12",
    one_liner: "Something the corpus never mentions.",
  });
  const r = run(c);
  assert.equal(r.verdict, "fail");
  assert.ok(rules(r).includes("preserve_experience_unsourced"));
  assert.equal(r.stats.unsourced.length, 1);
  console.log("  ✓ (c) an invented experience fails");
}

// --- (d) section representation (warn) -------------------------------------
{
  const c = baseContent();
  c.skills = [];
  c.credentials = [];
  const r = run(c);
  assert.equal(r.verdict, "warn", "unrepresented sections warn, they do not fail");
  const warned = r.issues.filter((i) => i.rule === "preserve_section_unrepresented");
  assert.equal(warned.length, 2);
  assert.ok(warned.some((i) => i.detail.includes("Skills")) && warned.some((i) => i.detail.includes("Education")));
  console.log("  ✓ (d) cv-source sections with content but no composition counterpart warn");
}

// --- (e) dates -------------------------------------------------------------
{
  const c = baseContent();
  (c.experiences[1] as { start: string }).start = "2018-01";
  const r = run(c);
  assert.equal(r.verdict, "fail");
  assert.ok(rules(r).includes("preserve_dates_changed"), `got ${JSON.stringify(rules(r))}`);
  assert.ok(!rules(r).includes("preserve_experience_unsourced"), "a date drift is a date drift, not an unsourced role");
  console.log("  ✓ (e) a date that differs from source fails");
}
{
  const c = baseContent();
  (c.experiences[0] as { end: string }).end = "present";
  assert.equal(run(c).verdict, "pass", "'present' and 'current' are the same open end date");
  console.log("  ✓ (e) present/current are equivalent end dates");
}

// --- (f) 'not for CVs' material ---------------------------------------------
{
  const c = baseContent();
  c.highlights.push("Jamie left the previous employer after an unresolved dispute with payroll.");
  const r = run(c);
  assert.equal(r.verdict, "fail");
  assert.ok(rules(r).includes("preserve_private_material_rendered"));
  console.log("  ✓ (f) text under a 'not for CVs' heading may never render");
}
{
  const c = baseContent();
  // Shares only short runs with the private block — below the 6-word shingle.
  c.highlights.push("Jamie left a clean handover behind.");
  assert.equal(run(c).verdict, "pass", "short incidental overlap is not a leak");
  console.log("  ✓ (f) incidental short overlaps are not flagged");
}

console.log("  ✓ core rules: identity, coverage, dates, private material");

// ---------------------------------------------------------------------------
// Abbreviated companies, "Launched …" headings, and slug drop ids.
//
// The compositions in state/ abbreviate employers ("NSW Dept. of Edu." for
// "Department of Education", "Australian Professional Leagues (APL)" for "APL",
// "OBS (a Nintex Workflow company)" for "OBS") and the corpus writes some
// headings without an end date at all. Every one of those was once reported as
// an unsourced experience, an unaccounted heading, or a date change.
// ---------------------------------------------------------------------------

const CV_SOURCE_2 = `# Jamie Rivers

## Applied Practice (non-employment)

### Launched 2025-02 · maintained to present — Engineer, Tinkercraft (open demonstration, non-commercial)

- Built it in the open.

## Professional Experience

### 2022-10 – 2025-01 — Delivery Manager, Department of Education

- Ran the schools programme.

### 2021-04 – 2022-09 — Engineering Lead and Architect, APL

- Led the match-day build.

### 2018-06 – 2021-03 — Architect and Principal Consultant, OBS

- Advised on workflow automation.

### 2016-01 — Microsoft MVP (Most Valuable Professional) for SharePoint Server,

- Community recognition.
`;

function content2(): ResumeContent {
  return {
    frontmatter: { ...baseContent().frontmatter },
    summary: "Delivery lead across public sector and sport.",
    highlights: ["Ran the schools programme."],
    skills: [{ name: "Delivery", bullets: ["Programme delivery"] }],
    experiences: [
      { placement: "mention", title: "Engineer", company: "Tinkercraft (tinkercraft.dev)", start: "2025-02", end: "current", one_liner: "Built it in the open." },
      { placement: "feature", title: "Delivery Manager", company: "NSW Dept. of Edu.", start: "2022-10", end: "2025-01", summary: "Programme delivery.", bullets: ["Ran the schools programme."] },
      { placement: "mention", title: "Engineering Lead & Architect", company: "Australian Professional Leagues (APL)", start: "2021-04", end: "2022-09", one_liner: "Led the match-day build." },
      { placement: "mention", title: "Architect and Principal Consultant", company: "OBS (a Nintex Workflow company)", start: "2018-06", end: "2021-03", one_liner: "Advised on workflow automation." },
      { placement: "mention", title: "Microsoft MVP (SharePoint Server)", company: "Microsoft Community", start: "2016-01", end: "current", one_liner: "Community recognition." },
    ],
    resumeId: "fixture-2",
  };
}

const run2 = (content: ResumeContent) =>
  checkPreservation({ content, provenance: PROVENANCE, cvSourceText: CV_SOURCE_2, profileFrontmatter: PROFILE });

// --- heading date forms ----------------------------------------------------
assert.deepEqual(parseHeadingDates("2022-10 – 2025-01"), { start: "2022-10", end: "2025-01" });
assert.deepEqual(parseHeadingDates("2026-09 – present"), { start: "2026-09", end: "current" });
assert.deepEqual(parseHeadingDates("Launched 2026-02 · maintained to present"), { start: "2026-02", end: "current" });
assert.deepEqual(parseHeadingDates("2001 – 2003"), { start: "2001-01", end: "2003-01" });
assert.deepEqual(parseHeadingDates("2016-01"), { start: "2016-01", end: "current" }, "a heading with no end is current, not 'ends when it started'");
{
  const parsed2 = parseSourceExperiences(CV_SOURCE_2);
  assert.deepEqual(parsed2.map((p) => [p.start, p.end]), [
    ["2025-02", "current"],
    ["2022-10", "2025-01"],
    ["2021-04", "2022-09"],
    ["2018-06", "2021-03"],
    ["2016-01", "current"],
  ]);
  assert.equal(parsed2[0].company, "Tinkercraft", "the 'Launched … — Title, Company (tail)' form parses");
  console.log("  ✓ every heading date form in the corpus parses, open ends included");
}

// --- abbreviated companies -------------------------------------------------
{
  const r = run2(content2());
  assert.equal(r.verdict, "pass", `expected pass, got ${r.verdict}: ${JSON.stringify(r.issues)}`);
  assert.equal(r.stats.unsourced.length, 0);
  assert.equal(r.stats.unaccounted.length, 0);
  console.log("  ✓ abbreviated / parenthesised / acronym company forms match their source heading");
}

// --- a genuine drop still fails --------------------------------------------
{
  const c = content2();
  c.experiences = c.experiences.filter((e) => !e.company.startsWith("OBS"));
  const r = run2(c);
  assert.equal(r.verdict, "fail", "a source role absent from the composition with no dropped_experiences entry must fail");
  assert.ok(rules(r).includes("preserve_experience_unaccounted"));
  assert.equal(r.stats.unaccounted.length, 1);
  assert.ok(r.stats.unaccounted[0].includes("OBS"));
  console.log("  ✓ a silently dropped source experience still fails");
}

// --- slug drop ids ---------------------------------------------------------
{
  const c = content2();
  c.experiences = c.experiences.filter((e) => !e.title.startsWith("Microsoft MVP"));
  c.dropped_experiences = [{ id: "microsoft-mvp", reason: "Community award, not an employment engagement." }];
  const r = run2(c);
  assert.equal(r.verdict, "pass", `slug drop ids account for their heading: ${JSON.stringify(r.issues)}`);
  assert.equal(r.stats.dropped_with_reason, 1);

  c.dropped_experiences = [{ id: "microsoft-365-consultant-abbvie", reason: "Different role entirely." }];
  const unrelated = run2(c);
  assert.equal(unrelated.verdict, "fail", "an unrelated drop id must not excuse a dropped heading");
  assert.ok(rules(unrelated).includes("preserve_experience_unaccounted"));
  console.log("  ✓ drop ids match their heading fuzzily but not promiscuously");
}

// --- attested in the corpus body, but not as a heading ---------------------
{
  const c = content2();
  c.experiences.push({
    placement: "mention",
    title: "Community Organiser",
    company: "Tinkercraft",
    start: "2015-01",
    end: "2015-12",
    one_liner: "Never written as a heading anywhere.",
  });
  const r = run2(c);
  assert.equal(r.verdict, "fail", "a role the corpus never states is still invented");
  assert.ok(rules(r).includes("preserve_experience_unsourced"));
  console.log("  ✓ an experience the corpus never states remains a hard fail");
}

console.log("preserve-core: all assertions passed");
