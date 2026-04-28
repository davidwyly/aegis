import { NextResponse } from "next/server"
import { listUnresolved, manuallyResolveById } from "@/lib/keeper/failures"

export const dynamic = "force-dynamic"

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
