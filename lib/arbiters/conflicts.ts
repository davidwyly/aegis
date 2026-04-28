import "server-only"
import { z } from "zod"
import { eq, and, inArray } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

const ADDR = /^0x[a-fA-F0-9]{40}$/

export const declareConflictSchema = z.object({
  chainId: z.number().int().positive(),
  partyAddress: z.string().regex(ADDR, "Invalid address"),
  reason: z.string().trim().max(500).optional(),
})

export type DeclareConflictInput = z.infer<typeof declareConflictSchema>

const lower = (a: string) => a.toLowerCase()

export async function declareConflict(
  arbiter: `0x${string}`,
  input: DeclareConflictInput,
) {
  const arbiterAddr = lower(arbiter)
  const partyAddr = lower(input.partyAddress)
  if (arbiterAddr === partyAddr) {
    throw new ConflictError("Arbiter cannot declare a conflict with self")
  }
  const existing = await db.query.arbiterConflicts.findFirst({
    where: (c, { and, eq }) =>
      and(
        eq(c.chainId, input.chainId),
        eq(c.arbiterAddress, arbiterAddr),
        eq(c.partyAddress, partyAddr),
      ),
  })
  if (existing) {
    if (input.reason && input.reason !== existing.reason) {
      await db
        .update(schema.arbiterConflicts)
        .set({ reason: input.reason })
        .where(eq(schema.arbiterConflicts.id, existing.id))
    }
    return { id: existing.id, created: false }
  }
  const [row] = await db
    .insert(schema.arbiterConflicts)
    .values({
      chainId: input.chainId,
      arbiterAddress: arbiterAddr,
      partyAddress: partyAddr,
      reason: input.reason ?? null,
    })
    .returning({ id: schema.arbiterConflicts.id })
  return { id: row.id, created: true }
}

export async function revokeConflict(
  arbiter: `0x${string}`,
  chainId: number,
  partyAddress: string,
) {
  await db
    .delete(schema.arbiterConflicts)
    .where(
      and(
        eq(schema.arbiterConflicts.chainId, chainId),
        eq(schema.arbiterConflicts.arbiterAddress, lower(arbiter)),
        eq(schema.arbiterConflicts.partyAddress, lower(partyAddress)),
      ),
    )
}

export async function listForArbiter(arbiter: string, chainId?: number) {
  return db.query.arbiterConflicts.findMany({
    where: (c, { and, eq }) => {
      const base = eq(c.arbiterAddress, lower(arbiter))
      return chainId !== undefined ? and(base, eq(c.chainId, chainId)) : base
    },
    orderBy: (c, { desc }) => [desc(c.declaredAt)],
  })
}

/**
 * For a set of (chainId, panelistAddress, partyA, partyB) tuples, return
 * which conflicts the panelist has declared with which party. Used by the
 * per-case page to flag panelists who should consider recusing.
 */
export async function findConflictsForPanel(
  chainId: number,
  panelists: string[],
  parties: [string, string],
): Promise<Map<string, Array<{ partyAddress: string; reason: string | null }>>> {
  if (panelists.length === 0) return new Map()
  const partySet = parties.map((p) => p.toLowerCase())
  const rows = await db
    .select()
    .from(schema.arbiterConflicts)
    .where(
      and(
        eq(schema.arbiterConflicts.chainId, chainId),
        inArray(
          schema.arbiterConflicts.arbiterAddress,
          panelists.map((p) => p.toLowerCase()),
        ),
        inArray(schema.arbiterConflicts.partyAddress, partySet),
      ),
    )
  const out = new Map<string, Array<{ partyAddress: string; reason: string | null }>>()
  for (const r of rows) {
    const list = out.get(r.arbiterAddress) ?? []
    list.push({ partyAddress: r.partyAddress, reason: r.reason })
    out.set(r.arbiterAddress, list)
  }
  return out
}

export class ConflictError extends Error {
  constructor(msg: string) {
    super(msg)
  }
}
