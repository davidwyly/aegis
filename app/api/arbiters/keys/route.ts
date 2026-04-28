import { NextResponse } from "next/server"
import { getPubkeysFor } from "@/lib/arbiters/keys"

const ADDR = /^0x[a-fA-F0-9]{40}$/

export async function GET(req: Request) {
  const url = new URL(req.url)
  // Accept comma-separated `addresses=` or repeated `address=` params.
  const csv = url.searchParams.get("addresses") ?? ""
  const repeated = url.searchParams.getAll("address")
  const all = [...csv.split(",").map((s) => s.trim()).filter(Boolean), ...repeated]
  const addresses = Array.from(
    new Set(all.filter((a) => ADDR.test(a)).map((a) => a.toLowerCase())),
  )
  if (addresses.length === 0) return NextResponse.json({ keys: [] })
  if (addresses.length > 100) {
    return NextResponse.json({ error: "Too many addresses (max 100)" }, { status: 400 })
  }
  const keys = await getPubkeysFor(addresses)
  return NextResponse.json({ keys })
}
