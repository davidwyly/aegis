import { NextResponse } from "next/server"
import { issueNonce } from "@/lib/auth/siwe"
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit"

export async function GET(req: Request) {
  try {
    // Without this, an attacker can hammer this endpoint to mint unlimited
    // unconsumed nonces and exhaust the table. 30/min/IP is generous for a
    // legitimate user (sign-in is rare) and quickly throttles abuse.
    enforceRateLimit(req, "auth-nonce", {
      limit: 30,
      windowMs: 60_000,
    })
    const nonce = await issueNonce()
    return NextResponse.json({ nonce })
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSeconds) },
        },
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "nonce error" },
      { status: 500 },
    )
  }
}
