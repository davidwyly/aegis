"use client"
import { useEffect, useState } from "react"
import { useAccount, useChainId, useConnect, useDisconnect, useSignMessage } from "wagmi"
import { SiweMessage } from "siwe"

export function SignInButton() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connectors, connectAsync } = useConnect()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const [me, setMe] = useState<{ address?: string | null } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => {})
  }, [])

  async function signIn() {
    if (busy) return
    setBusy(true)
    try {
      let acct = address
      if (!isConnected) {
        const injected = connectors.find((c) => c.type === "injected") ?? connectors[0]
        if (!injected) throw new Error("No wallet connector available")
        const res = await connectAsync({ connector: injected })
        acct = res.accounts[0]
      }
      if (!acct) throw new Error("No address")

      const nonceRes = await fetch("/api/auth/nonce")
      const { nonce } = await nonceRes.json()

      const msg = new SiweMessage({
        domain: window.location.host,
        address: acct,
        statement: "Sign in to Aegis arbitration court.",
        uri: window.location.origin,
        version: "1",
        chainId: chainId,
        nonce,
      })
      const message = msg.prepareMessage()
      const signature = await signMessageAsync({ message })

      const verify = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      })
      if (!verify.ok) throw new Error((await verify.json()).error ?? "verify failed")
      const fresh = await fetch("/api/auth/me").then((r) => r.json())
      setMe(fresh)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : "sign-in failed")
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" })
    disconnect()
    setMe({ address: null })
  }

  if (me?.address) {
    return (
      <button onClick={signOut} className="btn-secondary text-xs font-mono">
        {me.address.slice(0, 6)}…{me.address.slice(-4)} · sign out
      </button>
    )
  }
  return (
    <button onClick={signIn} disabled={busy} className="btn-primary text-xs">
      {busy ? "Signing…" : "Sign in"}
    </button>
  )
}
