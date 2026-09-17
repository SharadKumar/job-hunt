/**
 * fit-ops.ts — deterministic, lossless, path-addressed edits to a composition
 * for page fitting. NO text is ever written, rewritten or trimmed here: every
 * op moves a whole authored unit between the rendered content and
 * `ResumeContent.bench`, carrying its provenance references with it.
 *
 * Why a bench instead of deleting: the model spent real turns composing and
 * evidencing each bullet. Dropping one to save a line and re-composing it two
 * passes later when the page under-fills is the expensive loop this replaces.
 *
 * Guarantees
 * ----------
 * - **Lossless**: drop → restore round-trips text, provenance refs, and slot.
 * - **Never silent**: `drop_mention` records the role in
 *   `dropped_experiences` with a reason (and `restore_mention` removes it), so
 *   a role that leaves the page is visible to the preservation gate and to the
 *   reader of the quality report.
 * - **Idempotent**: an op that has already been applied is skipped, not
 *   re-applied. Ops are matched on TEXT (recorded at apply time), not on a
 *   bare index, precisely because indices shift.
 * - **Ordering preserved**: experiences keep their array slots. Bench buckets
 *   are keyed by the OWNER'S IDENTITY (`title|company|start|end` for
 *   experiences, the block name for skills), never by array index, so
 *   splicing an experience — here or by hand between runs — can never hand a
 *   role's benched bullets to its neighbour. Legacy `experiences[i]` /
 *   `skills[i]` keys are accepted on read and rewritten to identity on the
 *   next write.
 * - **Pure**: the input content/provenance are deep-cloned, never mutated.
 *
 * `priority` convention (matches `_interface.ts`): LOWER = keep sooner. The
 * lowest-priority (highest number) bench entry is dropped first; the
 * highest-priority (lowest number) is restored first.
 */

import type {
  ResumeContent,
  ResumeSourceProvenance,
  ExperienceItem,
  ExperienceFeatured,
  ExperienceMentioned,
  BenchBullet,
  BenchMention,
  BenchSkillItem,
  SourceReference,
} from "../../../templates/resume/_interface.ts";

export type FitOp =
  | { op: "drop_bullet"; path: string; text?: string }
  | { op: "restore_bullet"; path: string; text?: string }
  | { op: "drop_mention"; path: string; text?: string }
  | { op: "restore_mention"; path?: string; text?: string }
  | { op: "demote"; path: string; text?: string }
  | { op: "add_skill_item"; path: string; text?: string }
  | { op: "drop_skill_item"; path: string; text?: string };

export type AppliedOp = FitOp & { text: string; note?: string; original_path?: string };
export type SkippedOp = { op: FitOp; reason: string };

export type FitOpsResult = {
  content: ResumeContent;
  provenance: ResumeSourceProvenance | null;
  applied: AppliedOp[];
  skipped: SkippedOp[];
};

// ---------------------------------------------------------------- paths ----

type ExperiencePath = { kind: "experience"; index: number };
type BulletPath = { kind: "bullet"; index: number; bullet: number };
type SkillPath = { kind: "skill"; index: number };
type SkillItemPath = { kind: "skill_item"; index: number; item: number };

export function parseUnitPath(p: string): ExperiencePath | BulletPath | SkillPath | SkillItemPath | null {
  let m = p.match(/^experiences\[(\d+)\]\.bullets\[(\d+)\]$/);
  if (m) return { kind: "bullet", index: Number(m[1]), bullet: Number(m[2]) };
  m = p.match(/^experiences\[(\d+)\]$/);
  if (m) return { kind: "experience", index: Number(m[1]) };
  m = p.match(/^skills\[(\d+)\]\.bullets\[(\d+)\]$/);
  if (m) return { kind: "skill_item", index: Number(m[1]), item: Number(m[2]) };
  m = p.match(/^skills\[(\d+)\]$/);
  if (m) return { kind: "skill", index: Number(m[1]) };
  return null;
}

/** The composition index addressed by a path, whatever depth it names. */
function ownerIndexOf(p: string): { kind: "experience" | "skill"; index: number } | null {
  const parsed = parseUnitPath(p);
  if (!parsed) return null;
  const kind = parsed.kind === "experience" || parsed.kind === "bullet" ? "experience" : "skill";
  return { kind, index: parsed.index };
}

// ----------------------------------------------------------- provenance ----

