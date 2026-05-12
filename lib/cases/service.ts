import "server-only"
import { eq, and, desc, lt, or, sql, inArray } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"
import { z } from "zod"

export interface OnchainCaseRequestedSnapshot {
  chainId: number
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
  escrowAddress: `0x${string}`
  escrowCaseId: `0x${string}`
  partyA: `0x${string}`
  partyB: `0x${string}`
  feeToken: `0x${string}`
  amount: bigint
  panelSize: number
}

export async function recordCaseRequested(
  snap: OnchainCaseRequestedSnapshot,
): Promise<{ id: string; inserted: boolean }> {
  const existing = await db.query.cases.findFirst({
    where: (c, { eq, and }) =>
      and(
        eq(c.chainId, snap.chainId),
        eq(c.aegisAddress, snap.aegisAddress.toLowerCase()),
        eq(c.caseId, snap.caseId.toLowerCase()),
      ),
  })
  if (existing) return { id: existing.id, inserted: false }

  const [row] = await db
    .insert(schema.cases)
    .values({
      chainId: snap.chainId,
      aegisAddress: snap.aegisAddress.toLowerCase(),
      caseId: snap.caseId.toLowerCase(),
      escrowAddress: snap.escrowAddress.toLowerCase(),
      escrowCaseId: snap.escrowCaseId.toLowerCase(),
      partyA: snap.partyA.toLowerCase(),
      partyB: snap.partyB.toLowerCase(),
      feeToken: snap.feeToken.toLowerCase(),
      amount: snap.amount.toString(),
      panelSize: snap.panelSize,
      status: "awaiting_panel",
    })
    .returning({ id: schema.cases.id })
  return { id: row.id, inserted: true }
}

export interface OnchainCaseSnapshot {
  chainId: number
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
  escrowAddress: `0x${string}`
  escrowCaseId: `0x${string}`
  partyA: `0x${string}`
  partyB: `0x${string}`
  feeToken: `0x${string}`
  amount: bigint
  panelSize: number
  deadlineCommit: Date
  deadlineReveal: Date
  panel: Array<{ address: `0x${string}`; seat: number }>
}

/**
 * Idempotently record a CaseOpened event into the DB. Uses
 * (chainId, aegisAddress, caseId) as the natural key — re-indexing the same
 * event is a no-op.
 */
export async function recordCaseOpened(snap: OnchainCaseSnapshot): Promise<{
  id: string
  inserted: boolean
}> {
  // Check existing — possibly a row already exists from CaseRequested.
  const existing = await db.query.cases.findFirst({
    where: (c, { eq, and }) =>
      and(
        eq(c.chainId, snap.chainId),
        eq(c.aegisAddress, snap.aegisAddress.toLowerCase()),
        eq(c.caseId, snap.caseId.toLowerCase()),
      ),
  })

  let caseUuid: string
  if (existing) {
    // Awaiting-panel row already there — promote it to open + fill in
    // deadlines and the now-known panel size.
    await db
      .update(schema.cases)
      .set({
        status: "open",
        deadlineCommit: snap.deadlineCommit,
        deadlineReveal: snap.deadlineReveal,
        panelSize: snap.panelSize,
        updatedAt: new Date(),
      })
      .where(eq(schema.cases.id, existing.id))
    caseUuid = existing.id
  } else {
    const [row] = await db
      .insert(schema.cases)
      .values({
        chainId: snap.chainId,
        aegisAddress: snap.aegisAddress.toLowerCase(),
        caseId: snap.caseId.toLowerCase(),
        escrowAddress: snap.escrowAddress.toLowerCase(),
        escrowCaseId: snap.escrowCaseId.toLowerCase(),
        partyA: snap.partyA.toLowerCase(),
        partyB: snap.partyB.toLowerCase(),
        feeToken: snap.feeToken.toLowerCase(),
        amount: snap.amount.toString(),
        panelSize: snap.panelSize,
        deadlineCommit: snap.deadlineCommit,
        deadlineReveal: snap.deadlineReveal,
        status: "open",
      })
      .returning({ id: schema.cases.id })
    caseUuid = row.id
  }

  // Idempotent panel insert — skip if rows already exist for this case (which
  // can happen if recordCaseOpened is called twice; the indexer is allowed to
  // replay).
  const existingPanel = await db.query.panelMembers.findFirst({
    where: eq(schema.panelMembers.caseUuid, caseUuid),
  })
  if (!existingPanel) {
    await db.insert(schema.panelMembers).values(
      snap.panel.map((p) => ({
        caseUuid,
        panelistAddress: p.address.toLowerCase(),
        seat: p.seat,
      })),
    )
  }

  return { id: caseUuid, inserted: !existing }
}

