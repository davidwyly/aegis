import { NextResponse } from "next/server"
import { revokeConflict } from "@/lib/arbiters/conflicts"
import { requireSession, UnauthorizedError } from "@/lib/auth/session"

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ chain: string; party: string }> },
) {
  try {
    const session = await requireSession()
    const { chain, party } = await params
    const chainId = Number(chain)
    if (!Number.isFinite(chainId) || chainId <= 0)
      return NextResponse.json({ error: "Invalid chain" }, { status: 400 })
    if (!/^0x[a-fA-F0-9]{40}$/.test(party))
      return NextResponse.json({ error: "Invalid address" }, { status: 400 })
    await revokeConflict(session.address, chainId, party)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}
