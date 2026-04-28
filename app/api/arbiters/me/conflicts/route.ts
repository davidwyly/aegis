import { NextResponse } from "next/server"
import {
  declareConflict,
  declareConflictSchema,
  listForArbiter,
  ConflictError,
} from "@/lib/arbiters/conflicts"
import { requireSession, UnauthorizedError } from "@/lib/auth/session"

export async function GET(req: Request) {
  try {
    const session = await requireSession()
    const url = new URL(req.url)
    const chainId = url.searchParams.get("chainId")
    const rows = await listForArbiter(
      session.address,
      chainId ? Number(chainId) : undefined,
    )
    return NextResponse.json({ conflicts: rows })
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession()
    const parsed = declareConflictSchema.parse(await req.json())
    const result = await declareConflict(session.address, parsed)
    return NextResponse.json(result, { status: result.created ? 201 : 200 })
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    if (err instanceof ConflictError)
      return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 400 },
    )
  }
}
