import JSZip from "jszip"
import {
  listEvidenceWithContentForViewer,
  sanitiseGroupName,
} from "@/lib/cases/evidence"
import { getSession } from "@/lib/auth/session"

// Hard caps for the bundle. JSZip builds the whole archive in memory; an
// unbounded loop could OOM a serverless instance. With the upload cap at
// 2 MB/file, the file-count cap (200) sets the worst-case raw payload at
// ~400 MB, which the total-size cap (64 MB) trims long before we get
// there. If a case ever needs more, swap to a streaming zip + chunked
// response — that's a bigger lift, not warranted yet.
const MAX_BUNDLE_FILES = 200
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

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
  if (items.length > MAX_BUNDLE_FILES) {
    return new Response(
      `Bundle exceeds the ${MAX_BUNDLE_FILES}-file limit`,
      { status: 413 },
    )
  }
  const totalBytes = items.reduce((n, it) => n + it.size, 0)
  if (totalBytes > MAX_BUNDLE_BYTES) {
    return new Response(
      `Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte limit`,
      { status: 413 },
    )
  }

  const zip = new JSZip()
  const used = new Set<string>()
  // Defense-in-depth — the upload-time sanitiser strips traversal +
  // non-filename-safe chars, but a stale row from before the sanitiser
  // tightened (or a hand-crafted DB insert) could still smuggle weird
  // characters or hidden-dir prefixes into a ZIP entry name. Reuse the
  // same sanitiser at write time so the bundle is independently safe.
  const safeFolder = (raw: string | null): string =>
    sanitiseGroupName(raw) ?? "uncategorised"
  const manifest = items.map((it) => {
    const folder = safeFolder(it.groupName)
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