/**
 * Mark a case resolved with verdict metadata captured from CaseResolved or
 * CaseDefaultResolved events. Idempotent.
 */
export async function recordResolution(opts: {
  caseUuid: string
  status: "resolved" | "default_resolved"
  medianPercentage: number
  finalDigest: `0x${string}`
  resolutionTxHash: `0x${string}`
}): Promise<void> {
  await db
    .update(schema.cases)
    .set({
      status: opts.status,
      medianPercentage: opts.medianPercentage,
      finalDigest: opts.finalDigest,
      resolutionTxHash: opts.resolutionTxHash,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.cases.id, opts.caseUuid))
}

/**
 * Public ledger with keyset pagination + filters.
 *
 * `cursor` is a `(openedAt, id)` pair encoded as `<unix-ms>:<uuid>`. To
 * fetch the next page, pass `nextCursor` returned in the previous result.
 * Stable: if rows are inserted while paginating, you don't skip or
 * duplicate them (offset pagination would).
 */
export interface ListLedgerInput {
  chainId?: number
  status?: Array<
    | "awaiting_panel"
    | "open"
    | "revealing"
    | "appealable_resolved"
    | "appeal_awaiting_panel"
    | "appeal_open"
    | "appeal_revealing"
    | "resolved"
    | "default_resolved"
    | "stalled"
  >
  cursor?: string | null
  limit?: number
}

export interface ListLedgerResult {
  rows: Awaited<ReturnType<typeof db.query.cases.findMany>>
  nextCursor: string | null
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 25

function parseCursor(cursor: string | null | undefined): { ms: number; id: string } | null {
  if (!cursor) return null
  const i = cursor.indexOf(":")
  if (i < 0) return null
  const ms = Number(cursor.slice(0, i))
  const id = cursor.slice(i + 1)
  if (!Number.isFinite(ms) || !id) return null
  return { ms, id }
}

function makeCursor(openedAt: Date, id: string): string {
  return `${openedAt.getTime()}:${id}`
}

export async function listLedger(opts: ListLedgerInput = {}): Promise<ListLedgerResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const cur = parseCursor(opts.cursor)

  const conds = []
  if (opts.chainId !== undefined) conds.push(eq(schema.cases.chainId, opts.chainId))
  if (opts.status && opts.status.length > 0) {
    conds.push(inArray(schema.cases.status, opts.status))
  }
  if (cur) {
    // Keyset: rows strictly older than (cursor.ms, cursor.id). Tiebreak on
    // id so two cases opened in the same millisecond don't loop.
    conds.push(
      or(
        lt(schema.cases.openedAt, new Date(cur.ms)),
        and(
          eq(schema.cases.openedAt, new Date(cur.ms)),
          lt(schema.cases.id, cur.id),
        ),
      )!,
    )
  }

  const where = conds.length === 0 ? undefined : and(...conds)
  const rows = await db.query.cases.findMany({
    where,
    orderBy: [desc(schema.cases.openedAt), desc(schema.cases.id)],
    limit: limit + 1,
  })

  let nextCursor: string | null = null
  let pageRows = rows
  if (rows.length > limit) {
    pageRows = rows.slice(0, limit)
    const last = pageRows[pageRows.length - 1]
    nextCursor = makeCursor(last.openedAt, last.id)
  }

  // Suppress lint — sql kept available for ad-hoc filters added later.
  void sql

  return { rows: pageRows, nextCursor }
}

export async function getCaseByOnchainId(
  chainId: number,
  aegisAddress: string,
  caseId: string,
) {
  return db.query.cases.findFirst({
    where: (c, { eq, and }) =>
      and(
        eq(c.chainId, chainId),
        eq(c.aegisAddress, aegisAddress.toLowerCase()),
        eq(c.caseId, caseId.toLowerCase()),
      ),
  })
}

export async function getCaseById(uuid: string) {
  return db.query.cases.findFirst({
    where: eq(schema.cases.id, uuid),
  })
}

export async function getPanel(caseUuid: string) {
  // Active original-panel members only — recused / redrawn rows kept
  // for audit but not shown as part of the live panel.
  return db.query.panelMembers.findMany({
    where: (p, { and, eq, isNull }) =>
      and(
        eq(p.caseUuid, caseUuid),
        isNull(p.leftAt),
        eq(p.phase, "original"),
      ),
    orderBy: (p, { asc }) => [asc(p.seat)],
  })
}

