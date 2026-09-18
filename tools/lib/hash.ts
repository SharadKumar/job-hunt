/**
 * tools/lib/hash.ts — the one sha256 helper.
 *
 * Digest lengths differ by call site on purpose (a provenance record wants the
 * full 64 hex chars, a page fingerprint wants 16), so the length is a per-call
 * argument rather than a constant here.
 */

import { createHash } from "node:crypto";

/**
 * Hex sha256 of `input`. `length`, when given, truncates the digest to that
 * many hex characters; omit it for the full 64.
 */
export function sha256(input: string | Uint8Array, length?: number): string {
  const hex = createHash("sha256").update(input as any).digest("hex");
  return length === undefined ? hex : hex.slice(0, length);
}
