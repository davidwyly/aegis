import { NextResponse } from "next/server"
import { listQueueFor } from "@/lib/arbiters/queue"
import { requireSession, UnauthorizedError } from "@/lib/auth/session"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const session = await requireSession()
    const items = await listQueueFor(session.address)
    return NextResponse.json({ items })
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}
