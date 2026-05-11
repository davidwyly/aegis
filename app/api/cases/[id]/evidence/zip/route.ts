import JSZip from "jszip"
import { listEvidenceWithContentForViewer } from "@/lib/cases/evidence"
import { getSession } from "@/lib/auth/session"

/**
 * Bundle every evidence file the viewer is allowed to see into a single
 * .zip. Files are nested under their groupName directory; uploads with
 * no group land under an `uncategorised/` folder, matching the panel UI.
 * A manifest.json captures uploader, role, size, sha256, and encryption
 * metadata so a recipient can re-verify downloaded artefacts off-line.
 *
 * Encrypted evidence is included as-is (ciphertext); the manifest carries
 * the sealedRecipients + bodyNonce so the holder of a recipient key can
 * decrypt locally.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const session = await getSession()
  const items = await listEvidenceWithContentForViewer(id, session.address ?? null)
  if (items.length === 0) {
    return new Response("No evidence visible", { status: 404 })
  }

  const zip = new JSZip()
  const used = new Set<string>()
  const manifest = items.map((it) => {
    const folder = it.groupName?.trim() || "uncategorised"
    // De-dupe colliding filenames within the same folder. First try the
    // raw filename, then prepend a growing slice of the row's UUID until
    // unique — handles the pathological case where another uploader's
    // file already happens to match the id-prefixed slug.
    let entryName = `${folder}/${it.fileName}`
    if (used.has(entryName)) {
      let prefixLen = 8
      do {
        entryName = `${folder}/${it.id.slice(0, prefixLen)}-${it.fileName}`
        prefixLen += 4
      } while (used.has(entryName) && prefixLen <= it.id.length)
    }
    used.add(entryName)
    zip.file(entryName, it.content)
    return {
      file: entryName,
      role: it.role,
      uploaderAddress: it.uploaderAddress,
      uploadedAt: it.uploadedAt,
      mimeType: it.mimeType,
      size: it.size,
      sha256: it.sha256,
      isEncrypted: it.isEncrypted,
      bodyNonce: it.bodyNonce,
      sealedRecipients: it.sealedRecipients,
    }
  })
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        kind: "aegis-evidence-bundle",
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
      "Content-Disposition": `attachment; filename="aegis-evidence-${id.slice(0, 8)}.zip"`,
      "Cache-Control": "private, no-cache",
    },
  })
}
