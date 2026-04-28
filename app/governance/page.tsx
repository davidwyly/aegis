"use client"
import { useState } from "react"
import { encodeFunctionData, isAddress } from "viem"
import { aegisAbi } from "@/lib/abi/aegis"

type Action =
  | { kind: "registerArbiter"; arbiter: string; credentialCID: string }
  | { kind: "revokeArbiter"; arbiter: string }
  | {
      kind: "setPolicy"
      panelSize: number
      voteWindow: number
      revealWindow: number
      graceWindow: number
      stakeRequirement: string
      panelFeeBps: number
      treasury: string
      appealWindow: number
      appealPanelSize: number
      appealBondAmount: string
      appealOverturnTolerance: number
    }
  | { kind: "setNewCasesPaused"; paused: boolean }

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"

function buildCalldata(action: Action): `0x${string}` {
  switch (action.kind) {
    case "registerArbiter":
      return encodeFunctionData({
        abi: aegisAbi,
        functionName: "registerArbiter",
        args: [action.arbiter as `0x${string}`, (action.credentialCID || ZERO) as `0x${string}`],
      })
    case "revokeArbiter":
      return encodeFunctionData({
        abi: aegisAbi,
        functionName: "revokeArbiter",
        args: [action.arbiter as `0x${string}`],
      })
    case "setPolicy":
      return encodeFunctionData({
        abi: aegisAbi,
        functionName: "setPolicy",
        args: [
          {
            panelSize: action.panelSize,
            voteWindow: BigInt(action.voteWindow),
            revealWindow: BigInt(action.revealWindow),
            graceWindow: BigInt(action.graceWindow),
            stakeRequirement: BigInt(action.stakeRequirement),
            panelFeeBps: action.panelFeeBps,
            treasury: action.treasury as `0x${string}`,
            appealWindow: BigInt(action.appealWindow),
            appealPanelSize: action.appealPanelSize,
            appealBondAmount: BigInt(action.appealBondAmount),
            appealOverturnTolerance: action.appealOverturnTolerance,
          },
        ],
      })
    case "setNewCasesPaused":
      return encodeFunctionData({
        abi: aegisAbi,
        functionName: "setNewCasesPaused",
        args: [action.paused],
      })
  }
}

