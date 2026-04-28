import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth/session"

export async function GET() {
  const session = await getSession()
  return NextResponse.json({
    address: session.address ?? null,
    chainId: session.chainId ?? null,
    signedInAt: session.signedInAt ?? null,
  })
}
