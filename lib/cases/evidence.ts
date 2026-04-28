import "server-only"
import { createHash } from "node:crypto"
import { eq, and, inArray } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

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

export interface SealedRecipient {
  recipientPubkey: string
  ephemeralPubkey: string
  nonce: string
  wrapped: string
}

export interface UploadEvidenceInput {
  caseUuid: string
  uploaderAddress: `0x${string}`
  fileName: string
  mimeType: string
  /** Body bytes — plaintext when not encrypted, AES-GCM ciphertext when encrypted. */
  content: Buffer
  /** Encryption metadata. Both fields required if either is present. */
  bodyNonce?: string
  sealedRecipients?: SealedRecipient[]
}

export interface EvidenceListItem {
  id: string
  caseUuid: string
  uploaderAddress: string
  role: "partyA" | "partyB"
  fileName: string
  mimeType: string
  size: number
  sha256: string
  uploadedAt: Date
  isEncrypted: boolean
  bodyNonce: string | null
  sealedRecipients: SealedRecipient[] | null
}

export class EvidenceError extends Error {
  constructor(
    public code:
      | "CASE_NOT_FOUND"
      | "NOT_PARTY"
      | "FILE_TOO_LARGE"
      | "MIME_NOT_ALLOWED"
      | "FILE_EMPTY"
      | "FILENAME_REQUIRED",
  ) {
    super(code)
  }
}

const trimFilename = (name: string) =>
  name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200)

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
  const fileName = trimFilename(input.fileName)
  if (!fileName) throw new EvidenceError("FILENAME_REQUIRED")

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
 */
export async function listEvidenceForViewer(
  caseUuid: string,
  viewer: `0x${string}` | null,
): Promise<EvidenceListItem[]> {
  const caseRow = await db.query.cases.findFirst({
    where: eq(schema.cases.id, caseUuid),
  })
  if (!caseRow) return []

  const all = await db
    .select({
      id: schema.evidenceFiles.id,
      caseUuid: schema.evidenceFiles.caseUuid,
      uploaderAddress: schema.evidenceFiles.uploaderAddress,
      role: schema.evidenceFiles.role,
      fileName: schema.evidenceFiles.fileName,
      mimeType: schema.evidenceFiles.mimeType,
      size: schema.evidenceFiles.size,
      sha256: schema.evidenceFiles.sha256,
      isEncrypted: schema.evidenceFiles.isEncrypted,
      bodyNonce: schema.evidenceFiles.bodyNonce,
      sealedRecipients: schema.evidenceFiles.sealedRecipients,
      uploadedAt: schema.evidenceFiles.uploadedAt,
    })
    .from(schema.evidenceFiles)
    .where(eq(schema.evidenceFiles.caseUuid, caseUuid))

  if (!viewer) return []
  const v = viewer.toLowerCase()
  const isParty =
    v === caseRow.partyA.toLowerCase() || v === caseRow.partyB.toLowerCase()
  const isResolved =
    caseRow.status === "resolved" || caseRow.status === "default_resolved"

  if (isParty && !isResolved) {
    return all.filter((e) => e.uploaderAddress.toLowerCase() === v) as EvidenceListItem[]
  }

  const isPanelist = await db.query.panelMembers.findFirst({
    where: (p, { and, eq }) =>
      and(eq(p.caseUuid, caseUuid), eq(p.panelistAddress, v)),
  })
  if (isPanelist || isResolved) return all as EvidenceListItem[]
  return []
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

void inArray // reserved for future bulk fetches
void and
