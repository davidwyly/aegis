import "server-only"
import { createHash } from "node:crypto"
import { and, eq, inArray, type SQL } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"
import { resolveViewerVisibility } from "@/lib/cases/visibility"
import type { SealedKey } from "@/lib/crypto/seal"

export const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024 // 2 MB
export const EVIDENCE_ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
])

export interface UploadEvidenceInput {
  caseUuid: string
  uploaderAddress: `0x${string}`
  fileName: string
  mimeType: string
  /** Optional folder/group label so the UI and ZIP bundle can nest by topic. */
  groupName?: string | null
  /** Body bytes — plaintext when not encrypted, AES-GCM ciphertext when encrypted. */
  content: Buffer
  /** Encryption metadata. Both fields required if either is present. */
  bodyNonce?: string
  sealedRecipients?: SealedKey[]
}

export interface EvidenceListItem {
  id: string
  caseUuid: string
  uploaderAddress: string
  role: "partyA" | "partyB"
  fileName: string
  groupName: string | null
  mimeType: string
  size: number
  sha256: string
  uploadedAt: Date
  isEncrypted: boolean
  bodyNonce: string | null
  sealedRecipients: SealedKey[] | null
}

export class EvidenceError extends Error {
  constructor(
    public code:
      | "CASE_NOT_FOUND"
      | "NOT_PARTY"
      | "FILE_TOO_LARGE"
      | "MIME_NOT_ALLOWED"
      | "FILE_EMPTY"
      | "FILENAME_REQUIRED"
      | "FILENAME_INVALID",
  ) {
    super(code)
  }
}

/**
 * Canonical filename sanitiser. Returns null when the input is empty,
 * `.`, `..`, or contains `..` after sanitisation — those names are
 * either zero-information or zip-slip-able and must be rejected by
 * every caller. Upload path checks empty-after-trim *before* calling
 * this (mapping that to FILENAME_REQUIRED) and treats a null return
 * here as FILENAME_INVALID; the ZIP route treats null as "fall back
 * to a synthetic id-prefixed name so the file still lands".
 *
 * Rules:
 *   - replace any char outside [A-Za-z0-9._-] with `_`
 *   - strip leading dots (hidden-file names some extractors treat specially)
 *   - clamp to 200 chars
 *   - reject empty / "." / ".." / contains ".."
 */
export const sanitiseFileName = (name: string): string | null => {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200)
  if (
    cleaned.length === 0 ||
    cleaned === "." ||
    cleaned === ".." ||
    cleaned.includes("..")
  ) {
    return null
  }
  return cleaned
}

// Sanitise an uploader-supplied folder label. Allowed character set is
// filename-safe ASCII; we deliberately reject:
//   - the literal ".", ".."   — these as ZIP directory names create
//     entries like `../foo` that escape the extraction root (zip slip)
//   - any name *containing* ".." — same risk if the consumer's
//     extractor doesn't normalise path segments
//   - leading dots — produce hidden directories that some extractors
//     treat specially
// On rejection we collapse to null (uncategorised) rather than erroring,
// since the upload itself is valid; only the requested folder label is
// dropped.
//
// Exported so the ZIP route can re-apply the same sanitisation at write
// time as defense-in-depth against stale/hand-crafted rows.
export const sanitiseGroupName = (
  name: string | null | undefined,
): string | null => {
  if (!name) return null
  const trimmed = name.trim()
  if (trimmed.length === 0) return null
  const cleaned = trimmed
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 64)
  if (cleaned.length === 0) return null
  if (cleaned === "." || cleaned === ".." || cleaned.includes("..")) return null
  return cleaned
}

export async function uploadEvidence(
  input: UploadEvidenceInput,
): Promise<EvidenceListItem> {
  if (input.content.length === 0) throw new EvidenceError("FILE_EMPTY")
  if (input.content.length > EVIDENCE_MAX_BYTES) {
    throw new EvidenceError("FILE_TOO_LARGE")
  }
  if (!EVIDENCE_ALLOWED_MIME.has(input.mimeType)) {
    throw new EvidenceError("MIME_NOT_ALLOWED")
  }
  // "empty after trim" → REQUIRED; "non-empty but rejected by the
  // sanitiser (e.g. '.', '..', traversal-bearing)" → INVALID. Lets the
  // client tell users "please name this file" vs. "that name isn't
  // allowed".
  if (input.fileName.trim().length === 0) {
    throw new EvidenceError("FILENAME_REQUIRED")
  }
  const fileName = sanitiseFileName(input.fileName)
  if (!fileName) throw new EvidenceError("FILENAME_INVALID")
  const groupName = sanitiseGroupName(input.groupName)

  const caseRow = await db.query.cases.findFirst({
    where: eq(schema.cases.id, input.caseUuid),
  })
  if (!caseRow) throw new EvidenceError("CASE_NOT_FOUND")

  const uploader = input.uploaderAddress.toLowerCase()
  let role: "partyA" | "partyB"
  if (uploader === caseRow.partyA.toLowerCase()) role = "partyA"
  else if (uploader === caseRow.partyB.toLowerCase()) role = "partyB"
  else throw new EvidenceError("NOT_PARTY")

  const sha256 = createHash("sha256").update(input.content).digest("hex")

  // Either both encryption fields or neither.
  const isEncrypted = !!(input.bodyNonce || input.sealedRecipients)
  if (isEncrypted && (!input.bodyNonce || !input.sealedRecipients)) {
    throw new Error("bodyNonce and sealedRecipients must both be present when encrypting")
  }

  const [row] = await db
    .insert(schema.evidenceFiles)
    .values({
      caseUuid: input.caseUuid,
      uploaderAddress: uploader,
      role,
      fileName,
      groupName,
      mimeType: input.mimeType,
      size: input.content.length,
      sha256,
      content: input.content,
      isEncrypted,
      bodyNonce: input.bodyNonce ?? null,
      sealedRecipients: input.sealedRecipients ?? null,
    })
    .returning({
      id: schema.evidenceFiles.id,
      uploadedAt: schema.evidenceFiles.uploadedAt,
    })

  return {
    id: row.id,
    caseUuid: input.caseUuid,
    uploaderAddress: uploader,
    role,
    fileName,
    groupName,
    mimeType: input.mimeType,
    size: input.content.length,
    sha256,
    uploadedAt: row.uploadedAt,
    isEncrypted,
    bodyNonce: input.bodyNonce ?? null,
    sealedRecipients: input.sealedRecipients ?? null,
  }
}