/** Candidate keys under `evidence.experiences`, mirroring resume-provenance.ts. */
function experienceKeys(xp: ExperienceItem): string[] {
  return [
    `${xp.title}|${xp.company}|${xp.start}|${xp.end}`,
    `${xp.title} @ ${xp.company} (${xp.start}–${xp.end})`,
    `${xp.title}, ${xp.company}`,
    xp.title,
  ];
}

function findEvidenceKey(prov: ResumeSourceProvenance | null, xp: ExperienceItem): string | null {
  if (!prov?.evidence?.experiences) return null;
  return experienceKeys(xp).find((k) => prov.evidence.experiences[k]) ?? null;
}

function evidenceFor(prov: ResumeSourceProvenance | null, xp: ExperienceItem) {
  const key = findEvidenceKey(prov, xp);
  return key ? { key, entry: prov!.evidence.experiences[key] } : null;
}

// ---------------------------------------------------------------- bench ----

function bench(content: ResumeContent) {
  content.bench = content.bench ?? {};
  content.bench.bullets = content.bench.bullets ?? {};
  content.bench.mentions = content.bench.mentions ?? [];
  content.bench.skill_items = content.bench.skill_items ?? {};
  return content.bench as Required<ResumeContent>["bench"] & {
    bullets: Record<string, BenchBullet[]>;
    mentions: BenchMention[];
    skill_items: Record<string, BenchSkillItem[]>;
  };
}

/**
 * The bench key for an experience's bullets: its identity, not its slot. Same
 * shape as `dropped_experiences[].id` and the provenance sidecar's primary key,
 * so all three agree on what "this role" means.
 */
export function benchKeyForExperience(xp: ExperienceItem): string {
  return `${xp.title}|${xp.company}|${xp.start}|${xp.end}`;
}

/** The bench key for a skill block's items: its name. */
export function benchKeyForSkill(block: { name: string }): string {
  return block.name;
}

/** Legacy `benched:<title>|<company>` parking key, written before identity keys. */
const LEGACY_PARKED = /^benched:(.*)\|([^|]*)$/;

/** Bench bullets for experience `i`, accepting a legacy `experiences[i]` key. */
export function benchBulletsFor(content: ResumeContent, index: number): BenchBullet[] {
  const xp = content.experiences?.[index];
  if (!xp) return [];
  const buckets = content.bench?.bullets ?? {};
  return buckets[benchKeyForExperience(xp)] ?? buckets[`experiences[${index}]`] ?? [];
}

/** Bench skill items for block `i`, accepting a legacy `skills[i]` key. */
export function benchSkillItemsFor(content: ResumeContent, index: number): BenchSkillItem[] {
  const block = content.skills?.[index];
  if (!block) return [];
  const buckets = content.bench?.skill_items ?? {};
  return buckets[benchKeyForSkill(block)] ?? buckets[`skills[${index}]`] ?? [];
}

function remapKeys<T>(record: Record<string, T[]>, resolve: (key: string) => string | null): Record<string, T[]> {
  const next: Record<string, T[]> = {};
  for (const [key, entries] of Object.entries(record)) {
    const to = resolve(key) ?? key;
    next[to] = next[to] ? [...next[to], ...entries] : entries;
  }
  return next;
}

/**
 * Rewrite index-addressed bench keys to owner identity, once, before any op
 * runs. An `experiences[i]` key means "whatever is at slot i right now" — which
 * is exactly the assumption that breaks when a role is deleted above it — so we
 * resolve it against the live composition and never trust it again.
 */
export function normalizeBenchKeys(content: ResumeContent): void {
  const b = content.bench;
  if (!b) return;
  if (b.bullets) {
    b.bullets = remapKeys(b.bullets, (key) => {
      const parsed = parseUnitPath(key);
      if (parsed?.kind === "experience") {
        const xp = content.experiences?.[parsed.index];
        return xp ? benchKeyForExperience(xp) : null;
      }
      const parked = key.match(LEGACY_PARKED);
      if (!parked) return null;
      const mention = (b.mentions ?? []).find((m) => m.experience.title === parked[1] && m.experience.company === parked[2]);
      return mention ? benchKeyForExperience(mention.experience) : null;
    });
  }
  if (b.skill_items) {
    b.skill_items = remapKeys(b.skill_items, (key) => {
      const parsed = parseUnitPath(key);
      if (parsed?.kind !== "skill") return null;
      const block = content.skills?.[parsed.index];
      return block ? benchKeyForSkill(block) : null;
    });
  }
}

// ------------------------------------------------------- drop audit trail ----

