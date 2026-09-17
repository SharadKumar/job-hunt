#!/usr/bin/env tsx
/**
 * lexicon-mine.ts — mine the LOCAL job-description corpus for the vocabulary a
 * resume type must speak (plan B6, the "zero research" first pass).
 *
 *   npm run lexicon:mine -- --resume <id> [--profile <id>] [--min-df 2] [--top 60]
 *                              [--include-titles] [--json] [--out <path>]
 *
 * Corpus for one resume type:
 *   - pipeline rows (tools/pipeline.ts, SQLite) whose classification
 *     matched_resume_id (state/pipeline/classifications.json) equals the resume,
 *     whose pipeline resumeId equals the resume, or whose title matches one of
 *     the type's search_keywords. Full text only when description ≥ 500 chars.
 *   - state/pipeline/archive/<id>/jd.md for those same ids (or for archives
 *     whose id is not in the pipeline but whose text matches a keyword).
 *   - titles from EVERY matching row regardless of description length; they
 *     feed the title-family vocabulary (--include-titles adds them as terms).
 *
 * Ranks 1-3 word terms by document frequency (df) and must-have frequency and
 * marks each `present` / `absent` in cv-source.md. Output is a ranked
 * candidate list for the /resume-strategy lexicon refresh; nothing is written
 * to resume-types.yaml here. Exit 0 always; the summary states how many full
 * JDs were available so a thin corpus is never mistaken for a clean signal.
 */

import { readJsonIfExists } from "../lib/fs.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResume } from "../resumes.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { normalise, stem, STOPWORDS, phraseInText, tokenInText, buildStemSet } from "./keyword-lexicon.ts";
import { loadKeywordClouds, resolveCloudsForType } from "../keyword-clouds.ts";
import { repoPath } from "../repo-root.ts";
import { list as listOpportunities } from "../pipeline.ts";

/** 1-based cv-source line numbers whose normalised text contains the (normalised, stem-tolerant) term. */
function corpusLinesFor(term: string, corpusText: string, limit = 5): number[] {
  const words = term.split(" ");
  const stemmed = words.map(stem).join(" ");
  const out: number[] = [];
  corpusText.split("\n").forEach((line, i) => {
    if (out.length >= limit) return;
    const norm = normalise(line);
    if (phraseInText(term, norm) || phraseInText(stemmed, normalise(line.split(/\s+/).map((w) => stem(w.toLowerCase())).join(" ")))) out.push(i + 1);
  });
  return out;
}

export const MIN_FULL_TEXT_CHARS = 500;
const THIN_CORPUS_DOCS = 10;
const MUST_CUES = /\b(must|required|essential|mandatory|minimum|non-negotiable|need to have|you will have|you have)\b/i;
const NICE_CUES = /\b(desirable|preferred|bonus|advantage|nice to have|ideally)\b/i;
const CERT_PATTERN = /\b(TOGAF|PMP|PRINCE2|SAFe|ITIL|CISSP|CISM|AWS|Azure|GCP|CKA|CSM|PSM|CBAP|CIS-[A-Z]+|AZ-\d{3}|DP-\d{3}|AI-\d{3}|PL-\d{3}|MS-\d{3})\b/;
const TITLE_HINT = /\b(architect|manager|lead|engineer|consultant|director|head|principal|specialist|analyst|owner|cto|cio)\b/i;
const METHOD_HINT = /\b(agile|scrum|safe|kanban|devops|itil|togaf|prince2|lean|waterfall|mlops|llmops|ci cd|cicd)\b/i;

export type MinedTerm = {
  term: string;
  ngram: 1 | 2 | 3;
  df: number;
  must_have_df: number;
  title_df: number;
  background_df: number;
  sample_context: string;
  corpus_status: "present" | "absent";
  corpus_lines: number[];
  suggested_tier: "corpus" | "preppable" | "confirm" | "forbidden";
  suggested_category: "tool" | "platform" | "methodology" | "certification" | "title" | "domain" | "concept";
  /** nearest keyword cloud by token overlap; null when nothing overlaps */
  suggested_cloud: string | null;
  suggested_cloud_kind: "capability" | "domain" | "tooling" | null;
  score: number;
};

