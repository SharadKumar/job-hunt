#!/usr/bin/env tsx
/**
 * keyword-clouds.test.ts — the shared keyword-cloud layer.
 *
 * Three things matter here: the validator says no to a malformed cloud file or
 * a bad reference, resolution hands a positioning its clouds in weight order,
 * and the real migrated state/org/keyword-clouds.yaml holds its shape.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  CLOUD_KINDS,
  cloudAgeDays,
  cloudRefs,
  cloudsById,
  DEFAULT_KEYWORD_CLOUDS_PATH,
  loadKeywordClouds,
  normaliseCloudText,
  parseKeywordClouds,
  resolveCloudsForType,
  resolvedCloudTerms,
  resolveForbiddenClaims,
  validateKeywordClouds,
  validateTypeCloudRefs,
  type KeywordCloudsFile,
} from "../tools/keyword-clouds.ts";
import { loadResolvedResumes } from "../tools/resumes.ts";

const now = new Date("2026-09-11T00:00:00Z");
const fresh = "2026-09-01";
const ancient = "2026-01-01";

const ok = (): KeywordCloudsFile => ({
  version: 1,
  clouds: [
    {
      id: "alpha", kind: "capability", label: "Alpha", refreshed_at: fresh,
      terms: [
        { term: "agentic workflow engineering", tier: "corpus", category: "concept", evidence_patterns: ["supervised agent workflows"] },
        { term: "LLM-as-a-judge", tier: "confirm", category: "concept", why: "asked in most eval JDs" },
      ],
    },
    {
      id: "beta", kind: "tooling", label: "Beta", refreshed_at: fresh,
      terms: [{ term: "Claude Agent SDK", tier: "preppable", category: "tool" }],
    },
  ],
});

// --- validator: the happy path is quiet ------------------------------------
{
  const corpus = normaliseCloudText("We shipped supervised agent workflows across the platform.");
  const r = validateKeywordClouds(ok(), corpus, now);
  assert.deepEqual(r.errors, [], "a well-formed clouds file has no errors");
  assert.deepEqual(r.warnings, [], "and nothing to warn about when the corpus backs the corpus tier");
}

// --- validator: structural rules -------------------------------------------
{
  const bad: KeywordCloudsFile = {
    version: 1,
    clouds: [
      { id: "dup", kind: "capability", label: "A", refreshed_at: fresh, terms: [{ term: "shared term", tier: "corpus", evidence_patterns: ["a named Thing 42"] }] },
      { id: "dup", kind: "capability", label: "B", refreshed_at: fresh, terms: [] },
      // a term may live in exactly one cloud
      { id: "other", kind: "domain", label: "C", refreshed_at: fresh, terms: [{ term: "Shared Term", tier: "corpus", evidence_patterns: ["a named Thing 42"] }] },
      { id: "weird", kind: "nonsense" as any, label: "D", refreshed_at: "not-a-date", terms: [{ term: "x", tier: "invented" as any }] },
    ],
  };
  const r = validateKeywordClouds(bad, null, now);
  assert.ok(r.errors.some((e) => /duplicates cloud id 'dup'/.test(e)));
  assert.ok(r.errors.some((e) => /already belongs to cloud 'dup'/.test(e)), "one term, one cloud");
  assert.ok(r.errors.some((e) => /kind must be one of/.test(e)));
  assert.ok(r.errors.some((e) => /is not a valid date/.test(e)));
  assert.ok(r.errors.some((e) => /tier must be one of/.test(e)));
  assert.ok(r.warnings.some((w) => /cloud has no terms/.test(w)));
}

// --- validator: tier semantics survived the move ---------------------------
{
  const file: KeywordCloudsFile = {
    version: 1,
    clouds: [{
      id: "a", kind: "capability", label: "A", refreshed_at: ancient,
      terms: [
        { term: "ungrounded", tier: "corpus", evidence_patterns: ["a phrase the corpus lacks"] },
        { term: "vague", tier: "corpus", evidence_patterns: ["governance"] },
        { term: "asked", tier: "confirm" },
        { term: "blocked", tier: "forbidden" },
        { term: "typed", tier: "corpus", category: "sorcery" as any, evidence_patterns: ["a named Thing 42"] },
      ],
    }],
  };
  const r = validateKeywordClouds(file, normaliseCloudText("nothing relevant here"), now);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /is \d+ days old/.test(w)), "a stale cloud warns");
  assert.ok(r.warnings.some((w) => /'ungrounded'.*none of its evidence_patterns match/.test(w)));
  assert.ok(r.warnings.some((w) => /'vague' uses weak evidence pattern/.test(w)));
  assert.ok(r.warnings.some((w) => /'asked' is tier confirm but has no 'why'/.test(w)));
  assert.ok(r.warnings.some((w) => /'blocked' is tier forbidden but has no 'why'/.test(w)));
  assert.ok(r.warnings.some((w) => /unknown category 'sorcery'/.test(w)));
}

// --- reference validation ---------------------------------------------------
{
  const file = ok();
  const good = validateTypeCloudRefs("x", { clouds: [{ id: "alpha", weight: 5 }, { id: "beta", weight: 1 }] } as any, file);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.warnings, []);

  const bad = validateTypeCloudRefs("x", {
    clouds: [
      { id: "nope", weight: 3 },
      { id: "alpha", weight: 9 },
      { id: "alpha", weight: 2 },
      { id: "beta", weight: 2.5 as any },
      { id: "beta", weight: 1, must_have_min: 99 },
    ],
  } as any, file);
  assert.ok(bad.errors.some((e) => /unknown cloud 'nope'/.test(e)));
  assert.ok(bad.errors.some((e) => /weight must be an integer 1-5 \(got 9\)/.test(e)));
  assert.ok(bad.errors.some((e) => /references cloud 'alpha' twice/.test(e)));
  assert.ok(bad.errors.some((e) => /weight must be an integer 1-5 \(got 2.5\)/.test(e)));
  assert.ok(bad.warnings.some((w) => /must_have_min 99 exceeds/.test(w)));

  const none = validateTypeCloudRefs("x", {} as any, file);
  assert.ok(none.warnings.some((w) => /declares no clouds/.test(w)));
  // the deprecated flat block still counts as declared for one release
  assert.deepEqual(validateTypeCloudRefs("x", { domain_lexicon: { terms: [] } } as any, file).warnings, []);
}

// --- resolution -------------------------------------------------------------
{
  const file = ok();
  const lens = { clouds: [{ id: "beta", weight: 2 }, { id: "alpha", weight: 5, must_have_min: 1 }, { id: "ghost", weight: 4 }] } as any;
  const resolved = resolveCloudsForType(lens, file, now);
  assert.deepEqual(resolved.map((c) => c.id), ["alpha", "beta"], "heaviest first, unknown ids dropped");
  assert.equal(resolved[0].must_have_min, 1);
  assert.equal(resolved[0].kind, "capability");
  assert.equal(resolved[0].stale, false);
  assert.equal(resolvedCloudTerms(resolved).length, 3);
  assert.equal(resolvedCloudTerms(resolved)[0].cloud_id, "alpha");
  assert.equal(cloudRefs(lens).length, 3, "cloudRefs reports what the type asked for, not what resolved");
  assert.equal(cloudsById(file).get("beta")?.label, "Beta");
  assert.equal(cloudAgeDays({ refreshed_at: null }), null);
  assert.equal(cloudAgeDays({ refreshed_at: fresh }, now), 10);

  // The cloud is the authority on forbidden terms; the type need not mirror it.
  const withBlock: KeywordCloudsFile = {
    version: 1,
    clouds: [{ id: "alpha", kind: "capability", label: "Alpha", refreshed_at: fresh, terms: [{ term: "TOGAF-certified architect", tier: "forbidden", why: "never held" }] }],
  };
  const blocked = resolveForbiddenClaims({ forbidden_claims: ["something else"] } as any, resolveCloudsForType({ clouds: [{ id: "alpha", weight: 5 }] } as any, withBlock, now));
  assert.deepEqual(blocked.sort(), ["TOGAF-certified architect", "something else"]);
}

// --- parsing degrades safely ------------------------------------------------
{
  assert.deepEqual(parseKeywordClouds("").clouds, []);
  assert.deepEqual(parseKeywordClouds("clouds: not-a-list").clouds, []);
  assert.equal(parseKeywordClouds("version: 1\nclouds: []").version, 1);
}

// --- the real migrated file -------------------------------------------------
{
  const file = await loadKeywordClouds();
  assert.ok(file.clouds.length >= 15, `expected the migrated clouds, got ${file.clouds.length}`);
  for (const c of file.clouds) assert.ok(CLOUD_KINDS.includes(c.kind), `${c.id} has a known kind`);
  assert.ok(file.clouds.some((c) => c.kind === "capability"));
  assert.ok(file.clouds.some((c) => c.kind === "domain"));
  assert.ok(file.clouds.some((c) => c.kind === "tooling"));

  const structural = validateKeywordClouds(file, null, now);
  assert.deepEqual(structural.errors, [], "the migrated clouds file is structurally valid");

  // The migration must not have lost or duplicated a term.
  const seen = new Set<string>();
  let terms = 0;
  for (const c of file.clouds) for (const t of c.terms ?? []) {
    terms += 1;
    const k = normaliseCloudText(t.term);
    assert.ok(!seen.has(k), `term '${t.term}' appears in more than one cloud`);
    seen.add(k);
  }
  assert.ok(terms >= 130, `expected the migrated term corpus, got ${terms}`);

  // Every active positioning references clouds that exist, with legal weights,
  // and no positioning is left with nothing to write against.
  const resumes = await loadResolvedResumes({});
  const known = cloudsById(file);
  for (const { resume } of resumes) {
    const refs = cloudRefs(resume.market_lens);
    assert.ok(refs.length > 0, `${resume.id} references no keyword clouds`);
    assert.equal((resume.market_lens as any)?.domain_lexicon, undefined, `${resume.id} still carries the deprecated flat lexicon`);
    for (const ref of refs) {
      assert.ok(known.has(ref.id), `${resume.id} references unknown cloud '${ref.id}'`);
      assert.ok(Number.isInteger(ref.weight) && ref.weight >= 1 && ref.weight <= 5, `${resume.id}/${ref.id} weight out of range`);
    }
    const resolved = resolveCloudsForType(resume.market_lens, file, now);
    assert.ok(resolvedCloudTerms(resolved).length > 0, `${resume.id} resolves to no terms at all`);
    assert.deepEqual(
      resolved.map((c) => c.weight),
      [...resolved.map((c) => c.weight)].sort((a, b) => b - a),
      `${resume.id} clouds resolve heaviest first`,
    );
  }

  // The file on disk is the one the loader read.
  const onDisk = parseKeywordClouds(await fs.readFile(DEFAULT_KEYWORD_CLOUDS_PATH, "utf8"));
  assert.equal(onDisk.clouds.length, file.clouds.length);
}

console.log("keyword-clouds tests passed");
