import Link from "next/link"
import { SignInButton } from "./sign-in-button"

export function SiteNav() {
  return (
    <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <nav className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold tracking-tight">
          Aegis
        </Link>
        <span className="text-zinc-400">·</span>
        <Link href="/cases" className="hover:underline">
          Cases
        </Link>
        <Link href="/arbiters" className="hover:underline">
          Arbiters
        </Link>
        <Link href="/governance" className="hover:underline">
          Governance
        </Link>
        <Link href="/admin" className="text-zinc-500 hover:underline">
          Ops
        </Link>
        <div className="grow" />
        <SignInButton />
      </nav>
    </header>
  )
}
