import { NextResponse } from "next/server"
import { db, schema } from "@/lib/db/client"
import { eq, and } from "drizzle-orm"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const chainId = url.searchParams.get("chainId")
  const status = url.searchParams.get("status") ?? "active"

  const where =
    chainId !== undefined
      ? and(
          eq(schema.arbiters.chainId, Number(chainId)),
          eq(schema.arbiters.status, status as "active" | "revoked"),
        )
      : eq(schema.arbiters.status, status as "active" | "revoked")

  const rows = await db.query.arbiters.findMany({
    where,
    orderBy: (a, { desc }) => [desc(a.registeredAt)],
  })
  return NextResponse.json({ arbiters: rows })
}