/**
 * Reason stamped on the `dropped_experiences` entry a `drop_mention` leaves
 * behind. A role that leaves the rendered document must never leave silently:
 * `preserve-core` fails any cv-source experience that is neither rendered nor
 * listed in `dropped_experiences` WITH a reason, and the quality report shows
 * the user the editorial trail. The bench keeps the material; this keeps the
 * receipt.
 */
export const AUTO_FIT_DROP_REASON = "auto-fit: page budget";

/** The writer's id shape (`title|company|start|end`), so both producers agree. */
function droppedId(xp: ExperienceItem): string {
  return benchKeyForExperience(xp);
}

function recordDrop(content: ResumeContent, xp: ExperienceItem): void {
  const id = droppedId(xp);
  content.dropped_experiences = content.dropped_experiences ?? [];
  if (content.dropped_experiences.some((d) => d.id === id)) return;
  content.dropped_experiences.push({ id, reason: AUTO_FIT_DROP_REASON });
}

/** Restoring a role rescinds its drop: the receipt is removed, not amended. */
function forgetDrop(content: ResumeContent, xp: ExperienceItem): void {
  if (!content.dropped_experiences) return;
  const id = droppedId(xp);
  content.dropped_experiences = content.dropped_experiences.filter((d) => d.id !== id);
}

function sortByPriorityAsc<T extends { priority?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
}

// ------------------------------------------------------------------ ops ----

function dropBullet(content: ResumeContent, prov: ResumeSourceProvenance | null, op: Extract<FitOp, { op: "drop_bullet" }>): { applied?: AppliedOp; skipped?: string } {
  const parsed = parseUnitPath(op.path);
  if (!parsed || parsed.kind !== "bullet") return { skipped: `not a bullet path: ${op.path}` };
  const xp = content.experiences?.[parsed.index];
  if (!xp) return { skipped: `no experiences[${parsed.index}]` };
  if (xp.placement !== "feature") return { skipped: `experiences[${parsed.index}] is a mention, not a featured block` };

  const key = benchKeyForExperience(xp);
  const benched = bench(content).bullets[key] ?? [];
  // Idempotency: an op naming its text that is already on the bench is a no-op.
  if (op.text && benched.some((e) => e.text === op.text)) return { skipped: `already benched: ${op.text.slice(0, 40)}` };

  const at = op.text ? xp.bullets.indexOf(op.text) : parsed.bullet;
  if (at < 0 || at >= xp.bullets.length) return { skipped: `bullet not present at ${op.path}` };
  const text = xp.bullets[at];
  xp.bullets.splice(at, 1);

  const ev = evidenceFor(prov, xp);
  let refs: SourceReference[] | undefined;
  if (ev?.entry?.bullets) refs = ev.entry.bullets.splice(at, 1)[0];

  bench(content).bullets[key] = [...benched, { text, priority: benched.length + 1, provenance: refs, kind: "bullet", from: op.path, index: at }];
  return { applied: { ...op, text } };
}

function restoreBullet(content: ResumeContent, prov: ResumeSourceProvenance | null, op: Extract<FitOp, { op: "restore_bullet" }>): { applied?: AppliedOp; skipped?: string } {
  const owner = ownerIndexOf(op.path);
  if (!owner || owner.kind !== "experience") return { skipped: `not an experience path: ${op.path}` };
  const xp = content.experiences?.[owner.index];
  if (!xp) return { skipped: `no experiences[${owner.index}]` };
  if (xp.placement !== "feature") return { skipped: `experiences[${owner.index}] is a mention; promote it first` };

  const key = benchKeyForExperience(xp);
  const entries = (content.bench?.bullets?.[key] ?? []).filter((e) => (e.kind ?? "bullet") === "bullet");
  if (!entries.length) return { skipped: `bench empty for ${key}` };
  if (op.text && xp.bullets.includes(op.text)) return { skipped: `already rendered: ${op.text.slice(0, 40)}` };

  const entry = op.text ? entries.find((e) => e.text === op.text) : sortByPriorityAsc(entries)[0];
  if (!entry) return { skipped: `no bench entry for ${op.text ?? key}` };

  const at = Math.min(entry.index ?? xp.bullets.length, xp.bullets.length);
  xp.bullets.splice(at, 0, entry.text);
  const ev = evidenceFor(prov, xp);
  if (ev?.entry) {
    ev.entry.bullets = ev.entry.bullets ?? [];
    ev.entry.bullets.splice(at, 0, entry.provenance ?? []);
  }
  content.bench!.bullets![key] = content.bench!.bullets![key].filter((e) => e !== entry);
  return { applied: { ...op, path: `experiences[${owner.index}]`, text: entry.text } };
}