export type MinedDoc = { id: string; title: string; text: string; source: "pipeline" | "archive" | "title-only" };

export type MineResult = {
  resume_id: string;
  generated_at: string;
  corpus: {
    matching_rows: number;
    background_docs: number;
    full_text_docs: number;
    archive_docs: number;
    title_only_rows: number;
    thin: boolean;
    note: string;
  };
  title_families: Array<{ title: string; count: number }>;
  /** clouds the resume type references, heaviest first (for grouping the output) */
  clouds: Array<{ id: string; kind: string; label: string; weight: number }>;
  terms: MinedTerm[];
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return args;
}

/** Tolerant on purpose: a corrupt input file is skipped, not fatal. */
async function readJson<T>(file: string): Promise<T | null> {
  return readJsonIfExists<T>(file).catch(() => null);
}

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}

function titleMatches(title: string, keywords: string[]): boolean {
  const t = normalise(title);
  return keywords.some((k) => k && phraseInText(normalise(k).trim(), t));
}

/**
 * Build the mining corpus. Exported so tests can run the miner on a synthetic
 * pipeline without touching state/.
 */
export async function collectCorpus(opts: {
  resumeId: string;
  searchKeywords: string[];
  pipelinePath?: string;
  classificationsPath?: string;
  archiveDir?: string;
}): Promise<{ docs: MinedDoc[]; titles: string[]; matchingRows: number; backgroundDocs: MinedDoc[] }> {
  const classificationsPath = opts.classificationsPath ?? repoPath("state/pipeline/classifications.json");
  const archiveDir = opts.archiveDir ?? repoPath("state/pipeline/archive");

  // The pipeline lives in SQLite. Reading state/pipeline/opportunities.json by
  // hand used to yield an empty corpus the moment that file was renamed aside
  // by the migration, and the miner just reported "no matching rows". An
  // explicit --pipeline <json> still reads a JSON array, which is how the
  // tests mine a synthetic pipeline without touching state/.
  let rows: any[];
  if (opts.pipelinePath) {
    const rawPipeline = await readJson<any>(opts.pipelinePath);
    rows = Array.isArray(rawPipeline) ? rawPipeline : Object.values(rawPipeline ?? {});
  } else {
    rows = await listOpportunities({ withDescription: true });
  }
  const classifications = (await readJson<Record<string, any>>(classificationsPath)) ?? {};

  const matching = rows.filter((row) => {
    if (!row) return false;
    if (row.resumeId === opts.resumeId) return true;
    if (classifications[row.id]?.matched_resume_id === opts.resumeId) return true;
    return titleMatches(String(row.title ?? ""), opts.searchKeywords);
  });

  const docs: MinedDoc[] = [];
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const row of matching) {
    titles.push(String(row.title ?? ""));
    const desc = String(row.description ?? "");
    const archived = await readText(path.join(archiveDir, String(row.id), "jd.md"));
    const text = archived && archived.length >= desc.length ? archived : desc;
    if (text.length >= MIN_FULL_TEXT_CHARS) {
      docs.push({ id: String(row.id), title: String(row.title ?? ""), text, source: archived && archived.length >= desc.length ? "archive" : "pipeline" });
    } else {
      docs.push({ id: String(row.id), title: String(row.title ?? ""), text: "", source: "title-only" });
    }
    seen.add(String(row.id));
  }

  // Archives not in the pipeline (manual imports, test JDs): include when the
  // archived JD's title line or body matches a search keyword.
  let archiveEntries: string[] = [];
  try { archiveEntries = await fs.readdir(archiveDir); } catch { archiveEntries = []; }
  for (const entry of archiveEntries) {
    if (seen.has(entry)) continue;
    const jd = await readText(path.join(archiveDir, entry, "jd.md"));
    if (!jd || jd.length < MIN_FULL_TEXT_CHARS) continue;
    const firstLine = jd.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "";
    if (titleMatches(firstLine, opts.searchKeywords) || titleMatches(jd.slice(0, 400), opts.searchKeywords)) {
      docs.push({ id: entry, title: firstLine, text: jd, source: "archive" });
      titles.push(firstLine);
    }
  }
  // Background: every full-text JD in the pipeline or archive (any resume type).
  const backgroundDocs: MinedDoc[] = [];
  for (const row of rows) {
    if (!row) continue;
    const desc = String(row.description ?? "");
    const archived = await readText(path.join(archiveDir, String(row.id), "jd.md"));
    const text = archived && archived.length >= desc.length ? archived : desc;
    if (text.length >= MIN_FULL_TEXT_CHARS) backgroundDocs.push({ id: String(row.id), title: String(row.title ?? ""), text, source: "pipeline" });
  }
  const pipelineIds = new Set(rows.map((r) => String(r?.id)));
  for (const entry of archiveEntries) {
    if (pipelineIds.has(entry)) continue;
    const jd = await readText(path.join(archiveDir, entry, "jd.md"));
    if (jd && jd.length >= MIN_FULL_TEXT_CHARS) backgroundDocs.push({ id: entry, title: "", text: jd, source: "archive" });
  }
  return { docs, titles, matchingRows: matching.length, backgroundDocs };
}

