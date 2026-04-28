import "server-only"
import { getIronSession, type SessionOptions } from "iron-session"
import { cookies } from "next/headers"

export interface SessionData {
  /** Lowercase 0x-prefixed EVM address of the signed-in wallet. */
  address?: `0x${string}`
  chainId?: number
  signedInAt?: string
}

const DEV_FALLBACK = "dev-only-placeholder-change-me-before-prod-dev-only!!"

function sessionPassword(): string {
  const pw = process.env.SIWE_SESSION_SECRET
  if (pw && pw.length >= 32) return pw
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SIWE_SESSION_SECRET must be set (32+ chars) in production — generate with `openssl rand -hex 32`.",
    )
  }
  return DEV_FALLBACK
}

function buildOptions(): SessionOptions {
  return {
    password: sessionPassword(),
    cookieName: "aegis-session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  }
}

export async function getSession() {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, buildOptions())
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in")
    this.name = "UnauthorizedError"
  }
}

export async function requireSession() {
  const session = await getSession()
  if (!session.address) {
    throw new UnauthorizedError()
  }
  return session as SessionData & { address: `0x${string}` }
}
