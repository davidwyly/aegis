import JSZip from "jszip"
import { listBriefsForViewer } from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"

/**
 * Bundle every brief the viewer is allowed to see into a single .zip.
 * Visibility tracks listBriefsForViewer — parties see their own pre-resolution,
 * panelists see all once assigned, post-resolution everyone sees all.
 *
 * Naming: `${role}-${shortAddr}.txt` for plaintext briefs, `${role}-${shortAddr}.sealed.json`
 * for encrypted ones. A `manifest.json` at the root lists authors, submission
 * times, and encryption status so an offline recipient can map files back to
 * parties.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const session = await getSession()
  const briefs = await listBriefsForViewer(id, session.address ?? null)
  if (briefs.length === 0) {
    return new Response("No briefs visible", { status: 404 })
  }

  const zip = new JSZip()
  const manifest = briefs.map((b) => {
    const short = `${b.authorAddress.slice(2, 8)}`
    const fileName = b.isEncrypted
      ? `${b.role}-${short}.sealed.json`
      : `${b.role}-${short}.txt`
    if (b.isEncrypted) {
      zip.file(fileName, JSON.stringify(b.sealed, null, 2))
    } else {
      zip.file(fileName, b.body)
    }
    return {
      file: fileName,
      role: b.role,
      authorAddress: b.authorAddress,
      submittedAt: b.submittedAt,
      isEncrypted: b.isEncrypted,
    }
  })
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        kind: "aegis-briefs-bundle",
        version: 1,
        caseUuid: id,
        generatedAt: new Date().toISOString(),
        items: manifest,
      },
      null,
      2,
    ),
  )

  const buffer = await zip.generateAsync({ type: "uint8array" })
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="aegis-briefs-${id.slice(0, 8)}.zip"`,
      "Cache-Control": "private, no-cache",
    },
  })
}
