import { NextResponse } from "next/server"
import {
  uploadEvidence,
  listEvidenceForViewer,
  EVIDENCE_MAX_BYTES,
  EvidenceError,
} from "@/lib/cases/evidence"
import { requireSession, getSession, UnauthorizedError } from "@/lib/auth/session"
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit"

const ERROR_STATUS: Record<EvidenceError["code"], number> = {
  CASE_NOT_FOUND: 404,
  NOT_PARTY: 403,
  FILE_TOO_LARGE: 413,
  MIME_NOT_ALLOWED: 415,
  FILE_EMPTY: 400,
  FILENAME_REQUIRED: 400,
  FILENAME_INVALID: 400,
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const session = await getSession()
  const items = await listEvidenceForViewer(id, session.address ?? null)
  return NextResponse.json({ evidence: items })
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Cap evidence upload spam — each file is up to 2 MB and lands in
    // Postgres bytea. 20 uploads/minute/IP is plenty for a legitimate
    // party assembling a case, and stops a runaway attacker from
    // ballooning the table.
    enforceRateLimit(req, "evidence-upload", { limit: 20, windowMs: 60_000 })
    const { id } = await params
    const session = await requireSession()

    const form = await req.formData()
    const file = form.get("file")
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "Missing 'file' field (multipart/form-data)" },
        { status: 400 },
      )
    }
    // Server-side size guard before reading the buffer — `file.size` is
    // available on the Web `File` interface.
    if ((file as File).size > EVIDENCE_MAX_BYTES) {
      return NextResponse.json(
        { error: "FILE_TOO_LARGE" },
        { status: 413 },
      )
    }

    const arrayBuf = await (file as File).arrayBuffer()

    // Encrypted-evidence variant: client puts AES-GCM nonce + sealed
    // recipients in the form fields; the file body is the ciphertext.
    const bodyNonce = form.get("bodyNonce")
    const sealedJson = form.get("sealedRecipients")
    const fileNameField = form.get("fileName")
    const mimeTypeField = form.get("mimeType")
    const groupNameField = form.get("groupName")

    const item = await uploadEvidence({
      caseUuid: id,
      uploaderAddress: session.address,
      fileName:
        typeof fileNameField === "string" && fileNameField
          ? fileNameField
          : (file as File).name,
      mimeType:
        typeof mimeTypeField === "string" && mimeTypeField
          ? mimeTypeField
          : (file as File).type,
      groupName:
        typeof groupNameField === "string" && groupNameField
          ? groupNameField
          : null,
      content: Buffer.from(arrayBuf),
      bodyNonce:
        typeof bodyNonce === "string" && bodyNonce ? bodyNonce : undefined,
      sealedRecipients:
        typeof sealedJson === "string" && sealedJson
          ? JSON.parse(sealedJson)
          : undefined,
    })
    return NextResponse.json(item, { status: 201 })
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSeconds) },
        },
      )
    }
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    if (err instanceof EvidenceError)
      return NextResponse.json({ error: err.code }, { status: ERROR_STATUS[err.code] })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}