function dropMention(content: ResumeContent, prov: ResumeSourceProvenance | null, op: Extract<FitOp, { op: "drop_mention" }>): { applied?: AppliedOp; skipped?: string } {
  const parsed = parseUnitPath(op.path);
  if (!parsed || parsed.kind !== "experience") return { skipped: `not an experience path: ${op.path}` };
  const xp = content.experiences?.[parsed.index];
  if (!xp) return { skipped: `no experiences[${parsed.index}]` };
  if (xp.placement !== "mention") return { skipped: `experiences[${parsed.index}] is featured; demote it first` };

  const b = bench(content);
  if (b.mentions.some((m) => m.experience.title === xp.title && m.experience.company === xp.company)) {
    return { skipped: `already benched: ${xp.title} @ ${xp.company}` };
  }

  const ev = evidenceFor(prov, xp);
  let refs: SourceReference[] | undefined;
  let provKey: string | undefined;
  if (ev) {
    provKey = ev.key;
    refs = ev.entry?.one_liner;
    delete prov!.evidence.experiences[ev.key];
  }

  // The role's benched bullets need no shepherding: they are filed under its
  // identity, which the splice cannot touch.
  content.experiences.splice(parsed.index, 1);
  b.mentions.push({ experience: xp as ExperienceMentioned, priority: b.mentions.length + 1, provenance: refs, provenance_key: provKey });
  recordDrop(content, xp);
  return { applied: { ...op, text: `${xp.title} @ ${xp.company}` } };
}

/** Insert an experience so the array stays in the writer's reverse-chronological order. */
function insertExperience(content: ResumeContent, xp: ExperienceItem): number {
  const rank = (v: string): number => {
    if (!v || v === "current") return Number.MAX_SAFE_INTEGER;
    const m = v.match(/^(\d{4})-(\d{2})$/);
    return m ? Number(m[1]) * 12 + Number(m[2]) : 0;
  };
  const at = content.experiences.findIndex((e) => rank(e.end) < rank(xp.end) || (rank(e.end) === rank(xp.end) && rank(e.start) < rank(xp.start)));
  const index = at < 0 ? content.experiences.length : at;
  content.experiences.splice(index, 0, xp);
  return index;
}