function ngrams(words: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    const slice = words.slice(i, i + n);
    if (slice.some((w) => /^\d+$/.test(w) || w.length < 2)) continue;
    if (n === 1) {
      if (slice[0].length < 4 || STOPWORDS.has(slice[0]) || JD_BOILERPLATE.has(slice[0])) continue;
    } else {
      // Phrases may include a generic word but must contain at least one word that
      // is neither a stopword nor advert boilerplate, and must not start or end
      // with glue or boilerplate.
      if (slice.every((w) => STOPWORDS.has(w) || JD_BOILERPLATE.has(w))) continue;
      if (slice[0].length < 3 || slice[n - 1].length < 3) continue;
      if (GLUE.has(slice[0]) || GLUE.has(slice[n - 1])) continue;
      if (JD_BOILERPLATE.has(slice[0]) || JD_BOILERPLATE.has(slice[n - 1])) continue;
    }
    out.push(slice.join(" "));
  }
  return out;
}

/**
 * Advert boilerplate: words that describe the vacancy, not the capability.
 * They co-occur in nearly every JD and never belong in a resume lexicon.
 */
export const JD_BOILERPLATE = new Set<string>([
  "must","essential","required","require","requires","requirement","desirable","preferred","mandatory","minimum","ideally","bonus","advantage",
  "contract","contracts","contractor","permanent","temp","temporary","fixed","term","employment","type","position","positions","vacancy","opportunity","opportunities",
  "location","located","based","interstate","overseas","onsite","site","office","hybrid","remote","travel","relocate","relocation","canberra","sydney","melbourne","brisbane","perth","adelaide","hobart","darwin","australia","australian","nsw","vic","qld","act",
  "able","ability","obtain","hold","holding","eligible","eligibility","citizen","citizenship","clearance","baseline","nv1","nv2","checks","check","police","background",
  "apply","applying","application","applications","applicant","applicants","candidate","candidates","cv","resume","cover","letter","interview","interviews","shortlisted","successful","suitable","ideal","looking","seeking","seek","join","joining","join us","opportunity to",
  "salary","rate","daily","day","hourly","package","super","superannuation","benefits","bonus","incentive","remuneration","negotiable","dependent","depending",
  "role","roles","responsibilities","responsible","responsibility","duties","duty","key","about","overview","description","summary","details","detail","note","notes",
  "through","throughout","within","across","along","alongside","around","towards","toward","between","against","under","over","into","onto","upon",
  "environment","environments","practices","practice","approach","approaches","culture","team","teams","people","person","individual","someone","anyone","everyone",
  "work","working","works","worked","experience","experienced","years","year","months","month","weeks","week","hours","hour","time","full","part",
  "will","would","should","could","can","may","might","need","needs","needed","want","wants","wanted","expect","expected","expects",
  "strong","excellent","proven","demonstrated","demonstrable","solid","good","great","high","highly","well","best","better","deep","extensive","significant","relevant","appropriate",
  "skills","skill","knowledge","understanding","familiarity","proficiency","proficient","expertise","expert","capability","competency","competencies",
  "please","thank","thanks","contact","email","phone","call","click","link","website","www","http","https","com","au",
  "love","hear","hearing","confidential","discussion","conversation","chat","touch","reach","enquiries","enquiry","inquiries","today","now",
  "company","organisation","organization","client","clients","customer","customers","business","businesses","stakeholder","stakeholders","industry","sector","government","federal","state","department","agency","agencies",
  "date","dates","start","starting","asap","immediate","immediately","initial","extension","extensions","possible","possibility","likely","until","end","ending","closing","close","closes",
]);

