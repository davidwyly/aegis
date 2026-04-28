import Link from "next/link"

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Aegis</h1>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Eclipse-DAO-administered arbitration court. Vetted, ELCP-staked
          arbiters resolve disputes for any escrow protocol that implements
          the <code className="font-mono text-xs">IArbitrableEscrow</code> interface.
          Vaultra plugs in by setting Aegis as its <code className="font-mono text-xs">eclipseDAO</code>.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Link href="/cases" className="card hover:border-zinc-400">
          <h2 className="font-medium">Cases ledger</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Public list of opened, in-flight, and resolved cases. Verdict
            history per arbiter is published to keep panels honest.
          </p>
        </Link>
        <Link href="/arbiters" className="card hover:border-zinc-400">
          <h2 className="font-medium">Arbiters</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Registered arbiters, their ELCP stake, and on-chain case counts.
            Roster changes flow through Eclipse DAO proposals.
          </p>
        </Link>
        <Link href="/governance" className="card hover:border-zinc-400">
          <h2 className="font-medium">Governance bridge</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Build calldata for Eclipse DAO proposals that adjust panel size,
            stake requirement, fee split, or roster.
          </p>
        </Link>
        <div className="card">
          <h2 className="font-medium">Plug in your escrow</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Implement <code className="font-mono text-xs">IArbitrableEscrow</code>{" "}
            and assign Aegis as your contract&apos;s arbiter. See{" "}
            <code className="font-mono text-xs">docs/integration-vaultra.md</code>.
          </p>
        </div>
      </section>
    </div>
  )
}
