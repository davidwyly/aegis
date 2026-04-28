import { NextResponse } from "next/server"
import { z } from "zod"
import {
  getMyBrief,
  upsertBrief,
  BriefError,
  sealedBriefSchema,
} from "@/lib/cases/service"
import { requireSession, UnauthorizedError } from "@/lib/auth/session"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const session = await requireSession()
    const brief = await getMyBrief(id, session.address)
    return NextResponse.json({ brief: brief ?? null })
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 },
    )
  }
}

// Accept either a plaintext body or a sealed (encrypted) payload. Exactly
// one of `body` or `sealed` must be present.
const requestSchema = z.union([
  z.object({ body: z.string().min(1).max(8_000) }),
  z.object({ sealed: sealedBriefSchema }),
])

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const session = await requireSession()
    const parsed = requestSchema.parse(await req.json())
    const result = await upsertBrief({
      caseUuid: id,
      authorAddress: session.address,
      ...("body" in parsed ? { body: parsed.body } : { sealed: parsed.sealed }),
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "Sign in" }, { status: 401 })
    if (err instanceof BriefError) {
      const status = err.code === "CASE_NOT_FOUND" ? 404 : 403
      return NextResponse.json({ error: err.code }, { status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 400 },
    )
  }
}
