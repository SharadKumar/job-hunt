#!/usr/bin/env tsx
/**
 * editorial-bans.test.ts — the mechanical subset of the profile's editorial
 * rules must fail deterministically, on synthetic content only.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResumeContent } from "../templates/resume/_interface.ts";
import { checkEditorialBans, parseEditorialBans, loadEditorialBans, type EditorialBanRule } from "../tools/resume/lib/editorial-bans.ts";
import { resolveProfileContext } from "../tools/profile-context.ts";

const RULES: EditorialBanRule[] = parseEditorialBans(`
version: 1
rules:
  - id: venture-non-commercial
    scope: { company: "Acme Demo" }
    title_must_equal: "Engineer"
    forbidden_phrases: ["product", "customers", "launched"]
    severity: fail
  - id: venture-title
    scope: { company: "Beta ?Front" }
    title_must_equal: "CTO (part-time, pre-launch build)"
    forbidden_phrases: ["incorporat", "go-to-market", "ABN"]
    severity: fail
  - id: ventures-not-in-highlights
    scope: { field: highlights }
    forbidden_phrases: ["Beta Front", "Acme Demo"]
    severity: fail
  - id: no-founder-anywhere
    scope: { field: any }
    forbidden_regex: ["\\\\bfounder\\\\b"]
    severity: fail
  - id: skills-soft
    scope: { field: skills }
    forbidden_phrases: ["synergy"]
    severity: warn
`);

function content(over: Partial<ResumeContent> = {}): ResumeContent {
  return {
    frontmatter: { name: "Test Person", email: "t@example.com", phone: "0000" },
    summary: "Delivery-focused engineer.",
    highlights: ["Led a platform migration for a large insurer."],
    skills: [{ name: "Platform", bullets: ["TypeScript, Node, Playwright."] }],
    experiences: [],
    ...over,
  } as ResumeContent;
}

function featured(over: Record<string, unknown> = {}) {
  return {
    placement: "feature" as const,
    title: "Engineer",
    company: "Acme Demo",
    start: "2026-02",
    end: "current",
    summary: "Open demonstration of agentic delivery, non-commercial.",
    bullets: ["Built a multi-agent orchestration harness."],
    ...over,
  };
}

const ids = (r: ReturnType<typeof checkEditorialBans>) => r.issues.map((i) => i.rule_id);

// --- clean composition ------------------------------------------------------
{
  const r = checkEditorialBans({ content: content({ experiences: [featured() as any] }), rules: RULES });
  assert.equal(r.verdict, "pass", `clean content should pass, got ${JSON.stringify(r.issues)}`);
  assert.equal(r.stats.rules, RULES.length);
  console.log("  ✓ clean synthetic composition passes every rule");
}

// --- company-scoped forbidden phrase ---------------------------------------
{
  const r = checkEditorialBans({
    content: content({ experiences: [featured({ bullets: ["Shipped a live product used by customers."] }) as any] }),
    rules: RULES,
  });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(ids(r), ["venture-non-commercial", "venture-non-commercial"]);
  assert.equal(r.issues[0].unit_path, "experiences[0].bullets[0]");
  assert.deepEqual(r.issues.map((i) => i.matched.toLowerCase()), ["product", "customers"]);
  console.log("  ✓ company-scoped phrases fail with unit path and matched text");
}

// --- scope really is scoped ------------------------------------------------
{
  const r = checkEditorialBans({
    content: content({ experiences: [featured({ company: "Other Co", bullets: ["Shipped a product to customers."], title: "Principal Consultant" }) as any] }),
    rules: RULES,
  });
  assert.equal(r.verdict, "pass", "a non-matching company is untouched by the venture rule");
  console.log("  ✓ rules scoped by company do not leak onto other employers");
}

// --- title equality --------------------------------------------------------
{
  const exp = featured({ title: "CTO", company: "Beta Front", summary: "Pre-launch build.", bullets: ["Designed the platform."] });
  const r = checkEditorialBans({ content: content({ experiences: [exp as any] }), rules: RULES });
  assert.deepEqual(ids(r), ["venture-title"]);
  assert.equal(r.issues[0].unit_path, "experiences[0].title");
  assert.equal(r.issues[0].matched, "CTO");
  const ok = checkEditorialBans({
    content: content({ experiences: [featured({ ...exp, title: "CTO (part-time, pre-launch build)" }) as any] }),
    rules: RULES,
  });
  assert.equal(ok.verdict, "pass");
  console.log("  ✓ title_must_equal fails a wrong title and passes the exact one");
}

// --- stem matching ---------------------------------------------------------
{
  const exp = featured({
    title: "CTO (part-time, pre-launch build)",
    company: "Beta Front",
    summary: "Incorporated the entity and registered an ABN.",
    bullets: ["Ran go-to-market waves."],
  });
  const r = checkEditorialBans({ content: content({ experiences: [exp as any] }), rules: RULES });
  assert.deepEqual(ids(r), ["venture-title", "venture-title", "venture-title"]);
  assert.equal(r.issues[0].matched, "Incorporated", "stem match catches inflections of a documented stem");
  console.log("  ✓ plain phrases are stem-tolerant at the end and word-anchored at the start");
}

// --- word boundary at the start --------------------------------------------
{
  const wordRules = parseEditorialBans(`
version: 1
rules:
  - id: strict
    scope: { field: summary }
    forbidden_phrases: ["product"]
    match: word
    severity: fail
`);
  assert.equal(checkEditorialBans({ content: content({ summary: "Reduced byproduct waste." }), rules: wordRules }).verdict, "pass");
  assert.equal(checkEditorialBans({ content: content({ summary: "Owned productisation." }), rules: wordRules }).verdict, "pass", "match: word does not stem");
  assert.equal(checkEditorialBans({ content: content({ summary: "Owned the product." }), rules: wordRules }).verdict, "fail");
  console.log("  ✓ match: word is strict at both ends; the start boundary always holds");
}

// --- field scopes ----------------------------------------------------------
{
  const r = checkEditorialBans({ content: content({ highlights: ["Built Beta Front, a broker platform."] }), rules: RULES });
  assert.deepEqual(ids(r), ["ventures-not-in-highlights"]);
  assert.equal(r.issues[0].unit_path, "highlights[0]");
  const notHighlight = checkEditorialBans({ content: content({ summary: "Beta Front is a part-time build." }), rules: RULES });
  assert.equal(notHighlight.verdict, "pass", "the highlights rule does not apply to the summary");
  console.log("  ✓ field scopes select only their own units");
}

// --- scope: any covers every rendered field --------------------------------
{
  const cases: Array<[string, Partial<ResumeContent>]> = [
    ["summary", { summary: "Founder and engineer." }],
    ["highlights[0]", { highlights: ["Founder of a broker platform."] }],
    ["skills[0].bullets[0]", { skills: [{ name: "Platform", bullets: ["Founder-level ownership."] }] }],
    ["credentials[0]", { credentials: ["Founder, some programme."] }],
    ["experiences[0].summary", { experiences: [featured({ summary: "Founder of the venture." }) as any] }],
  ];
  for (const [unitPath, over] of cases) {
    const r = checkEditorialBans({ content: content(over), rules: RULES });
    const hit = r.issues.find((i) => i.rule_id === "no-founder-anywhere");
    if (unitPath === "skills[0].bullets[0]") {
      // "Founder-level" is hyphenated, so \bfounder\b matches: still a fail.
      assert.ok(hit, `expected a founder hit in ${unitPath}`);
    } else {
      assert.ok(hit, `expected a founder hit in ${unitPath}`);
      assert.equal(hit!.unit_path, unitPath);
    }
  }
  console.log("  ✓ scope: any reaches summary, highlights, skills, credentials and experiences");
}

// --- regex rules -----------------------------------------------------------
{
  const regexRules = parseEditorialBans(`
version: 1
rules:
  - id: lender-not-delivered
    scope: { field: any }
    forbidden_regex: ["deliver(ed|ing)[^.]{0,60}(credit[- ]application|credit-support agent)"]
    severity: fail
`);
  const bad = checkEditorialBans({ content: content({ summary: "Delivered an automated credit-application pipeline." }), rules: regexRules });
  assert.equal(bad.verdict, "fail");
  assert.equal(bad.issues[0].rule_id, "lender-not-delivered");
  const ok = checkEditorialBans({ content: content({ summary: "Architected a credit-application pipeline under a signed statement of work." }), rules: regexRules });
  assert.equal(ok.verdict, "pass");
  console.log("  ✓ forbidden_regex fires on the banned claim and not on the sanctioned framing");
}

// --- warn severity ---------------------------------------------------------
{
  const r = checkEditorialBans({ content: content({ skills: [{ name: "Delivery", bullets: ["Cross-team synergy."] }] }), rules: RULES });
  assert.equal(r.verdict, "warn");
  assert.equal(r.stats.fail_count, 0);
  assert.equal(r.stats.warn_count, 1);
  console.log("  ✓ warn-severity rules warn rather than fail");
}

// --- resume scoping --------------------------------------------------------
{
  const scoped = parseEditorialBans(`
version: 1
rules:
  - id: no-developer-except-builder
    scope: { field: [headline, summary, highlights] }
    except_resumes: [builder]
    forbidden_phrases: ["developer"]
    match: word
    severity: fail
  - id: builder-only
    scope: { field: summary }
    resumes: [builder]
    forbidden_phrases: ["strategy"]
    severity: fail
`);

  const dev = content({ summary: "Hands-on developer and architect." });

  // except_resumes: fires everywhere but the excepted positioning.
  assert.equal(checkEditorialBans({ content: dev, rules: scoped, resumeId: "architect" }).verdict, "fail");
  assert.deepEqual(ids(checkEditorialBans({ content: dev, rules: scoped, resumeId: "architect" })), ["no-developer-except-builder"]);
  assert.equal(checkEditorialBans({ content: dev, rules: scoped, resumeId: "builder" }).verdict, "pass");

  // resumes: fires only on the listed positioning.
  const strat = content({ summary: "Owns AI strategy." });
  assert.equal(checkEditorialBans({ content: strat, rules: scoped, resumeId: "builder" }).verdict, "fail");
  assert.equal(checkEditorialBans({ content: strat, rules: scoped, resumeId: "architect" }).verdict, "pass");

  // Unknown resume id: `except_resumes` still applies, `resumes` does not, so
  // scoping can never silently widen a ban.
  assert.equal(checkEditorialBans({ content: dev, rules: scoped }).verdict, "fail");
  assert.equal(checkEditorialBans({ content: strat, rules: scoped }).verdict, "pass");

  // Applicable-rule count reflects the scoping, not the declared total.
  assert.equal(checkEditorialBans({ content: dev, rules: scoped, resumeId: "builder" }).stats.rules, 1);
  assert.equal(checkEditorialBans({ content: dev, rules: scoped, resumeId: "architect" }).stats.rules, 1);

  // content.resumeId is the fallback when the caller passes no id.
  assert.equal(checkEditorialBans({ content: { ...dev, resumeId: "builder" } as ResumeContent, rules: scoped }).verdict, "pass");

  console.log("  ✓ resumes / except_resumes scope rules to individual positionings");
}

// --- multi-field scope, including headline ---------------------------------
{
  const multi = parseEditorialBans(`
version: 1
rules:
  - id: no-developer
    scope: { field: [headline, summary, highlights] }
    forbidden_phrases: ["developer"]
    match: word
    severity: fail
`);
  assert.deepEqual(
    checkEditorialBans({ content: content({ headline: "Applied AI Developer" }), rules: multi }).issues.map((i) => i.unit_path),
    ["headline"],
  );
  assert.deepEqual(
    checkEditorialBans({ content: content({ highlights: ["Led a developer enablement programme."] }), rules: multi }).issues.map((i) => i.unit_path),
    ["highlights[0]"],
  );
  // Fields outside the listed scopes are untouched, and each unit reports once.
  assert.equal(checkEditorialBans({ content: content({ skills: [{ name: "Developer Tooling", bullets: ["x"] }] }), rules: multi }).verdict, "pass");
  assert.equal(
    checkEditorialBans({ content: content({ headline: "Developer", summary: "A developer." }), rules: multi }).issues.length,
    2,
  );
  console.log("  ✓ a list of field scopes covers their union, headline included");
}

// --- schema validation -----------------------------------------------------
{
  assert.throws(() => parseEditorialBans("version: 2\nrules: []\n"), /unsupported version/);
  assert.throws(() => parseEditorialBans("version: 1\nrules:\n  - scope: { field: any }\n"), /has no id/);
  assert.throws(() => parseEditorialBans("version: 1\nrules:\n  - id: x\n    scope: {}\n"), /neither scope.company nor scope.field/);
  assert.throws(() => parseEditorialBans("version: 1\nrules:\n  - id: x\n    scope: { field: nope }\n"), /unknown scope.field/);
  assert.throws(() => parseEditorialBans("version: 1\nrules:\n  - id: x\n    scope: { field: any }\n    title_must_equal: Y\n"), /title_must_equal without scope.company/);
  assert.throws(() => parseEditorialBans("version: 1\nrules:\n  - id: x\n    scope: { field: [summary, nope] }\n"), /unknown scope.field 'nope'/);
  assert.throws(
    () => parseEditorialBans("version: 1\nrules:\n  - id: x\n    scope: { field: any }\n    resumes: [a]\n    except_resumes: [b]\n"),
    /sets both resumes and except_resumes/,
  );
  assert.throws(() => parseEditorialBans("version: 1\nrules:\n  - id: x\n    scope: { field: any }\n    resumes: a\n"), /non-list resumes/);
  assert.equal(parseEditorialBans("version: 1\n").length, 0);
  console.log("  ✓ malformed rule files throw rather than silently passing");
}

// --- the gate skips when a profile declares no bans ------------------------
{
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "editorial-bans-"));
  assert.equal(await loadEditorialBans(path.join(tmp, "editorial-bans.yaml")), null);
  await fs.rm(tmp, { recursive: true, force: true });
  console.log("  ✓ a missing bans file loads as null so the audit can skip");
}

// --- this profile's real bans file parses and is coherent -------------------
{
  const file = path.join(resolveProfileContext().profileDir, "editorial-bans.yaml");
  const rules = await loadEditorialBans(file);
  if (rules) {
    assert.ok(rules.length > 0, "the profile's bans file declares at least one rule");
    assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, "rule ids are unique");
    // Rules must be inert against empty content: no rule may fire on nothing.
    const empty = checkEditorialBans({ content: content({ highlights: [], skills: [], summary: "" }), rules });
    assert.equal(empty.verdict, "pass", `rules fired on empty content: ${JSON.stringify(empty.issues)}`);
    console.log(`  ✓ profile bans file parses (${rules.length} rules) and is inert on empty content`);
  } else {
    console.log("  ✓ profile declares no bans file (gate skips)");
  }
}

console.log("editorial-bans tests passed");