const GLUE = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "across", "over", "your", "our", "its", "has", "have", "are", "not", "but", "all", "any", "via", "per", "a", "an", "of", "in", "on", "to", "by", "as", "at", "or", "is", "be", "it", "will", "you", "we"]);

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+|•|•/).map((s) => s.trim()).filter((s) => s.length > 12);
}

function suggestCategory(term: string, sampleOriginal: string): MinedTerm["suggested_category"] {
  if (CERT_PATTERN.test(sampleOriginal) && CERT_PATTERN.test(term.toUpperCase())) return "certification";
  if (/certif/i.test(term)) return "certification";
  if (TITLE_HINT.test(term) && term.split(" ").length <= 3) return "title";
  if (METHOD_HINT.test(term)) return "methodology";
  if (/\b(servicenow|salesforce|sharepoint|dynamics|azure|aws|gcp|kubernetes|snowflake|databricks|power platform|microsoft 365|m365|office 365|copilot|openai|anthropic|claude|langchain|terraform|jira|confluence)\b/i.test(term)) return "platform";
  if (/\b(python|typescript|javascript|java|sql|react|node|dotnet|net core|c#|golang|rust|graphql|kafka|docker)\b/i.test(term)) return "tool";
  if (/\b(rag|llm|agentic|agent|vector|embedding|prompt|fine tuning|guardrail|evaluation|observability|mlops|llmops)\b/i.test(term)) return "concept";
  return "domain";
}

/** Per-document term presence for background (whole-pipeline) frequency. */
function docTermSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const words = normalise(sentence).trim().split(" ").filter(Boolean);
    for (const n of [1, 2, 3] as const) for (const g of ngrams(words, n)) set.add(g);
  }
  return set;
}