export async function getAppealPanel(caseUuid: string) {
  // Appeal-panel members — only present once VRF seats them.
  return db.query.panelMembers.findMany({
    where: (p, { and, eq, isNull }) =>
      and(
        eq(p.caseUuid, caseUuid),
        isNull(p.leftAt),
        eq(p.phase, "appeal"),
      ),
    orderBy: (p, { asc }) => [asc(p.seat)],
  })
}

export async function getPanelHistory(caseUuid: string) {
  return db.query.panelMembers.findMany({
    where: eq(schema.panelMembers.caseUuid, caseUuid),
    orderBy: (p, { asc, desc }) => [asc(p.seat), desc(p.joinedAt)],
  })
}

// ============================================================
// Briefs
// ============================================================

export const briefBodySchema = z
  .string()
  .trim()
  .min(1, "Brief is empty")
  .max(8_000, "Brief too long (8 KB max)")

/** Sealed-brief shape — mirrors `lib/crypto/seal.ts`'s SealedBrief. */
export const sealedBriefSchema = z.object({
  bodyNonce: z.string().regex(/^0x[a-fA-F0-9]+$/),
  bodyCiphertext: z.string().regex(/^0x[a-fA-F0-9]+$/),
  recipients: z
    .array(
      z.object({
        recipientPubkey: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        ephemeralPubkey: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        nonce: z.string().regex(/^0x[a-fA-F0-9]+$/),
        wrapped: z.string().regex(/^0x[a-fA-F0-9]+$/),
      }),
    )
    .min(1)
    .max(20),
})
export type SealedBriefValue = z.infer<typeof sealedBriefSchema>

export async function upsertBrief(opts: {
  caseUuid: string
  authorAddress: `0x${string}`
  /** Plaintext body — required for plaintext briefs. */
  body?: string
  /** Sealed payload — required for encrypted briefs. */
  sealed?: SealedBriefValue
}) {
  // Determine role from the case
  const caseRow = await db.query.cases.findFirst({
    where: eq(schema.cases.id, opts.caseUuid),
  })
  if (!caseRow) throw new BriefError("CASE_NOT_FOUND")
  const author = opts.authorAddress.toLowerCase()
  let role: "partyA" | "partyB"
  if (author === caseRow.partyA.toLowerCase()) role = "partyA"
  else if (author === caseRow.partyB.toLowerCase()) role = "partyB"
  else throw new BriefError("NOT_PARTY")

  const isEncrypted = !!opts.sealed
  if (isEncrypted && opts.body) {
    throw new Error("Pass either body or sealed, not both")
  }
  if (!isEncrypted) {
    if (!opts.body) throw new Error("Brief body required")
    briefBodySchema.parse(opts.body)
  }
  const body = isEncrypted ? "" : briefBodySchema.parse(opts.body!)
  const sealed = isEncrypted ? sealedBriefSchema.parse(opts.sealed) : null

  const existing = await db.query.briefs.findFirst({
    where: (b, { eq, and }) =>
      and(eq(b.caseUuid, opts.caseUuid), eq(b.authorAddress, author)),
  })

  if (existing) {
    // Skip the no-op update for plaintext briefs (don't pollute history
    // when a user clicks Save without changing anything). For encrypted
    // updates we always overwrite — the ciphertext changes per save
    // because of fresh nonces, so structural equality isn't meaningful.
    if (!isEncrypted && existing.body === body && !existing.isEncrypted) {
      return { id: existing.id, role, updated: false }
    }
    // Plaintext-to-plaintext edit: snapshot the previous body into
    // brief_versions so observers can see the edit history. Encrypted
    // briefs are NOT versioned in v1 alpha — a future version could
    // store ciphertext history alongside the wrapping keys.
    if (!isEncrypted && !existing.isEncrypted) {
      const priorVersions = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.briefVersions)
        .where(eq(schema.briefVersions.briefId, existing.id))
      const nextVersion = (priorVersions[0]?.count ?? 0) + 1
      await db.insert(schema.briefVersions).values({
        briefId: existing.id,
        version: nextVersion,
        body: existing.body,
      })
    }
    await db
      .update(schema.briefs)
      .set({
        body,
        isEncrypted,
        sealed,
        updatedAt: new Date(),
      })
      .where(eq(schema.briefs.id, existing.id))
    return { id: existing.id, role, updated: true }
  }

  const [row] = await db
    .insert(schema.briefs)
    .values({
      caseUuid: opts.caseUuid,
      authorAddress: author,
      role,
      body,
      isEncrypted,
      sealed,
    })
    .returning({ id: schema.briefs.id })
  return { id: row.id, role, updated: false }
}

