import { eq, and, isNull } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

export interface FailureKey {
  chainId: number
  vaultraAddress: string
  escrowId: string
  milestoneIndex: bigint
  noMilestone: boolean
}

/**
 * Upsert a failure record. If the same (chain, vaultra, escrow, milestone, kind)
 * already has an unresolved row, increment `attempts`; otherwise insert a new
 * row. If a previously-resolved row exists, that's left alone — failures are
 * point-in-time and a re-occurrence creates a fresh row via uniqueness on
 * the `unresolved` partial.
 */
export async function recordFailure(key: FailureKey, reason: string): Promise<void> {
  const existing = await db.query.keeperFailures.findFirst({
    where: (f, { and, eq, isNull }) =>
      and(
        eq(f.chainId, key.chainId),
        eq(f.vaultraAddress, key.vaultraAddress.toLowerCase()),
        eq(f.escrowId, key.escrowId.toLowerCase()),
        eq(f.milestoneIndex, key.milestoneIndex.toString()),
        eq(f.noMilestone, key.noMilestone),
        isNull(f.resolvedAt),
      ),
  })

  if (existing) {
    await db
      .update(schema.keeperFailures)
      .set({
        reason: reason.slice(0, 1_000),
        attempts: (existing.attempts ?? 1) + 1,
        lastAttempted: new Date(),
      })
      .where(eq(schema.keeperFailures.id, existing.id))
    return
  }

  await db.insert(schema.keeperFailures).values({
    chainId: key.chainId,
    vaultraAddress: key.vaultraAddress.toLowerCase(),
    escrowId: key.escrowId.toLowerCase(),
    milestoneIndex: key.milestoneIndex.toString(),
    noMilestone: key.noMilestone,
    reason: reason.slice(0, 1_000),
  })
}

/** Mark any unresolved failure for this dispute as resolved. */
export async function markResolved(key: FailureKey): Promise<void> {
  await db
    .update(schema.keeperFailures)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(schema.keeperFailures.chainId, key.chainId),
        eq(schema.keeperFailures.vaultraAddress, key.vaultraAddress.toLowerCase()),
        eq(schema.keeperFailures.escrowId, key.escrowId.toLowerCase()),
        eq(
          schema.keeperFailures.milestoneIndex,
          key.milestoneIndex.toString(),
        ),
        eq(schema.keeperFailures.noMilestone, key.noMilestone),
        isNull(schema.keeperFailures.resolvedAt),
      ),
    )
}

export async function listUnresolved() {
  return db.query.keeperFailures.findMany({
    where: isNull(schema.keeperFailures.resolvedAt),
    orderBy: (f, { desc }) => [desc(f.lastAttempted)],
    limit: 200,
  })
}

/** Operator-driven resolve. Same effect as markResolved but takes the row id. */
export async function manuallyResolveById(id: string): Promise<void> {
  await db
    .update(schema.keeperFailures)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(schema.keeperFailures.id, id),
        isNull(schema.keeperFailures.resolvedAt),
      ),
    )
}