export function mineTerms(
  docs: MinedDoc[],
  corpusText: string,
  opts: { minDf?: number; top?: number; titles?: string[]; includeTitles?: boolean; backgroundDocs?: MinedDoc[] } = {},
): MinedTerm[] {
  const minDf = opts.minDf ?? 2;
  const fullDocs = docs.filter((d) => d.text);
  const inType = new Set(fullDocs.map((d) => d.id));
  // Background = every other full JD in the pipeline, regardless of resume type.
  // A term that shows up in most of those is advert-speak, not a capability.
  const background = (opts.backgroundDocs ?? []).filter((d) => d.text && !inType.has(d.id));
  const backgroundDf = new Map<string, number>();
  for (const doc of background) for (const term of docTermSet(doc.text)) backgroundDf.set(term, (backgroundDf.get(term) ?? 0) + 1);
  const normCorpus = normalise(corpusText);
  const stemSet = buildStemSet(normCorpus);

  type Acc = { df: number; must: number; sample: string; sampleOriginal: string; ngram: 1 | 2 | 3; title_df: number };
  const acc = new Map<string, Acc>();

  for (const doc of fullDocs) {
    const perDoc = new Map<string, { must: boolean; sample: string }>();
    for (const sentence of splitSentences(doc.text)) {
      const must = MUST_CUES.test(sentence) && !NICE_CUES.test(sentence);
      const words = normalise(sentence).trim().split(" ").filter(Boolean);
      for (const n of [1, 2, 3] as const) {
        for (const g of ngrams(words, n)) {
          const prev = perDoc.get(g);
          if (!prev) perDoc.set(g, { must, sample: sentence });
          else if (must && !prev.must) perDoc.set(g, { must: true, sample: sentence });
        }
      }
    }
    for (const [term, info] of perDoc) {
      const a = acc.get(term) ?? { df: 0, must: 0, sample: info.sample, sampleOriginal: info.sample, ngram: term.split(" ").length as 1 | 2 | 3, title_df: 0 };
      a.df += 1;
      if (info.must) a.must += 1;
      if (info.must && !MUST_CUES.test(a.sample)) a.sample = info.sample;
      acc.set(term, a);
    }
  }

  // Titles: count per-term presence across every matching row's title.
  const titles = opts.titles ?? [];
  for (const title of titles) {
    const words = normalise(title).trim().split(" ").filter(Boolean);
    const seen = new Set<string>();
    for (const n of [1, 2, 3] as const) for (const g of ngrams(words, n)) seen.add(g);
    for (const g of seen) {
      const a = acc.get(g);
      if (a) a.title_df += 1;
      else if (opts.includeTitles) acc.set(g, { df: 0, must: 0, sample: title, sampleOriginal: title, ngram: g.split(" ").length as 1 | 2 | 3, title_df: 1 });
    }
  }

  const out: MinedTerm[] = [];
  for (const [term, a] of acc) {
    const df = a.df + (opts.includeTitles ? Math.min(a.title_df, 1) : 0);
    if (df < minDf && a.title_df < minDf) continue;
    const words = term.split(" ");
    const present = words.length === 1 ? tokenInText(term, normCorpus, stemSet) : phraseInText(term, normCorpus) || phraseInText(words.map(stem).join(" "), normalise(corpusText.split(" ").map(stem).join(" ")));
    const category = suggestCategory(term, a.sampleOriginal);
    const tier: MinedTerm["suggested_tier"] = present ? "corpus" : category === "certification" ? "forbidden" : category === "concept" || category === "methodology" ? "preppable" : "confirm";
    // Longer phrases are more specific and worth more; must-have mentions weigh double;
    // terms common across unrelated JDs are penalised (background ratio).
    const bgRatio = background.length ? (backgroundDf.get(term) ?? 0) / background.length : 0;
    const distinctiveness = 1 - 0.85 * bgRatio;
    const score = (a.df + 2 * a.must + 0.5 * a.title_df) * (1 + 0.35 * (words.length - 1)) * distinctiveness;
    out.push({
      term,
      ngram: a.ngram,
      df: a.df,
      must_have_df: a.must,
      title_df: a.title_df,
      background_df: backgroundDf.get(term) ?? 0,
      // mineTerms is cloud-agnostic; mineLexicon fills these from the type's clouds.
      suggested_cloud: null,
      suggested_cloud_kind: null,
      sample_context: a.sample.slice(0, 160),
      corpus_status: present ? "present" : "absent",
      corpus_lines: present ? corpusLinesFor(term, corpusText) : [],
      suggested_tier: tier,
      suggested_category: category,
      score: Math.round(score * 100) / 100,
    });
  }

  // Drop unigrams fully covered by a higher-scoring bigram that contains them
  // (keeps "solution architecture" over a lone "architecture"-style noise).
  out.sort((x, y) => y.score - x.score || y.df - x.df || x.term.localeCompare(y.term));
  const kept: MinedTerm[] = [];
  for (const t of out) {
    if (t.ngram === 1 && kept.some((k) => k.ngram > 1 && k.term.split(" ").includes(t.term) && k.df >= t.df * 0.8)) continue;
    kept.push(t);
  }
  return kept.slice(0, opts.top ?? 60);
}