/**
 * Returns the full edit history for a brief (oldest version first). Same
 * visibility rules as the brief itself — caller should pre-filter.
 */
export async function listBriefVersions(briefId: string) {
  return db.query.briefVersions.findMany({
    where: eq(schema.briefVersions.briefId, briefId),
    orderBy: (v, { asc }) => [asc(v.version)],
  })
}

/**
 * Bulk variant — fetch versions for many briefs in a single query and
 * group by briefId. Callers that render N briefs would otherwise issue
 * N round-trips through listBriefVersions.
 *
 * Caller should only invoke this when they actually need body content
 * (i.e. post-resolution view). For pre-resolution count-only paths use
 * listBriefVersionCountsByBriefIds to avoid fetching N kilobytes of
 * body per row just to call .length.
 */
export async function listBriefVersionsByBriefIds(
  briefIds: string[],
): Promise<Map<string, Awaited<ReturnType<typeof listBriefVersions>>>> {
  const grouped = new Map<
    string,
    Awaited<ReturnType<typeof listBriefVersions>>
  >()
  for (const id of briefIds) grouped.set(id, [])
  if (briefIds.length === 0) return grouped
  // Order by (briefId, version) so Postgres can satisfy the sort with
  // the existing brief_versions_uniq_idx composite index instead of a
  // global sort on `version` alone.
  const rows = await db.query.briefVersions.findMany({
    where: inArray(schema.briefVersions.briefId, briefIds),
    orderBy: (v, { asc }) => [asc(v.briefId), asc(v.version)],
  })
  for (const r of rows) {
    const bucket = grouped.get(r.briefId)
    if (bucket) bucket.push(r)
  }
  return grouped
}

/**
 * Count-only bulk variant — for the pre-resolution path where the
 * caller wants "edited N times" without paying to pull every prior
 * body across the wire. One grouped aggregate query.
 */
export async function listBriefVersionCountsByBriefIds(
  briefIds: string[],
): Promise<Map<string, number>> {
  const grouped = new Map<string, number>()
  for (const id of briefIds) grouped.set(id, 0)
  if (briefIds.length === 0) return grouped
  const rows = await db
    .select({
      briefId: schema.briefVersions.briefId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.briefVersions)
    .where(inArray(schema.briefVersions.briefId, briefIds))
    .groupBy(schema.briefVersions.briefId)
  for (const r of rows) grouped.set(r.briefId, r.count)
  return grouped
}

export async function getMyBrief(caseUuid: string, address: `0x${string}`) {
  return db.query.briefs.findFirst({
    where: (b, { eq, and }) =>
      and(eq(b.caseUuid, caseUuid), eq(b.authorAddress, address.toLowerCase())),
  })
}

/**
 * Visibility rule for briefs:
 *   - the author can always see their own
 *   - panelists can read both briefs once the case exists
 *   - opposing party cannot read until the case is resolved
 *   - public ledger never includes briefs
 */
export async function listBriefsForViewer(
  caseUuid: string,
  viewer: `0x${string}` | null,
) {
  const all = await db.query.briefs.findMany({
    where: eq(schema.briefs.caseUuid, caseUuid),
  })
  if (!viewer) return []
  const v = viewer.toLowerCase()

  const caseRow = await db.query.cases.findFirst({
    where: eq(schema.cases.id, caseUuid),
  })
  if (!caseRow) return []
  const isParty =
    v === caseRow.partyA.toLowerCase() || v === caseRow.partyB.toLowerCase()
  const isResolved =
    caseRow.status === "resolved" || caseRow.status === "default_resolved"

  if (isParty && !isResolved) {
    return all.filter((b) => b.authorAddress.toLowerCase() === v)
  }

  // Panelists or post-resolution party: see all.
  const isPanelist = await db.query.panelMembers.findFirst({
    where: (p, { eq, and }) =>
      and(eq(p.caseUuid, caseUuid), eq(p.panelistAddress, v)),
  })
  if (isPanelist || isResolved) return all
  return []
}

export class BriefError extends Error {
  constructor(public code: "CASE_NOT_FOUND" | "NOT_PARTY") {
    super(code)
  }
}
