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
    const item = await uploadEvidence({
      caseUuid: id,
      uploaderAddress: session.address,
      fileName: (file as File).name,
      mimeType: (file as File).type,
      content: Buffer.from(arrayBuf),
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
