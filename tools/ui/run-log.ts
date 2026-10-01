import { promises as fs } from "node:fs";

/** Find the latest start in an appended daily log without loading its transcript. */
export async function readRunLogEdges(file: string, edgeBytes = 8192) {
  const handle = await fs.open(file, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    const tailBuffer = Buffer.alloc(Math.min(edgeBytes, size));
    await handle.read(tailBuffer, 0, tailBuffer.length, size - tailBuffer.length);
    const tail = tailBuffer.toString("utf8");
    if (size <= edgeBytes) return { head: tail, tail, mtime_ms: mtimeMs };
    let end = size;
    let newerPrefix = "";
    while (end > 0) {
      const start = Math.max(0, end - 65536);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const chunk = buffer.toString("utf8");
      const starts = [...(chunk + newerPrefix).matchAll(/^===\s*\S+\s+starting daily run[^\n]*/gm)];
      if (starts.length) return { head: starts[starts.length - 1][0], tail, mtime_ms: mtimeMs };
      // Keep a marker split across a chunk boundary intact on the next read.
      newerPrefix = chunk.slice(0, 512);
      end = start;
    }
    return { head: "", tail, mtime_ms: mtimeMs };
  } finally {
    await handle.close();
  }
}