const CLOUD_STOP = new Set(["and", "or", "the", "of", "for", "a", "an", "in", "to"]);

function contentTokens(text: string): Set<string> {
  return new Set(normalise(text).split(" ").map(stem).filter((t) => t.length >= 3 && !CLOUD_STOP.has(t)));
}

/**
 * Nearest keyword cloud for a mined term: the cloud whose own terms, aliases
 * and label share the most content tokens with it.
 *
 * Deliberately a suggestion, not a decision. A mined term is raw research; the
 * /resume-strategy cloud refresh is where a human decides which cloud owns it.
 */
export function suggestCloud(
  term: string,
  clouds: Array<{ id: string; kind: string; label: string; terms?: Array<{ term: string; aliases?: string[] }> }>,
): { id: string; kind: string } | null {
  const want = contentTokens(term);
  if (!want.size) return null;
  let best: { id: string; kind: string; score: number } | null = null;
  for (const cloud of clouds) {
    let score = 0;
    for (const phrase of [cloud.label, ...(cloud.terms ?? []).flatMap((t) => [t.term, ...(t.aliases ?? [])])]) {
      const have = contentTokens(phrase);
      let overlap = 0;
      for (const t of want) if (have.has(t)) overlap += 1;
      if (!overlap) continue;
      // normalise by phrase length so a long phrase does not win on sheer size
      score = Math.max(score, overlap / Math.max(want.size, have.size));
    }
    if (score > 0 && (!best || score > best.score)) best = { id: cloud.id, kind: cloud.kind, score };
  }
  return best ? { id: best.id, kind: best.kind } : null;
}