/**
 * Visibility — same rules as briefs:
 *   - the uploader can always see their own
 *   - panelists can read all once the case exists
 *   - opposing party can only read post-resolution
 *   - public ledger never includes evidence pre-resolution
 *
 * The visibility predicate is pushed into SQL so non-visible rows are
 * never returned, and an optional `limit` lets the ZIP route cap the
 * fetch at cap+1 to detect over-cap cases without materialising the
 * whole list.
 */
export async function listEvidenceForViewer(
  caseUuid: string,
  viewer: `0x${string}` | null,
  options: { limit?: number } = {},
): Promise<EvidenceListItem[]> {
  const visibility = await resolveViewerVisibility(caseUuid, viewer)
  if (visibility === "none") return []

  // Push the visibility class into SQL so non-visible rows never come
  // back from Postgres. `own` always implies a non-null viewer (per
  // the helper contract).
  const where: SQL =
    visibility === "own"
      ? (and(
          eq(schema.evidenceFiles.caseUuid, caseUuid),
          eq(schema.evidenceFiles.uploaderAddress, viewer!.toLowerCase()),
        ) as SQL)
      : eq(schema.evidenceFiles.caseUuid, caseUuid)

  const baseQuery = db
    .select({
      id: schema.evidenceFiles.id,
      caseUuid: schema.evidenceFiles.caseUuid,
      uploaderAddress: schema.evidenceFiles.uploaderAddress,
      role: schema.evidenceFiles.role,
      fileName: schema.evidenceFiles.fileName,
      groupName: schema.evidenceFiles.groupName,
      mimeType: schema.evidenceFiles.mimeType,
      size: schema.evidenceFiles.size,
      sha256: schema.evidenceFiles.sha256,
      isEncrypted: schema.evidenceFiles.isEncrypted,
      bodyNonce: schema.evidenceFiles.bodyNonce,
      sealedRecipients: schema.evidenceFiles.sealedRecipients,
      uploadedAt: schema.evidenceFiles.uploadedAt,
    })
    .from(schema.evidenceFiles)
    .where(where)

  const rows =
    options.limit !== undefined
      ? await baseQuery.limit(options.limit)
      : await baseQuery
  return rows as EvidenceListItem[]
}

export interface EvidenceBlob {
  fileName: string
  mimeType: string
  content: Buffer
}

export async function downloadEvidence(
  caseUuid: string,
  evidenceId: string,
  viewer: `0x${string}` | null,
): Promise<EvidenceBlob | null> {
  const visible = await listEvidenceForViewer(caseUuid, viewer)
  const summary = visible.find((e) => e.id === evidenceId)
  if (!summary) return null

  const [row] = await db
    .select({
      content: schema.evidenceFiles.content,
      fileName: schema.evidenceFiles.fileName,
      mimeType: schema.evidenceFiles.mimeType,
    })
    .from(schema.evidenceFiles)
    .where(eq(schema.evidenceFiles.id, evidenceId))
  if (!row) return null
  return {
    fileName: row.fileName,
    mimeType: row.mimeType,
    content: row.content,
  }
}

export interface EvidenceWithContent extends EvidenceListItem {
  content: Buffer
}

/**
 * Bulk content fetch for a known set of evidence ids. Callers that need
 * to apply count/byte caps should run listEvidenceForViewer first, cap
 * the metadata-only list, and only then call this — that keeps oversized
 * cases from pulling every `content` bytea into memory before the route
 * realises it should return 413.
 */
export async function fetchEvidenceContentByIds(
  ids: string[],
): Promise<Map<string, Buffer>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: schema.evidenceFiles.id,
      content: schema.evidenceFiles.content,
    })
    .from(schema.evidenceFiles)
    .where(inArray(schema.evidenceFiles.id, ids))
  return new Map(rows.map((r) => [r.id, r.content]))
}

