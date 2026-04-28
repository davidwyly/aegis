import type { Metadata } from "next"
import "@/styles/globals.css"
import { Providers } from "./providers"
import { SiteNav } from "@/components/site-nav"

export const metadata: Metadata = {
  title: "Aegis — Eclipse-DAO Arbitration",
  description:
    "Eclipse-DAO-administered arbitration court for Vaultra and other escrow protocols.",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <Providers>
          <SiteNav />
          <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  )
}
