/**
 * files.ts: upload a local file and attach it to a Twenty record.
 *
 * The flow proved on Twenty 2.60.3 with an API key whose role holds the
 * UPLOAD_FILE flag:
 *   1. metadata mutation createFileUpload(filename, size, fileFolder: FilesField,
 *      fieldMetadataId: <attachment.file field id>) returns an uploadUrl;
 *   2. PUT the bytes to that URL;
 *   3. completeFileUpload(fileId);
 *   4. POST /rest/attachments { id, name, file: [{ fileId, label }], target<Object>Id }.
 */

import { promises as fs } from "node:fs";
import type { TwentyCall } from "./records.ts";

async function gql(call: TwentyCall, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const j = await call("POST", "/metadata", { query, variables });
  if (j.errors?.length) throw new Error(`Twenty metadata: ${String(j.errors[0]?.message ?? "error").slice(0, 200)}`);
  return j.data;
}

/** The id of the attachment object's FILES field, which every upload names. */
export async function attachmentFileFieldId(call: TwentyCall): Promise<string> {
  const data = await gql(call, "{ objects(paging: { first: 500 }) { edges { node { nameSingular fieldsList { id name type } } } } }");
  const att = (data?.objects?.edges ?? []).map((e: any) => e.node).find((n: any) => n.nameSingular === "attachment");
  const field = att?.fieldsList?.find((f: any) => f.type === "FILES" && f.name === "file");
  if (!field?.id) throw new Error("Twenty: the attachment object has no FILES field named file");
  return field.id;
}

export type AttachInput = { id: string; name: string; path: string; targetField: string; targetId: string };

/** Upload one file and create its attachment record with the given id. */
export async function uploadAttachment(call: TwentyCall, fieldId: string, a: AttachInput, fetchImpl: typeof fetch = fetch): Promise<void> {
  const bytes = await fs.readFile(a.path);
  const data = await gql(
    call,
    "mutation($filename: String!, $size: Float!, $fieldMetadataId: String) { createFileUpload(filename: $filename, size: $size, fileFolder: FilesField, fieldMetadataId: $fieldMetadataId) { fileId uploadUrl contentType } }",
    { filename: a.name, size: bytes.length, fieldMetadataId: fieldId },
  );
  const target = data?.createFileUpload;
  if (!target?.uploadUrl || !target?.fileId) throw new Error("Twenty: createFileUpload returned no upload URL");
  const put = await fetchImpl(target.uploadUrl, { method: "PUT", headers: { "Content-Type": target.contentType || "application/octet-stream" }, body: bytes });
  if (!put.ok) throw new Error(`Twenty file upload PUT ${put.status}`);
  await gql(call, "mutation($fileId: String!) { completeFileUpload(fileId: $fileId) { id } }", { fileId: target.fileId });
  await call("POST", "/rest/attachments", { id: a.id, name: a.name, file: [{ fileId: target.fileId, label: a.name }], [a.targetField]: a.targetId });
}
