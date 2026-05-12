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
  const used = new Set<string>()
  const manifest = briefs.map((b) => {
    // 10 hex chars of the address makes accidental cross-author
    // collisions vanishingly unlikely; `used` is the belt-and-braces
    // guarantee (schema already constrains one brief per author per
    // case, so this only triggers under tampering).
    const baseShort = b.authorAddress.slice(2, 12)
    const ext = b.isEncrypted ? "sealed.json" : "txt"
    let fileName = `${b.role}-${baseShort}.${ext}`
    if (used.has(fileName)) {
      let prefixLen = 14
      do {
        fileName = `${b.role}-${b.authorAddress.slice(2, prefixLen)}.${ext}`
        prefixLen += 4
      } while (used.has(fileName) && prefixLen <= b.authorAddress.length)
    }
    used.add(fileName)
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

  // ArrayBuffer rather than uint8array — TS 5.7+ types Uint8Array as
  // Uint8Array<ArrayBufferLike>, which isn't directly assignable to
  // BodyInit. ArrayBuffer is. Same bytes on the wire either way.
  const buffer = await zip.generateAsync({ type: "arraybuffer" })
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="aegis-briefs-${id.slice(0, 8)}.zip"`,
      "Cache-Control": "private, no-cache",
    },
  })
}
