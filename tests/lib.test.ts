/**
 * tests/lib.test.ts — the shared helpers in tools/lib/.
 *
 * These are consumed by roughly forty tools, so their edge cases (what counts
 * as "not there", what throws, how a bare flag parses) are contract, not
 * detail.
 */

import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  exists,
  readJson,
  readJsonIfExists,
  readYaml,
  readYamlIfExists,
  writeAtomic,
  todayStamp,
} from "../tools/lib/fs.ts";
import { sha256 } from "../tools/lib/hash.ts";
import { parseArgs } from "../tools/lib/args.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-lib-test-"));
const at = (name: string) => path.join(tmp, name);

try {
  /* ------------------------------------------------------------- exists */

  await fs.writeFile(at("present.txt"), "hi");
  await fs.mkdir(at("adir"));
  assert.equal(await exists(at("present.txt")), true);
  assert.equal(await exists(at("adir")), true, "a directory exists");
  assert.equal(await exists(at("missing.txt")), false);
  assert.equal(await exists(null), false, "nullish path is not an existence error");
  assert.equal(await exists(undefined), false);
  assert.equal(await exists(""), false);
  console.log("  ✓ exists covers files, directories, missing paths and nullish input");

  /* --------------------------------------------------------- JSON readers */

  await fs.writeFile(at("good.json"), JSON.stringify({ a: 1, b: ["x"] }));
  await fs.writeFile(at("bad.json"), "{not json");

  assert.deepEqual(await readJson<{ a: number }>(at("good.json")), { a: 1, b: ["x"] });
  await assert.rejects(readJson(at("missing.json")), /ENOENT/, "readJson surfaces a missing file");
  await assert.rejects(readJson(at("bad.json")), "readJson surfaces malformed JSON");

  assert.deepEqual(await readJsonIfExists(at("good.json")), { a: 1, b: ["x"] });
  assert.equal(await readJsonIfExists(at("missing.json")), null, "missing file → null by default");
  assert.deepEqual(
    await readJsonIfExists(at("missing.json"), { fallback: true }),
    { fallback: true },
    "missing file → the supplied fallback",
  );
  await assert.rejects(
    readJsonIfExists(at("bad.json")),
    "malformed JSON still throws; only absence is tolerated",
  );
  assert.equal(await readJsonIfExists(at("bad.json")).catch(() => null), null, "callers opt into parse tolerance");
  console.log("  ✓ readJson throws, readJsonIfExists falls back on absence only");

  /* --------------------------------------------------------- YAML readers */

  await fs.writeFile(at("good.yaml"), "a: 1\nlist:\n  - x\n");
  await fs.writeFile(at("bad.yaml"), "a: [1,\n  b: : :\n");

  assert.deepEqual(await readYaml(at("good.yaml")), { a: 1, list: ["x"] });
  await assert.rejects(readYaml(at("missing.yaml")), /ENOENT/);
  await assert.rejects(readYaml(at("bad.yaml")), "readYaml surfaces malformed YAML");

  assert.deepEqual(await readYamlIfExists(at("good.yaml")), { a: 1, list: ["x"] });
  assert.equal(await readYamlIfExists(at("missing.yaml")), null);
  assert.deepEqual(await readYamlIfExists(at("missing.yaml"), []), []);
  await assert.rejects(readYamlIfExists(at("bad.yaml")), "malformed YAML still throws");
  console.log("  ✓ readYaml throws, readYamlIfExists falls back on absence only");

  /* ---------------------------------------------------------- writeAtomic */

  const target = at("atomic.json");
  await writeAtomic(target, '{"v":1}');
  assert.equal(await fs.readFile(target, "utf8"), '{"v":1}');
  assert.deepEqual(
    (await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp")),
    [],
    "writeAtomic leaves no temp file behind",
  );

  await writeAtomic(target, '{"v":2}');
  assert.equal(await fs.readFile(target, "utf8"), '{"v":2}', "writeAtomic overwrites in place");
  assert.deepEqual((await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp")), []);

  await writeAtomic(at("atomic.bin"), new Uint8Array([1, 2, 3]));
  assert.deepEqual([...(await fs.readFile(at("atomic.bin")))], [1, 2, 3], "writeAtomic takes bytes too");

  await assert.rejects(
    writeAtomic(at("no/such/dir/x.json"), "{}"),
    /ENOENT/,
    "writeAtomic does not create the parent directory; callers own that",
  );
  assert.equal(fsSync.existsSync(at("no")), false);
  console.log("  ✓ writeAtomic renames into place, handles bytes, and never strands a .tmp");

  /* ----------------------------------------------------------- todayStamp */

  assert.equal(todayStamp(new Date("2026-09-17T13:45:00.000Z")), "2026-09-17");
  assert.equal(todayStamp(new Date("2026-01-02T00:00:00.000Z")), "2026-01-02", "zero-padded");
  assert.match(todayStamp(), /^\d{4}-\d{2}-\d{2}$/, "defaults to now");
  assert.equal(todayStamp(), new Date().toISOString().slice(0, 10), "UTC, same as toISOString");
  console.log("  ✓ todayStamp is a zero-padded UTC YYYY-MM-DD");

  /* --------------------------------------------------------------- sha256 */

  const KNOWN_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.equal(sha256(""), KNOWN_EMPTY);
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("abc").length, 64, "full digest by default");
  assert.equal(sha256("abc", 16), "ba7816bf8f01cfea", "length truncates the hex digest");
  assert.equal(sha256("abc", 16).length, 16);
  assert.equal(sha256("abc", 0), "", "a zero length is honoured, not treated as absent");
  assert.equal(sha256("abc", 128), sha256("abc"), "a length beyond 64 cannot invent digits");
  assert.equal(sha256(Buffer.from("abc", "utf8")), sha256("abc"), "bytes and utf8 text agree");
  console.log("  ✓ sha256 matches the known vectors and truncates on request");

  /* ------------------------------------------------------------- parseArgs */

  assert.deepEqual(parseArgs([]), { positionals: [], flags: {} });

  assert.deepEqual(
    parseArgs(["--resume", "architect", "--template", "classic"]),
    { positionals: [], flags: { resume: "architect", template: "classic" } },
    "--key value",
  );
  assert.deepEqual(
    parseArgs(["--resume=architect", "--template=classic"]),
    { positionals: [], flags: { resume: "architect", template: "classic" } },
    "--key=value",
  );
  assert.deepEqual(
    parseArgs(["--out=", "--note=a=b"]),
    { positionals: [], flags: { out: "", note: "a=b" } },
    "an empty inline value is a value; only the first = splits",
  );

  assert.deepEqual(
    parseArgs(["--json"]),
    { positionals: [], flags: { json: true } },
    "a trailing bare flag is boolean true, not the string 'true'",
  );
  assert.deepEqual(
    parseArgs(["--json", "--out", "x"]),
    { positionals: [], flags: { json: true, out: "x" } },
    "a flag followed by another --x is boolean",
  );

  assert.deepEqual(
    parseArgs(["list", "--profile", "p", "extra"]),
    { positionals: ["list", "extra"], flags: { profile: "p" } },
    "positionals keep their order around flags",
  );
  assert.deepEqual(
    parseArgs(["--count", "-3"]),
    { positionals: [], flags: { count: "-3" } },
    "a single dash is a value, not a flag",
  );
  assert.deepEqual(
    parseArgs(["--mode", "a", "--mode", "b"]),
    { positionals: [], flags: { mode: "b" } },
    "the last occurrence wins",
  );
  assert.deepEqual(
    parseArgs(["--", "raw"]),
    { positionals: [], flags: { "": "raw" } },
    "a lone -- parses as an empty-named flag, it is NOT a passthrough separator (npm strips its own -- before argv)",
  );
  assert.deepEqual(parseArgs(["--"]), { positionals: [], flags: { "": true } });
  console.log("  ✓ parseArgs handles both grammars, bare flags, positionals and repeats");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("lib.test.ts: all assertions passed");
