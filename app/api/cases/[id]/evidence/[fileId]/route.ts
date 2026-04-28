import { downloadEvidence } from "@/lib/cases/evidence"
import { getSession } from "@/lib/auth/session"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const { id, fileId } = await params
  const session = await getSession()
  const blob = await downloadEvidence(id, fileId, session.address ?? null)
  if (!blob) return new Response("Not found", { status: 404 })

  // Buffer is a Uint8Array at runtime; wrap so the Web Response BodyInit
  // typing accepts it.
  const body = new Uint8Array(blob.content)
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": blob.mimeType,
      "Content-Disposition": `inline; filename="${blob.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-cache",
    },
  })
}
