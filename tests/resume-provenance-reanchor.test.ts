/**
 * resume-provenance-reanchor.test.ts — citation support scoring + re-anchoring.
 *
 * Synthetic corpus, synthetic sidecar: no dependency on the real profile.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyseCitations,
  reanchor,
  supportScore,
  numberTokens,
  numberSupportedInUnit,
  numberFoundInLine,
  numberValue,
  distinctiveTokens,
  sourceWindows,
  companyOverlap,
  quoteIsStale,
  WEAK_SCORE,
} from "../tools/resume/resume-reanchor.ts";
import type { ResumeContent, ResumeSourceProvenance } from "../templates/resume/_interface.ts";

const CV = `# A Person

## Professional Summary

Runs the Microsoft workplace estate for regulated insurers and freight operators.

## Professional Experience

### 2020-01 – 2022-03 — Delivery Manager, Northwind Health

- Ran the claims-adjudication migration across 14 squads and 68 controls.
- Negotiated the vendor licensing renewal for the telemetry stack.
- The claims estate serves roughly 35,000 staff in four countries.

### 2016-05 – 2019-12 — Data Architect, Contoso Freight

- Consolidated 12.9TB of shipment telemetry into a single lakehouse.
- Rebuilt the customs-clearance integration on an event-driven backbone.
`;
const FILE = "state/profile/cv-source.md";
const sources = new Map<string, string>([[FILE, CV]]);
const lineOf = (needle: string): number => CV.split("\n").findIndex((l) => l.includes(needle)) + 1;

const CLAIMS_LINE = lineOf("claims-adjudication");
const TELEMETRY_LINE = lineOf("12.9TB");
const CUSTOMS_LINE = lineOf("customs-clearance");

// ---- primitives ----------------------------------------------------------
assert.deepEqual(numberTokens("68 controls, 12.9TB and $50M at 20%"), ["68", "12.9tb", "50m", "20%"]);
assert.ok(distinctiveTokens("Ran the claims-adjudication migration").words.includes("claim"));
assert.equal(supportScore("Consolidated 12.9TB of shipment telemetry", CV.split("\n")[TELEMETRY_LINE - 1]), 1);
assert.ok(supportScore("Consolidated 12.9TB of shipment telemetry", CV.split("\n")[CLAIMS_LINE - 1]) < WEAK_SCORE);
assert.ok(companyOverlap("Northwind Health", "2020-01 – 2022-03 — Delivery Manager, Northwind Health"));
assert.ok(!companyOverlap("Northwind Health", "Contoso Freight"));
assert.ok(sourceWindows(CV).some((w) => w.kind === "block"), "block windows exist");
console.log("  ✓ text primitives");

// ---- fixture -------------------------------------------------------------
const content = (): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  summary: "Delivery leader across claims adjudication and shipment telemetry.",
  highlights: ["Ran the claims-adjudication migration across 68 controls."],
  skills: [],
  credentials: [],
  experiences: [
    {
      title: "Delivery Manager",
      company: "Northwind Health",
      start: "2020-01",
      end: "2022-03",
      placement: "feature",
      summary: "Owned the claims-adjudication migration.",
      bullets: [
        "Ran the claims-adjudication migration across 14 squads and 68 controls.",
        "Negotiated the vendor licensing renewal for the telemetry stack.",
      ],
    },
    {
      title: "Data Architect",
      company: "Contoso Freight",
      start: "2016-05",
      end: "2019-12",
      placement: "feature",
      bullets: ["Consolidated 12.9TB of shipment telemetry into a single lakehouse."],
    },
  ],
  resumeId: "test",
}) as ResumeContent;

const KEY_A = "Delivery Manager|Northwind Health|2020-01|2022-03";
const KEY_B = "Data Architect|Contoso Freight|2016-05|2019-12";

const provenance = (): ResumeSourceProvenance => ({
  evidence: {
    summary: [{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE], quote: "claims-adjudication migration" }],
    highlights: [[{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE], quote: "68 controls" }]],
    skills: {},
    experiences: {
      [KEY_A]: {
        summary: [{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE], quote: "claims-adjudication migration" }],
        bullets: [
          // Correct citation — must be left alone.
          [{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE], quote: "claims-adjudication migration, 68 controls" }],
          // Shifted citation: points at the wrong line inside the corpus.
          [{ file: FILE, lines: [CUSTOMS_LINE, CUSTOMS_LINE], quote: "vendor licensing renewal" }],
        ],
      },
      [KEY_B]: {
        bullets: [[{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE], quote: "12.9TB of shipment telemetry" }]],
      },
    },
  },
});

// ---- weak citation + number_unsupported ----------------------------------
const report = analyseCitations({ content: content(), provenance: provenance(), sources });
const weakUnits = report.weak.map((w) => w.unit);
assert.ok(weakUnits.includes(`experiences['${KEY_A}'].bullets[1]`), "shifted bullet is weak");
assert.ok(weakUnits.includes(`experiences['${KEY_B}'].bullets[0]`), "wrong-role citation is weak");
assert.ok(!weakUnits.includes(`experiences['${KEY_A}'].bullets[0]`), "correct citation is not weak");
console.log("  ✓ weak citations detected");

const numbers = report.numberUnsupported.map((n) => n.unit);
assert.ok(numbers.includes(`experiences['${KEY_B}'].bullets[0]`), "12.9TB missing from the cited line");
assert.deepEqual(
  report.numberUnsupported.find((n) => n.unit === `experiences['${KEY_B}'].bullets[0]`)!.numbers,
  ["12.9tb"],
);
assert.ok(!numbers.includes("highlights[0]"), "68 is present in the highlight's cited line");
console.log("  ✓ number_unsupported reported for an absent metric");

// ---- reanchor moves the shifted citation ---------------------------------
const prov = provenance();
const moved = reanchor({ content: content(), provenance: prov, sources, apply: true });
const move = moved.moves.find((m) => m.unit === `experiences['${KEY_A}'].bullets[1]`);
assert.ok(move, "the shifted bullet was re-anchored");
assert.equal(move!.to[0], lineOf("vendor licensing"), "re-anchored onto the vendor-licensing line");
assert.ok(move!.newScore >= move!.oldScore + 0.2);
assert.ok(!moved.moves.some((m) => m.unit === `experiences['${KEY_A}'].bullets[0]`), "correct citation untouched");
assert.deepEqual(
  prov.evidence.experiences[KEY_A].bullets![0][0].lines,
  [CLAIMS_LINE, CLAIMS_LINE],
  "correct citation's line range is unchanged",
);
assert.deepEqual(prov.evidence.experiences[KEY_A].bullets![1][0].lines, [lineOf("vendor licensing"), lineOf("vendor licensing")]);
console.log("  ✓ reanchor moves a shifted citation and leaves a correct one alone");

// Block restriction: the Contoso bullet cited a Northwind line, so it can only
// be re-anchored inside the Contoso block.
const contosoMove = moved.moves.find((m) => m.unit === `experiences['${KEY_B}'].bullets[0]`);
assert.ok(contosoMove, "wrong-role citation re-anchored");
assert.equal(contosoMove!.to[0] <= TELEMETRY_LINE && contosoMove!.to[1] >= TELEMETRY_LINE, true, "landed on the Contoso telemetry line");
console.log("  ✓ experience units re-anchor only inside their own block");

// ---- dry run does not write ----------------------------------------------
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reanchor-"));
const sidecarPath = path.join(dir, "X.provenance.json");
const before = `${JSON.stringify(provenance(), null, 2)}\n`;
await fs.writeFile(sidecarPath, before);
const dry = reanchor({ content: content(), provenance: JSON.parse(before) as ResumeSourceProvenance, sources, apply: true });
assert.ok(dry.moves.length > 0, "dry run still computes moves");
assert.equal(await fs.readFile(sidecarPath, "utf8"), before, "dry run leaves the sidecar byte-identical");
await fs.rm(dir, { recursive: true, force: true });
console.log("  ✓ dry run does not write the sidecar");

// ---- number widening ------------------------------------------------------
// Numbers stated in the corpus but OUTSIDE the unit's cited ranges are widened
// onto the line that carries them; numbers the corpus does not carry stay a fail.

const SUMMARY_LINE = lineOf("Runs the Microsoft workplace estate");
const STAFF_LINE = lineOf("35,000 staff");

const widenContent = (): ResumeContent => ({
  frontmatter: { name: "A Person", email: "a@example.com", phone: "0" },
  summary: "Microsoft 365 workplace estate lead for insurers.",
  highlights: [],
  skills: [],
  credentials: [],
  experiences: [
    {
      title: "Delivery Manager",
      company: "Northwind Health",
      start: "2020-01",
      end: "2022-03",
      placement: "feature",
      summary: "Ran the claims-adjudication programme.",
      bullets: [
        // 35K is stated in the Northwind block, just not on the cited line.
        "Ran claims adjudication for about 35K staff.",
        // 12.9TB exists only inside the Contoso block — off limits for a Northwind bullet.
        "Ran claims adjudication over 12.9TB of telemetry.",
        // 42% is nowhere in the corpus at all.
        "Ran claims adjudication and cut handling time by 42%.",
      ],
    },
  ],
  resumeId: "test",
}) as ResumeContent;

const widenProvenance = (): ResumeSourceProvenance => ({
  evidence: {
    // The cited summary line says "Microsoft" but not "365".
    summary: [{ file: FILE, lines: [SUMMARY_LINE, SUMMARY_LINE] }],
    highlights: [],
    skills: {},
    experiences: {
      [KEY_A]: {
        bullets: [
          [{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE] }],
          [{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE] }],
          [{ file: FILE, lines: [CLAIMS_LINE, CLAIMS_LINE] }],
        ],
      },
    },
  },
});

// ---- product-name guard --------------------------------------------------
assert.ok(
  numberSupportedInUnit("365", "Microsoft 365 workplace estate lead.", "Runs the Microsoft workplace estate."),
  "a version token glued to a product name the cited text carries is supported",
);
assert.ok(
  !numberSupportedInUnit("365", "365 tenants migrated.", "Runs the Microsoft workplace estate."),
  "a bare number with no product name in front of it is not excused",
);
assert.ok(
  !numberSupportedInUnit("50m", "Migrated Acme 50M records.", "Acme migration leadership."),
  "a magnitude is never excused by an adjacent product name",
);
assert.ok(
  numberSupportedInUnit("3.0", "MCTS: SharePoint Services 3.0 (Development).", "Microsoft Certified: SharePoint Services - Development."),
  "SharePoint Services 3.0 is supported by a line naming the product",
);
const guarded = analyseCitations({ content: widenContent(), provenance: widenProvenance(), sources });
assert.ok(!guarded.numberUnsupported.some((n) => n.unit === "summary"), "Microsoft 365 is not a number_unsupported");
console.log("  \u2713 product-name guard excuses version tokens, never metrics");

// ---- value-aware corpus matching -----------------------------------------
assert.equal(numberValue("20k"), 20000);
assert.equal(numberValue("6.3b"), 6.3e9);
assert.equal(numberValue("12.9tb"), null, "a unit suffix is not a magnitude");
assert.ok(numberFoundInLine("35k", "serves roughly 35,000 staff in four countries"), "35K matches 35,000");
assert.ok(numberFoundInLine("2m", "project to $2.x million / 10 people team"), "$2M matches $2.x million");
assert.ok(!numberFoundInLine("50m", "three-tier escalation ($25 warning -> $50 hard stop)"), "$50M does not match $50");
assert.ok(numberFoundInLine("2", "a team of 4 engineers and 2 QA"), "a bare number before a two-letter word still matches");
console.log("  \u2713 corpus number matching is value-aware and magnitude-strict");

// ---- surface-form normalisation ------------------------------------------
// Both sides of every comparison run through one normaliser, so a composition
// and the corpus line it cites may differ in currency prefix, trailing "+",
// thousands separator, unit spacing or spelled-out magnitude.
const SURFACE_PAIRS: Array<[string, string, string]> = [
  ["reporting to the COO of an A$6.3B+ lender", "A$6.3B+ Australian non-bank lender", "A$6.3B+ lender vs A$6.3B+"],
  ["Consolidated 12.9TB of telemetry", "consolidated 12.9 TB of shipment telemetry", "12.9TB vs 12.9 TB"],
  ["Migrated 9.50TB of mailboxes", "a 9.50 TB mailbox estate", "9.50TB vs 9.50 TB"],
  ["Served 150K on the platform", "reached 150K users", "150K vs 150K users"],
  ["Ran a $50M programme", "a programme worth approximately $50M", "$50M vs approximately $50M"],
  ["an A$6.3B+ lender", "worth A$6.3 billion today", "A$6.3B+ vs 6.3 billion"],
  ["serves 35K staff", "serves roughly 35,000 staff", "35K vs 35,000"],
  ["USD 20K of savings", "banked $20,000 of savings", "USD 20K vs $20,000"],
];
for (const [unit, line, label] of SURFACE_PAIRS) {
  const tokens = numberTokens(unit);
  assert.ok(tokens.length, `${label}: the unit carries a number`);
  for (const token of tokens) {
    assert.ok(numberSupportedInUnit(token, unit, line), `${label}: ${token} is supported by the cited line`);
    assert.ok(numberFoundInLine(token, line), `${label}: ${token} is found in the corpus line`);
  }
}
assert.deepEqual(numberTokens("A$6.3B+ lender, 12.9 TB, 150K users and 2.x million records"), ["6.3b", "12.9tb", "150k", "2m"]);

// Magnitude-strictness survives the widened normalisation.
assert.ok(!numberFoundInLine("20k", "a team of 20 engineers"), "20k does not match a bare 20");
assert.ok(!numberSupportedInUnit("20k", "20K users onboarded", "20 users onboarded"), "20K is not supported by 20");
assert.ok(!numberFoundInLine("12.9tb", "12.9 per cent of the estate"), "a unit claim is not carried by a bare number");
assert.ok(!numberFoundInLine("6.3b", "6.3 million in annualised run cost"), "billions are not millions");
// A short word after a number is not a unit: "4 in Manila" must stay a bare 4.
assert.deepEqual(numberTokens("a core team of 4 in Manila over 24 hr shifts"), ["4", "24"]);
console.log("  \u2713 surface forms normalise identically on both sides");

// ---- widening, block restriction, absent-from-corpus ----------------------
const widenProv = widenProvenance();
const widened = reanchor({ content: widenContent(), provenance: widenProv, sources, apply: true });
const staffWidening = widened.widenings.find((w) => w.token === "35k");
assert.ok(staffWidening, "35K was widened onto the line that states it");
assert.deepEqual([staffWidening!.line, staffWidening!.file], [STAFF_LINE, FILE]);
assert.match(staffWidening!.note, /^number-widened \d{4}-\d{2}-\d{2}: 35k$/);
const staffRefs = widenProv.evidence.experiences[KEY_A].bullets![0];
assert.equal(staffRefs.length, 2, "the widening was appended, not substituted");
assert.deepEqual(staffRefs[0].lines, [CLAIMS_LINE, CLAIMS_LINE], "the original citation is untouched");
assert.deepEqual(staffRefs[1].lines, [STAFF_LINE, STAFF_LINE]);
console.log("  \u2713 a number stated elsewhere in the block is widened onto its line");

assert.ok(
  !widened.widenings.some((w) => w.token === "12.9tb"),
  "a number that only exists in another employer's block is never widened in",
);
const telemetryAbsent = widened.numberAbsent.find((a) => a.token === "12.9tb");
assert.ok(telemetryAbsent, "the out-of-block number is reported absent");
assert.equal(telemetryAbsent!.unit, `experiences['${KEY_A}'].bullets[1]`);
assert.equal(widenProv.evidence.experiences[KEY_A].bullets![1].length, 1, "no citation appended for it");
console.log("  \u2713 widening is restricted to the unit's own experience block");

// A second pass must be a no-op: the widened ref is neither re-anchored away
// (it scores badly against the whole unit by construction) nor duplicated.
const second = reanchor({ content: widenContent(), provenance: widenProv, sources, apply: true });
assert.ok(!second.moves.some((m) => m.unit === `experiences['${KEY_A}'].bullets[0]`), "a widened ref is never re-anchored");
assert.equal(widenProv.evidence.experiences[KEY_A].bullets![0].length, 2, "a second pass appends nothing");
assert.deepEqual(widenProv.evidence.experiences[KEY_A].bullets![0][1].lines, [STAFF_LINE, STAFF_LINE]);
console.log("  \u2713 widening is idempotent and survives re-anchoring");

const pctAbsent = widened.numberAbsent.find((a) => a.token === "42%");
assert.ok(pctAbsent, "a number absent from the whole corpus is surfaced, not hidden");
assert.equal(pctAbsent!.unit, `experiences['${KEY_A}'].bullets[2]`);
assert.match(pctAbsent!.text, /42%/);
console.log("  \u2713 number_absent_from_corpus survives widening as a fail");


// ---- letter-glued digits are not numbers ---------------------------------
// Regression (2026-09-11): "PRINCE2" emitted a "2" token, so every unit naming
// a certification or a product with digits glued on became a bogus
// number_unsupported fail.
assert.deepEqual(numberTokens("Working knowledge of PRINCE2 delivery governance"), []);
assert.deepEqual(numberTokens("ISO27001, M365, O365, S3 and Next.js14"), []);
assert.deepEqual(numberTokens("Log4j and SHA256 hardening"), []);
// A digit separated by a space IS a number token. "ISO 42001" and
// "Microsoft 365" stay numeric and are excused, visibly, by the product-name
// guard when the cited text names the product.
assert.deepEqual(numberTokens("Aligned to ISO 42001 controls"), ["42001"]);
assert.ok(
  numberSupportedInUnit("42001", "Aligned the control set to ISO 42001.", "Mapped the programme to ISO 42001 requirements."),
  "ISO 42001 is excused by the product-name guard when the cited text carries it",
);
assert.deepEqual(numberTokens("68 controls and A$ 50 million"), ["68", "50m"], "real metrics are untouched");
console.log("  \u2713 digits glued to a letter are part of a word, never a number claim");

// ---- a stale widened ref is re-pointed, not skipped -----------------------
// The corpus moves under a widened ref (an edit above shifts line numbers). A
// ref whose line no longer carries its token must be re-searched and updated
// in place, otherwise its quote and its line disagree and the figure is
// unproven while the gate stays silent.
const staleProv = widenProvenance();
staleProv.evidence.experiences[KEY_A].bullets![0].push({
  file: FILE,
  lines: [CUSTOMS_LINE, CUSTOMS_LINE],
  quote: "The claims estate serves roughly 35,000 staff in four countries.",
  note: "number-widened 2026-01-01: 35k",
});
const restale = reanchor({ content: widenContent(), provenance: staleProv, sources, apply: true });
const repoint = restale.widenings.find((w) => w.token === "35k");
assert.ok(repoint, "a stale widened ref is re-widened, not skipped");
assert.equal(repoint!.line, STAFF_LINE);
const staleRefs = staleProv.evidence.experiences[KEY_A].bullets![0];
assert.equal(staleRefs.length, 2, "the stale ref was updated in place, not duplicated");
assert.deepEqual(staleRefs[1].lines, [STAFF_LINE, STAFF_LINE], "re-pointed at the line carrying the number");
assert.match(staleRefs[1].quote!, /35,000 staff/);
assert.match(staleRefs[1].note!, /^number-widened \d{4}-\d{2}-\d{2}: 35k$/);
// And a ref that still supports its token is left completely alone.
const fresh = reanchor({ content: widenContent(), provenance: staleProv, sources, apply: true });
assert.ok(!fresh.widenings.some((w) => w.token === "35k"), "a still-valid widened ref is untouched");
assert.equal(staleProv.evidence.experiences[KEY_A].bullets![0].length, 2);
console.log("  \u2713 a stale number-widened ref is re-anchored in place");

// ---- a stale cached quote is refreshed, not re-anchored -------------------
// The corpus line is REWRITTEN under a citation that still points at the right
// place: the cached quote is gone, but the live lines still carry the claim.
// The quote must be refreshed in place — moving the citation would be wrong,
// and keeping the dead quote scores the unit against text that no longer
// exists, which pins the provenance gate at warn forever.
assert.ok(quoteIsStale("a squad model nobody uses now", CV.split("\n")[CLAIMS_LINE - 1]), "absent text is a stale quote");
assert.ok(!quoteIsStale("claims-adjudication migration", CV.split("\n")[CLAIMS_LINE - 1]), "live text is not stale");
assert.ok(!quoteIsStale("Claims adjudication  MIGRATION!", CV.split("\n")[CLAIMS_LINE - 1]), "staleness ignores case and punctuation");
assert.ok(!quoteIsStale(undefined, "anything"), "a ref with no quote is never stale");

const staleQuoteProv = provenance();
const refreshedRef = staleQuoteProv.evidence.experiences[KEY_A].bullets![0][0];
refreshedRef.lines = [CLAIMS_LINE, CLAIMS_LINE];
refreshedRef.quote = "Ran the legacy adjudication rewrite across 9 squads.";

const staleQuoteReport = analyseCitations({ content: content(), provenance: staleQuoteProv, sources });
const staleScored = staleQuoteReport.units
  .find((u) => u.unit === `experiences['${KEY_A}'].bullets[0]`)!
  .scored[0];
assert.ok(staleScored.staleQuote, "the check pass flags the stale quote");
assert.ok(!staleScored.weak, "a stale quote is scored against the live text, not the dead quote");
assert.ok(
  !staleQuoteReport.weak.some((w) => w.unit === `experiences['${KEY_A}'].bullets[0]`),
  "the still-supported citation is not reported as a weak_citation",
);

const refreshed = reanchor({ content: content(), provenance: staleQuoteProv, sources, apply: true });
const refresh = refreshed.refreshes.find((r) => r.unit === `experiences['${KEY_A}'].bullets[0]`);
assert.ok(refresh, "the stale quote was refreshed");
assert.deepEqual(refresh!.lines, [CLAIMS_LINE, CLAIMS_LINE], "refreshing never moves the citation");
assert.match(refresh!.newQuote, /claims-adjudication migration across 14 squads and 68 controls/);
assert.deepEqual(refreshedRef.lines, [CLAIMS_LINE, CLAIMS_LINE], "line range untouched on disk shape");
assert.equal(refreshedRef.quote, CV.split("\n")[CLAIMS_LINE - 1].replace(/\s+/g, " ").trim());
assert.match(refreshedRef.note!, /quote refreshed \d{4}-\d{2}-\d{2}/);
assert.ok(
  !refreshed.moves.some((m) => m.unit === `experiences['${KEY_A}'].bullets[0]`),
  "a refreshed citation is never also moved",
);
// Idempotent: the refreshed quote is live text, so a second pass is a no-op.
const secondRefresh = reanchor({ content: content(), provenance: staleQuoteProv, sources, apply: true });
assert.ok(
  !secondRefresh.refreshes.some((r) => r.unit === `experiences['${KEY_A}'].bullets[0]`),
  "a live quote is not refreshed again",
);
console.log("  \u2713 a stale quote over supporting live text is refreshed in place");

// A stale quote whose live lines do NOT support the unit is a genuinely
// misplaced citation and still falls through to the re-anchor search.
const staleWrongProv = provenance();
const wrongRef = staleWrongProv.evidence.experiences[KEY_A].bullets![1][0];
wrongRef.lines = [CUSTOMS_LINE, CUSTOMS_LINE];
wrongRef.quote = "Negotiated the 2019 hosting renewal";
const rehomed = reanchor({ content: content(), provenance: staleWrongProv, sources, apply: true });
assert.ok(
  !rehomed.refreshes.some((r) => r.unit === `experiences['${KEY_A}'].bullets[1]`),
  "a stale quote over unsupporting text is not refreshed",
);
const rehomedMove = rehomed.moves.find((m) => m.unit === `experiences['${KEY_A}'].bullets[1]`);
assert.ok(rehomedMove, "it re-anchors instead");
assert.equal(rehomedMove!.to[0], lineOf("vendor licensing"));
assert.deepEqual(wrongRef.lines, [lineOf("vendor licensing"), lineOf("vendor licensing")]);
console.log("  \u2713 a stale quote over unsupporting text falls through to re-anchoring");

console.log("resume-provenance-reanchor: OK");
