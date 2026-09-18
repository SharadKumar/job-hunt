/**
 * tests/fixtures/archive/make-archive.ts — a throwaway archive to compact.
 *
 * Everything here is invented: a two-line "docx", a "pdf", a noise PNG that is
 * a real PNG (chromium has to be able to decode it) and big enough to trip the
 * 300 KB screenshot threshold. Nothing is copied from the owner's state.
 *
 * Layout built under a fresh temp root:
 *
 *   state/profile/resumes/fixture-resume/{Fixture-Person_Architect.docx,.pdf,.md,metadata.json}
 *   state/pipeline/classification-batch-a.json          (scratch)
 *   state/pipeline/archive/pkg-baseline/                (copies of the baseline set)
 *   state/pipeline/archive/pkg-tailored/                (its own, unique CV)
 */

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/**
 * A valid 8-bit RGB PNG of deterministic pseudo-noise. Noise is the point:
 * a flat colour deflates to a few hundred bytes and would never look like the
 * 1.3 MB screenshots this tool exists to shrink.
 */
export function noisePng(width = 520, height = 320): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width * 3; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[row + 1 + x] = (seed >> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export type ArchiveFixture = {
  root: string;
  archiveDir: string;
  baselinesDir: string;
  baselineDir: string;
  baselinePackage: string;
  tailoredPackage: string;
  scratchFile: string;
  screenshot: string;
  docxName: string;
  docxSha256: string;
};

export function makeArchiveFixture(): ArchiveFixture {
  const root = mkdtempSync(path.join(tmpdir(), "archive-compact-test-"));
  const baselinesDir = path.join(root, "state", "profile", "resumes");
  const baselineDir = path.join(baselinesDir, "fixture-resume");
  const archiveDir = path.join(root, "state", "pipeline", "archive");
  const baselinePackage = path.join(archiveDir, "pkg-baseline");
  const tailoredPackage = path.join(archiveDir, "pkg-tailored");
  for (const dir of [baselineDir, baselinePackage, tailoredPackage]) mkdirSync(dir, { recursive: true });

  const docxName = "Fixture-Person_Architect.docx";
  const docx = Buffer.from("PK-fixture-docx: approved baseline body\n");
  const pdf = Buffer.from("%PDF-fixture-1.4\nfixture baseline pdf\n");
  const md = Buffer.from("# Fixture Person\n\nApproved baseline markdown.\n");
  writeFileSync(path.join(baselineDir, docxName), docx);
  writeFileSync(path.join(baselineDir, "Fixture-Person_Architect.pdf"), pdf);
  writeFileSync(path.join(baselineDir, "Fixture-Person_Architect.md"), md);
  const contentHash = createHash("sha256").update("fixture-baseline-content").digest("hex");
  writeFileSync(path.join(baselineDir, "metadata.json"), JSON.stringify({
    resume_id: "fixture-resume",
    template: "classic",
    content_hash: contentHash,
    approved_hash: contentHash,
    approved_at: "2026-09-01T00:00:00.000Z",
    approval_status: "approved",
    page_count: 3,
    artefacts: {
      docx: path.join(baselineDir, docxName),
      pdf: path.join(baselineDir, "Fixture-Person_Architect.pdf"),
      md: path.join(baselineDir, "Fixture-Person_Architect.md"),
    },
  }, null, 2));

  // Baseline-mode package: byte-identical copies of the baseline set.
  for (const name of [docxName, "Fixture-Person_Architect.pdf", "Fixture-Person_Architect.md"]) {
    copyFileSync(path.join(baselineDir, name), path.join(baselinePackage, name));
  }
  writeFileSync(path.join(baselinePackage, "cover-letter.md"), "Dear hiring team,\n\nI ran the gateway stream.\n");
  writeFileSync(path.join(baselinePackage, "jd.md"), "# Fixture role\n");
  writeFileSync(path.join(baselinePackage, "metadata.json"), JSON.stringify({
    opportunityId: "pkg-baseline",
    resumeId: "fixture-resume",
    mode: "baseline",
    resume: { docx: path.join(baselinePackage, docxName), pdf: path.join(baselinePackage, "Fixture-Person_Architect.pdf"), pages: 3 },
    submitted: true,
  }, null, 2));
  const screenshot = path.join(baselinePackage, "pkg-baseline-success.png");
  writeFileSync(screenshot, noisePng());
  writeFileSync(path.join(baselinePackage, "confirmation.txt"), "Applied 2026-09-14.\n");

  // Tailored package: a CV that exists nowhere else and must never be touched.
  const tailoredDocx = path.join(tailoredPackage, "Fixture-Person_Tailored.docx");
  writeFileSync(tailoredDocx, Buffer.from("PK-fixture-docx: tailored for this role only\n"));
  writeFileSync(path.join(tailoredPackage, "cover-letter.md"), "Dear hiring team,\n\nTailored.\n");
  writeFileSync(path.join(tailoredPackage, "metadata.json"), JSON.stringify({
    opportunityId: "pkg-tailored",
    resumeId: "fixture-resume",
    mode: "tailored",
    resume: { mode: "tailored", docx: tailoredDocx },
  }, null, 2));

  const scratchFile = path.join(root, "state", "pipeline", "classification-batch-a.json");
  writeFileSync(scratchFile, JSON.stringify({ stale: true, rows: [] }));

  return {
    root,
    archiveDir,
    baselinesDir,
    baselineDir,
    baselinePackage,
    tailoredPackage,
    scratchFile,
    screenshot,
    docxName,
    docxSha256: createHash("sha256").update(docx).digest("hex"),
  };
}
