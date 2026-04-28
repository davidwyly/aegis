import { NextResponse } from "next/server"
import {
  pubkeyRegistrationSchema,
  registerPubkey,
  getPubkey,
  PubkeyError,
} from "@/lib/arbiters/keys"
import { requireSession, UnauthorizedError } from "@/lib/auth/session"

export async function GET() {
  try {
    const session = await requireSession()
    const row = await getPubkey(session.address)
    return NextResponse.json({ pubkey: row ?? null })
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
    const parsed = pubkeyRegistrationSchema.parse(await req.json())
    const result = await registerPubkey(session.address, parsed)
    return NextResponse.json(result, { status: result.updated ? 200 : 201 })
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    if (err instanceof PubkeyError)
      return NextResponse.json({ error: err.code }, { status: 400 })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 400 },
    )
  }
}
