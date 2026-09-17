/**
 * Templates contract for CV rendering.
 *
 * A template is a renderer: code that takes canonical CV content + render
 * options and emits artefacts (docx, pdf, md, html). Different templates
 * make different visual / structural / layout choices. The active templates
 * use HTML/CSS + Playwright for presentation PDFs and a shared docx renderer
 * for ATS output, but the interface intentionally leaves engines open.
 *
 * The harness contracts on this interface only. Templates choose their
 * implementation freely as long as they conform to render(content, opts).
 */

export type Frontmatter = {
  name: string;
  email: string;
  phone: string;
  citizenship?: string;
  location?: { city?: string; country?: string };
  linkedin_url?: string;
  github_url?: string;
};

/**
 * Common fields every experience carries regardless of placement. Placement
 * determines the rest of the shape and how the template renders it.
 */
type ExperienceBase = {
  title: string;
  company: string;
  location?: string;
  start: string;            // YYYY-MM
  end: string;              // YYYY-MM | "current"
  /** Optional human-readable date treatment for non-employment experience,
   *  e.g. "Launched February 2026". Chronology still uses start/end. */
  date_label?: string;
  /** Optional editorial rank for the deterministic fit ladder (lower = keep
   *  sooner). Templates ignore it; `fit-ops` falls back to array position. */
  tier?: number;
};

/**
 * A featured experience renders as a full block: title + company + dates,
 * a paragraph summary, and a bullet list. resume-writer picks 4-7 bullets
 * per featured experience based on target relevance.
 */
export type ExperienceFeatured = ExperienceBase & {
  placement: "feature";
  /** Maps to `line_units.experience_summary`; full-width prose below the
   *  title/date row. */
  summary: string;
  /** Each bullet maps to `line_units.experience_bullet`. */
  bullets: string[];
};

/**
 * A mentioned experience renders inside the Experience section with the SAME
 * heading row as a featured block — role, company, and a right-aligned date
 * range — followed by its one-liner as a short summary paragraph. No bullet
 * list, and tighter spacing, so the run of mentions still reads compact. The
 * hook should target one rendered line and must not exceed two rendered lines
 * unless the writer reports a source/fit exception.
 */
export type ExperienceMentioned = ExperienceBase & {
  placement: "mention";
  /** Maps to `line_units.earlier_one_liner`. The role/company/date row is a
   *  separate heading line, so this text alone is the measured unit: budget it
   *  as full-width summary prose, not as prose after a fixed prefix. */
  one_liner: string;
};

/**
 * Discriminated union — template render.ts files MUST switch on `placement`.
 * The dispatcher validates the shape; templates render per case.
 */
export type ExperienceItem = ExperienceFeatured | ExperienceMentioned;

/** A rendered skill block has a visible `name`, optional one-line summary
 *  (`line_units.skill_summary`), and bullets mapping to `line_units.skill_item`. */
export type SkillBlock = { name: string; summary?: string; bullets: string[]; /** "screener": the one term-dense block written for ATS/AI screeners (see resume-keywords.ts) */ role?: "screener" };

export type SourceReference = {
  file: string;
  /** 1-based inclusive line range in the source file. */
  lines: [number, number];
  /** Short copied anchor text used only for audit/debugging, not rendering. */
  quote?: string;
  note?: string;
};

export type ResumeSourceProvenance = {
  /** SHA-256 of state/profile/cv-source.md at composition time. */
  cv_source_hash?: string;
  /** SHA-256 of state/profile/profile.md at composition time. */
  profile_hash?: string;
  evidence: {
    summary: SourceReference[];
    highlights: SourceReference[][];
    skills: Record<string, SourceReference[]>;
    additional_skills_summary?: SourceReference[];
    credentials?: SourceReference[][];
    experiences: Record<string, {
      summary?: SourceReference[];
      bullets?: SourceReference[][];
      one_liner?: SourceReference[];
    }>;
  };
  /** Claims the writer could not support directly from source; should block approval. */
  unsupported_claims?: string[];
};

export type MarketAlignment = {
  applied_terms?: string[];
  implicit_terms_used?: Array<{
    term: string;
    source_signal: string;
    rationale?: string;
  }>;
  confirmation_needed?: Array<{
    signal: string;
    question: string;
    reason?: string;
  }>;
  open_questions?: Array<{
    signal: string;
    question: string;
    reason?: string;
  }>;
  source_update_required?: Array<{
    signal: string;
    question: string;
    reason?: string;
  }>;
  suppressed_confirmations?: Array<{
    signal: string;
    status: "declined" | "not_applicable";
    reason?: string;
  }>;
  missing_signals?: string[];
};

/** A benched bullet. `from` records the unit path it was taken from; `index`
 *  the slot it occupied, so restoring puts it back where it was. `kind:
 *  "summary"` marks a featured summary parked by `demote` — never restored as
 *  a bullet. */
export type BenchBullet = {
  text: string;
  priority?: number;
  provenance?: SourceReference[];
  kind?: "bullet" | "summary";
  from?: string;
  index?: number;
};

