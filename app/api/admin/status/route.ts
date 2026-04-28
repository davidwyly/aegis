import { NextResponse } from "next/server"
import { readAdminStatus } from "@/lib/admin/status"

// Public read of operational state — keeper cursors, case counts.
// No PII or secrets. Gate behind your edge proxy if you want to keep ops
// state non-public.
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const status = await readAdminStatus()
    return NextResponse.json(status)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "status error" },
      { status: 500 },
    )
  }
}
