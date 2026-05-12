import { NextResponse } from "next/server"
import { listUnresolved, manuallyResolveById } from "@/lib/keeper/failures"
import { getSession } from "@/lib/auth/session"

export const dynamic = "force-dynamic"

// Comma-separated lowercase 0x-addresses with admin write access. If
// unset we deny all writes — fail-closed beats "anyone can hide
// failures from the ops dashboard" when the env wasn't wired up yet.
function adminAddresses(): Set<string> {
  const raw = process.env.AEGIS_ADMIN_ADDRESSES ?? ""
  return new Set(
    raw
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.startsWith("0x") && a.length === 42),
  )
}

export async function GET() {
  try {
    const failures = await listUnresolved()
    return NextResponse.json({ failures })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  // Body: { id: string, action: "resolve" }
  // Single endpoint — keeps the API surface minimal until we need more verbs.
  const session = await getSession()
  const allow = adminAddresses()
  if (!session.address || !allow.has(session.address.toLowerCase())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }
  try {
    const body = (await req.json()) as { id?: string; action?: string }
    if (!body.id || body.action !== "resolve") {
      return NextResponse.json(
        { error: "Body must be { id, action: 'resolve' }" },
        { status: 400 },
      )
    }
    await manuallyResolveById(body.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}