/** Punctuation/space-insensitive key so "AT Kearney" finds "A.T. Kearney". */
function loosely(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match a bench mention by company OR title OR "title @ company", exactly
 * first, then loosely, and finally by a loose substring match — but only when
 * exactly one mention matches, so an ambiguous nickname never restores the
 * wrong role.
 */
function findBenchMention(mentions: BenchMention[], wanted: string): BenchMention | undefined {
  const full = (m: BenchMention) => `${m.experience.title} @ ${m.experience.company}`;
  const exact = mentions.find((m) => full(m) === wanted || m.experience.title === wanted || m.experience.company === wanted);
  if (exact) return exact;

  const needle = loosely(wanted);
  if (!needle) return undefined;
  const loose = mentions.filter((m) => [full(m), m.experience.title, m.experience.company].some((c) => loosely(c) === needle));
  if (loose.length === 1) return loose[0];

  const partial = mentions.filter((m) => {
    const candidates = [full(m), m.experience.title, m.experience.company].map(loosely).filter(Boolean);
    return candidates.some((c) => c.includes(needle) || needle.includes(c));
  });
  return partial.length === 1 ? partial[0] : undefined;
}

function restoreMention(content: ResumeContent, prov: ResumeSourceProvenance | null, op: Extract<FitOp, { op: "restore_mention" }>): { applied?: AppliedOp; skipped?: string } {
  const b = bench(content);
  if (!b.mentions.length) return { skipped: "bench has no mentions" };
  const wanted = op.text ?? op.path;
  const entry = wanted ? findBenchMention(b.mentions, wanted) : sortByPriorityAsc(b.mentions)[0];
  if (!entry) return { skipped: `no bench mention matching '${wanted}'` };
  if (content.experiences.some((e) => e.title === entry.experience.title && e.company === entry.experience.company)) {
    return { skipped: `already rendered: ${entry.experience.title}` };
  }

  const index = insertExperience(content, entry.experience);

  if (prov?.evidence?.experiences) {
    const key = entry.provenance_key ?? experienceKeys(entry.experience)[0];
    prov.evidence.experiences[key] = { ...(prov.evidence.experiences[key] ?? {}), one_liner: entry.provenance ?? [] };
  }
  b.mentions = b.mentions.filter((m) => m !== entry);
  forgetDrop(content, entry.experience);
  return { applied: { ...op, path: `experiences[${index}]`, text: `${entry.experience.title} @ ${entry.experience.company}` } };
}

/**
 * Featured block → compact mention, using a PREPARED one-liner from the bench.
 * Refuses otherwise: writing a one-liner is composition, and composition is the
 * model's job, not this tool's.
 */
function demote(content: ResumeContent, prov: ResumeSourceProvenance | null, op: Extract<FitOp, { op: "demote" }>): { applied?: AppliedOp; skipped?: string } {
  const parsed = parseUnitPath(op.path);
  if (!parsed || parsed.kind !== "experience") return { skipped: `not an experience path: ${op.path}` };
  const xp = content.experiences?.[parsed.index];
  if (!xp) return { skipped: `no experiences[${parsed.index}]` };
  if (xp.placement === "mention") return { skipped: `experiences[${parsed.index}] is already a mention` };

  const b = bench(content);
  const prepared = b.mentions.find((m) => m.experience.title === xp.title && m.experience.company === xp.company);
  if (!prepared) {
    return { skipped: `demote refused: no bench one-liner for '${xp.title} @ ${xp.company}' — compose one into bench.mentions first` };
  }

  const featured = xp as ExperienceFeatured;
  const key = benchKeyForExperience(xp);
  const path = `experiences[${parsed.index}]`;
  const ev = evidenceFor(prov, xp);
  const benched = b.bullets[key] ?? [];
  // Park the whole featured block so the demote is reversible.
  featured.bullets.forEach((text, i) => {
    benched.push({ text, priority: benched.length + i + 1, provenance: ev?.entry?.bullets?.[i], kind: "bullet", from: `${path}.bullets[${i}]`, index: i });
  });
  if (featured.summary) {
    benched.push({ text: featured.summary, priority: 0, provenance: ev?.entry?.summary, kind: "summary", from: `${path}.summary` });
  }
  b.bullets[key] = benched;

  const mention: ExperienceMentioned = {
    ...prepared.experience,
    title: featured.title,
    company: featured.company,
    start: featured.start,
    end: featured.end,
    placement: "mention",
  };
  content.experiences[parsed.index] = mention;
  if (ev?.entry) {
    delete ev.entry.bullets;
    delete ev.entry.summary;
    ev.entry.one_liner = prepared.provenance ?? ev.entry.one_liner ?? [];
  }
  b.mentions = b.mentions.filter((m) => m !== prepared);
  return { applied: { ...op, text: mention.one_liner } };
}

function addSkillItem(content: ResumeContent, op: Extract<FitOp, { op: "add_skill_item" }>): { applied?: AppliedOp; skipped?: string } {
  const owner = ownerIndexOf(op.path);
  if (!owner || owner.kind !== "skill") return { skipped: `not a skills path: ${op.path}` };
  const block = content.skills?.[owner.index];
  if (!block) return { skipped: `no skills[${owner.index}]` };

  const key = benchKeyForSkill(block);
  const entries = content.bench?.skill_items?.[key] ?? [];
  if (!entries.length) return { skipped: `bench empty for ${key}` };
  if (op.text && block.bullets.includes(op.text)) return { skipped: `already rendered: ${op.text.slice(0, 40)}` };
  const entry = op.text ? entries.find((e) => e.text === op.text) : sortByPriorityAsc(entries)[0];
  if (!entry) return { skipped: `no bench skill item for ${op.text ?? key}` };

  const at = Math.min(entry.index ?? block.bullets.length, block.bullets.length);
  block.bullets.splice(at, 0, entry.text);
  content.bench!.skill_items![key] = entries.filter((e) => e !== entry);
  return { applied: { ...op, path: `skills[${owner.index}]`, text: entry.text } };
}

function dropSkillItem(content: ResumeContent, op: Extract<FitOp, { op: "drop_skill_item" }>): { applied?: AppliedOp; skipped?: string } {
  const parsed = parseUnitPath(op.path);
  if (!parsed || parsed.kind !== "skill_item") return { skipped: `not a skill item path: ${op.path}` };
  const block = content.skills?.[parsed.index];
  if (!block) return { skipped: `no skills[${parsed.index}]` };
  const key = benchKeyForSkill(block);
  const benched = bench(content).skill_items[key] ?? [];
  if (op.text && benched.some((e) => e.text === op.text)) return { skipped: `already benched: ${op.text.slice(0, 40)}` };

  const at = op.text ? block.bullets.indexOf(op.text) : parsed.item;
  if (at < 0 || at >= block.bullets.length) return { skipped: `skill item not present at ${op.path}` };
  const text = block.bullets[at];
  block.bullets.splice(at, 1);
  bench(content).skill_items[key] = [...benched, { text, priority: benched.length + 1, index: at }];
  return { applied: { ...op, text } };
}

// --------------------------------------------------------------- driver ----

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Stable identity of the unit an op addresses, captured from the composition as
 * it was BEFORE the plan ran.
 *
 * Every path in a plan is written against the pre-plan array. Applying ops
 * sequentially splices those arrays, so a later op's literal index silently
 * addresses a different unit (the classic symptom: a plan of two drop_mention
 * ops on ascending indices removed original[8] and original[11]). Resolving to
 * identity up front and re-resolving to a live index immediately before each op
 * makes the plan mean what it says regardless of what earlier ops moved.
 */
type UnitIdentity =
  | { kind: "experience"; title: string; company: string }
  | { kind: "bullet"; title: string; company: string; text?: string; bullet: number }
  | { kind: "skill"; name: string }
  | { kind: "skill_item"; name: string; text?: string; item: number };

function bulletsOf(xp: ExperienceItem | undefined): string[] | undefined {
  return xp && "bullets" in xp ? (xp as ExperienceFeatured).bullets : undefined;
}

/** Capture identity from the pre-plan composition. `null` = unresolvable, leave the path alone. */
function identifyUnit(content: ResumeContent, path: string | undefined, opText?: string): UnitIdentity | null {
  if (!path) return null;
  const parsed = parseUnitPath(path);
  if (!parsed) return null;
  if (parsed.kind === "experience" || parsed.kind === "bullet") {
    const xp = content.experiences?.[parsed.index];
    if (!xp) return null;
    if (parsed.kind === "experience") return { kind: "experience", title: xp.title, company: xp.company };
    // Ops that already carry `text` are authoritative; otherwise read the text at the pre-plan index.
    return { kind: "bullet", title: xp.title, company: xp.company, text: opText ?? bulletsOf(xp)?.[parsed.bullet], bullet: parsed.bullet };
  }
  const block = content.skills?.[parsed.index];
  if (!block) return null;
  if (parsed.kind === "skill") return { kind: "skill", name: block.name };
  return { kind: "skill_item", name: block.name, text: opText ?? block.bullets?.[parsed.item], item: parsed.item };
}

/** Re-resolve an identity against the live composition. `null` = gone; the op will skip with a reason. */
function resolveUnit(content: ResumeContent, id: UnitIdentity): string | null {
  if (id.kind === "experience" || id.kind === "bullet") {
    const xi = content.experiences?.findIndex((e) => e.title === id.title && e.company === id.company) ?? -1;
    if (xi < 0) return null;
    if (id.kind === "experience") return `experiences[${xi}]`;
    const at = id.text ? (bulletsOf(content.experiences[xi])?.indexOf(id.text) ?? -1) : -1;
    return `experiences[${xi}].bullets[${at >= 0 ? at : id.bullet}]`;
  }
  const si = content.skills?.findIndex((s) => s.name === id.name) ?? -1;
  if (si < 0) return null;
  if (id.kind === "skill") return `skills[${si}]`;
  const at = id.text ? (content.skills[si].bullets?.indexOf(id.text) ?? -1) : -1;
  return `skills[${si}].bullets[${at >= 0 ? at : id.item}]`;
}

/** Ops whose `path` is a bench selector, not an index into the composition. */
const SELECTOR_PATH_OPS = new Set(["restore_mention"]);
/** Ops that address a unit currently in the composition, so its text pins the target. */
const TEXT_PINNED_OPS = new Set(["drop_bullet", "drop_skill_item"]);

/**
 * Apply ops in order. Never throws on a bad op — an op that cannot apply is
 * reported in `skipped` with a reason, which is what makes replaying a plan
 * safe.
 */
export function applyFitOps(
  input: { content: ResumeContent; provenance?: ResumeSourceProvenance | null },
  ops: FitOp[],
): FitOpsResult {
  const content = clone(input.content);
  const inlineProvenance = input.provenance === undefined ? content.source_provenance ?? null : input.provenance;
  const provenance = inlineProvenance ? clone(inlineProvenance) : null;
  if (content.source_provenance && provenance) content.source_provenance = provenance;
  // Legacy index keys mean "slot i of the composition as it stands now"; resolve
  // them to identity once, before any op moves anything.
  normalizeBenchKeys(content);

  const applied: AppliedOp[] = [];
  const skipped: SkippedOp[] = [];

  // Pin every op to the composition as it was BEFORE the plan ran, so a splice
  // by an earlier op can never redirect a later op onto the wrong unit.
  const pinned = ops.map((op) => ({
    op,
    identity: op && !SELECTOR_PATH_OPS.has(op.op) ? identifyUnit(content, (op as { path?: string }).path, op.text) : null,
  }));

  for (const { op, identity } of pinned) {
    // Re-resolve immediately before applying: identity → live index.
    let live: FitOp = op;
    if (identity) {
      const path = resolveUnit(content, identity) ?? (op as { path?: string }).path;
      const text = op.text ?? (TEXT_PINNED_OPS.has(op.op) && "text" in identity ? identity.text : undefined);
      live = { ...op, path, ...(text === undefined ? {} : { text }) } as FitOp;
    }

    let outcome: { applied?: AppliedOp; skipped?: string };
    switch (live.op) {
      case "drop_bullet": outcome = dropBullet(content, provenance, live); break;
      case "restore_bullet": outcome = restoreBullet(content, provenance, live); break;
      case "drop_mention": outcome = dropMention(content, provenance, live); break;
      case "restore_mention": outcome = restoreMention(content, provenance, live); break;
      case "demote": outcome = demote(content, provenance, live); break;
      case "add_skill_item": outcome = addSkillItem(content, live); break;
      case "drop_skill_item": outcome = dropSkillItem(content, live); break;
      default: outcome = { skipped: `unknown op '${(live as FitOp).op}'` };
    }
    if (outcome.applied) {
      const originalPath = (op as { path?: string }).path;
      applied.push(originalPath === undefined ? outcome.applied : { ...outcome.applied, original_path: originalPath });
    } else skipped.push({ op, reason: outcome.skipped ?? "no-op" });
  }

  return { content, provenance, applied, skipped };
}

// ---------------------------------------------------------------- ladder ----

export type LadderInput = {
  content: ResumeContent;
  /** From the audit's fit report. */
  fit: { verdict: string; lines_to_remove: number; lines_to_add: number };
  /** unit_path → rendered line count, from the audit's measured line units. */
  unitLines?: Record<string, number>;
  /** Minimum bullets a featured block keeps before the ladder moves on. */
  minBulletsPerFeature?: number;
  /**
   * Experience indices the positioning protects — derived from the resume's
   * `evidence_strategy.magnify[].experience` and `.support[].experience`. The
   * ladder never drops a bullet from, demotes, or benches one of these roles.
   * It may still RESTORE into them: protection is against loss, not against
   * gain. Indices address the composition the plan is written against.
   */
  protectedExperiences?: number[];
  /**
   * `content_policy.experiences.mentioned.keep_all` — full career breadth is
   * mandatory on this positioning, so no mention may leave the page for a line
   * of budget. The ladder emits no `drop_mention` at all when true.
   */
  keepAllMentions?: boolean;
};

/**
 * Resolve the positioning's protected roles to composition indices.
 *
 * The resume names them in prose (`experience: Acme Consulting Corp`), the
 * composition holds structured roles, so match case-insensitively by substring
 * against `company` first and `title` second — a role named for its employer
 * must not be shadowed by an unrelated role whose TITLE happens to contain the
 * same word. Every experience that matches is protected: a single employer may
 * legitimately render as more than one block.
 */
export function protectedExperienceIndices(
  content: ResumeContent,
  evidenceStrategy?: { magnify?: Array<{ experience?: string }>; support?: Array<{ experience?: string }> } | null,
): number[] {
  const names = [...(evidenceStrategy?.magnify ?? []), ...(evidenceStrategy?.support ?? [])]
    .map((e) => (e?.experience ?? "").trim().toLowerCase())
    .filter(Boolean);
  const experiences = content.experiences ?? [];
  const out = new Set<number>();
  for (const needle of names) {
    const matching = (field: (xp: ExperienceItem) => string) =>
      experiences.flatMap((xp, i) => {
        const value = (field(xp) ?? "").toLowerCase();
        if (!value) return [];
        // Either direction: "Acme" names "Acme Consulting Corp", and vice versa.
        const hit = value.includes(needle) || (needle.length >= 4 && needle.includes(value));
        return hit ? [i] : [];
      });
    const hits = matching((xp) => xp.company);
    for (const i of (hits.length ? hits : matching((xp) => xp.title))) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** Editorial rank of an experience: explicit `tier`, else array position. */
export function experienceTier(xp: ExperienceItem, index: number): number {
  return typeof xp.tier === "number" ? xp.tier : index;
}

/**
 * The fit ladder, in code so the model never has to reason about it.
 *
 * Over budget  → drop the lowest-tier featured bullets first (last bullet of
 *                the least important role), then the lowest-tier mentions.
 * Under filled → restore bullets on the most recent roles first, then mentions,
 *                then skill items.
 *
 * Two things the ladder will not do, whatever the arithmetic says: take content
 * out of a role the positioning protects, and drop a mention when the
 * positioning requires full career breadth. Both are editorial decisions the
 * resume already made; a page-budget deficit is not a licence to reverse them.
 *
 * Estimated line savings come from the audit's measured unit line counts where
 * available, otherwise a conservative 1 line per unit.
 */
export function planAutoOps(input: LadderInput): FitOp[] {
  const { content, fit } = input;
  const lines = input.unitLines ?? {};
  const minBullets = input.minBulletsPerFeature ?? 3;
  const isProtected = new Set(input.protectedExperiences ?? []);
  const ops: FitOp[] = [];

  const featured = content.experiences
    .map((xp, index) => ({ xp, index, tier: experienceTier(xp, index) }))
    .filter((e) => e.xp.placement === "feature") as Array<{ xp: ExperienceFeatured; index: number; tier: number }>;
  const mentions = content.experiences
    .map((xp, index) => ({ xp, index, tier: experienceTier(xp, index) }))
    .filter((e) => e.xp.placement === "mention");

  if (fit.verdict === "over_budget" && fit.lines_to_remove > 0) {
    let budget = fit.lines_to_remove;
    // Lowest tier (largest number) first; within a role, the last bullet first.
    const candidates: Array<{ path: string; text: string; lines: number }> = [];
    const remaining = new Map<number, number>();
    for (const f of [...featured].sort((a, b) => b.tier - a.tier)) {
      if (isProtected.has(f.index)) continue;
      remaining.set(f.index, f.xp.bullets.length);
      for (let j = f.xp.bullets.length - 1; j >= 0; j--) {
        const path = `experiences[${f.index}].bullets[${j}]`;
        candidates.push({ path, text: f.xp.bullets[j], lines: lines[path] ?? 1 });
      }
    }
    for (const c of candidates) {
      if (budget <= 0) break;
      const owner = Number(c.path.match(/^experiences\[(\d+)\]/)![1]);
      const left = remaining.get(owner) ?? 0;
      if (left <= minBullets) continue;
      remaining.set(owner, left - 1);
      ops.push({ op: "drop_bullet", path: c.path, text: c.text });
      budget -= c.lines;
    }
    if (input.keepAllMentions) return ops;
    for (const m of [...mentions].sort((a, b) => b.tier - a.tier)) {
      if (budget <= 0) break;
      if (isProtected.has(m.index)) continue;
      const path = `experiences[${m.index}]`;
      ops.push({ op: "drop_mention", path, text: `${m.xp.title} @ ${m.xp.company}` });
      budget -= lines[`${path}.one_liner`] ?? 1;
    }
    return ops;
  }

  if ((fit.verdict === "under_filled" || fit.verdict === "under_pages") && fit.lines_to_add > 0) {
    let budget = fit.lines_to_add;
    // Most recent / highest-tier roles first.
    for (const f of [...featured].sort((a, b) => a.tier - b.tier)) {
      const entries = sortByPriorityAsc(benchBulletsFor(content, f.index).filter((e) => (e.kind ?? "bullet") === "bullet"));
      for (const entry of entries) {
        if (budget <= 0) break;
        ops.push({ op: "restore_bullet", path: `experiences[${f.index}]`, text: entry.text });
        budget -= 2; // a restored bullet typically renders 1-2 lines
      }
      if (budget <= 0) break;
    }
    for (const entry of sortByPriorityAsc(content.bench?.mentions ?? [])) {
      if (budget <= 0) break;
      ops.push({ op: "restore_mention", text: `${entry.experience.title} @ ${entry.experience.company}` });
      budget -= 1;
    }
    for (let i = 0; i < (content.skills?.length ?? 0); i++) {
      for (const entry of sortByPriorityAsc(benchSkillItemsFor(content, i))) {
        if (budget <= 0) break;
        ops.push({ op: "add_skill_item", path: `skills[${i}]`, text: entry.text });
        budget -= 1;
      }
    }
    return ops;
  }

  return ops;
}
