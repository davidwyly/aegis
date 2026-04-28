import "server-only"
import { db, schema } from "@/lib/db/client"
import { sql, eq, and, inArray, isNull } from "drizzle-orm"

export interface IndexerCursor {
  chainId: number
  contractAddress: string
  eventName: string
  lastBlock: string
  updatedAt: string
  /** Seconds since last cursor update. */
  lagSeconds: number
}

export interface AdminStatus {
  cursors: IndexerCursor[]
  caseCounts: { status: string; count: number }[]
  inflightCases: number
  stuckCases: number // open/revealing AND deadlineReveal in the past
  vrfStuckCases: number // awaiting_panel for >1h — Chainlink VRF subscription health signal
  arbitersActive: number
  unresolvedFailures: number // bridge-step failures in keeper_failures
}

/**
 * Snapshot for /admin and /api/admin/status. Pure read — no on-chain calls.
 * Surfaces what the DB knows about keeper progress.
 */
export async function readAdminStatus(): Promise<AdminStatus> {
  const cursors = await db.query.indexerState.findMany()
  const cursorRows: IndexerCursor[] = cursors.map((c) => {
    const lagMs = Date.now() - c.updatedAt.getTime()
    return {
      chainId: c.chainId,
      contractAddress: c.contractAddress,
      eventName: c.eventName,
      lastBlock: c.lastBlock.toString(),
      updatedAt: c.updatedAt.toISOString(),
      lagSeconds: Math.floor(lagMs / 1000),
    }
  })

  const counts = await db
    .select({
      status: schema.cases.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.cases)
    .groupBy(schema.cases.status)

  const inflight = counts
    .filter(
      (c) =>
        c.status === "awaiting_panel" ||
        c.status === "open" ||
        c.status === "revealing",
    )
    .reduce((sum, c) => sum + c.count, 0)

  // Stuck = past deadline_reveal still in open/revealing. awaiting_panel
  // cases have a null deadline_reveal (waiting on VRF) so they can't be
  // "stuck" by this definition; if they linger, that's a separate ops
  // concern (VRF sub out of LINK, etc.).
  const stuckRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.cases)
    .where(
      and(
        inArray(schema.cases.status, ["open", "revealing"]),
        sql`${schema.cases.deadlineReveal} IS NOT NULL AND ${schema.cases.deadlineReveal} < now()`,
      ),
    )
  const stuck = stuckRows[0]?.count ?? 0

  // VRF stuck — awaiting_panel for >1 hour. With a healthy subscription
  // fulfillment usually lands in seconds; a non-trivial backlog at this
  // age means the VRF sub is out of LINK or the keeper bridge isn't
  // requesting at all.
  const vrfStuckRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.cases)
    .where(
      and(
        eq(schema.cases.status, "awaiting_panel"),
        sql`${schema.cases.openedAt} < now() - interval '1 hour'`,
      ),
    )
  const vrfStuck = vrfStuckRows[0]?.count ?? 0

  const arbitersActiveRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.arbiters)
    .where(eq(schema.arbiters.status, "active"))
  const arbitersActive = arbitersActiveRows[0]?.count ?? 0

  const failureRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.keeperFailures)
    .where(isNull(schema.keeperFailures.resolvedAt))
  const unresolvedFailures = failureRows[0]?.count ?? 0

  return {
    cursors: cursorRows,
    caseCounts: counts.map((c) => ({ status: c.status, count: c.count })),
    inflightCases: inflight,
    stuckCases: stuck,
    vrfStuckCases: vrfStuck,
    arbitersActive,
    unresolvedFailures,
  }
}
