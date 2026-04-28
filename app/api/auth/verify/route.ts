import { NextResponse } from "next/server"
import { z } from "zod"
import { verifySiwe } from "@/lib/auth/siwe"
import { getSession } from "@/lib/auth/session"

const bodySchema = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
})

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.parse(await req.json())
    const { address, chainId } = await verifySiwe(parsed.message, parsed.signature)
    const session = await getSession()
    session.address = address
    session.chainId = chainId
    session.signedInAt = new Date().toISOString()
    await session.save()
    return NextResponse.json({ address, chainId })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "verify failed" },
      { status: 400 },
    )
  }
}