export function titleFamilies(titles: string[], top = 10): Array<{ title: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of titles) {
    const t = raw.toLowerCase().replace(/\s*[-–|(].*$/, "").replace(/\b(senior|principal|lead|contract|contractor|permanent|remote|hybrid|sydney|melbourne|brisbane|canberra|nsw|vic|qld)\b/g, "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, top);
}

export async function mineLexicon(args: Record<string, string>): Promise<MineResult> {
  const resumeId = args.resume;
  if (!resumeId) throw new Error("--resume <id> is required");
  const ctx = resolveProfileContext(args.profile);
  const resume: any = await getResume(resumeId, { profileId: ctx.profileId });
  if (!resume) throw new Error(`Resume '${resumeId}' not found in ${ctx.resumesPath}`);
  const corpusText = (await readText(ctx.cvSourcePath)) ?? "";

  const { docs, titles, matchingRows, backgroundDocs } = await collectCorpus({
    resumeId,
    searchKeywords: resume.search_keywords ?? [],
    pipelinePath: args.pipeline,
    classificationsPath: args.classifications,
    archiveDir: args.archive,
  });
  const fullDocs = docs.filter((d) => d.text);
  const archiveDocs = fullDocs.filter((d) => d.source === "archive").length;
  const thin = fullDocs.length < THIN_CORPUS_DOCS;

  const cloudsFile = await loadKeywordClouds();
  const resolved = resolveCloudsForType(resume.market_lens, cloudsFile);
  // Fall back to every declared cloud when the type references none yet: a
  // pre-migration type still gets useful grouping suggestions.
  const candidates = resolved.length
    ? resolved.map((c) => ({ id: c.id, kind: c.kind, label: c.label, terms: c.terms }))
    : cloudsFile.clouds.map((c) => ({ id: c.id, kind: c.kind, label: c.label ?? c.id, terms: c.terms }));

  const terms = mineTerms(docs, corpusText, {
    minDf: args["min-df"] ? Number(args["min-df"]) : undefined,
    top: args.top ? Number(args.top) : undefined,
    titles,
    includeTitles: args["include-titles"] === "true",
    backgroundDocs,
  });

  return {
    resume_id: resumeId,
    generated_at: new Date().toISOString(),
    corpus: {
      matching_rows: matchingRows,
      background_docs: backgroundDocs.filter((d) => !fullDocs.some((f) => f.id === d.id)).length,
      full_text_docs: fullDocs.length,
      archive_docs: archiveDocs,
      title_only_rows: docs.filter((d) => !d.text).length,
      thin,
      note: thin
        ? `Only ${fullDocs.length} full job descriptions (>= ${MIN_FULL_TEXT_CHARS} chars) matched this resume type; treat rankings as indicative. Run 'npm run seek:enrich -- --status any --min-score 60 --limit 30 --resume ${resumeId}' in an attended session to widen the corpus, then fall back to the market-lens web pass for gaps.`
        : `${fullDocs.length} full job descriptions matched; document frequencies are meaningful.`,
    },
    title_families: titleFamilies(titles),
    clouds: resolved.map((c) => ({ id: c.id, kind: c.kind, label: c.label, weight: c.weight })),
    terms: terms.map((t) => {
      const hit = suggestCloud(t.term, candidates);
      return { ...t, suggested_cloud: hit?.id ?? null, suggested_cloud_kind: (hit?.kind as MinedTerm["suggested_cloud_kind"]) ?? null };
    }),
  };
}

function printTable(result: MineResult): void {
  console.log(`# lexicon:mine ${result.resume_id}`);
  console.log(`corpus: ${result.corpus.full_text_docs} full JDs (${result.corpus.archive_docs} archived), ${result.corpus.title_only_rows} title-only rows, ${result.corpus.matching_rows} matching rows, ${result.corpus.background_docs} background JDs from other types`);
  console.log(result.corpus.note);
  console.log("");
  console.log("title families:");
  for (const f of result.title_families) console.log(`  ${String(f.count).padStart(3)}  ${f.title}`);
  console.log("");
  if (result.clouds.length) {
    console.log("clouds referenced by this positioning (weight):");
    for (const c of result.clouds) console.log(`  ${c.weight}  ${c.id}  [${c.kind}]  ${c.label}`);
    console.log("");
  }

  // Grouped by suggested cloud, in the positioning's own weight order, so the
  // refresh reads as "here is what the market added to THIS cloud".
  const order = new Map(result.clouds.map((c, i) => [c.id, i]));
  const groups = new Map<string, MinedTerm[]>();
  for (const t of result.terms) (groups.get(t.suggested_cloud ?? "") ?? groups.set(t.suggested_cloud ?? "", []).get(t.suggested_cloud ?? "")!).push(t);
  const ids = [...groups.keys()].sort((a, b) =>
    (a ? order.get(a) ?? 500 : 999) - (b ? order.get(b) ?? 500 : 999) || a.localeCompare(b));
  for (const id of ids) {
    console.log(`## ${id || "(no cloud suggestion)"}`);
    console.log("score  df  must  title  bg  status   tier        category       term");
    for (const t of groups.get(id)!) {
      console.log(`${String(t.score).padStart(5)}  ${String(t.df).padStart(2)}  ${String(t.must_have_df).padStart(4)}  ${String(t.title_df).padStart(5)}  ${String(t.background_df).padStart(2)}  ${t.corpus_status.padEnd(8)} ${t.suggested_tier.padEnd(11)} ${t.suggested_category.padEnd(14)} ${t.term}`);
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.resume) {
    console.error("Usage: tsx tools/resume/lexicon-mine.ts --resume <id> [--profile <id>] [--min-df 2] [--top 60] [--include-titles] [--json] [--out <path>]");
    process.exit(2);
  }
  const result = await mineLexicon(args);
  if (args.out) {
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, JSON.stringify(result, null, 2));
  }
  if (args.json === "true") console.log(JSON.stringify(result, null, 2));
  else printTable(result);
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
