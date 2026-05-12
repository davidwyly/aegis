import JSZip from "jszip"
import {
  evidenceCasePreflight,
  fetchEvidenceContentByIds,
  listEvidenceForViewer,
  sanitiseFileName,
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
  // Short-circuit anonymous callers — listEvidenceForViewer hits the
  // case + evidence rows before checking viewer, so without this every
  // unauthenticated request to a public URL would scan the evidence
  // table. Same visible behaviour either way (empty → 404), but cheap.
  if (!session.address) {
    return new Response("No evidence visible", { status: 404 })
  }
  // Aggregate preflight — case-wide COUNT + SUM(size) in one query, no
  // row materialisation. A case with thousands of attachments (an
  // upload-spam vector) fails here without listEvidenceForViewer ever
  // running. The caps are case-wide; visible-to-viewer counts are
  // always ≤ this, so over-cap here means over-cap for any viewer.
  const pre = await evidenceCasePreflight(id)
  if (pre.count > MAX_BUNDLE_FILES) {
    return new Response(
      `Bundle exceeds the ${MAX_BUNDLE_FILES}-file limit`,
      { status: 413 },
    )
  }
  if (pre.totalBytes > MAX_BUNDLE_BYTES) {
    return new Response(
      `Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte limit`,
      { status: 413 },
    )
  }
  // Two-pass: pull metadata-only summaries first and re-check viewer-
  // scoped caps before touching the content bytea (preflight is case-
  // wide; the per-viewer slice may differ for non-resolved cases).
  const summaries = await listEvidenceForViewer(id, session.address)
  if (summaries.length === 0) {
    return new Response("No evidence visible", { status: 404 })
  }
  if (summaries.length > MAX_BUNDLE_FILES) {
    return new Response(
      `Bundle exceeds the ${MAX_BUNDLE_FILES}-file limit`,
      { status: 413 },
    )
  }
  const totalBytes = summaries.reduce((n, it) => n + it.size, 0)
  if (totalBytes > MAX_BUNDLE_BYTES) {
    return new Response(
      `Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte limit`,
      { status: 413 },
    )
  }
  // Caps passed — now pull content in one bulk query.
  const contentById = await fetchEvidenceContentByIds(
    summaries.map((s) => s.id),
  )

  const zip = new JSZip()
  const used = new Set<string>()
  // Defense-in-depth — the upload-time sanitiser strips traversal +
  // non-filename-safe chars, but a stale row from before the sanitiser
  // tightened (or a hand-crafted DB insert) could still smuggle weird
  // characters or hidden-dir prefixes into a ZIP entry name. Reuse the
  // same sanitiser at write time so the bundle is independently safe.
  const safeFolder = (raw: string | null): string =>
    sanitiseGroupName(raw) ?? "uncategorised"
  // Same defense for the file portion of the ZIP entry. The upload
  // path already runs sanitiseFileName, but a tampered row could
  // smuggle "..", ".", or path separators — any of which would let an
  // extractor produce an entry like `documents/../foo` that escapes
  // the extraction root. Re-run the same sanitiser at write time; on
  // rejection, fall back to a synthetic id-prefixed name so the file
  // still lands in the bundle.
  const manifest = summaries.flatMap((it) => {
    const content = contentById.get(it.id)
    if (!content) return []
    const folder = safeFolder(it.groupName)
    const baseName = sanitiseFileName(it.fileName) ?? `file-${it.id.slice(0, 8)}`
    // De-dupe colliding filenames within the same folder. First try the
    // sanitised base, then prepend a growing slice of the row's UUID until
    // unique — handles the pathological case where another uploader's
    // file already happens to match the id-prefixed slug.
    let entryName = `${folder}/${baseName}`
    if (used.has(entryName)) {
      let prefixLen = 8
      do {
        entryName = `${folder}/${it.id.slice(0, prefixLen)}-${baseName}`
        prefixLen += 4
      } while (used.has(entryName) && prefixLen <= it.id.length)
    }
    used.add(entryName)
    zip.file(entryName, content)
    return [
      {
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
      },
    ]
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

  // ArrayBuffer rather than uint8array — TS 5.7+ types Uint8Array as
  // Uint8Array<ArrayBufferLike>, which isn't directly assignable to
  // BodyInit. ArrayBuffer is. Same bytes on the wire either way.
  const buffer = await zip.generateAsync({ type: "arraybuffer" })
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="aegis-evidence-${id.slice(0, 8)}.zip"`,
      "Cache-Control": "private, no-cache",
    },
  })
}