/** A benched role, ready to be restored (or demoted into) as a compact row. */
export type BenchMention = {
  experience: ExperienceMentioned;
  priority?: number;
  provenance?: SourceReference[];
  /** Key under `source_provenance.evidence.experiences` to restore it beneath. */
  provenance_key?: string;
};

export type BenchSkillItem = { text: string; priority?: number; index?: number };

/** Spare, source-evidenced material keyed by OWNER IDENTITY, never by array
 *  slot: `title|company|start|end` for bullets (the same id used by
 *  `dropped_experiences` and the provenance sidecar) and the block name for
 *  skill items, so deleting an experience cannot hand its bench to a
 *  neighbour. Legacy `experiences[i]` / `skills[i]` keys are still read and
 *  rewritten to identity on the next write by `tools/resume/lib/fit-ops.ts`. */
export type ResumeBench = {
  bullets?: Record<string, BenchBullet[]>;
  mentions?: BenchMention[];
  skill_items?: Record<string, BenchSkillItem[]>;
};

export type ResumeContent = {
  frontmatter: Frontmatter;
  /** Optional role headline shown under the name (e.g. "Agentic AI Engineering
   *  Lead"). resume-writer populates it from the positioning's `label`.
   *  Templates render it if present; omit safely if absent. */
  headline?: string;
  /** Composed per render by resume-writer (positioning-specific lead).
   *  Must be authored against the active template's `line_units.summary`
   *  budget before render, then visually/evaluator checked after render. */
  summary: string;
  /** Each highlight maps to `line_units.impact_bullet`; writer must account
   *  for bullet indentation and desired rendered line fill. */
  highlights: string[];
  skills: SkillBlock[];
  /** Short paragraph summarising source-supported skills not prioritised in
   * the main skills blocks. Maps to `line_units.additional_skills_summary`;
   * rendered below skill lines as full-width prose. */
  additional_skills_summary?: string;
  /** Optional education / certifications block. Kept separate from
   * Experience so earlier career entries are not abused for credentials. */
  /** Each credential maps to `line_units.credential`. */
  credentials?: string[];
  /**
   * Reverse chronological. Mix of featured + mentioned. resume-writer composes
   * this from state/profile/cv-source.md plus the positioning brief; the
   * dispatcher trusts it verbatim.
   */
  experiences: ExperienceItem[];
  /**
   * Audit transparency: experiences resume-writer evaluated and chose to drop
   * entirely. Templates ignore this field; quality reports surface it so
   * the user sees the editorial trail. Optional — populated by resume-writer.
   */
  dropped_experiences?: { id: string; reason: string }[];
  /**
   * The fit bench: material the writer composed and evidenced but that is not
   * currently rendered. `tools/resume/lib/fit-ops.ts` moves whole units between
   * the bench and the rendered content so the page-fit loop is deterministic
   * and lossless — nothing is deleted, and no text is ever rewritten.
   * Templates ignore this field entirely.
   *
   * `priority` ranks within a bucket: LOWER number = keep sooner (1 is the
   * first thing restored, and the last thing dropped).
   */
  bench?: ResumeBench;
  /**
   * Audit trail from authored resume content back to canonical profile source.
   * Templates ignore this; resume-writer and review skills use it to prove the
   * selected content came from state/profile/cv-source.md rather than model
   * invention. Optional for older artefacts and template samples.
   */
  source_provenance?: ResumeSourceProvenance;
  /**
   * Non-rendered audit metadata from market-guided composition. Role/resume
   * types may define employer-market language, but resume-writer can only use
   * terms that are explicit or defensibly implicit in the source evidence.
   * Templates ignore this; review skills inspect it from the composition JSON.
   */
  market_alignment?: MarketAlignment;
  resumeId: string;
};

export type Flavour = "ats" | "presentation";

export type ResumeRenderPolicy = {
  show_contact_line?: boolean;
  show_experience_dates?: boolean;
};

export type RenderOptions = {
  flavours: Flavour[];       // which artefacts to produce
  outDir: string;            // where to write output files
  maxBullets?: number;       // per-experience cap; templates may interpret
  pageSize?: "A4" | "Letter";
  filenamePrefix?: string;   // default: "cv"
  renderPolicy?: ResumeRenderPolicy;
  /**
   * Optional shared Playwright session (see tools/resume/lib/browser-session).
   * HTML templates render on its page instead of launching their own browser,
   * and leave the page open on the rendered document for in-process checks.
   * Templates that do not use a browser ignore it.
   */
  session?: import("../../tools/resume/lib/browser-session.ts").BrowserSession;
};

export type RenderResult = {
  // Map flavour → produced file paths. Templates set only what they emit.
  ats?: { docx?: string; pdf?: string; md?: string };
  presentation?: { docx?: string; pdf?: string; html?: string };
  // Diagnostics — what the renderer wants to surface to the orchestrator.
  warnings?: string[];
  meta?: Record<string, unknown>;
};

/**
 * A CV template renderer. Each template's `render.ts` exports this as
 * `default`.
 */
export type ResumeTemplate = (content: ResumeContent, options: RenderOptions) => Promise<RenderResult>;