export default function GovernancePage() {
  const [action, setAction] = useState<Action>({
    kind: "registerArbiter",
    arbiter: "",
    credentialCID: "",
  })
  const aegisTarget =
    process.env.NEXT_PUBLIC_AEGIS_BASE_SEPOLIA ??
    process.env.NEXT_PUBLIC_AEGIS_HARDHAT ??
    ""

  let calldata = ""
  let calldataError: string | null = null
  try {
    calldata = buildCalldata(action)
  } catch (err) {
    calldataError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Governance bridge</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Build calldata for an Eclipse DAO proposal that calls into Aegis.
          Paste the resulting <code className="font-mono">target / value / data</code>{" "}
          into Eclipse&apos;s <code className="font-mono">propose()</code>.
        </p>
      </div>

      <section className="card space-y-3">
        <div className="flex flex-wrap gap-2">
          {(["registerArbiter", "revokeArbiter", "setPolicy", "setNewCasesPaused"] as const).map(
            (k) => (
              <button
                key={k}
                onClick={() => setAction(defaultsFor(k))}
                className={
                  action.kind === k ? "btn-primary text-xs" : "btn-secondary text-xs"
                }
              >
                {k}
              </button>
            ),
          )}
        </div>
        <div className="grid gap-3">{renderForm(action, setAction)}</div>
      </section>

      <section className="card">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Proposal payload
        </h2>
        <dl className="mt-2 space-y-2 text-sm">
          <div>
            <dt className="text-xs text-zinc-500">target (Aegis)</dt>
            <dd className="font-mono break-all">{aegisTarget || "set NEXT_PUBLIC_AEGIS_*"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">value (wei)</dt>
            <dd className="font-mono">0</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">data</dt>
            <dd className="font-mono break-all">
              {calldataError ? <span className="text-rose-700 dark:text-rose-300">{calldataError}</span> : calldata}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

function defaultsFor(kind: Action["kind"]): Action {
  switch (kind) {
    case "registerArbiter":
      return { kind: "registerArbiter", arbiter: "", credentialCID: "" }
    case "revokeArbiter":
      return { kind: "revokeArbiter", arbiter: "" }
    case "setPolicy":
      return {
        kind: "setPolicy",
        panelSize: 3,
        voteWindow: 86_400,
        revealWindow: 86_400,
        graceWindow: 43_200,
        stakeRequirement: "100000000000000000000",
        panelFeeBps: 8000,
        treasury: "",
        appealWindow: 7 * 86_400, // 7 days
        appealPanelSize: 5,
        appealBondAmount: "200000000000000000000", // 200 ELCP
        appealOverturnTolerance: 5, // ±5pp
      }
    case "setNewCasesPaused":
      return { kind: "setNewCasesPaused", paused: false }
  }
}

function renderForm(
  action: Action,
  setAction: React.Dispatch<React.SetStateAction<Action>>,
) {
  switch (action.kind) {
    case "registerArbiter":
      return (
        <>
          <Field label="Arbiter address">
            <input
              className="input w-full font-mono text-sm"
              value={action.arbiter}
              onChange={(e) => setAction({ ...action, arbiter: e.target.value })}
              placeholder="0x…"
            />
          </Field>
          <Field label="Credential CID (bytes32 hex; e.g. IPFS multihash digest)">
            <input
              className="input w-full font-mono text-sm"
              value={action.credentialCID}
              onChange={(e) => setAction({ ...action, credentialCID: e.target.value })}
              placeholder="0x000…"
            />
          </Field>
          {!isAddress(action.arbiter) && action.arbiter.length > 0 && (
            <small className="text-rose-600 dark:text-rose-400">Invalid address</small>
          )}
        </>
      )
    case "revokeArbiter":
      return (
        <Field label="Arbiter address">
          <input
            className="input w-full font-mono text-sm"
            value={action.arbiter}
            onChange={(e) => setAction({ ...action, arbiter: e.target.value })}
            placeholder="0x…"
          />
        </Field>
      )
    case "setPolicy":
      return (
        <>
          <Field label="Panel size (3, 5, or 7)">
            <input
              type="number"
              className="input w-full"
              value={action.panelSize}
              onChange={(e) => setAction({ ...action, panelSize: Number(e.target.value) })}
            />
          </Field>
          <Field label="Vote window (seconds)">
            <input
              type="number"
              className="input w-full"
              value={action.voteWindow}
              onChange={(e) => setAction({ ...action, voteWindow: Number(e.target.value) })}
            />
          </Field>
          <Field label="Reveal window (seconds)">
            <input
              type="number"
              className="input w-full"
              value={action.revealWindow}
              onChange={(e) => setAction({ ...action, revealWindow: Number(e.target.value) })}
            />
          </Field>
          <Field label="Grace window (seconds)">
            <input
              type="number"
              className="input w-full"
              value={action.graceWindow}
              onChange={(e) => setAction({ ...action, graceWindow: Number(e.target.value) })}
            />
          </Field>
          <Field label="Stake requirement (wei)">
            <input
              className="input w-full font-mono"
              value={action.stakeRequirement}
              onChange={(e) =>
                setAction({ ...action, stakeRequirement: e.target.value })
              }
            />
          </Field>
          <Field label="Panel fee (bps; 8000 = 80% to panel)">
            <input
              type="number"
              className="input w-full"
              value={action.panelFeeBps}
              onChange={(e) => setAction({ ...action, panelFeeBps: Number(e.target.value) })}
            />
          </Field>
          <Field label="Treasury address">
            <input
              className="input w-full font-mono"
              value={action.treasury}
              onChange={(e) => setAction({ ...action, treasury: e.target.value })}
              placeholder="0x…"
            />
          </Field>
        </>
      )
    case "setNewCasesPaused":
      return (
        <Field label="Paused">
          <select
            className="input"
            value={String(action.paused)}
            onChange={(e) =>
              setAction({ ...action, paused: e.target.value === "true" })
            }
          >
            <option value="false">false (accepting new cases)</option>
            <option value="true">true (pause new cases)</option>
          </select>
        </Field>
      )
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-xs text-zinc-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
