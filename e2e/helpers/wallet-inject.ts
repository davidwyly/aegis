import type { Page } from "@playwright/test"
import {
  createPublicClient,
  http,
  numberToHex,
  hexToBigInt,
  type Hex,
  type TransactionSerializable,
} from "viem"
import { hardhat } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

/**
 * Inject a minimal EIP-1193 provider as `window.ethereum` so the wagmi
 * `injected` connector picks it up. Signing is delegated back to the test
 * process via `page.exposeFunction` — the shim itself only marshals
 * requests, never holds the private key.
 *
 * Supported methods: eth_chainId, eth_accounts, eth_requestAccounts,
 * personal_sign, eth_signTypedData_v4, eth_sendTransaction. Everything
 * else is forwarded to the hardhat RPC unchanged.
 *
 * Call once per page (or in `beforeEach`) BEFORE `page.goto(…)` — the
 * init script needs to run before any wagmi code touches `window.ethereum`.
 */
export async function injectWallet(
  page: Page,
  privateKey: Hex,
  rpcUrl: string,
): Promise<void> {
  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({ chain: hardhat, transport: http(rpcUrl) })

  await page.exposeFunction(
    "__aegisWalletSign",
    async (method: string, params: unknown[]): Promise<Hex> => {
      switch (method) {
        case "personal_sign": {
          // params order is [message, address]; metamask reverses, but the
          // wagmi `injected` connector calls it as [message, address].
          const [message] = params as [Hex, Hex]
          return await account.signMessage({ message: { raw: message } })
        }
        case "eth_signTypedData_v4": {
          const [, jsonStr] = params as [Hex, string]
          const typed = JSON.parse(jsonStr) as Parameters<typeof account.signTypedData>[0]
          return await account.signTypedData(typed)
        }
        case "eth_sendTransaction": {
          const [tx] = params as [
            {
              from?: Hex
              to?: Hex
              data?: Hex
              value?: Hex
              gas?: Hex
              maxFeePerGas?: Hex
              maxPriorityFeePerGas?: Hex
              nonce?: Hex
              type?: Hex
            },
          ]
          // Fill in nonce + gas params if the caller didn't.
          const nonce =
            tx.nonce !== undefined
              ? Number(hexToBigInt(tx.nonce))
              : await publicClient.getTransactionCount({ address: account.address })
          const fees = await publicClient.estimateFeesPerGas()
          const gas =
            tx.gas !== undefined
              ? hexToBigInt(tx.gas)
              : await publicClient.estimateGas({
                  account: account.address,
                  to: tx.to,
                  data: tx.data,
                  value: tx.value ? hexToBigInt(tx.value) : undefined,
                })

          const serializable: TransactionSerializable = {
            chainId: hardhat.id,
            type: "eip1559",
            to: tx.to,
            data: tx.data,
            value: tx.value ? hexToBigInt(tx.value) : 0n,
            nonce,
            gas,
            maxFeePerGas: tx.maxFeePerGas ? hexToBigInt(tx.maxFeePerGas) : fees.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas
              ? hexToBigInt(tx.maxPriorityFeePerGas)
              : fees.maxPriorityFeePerGas,
          }
          const signed = await account.signTransaction(serializable)
          const hash = await publicClient.request({
            method: "eth_sendRawTransaction",
            params: [signed],
          })
          return hash as Hex
        }
        default:
          throw new Error(`__aegisWalletSign: unsupported method ${method}`)
      }
    },
  )

  // Init script runs in the page context BEFORE any app JS. It builds
  // the EIP-1193 provider that wagmi's `injected` connector expects to
  // find on `window.ethereum`.
  await page.addInitScript(
    ({ address, chainIdHex, rpcUrl }: { address: string; chainIdHex: string; rpcUrl: string }) => {
      type RequestArgs = { method: string; params?: unknown[] }
      type Listener = (...args: unknown[]) => void

      const listeners = new Map<string, Set<Listener>>()
      const emit = (event: string, ...args: unknown[]) => {
        const set = listeners.get(event)
        if (set) for (const fn of set) fn(...args)
      }

      const forwardingMethods = new Set([
        "eth_chainId",
        "eth_accounts",
        "eth_requestAccounts",
        "personal_sign",
        "eth_signTypedData_v4",
        "eth_sendTransaction",
      ])

      const provider = {
        isMetaMask: true,
        request: async ({ method, params = [] }: RequestArgs) => {
          if (method === "eth_chainId") return chainIdHex
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [address]
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain")
            return null

          if (
            method === "personal_sign" ||
            method === "eth_signTypedData_v4" ||
            method === "eth_sendTransaction"
          ) {
            const sign = (window as unknown as {
              __aegisWalletSign: (m: string, p: unknown[]) => Promise<string>
            }).__aegisWalletSign
            return await sign(method, params)
          }

          // Anything else — eth_call, eth_blockNumber, eth_estimateGas, etc.
          // — forwards untouched to the hardhat RPC.
          const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
          })
          const json = (await res.json()) as { result?: unknown; error?: unknown }
          if (json.error) throw json.error
          return json.result
        },
        on: (event: string, listener: Listener) => {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event)!.add(listener)
        },
        removeListener: (event: string, listener: Listener) => {
          listeners.get(event)?.delete(listener)
        },
        // wagmi pings these to detect provider compatibility.
        _events: {},
        _state: { accounts: [address], isConnected: true, isUnlocked: true, isPermanentlyDisconnected: false },
      }

      // Some apps look at the array variant.
      ;(window as unknown as { ethereum: typeof provider }).ethereum = provider
      ;(window as unknown as { web3: { currentProvider: typeof provider } }).web3 = {
        currentProvider: provider,
      }

      // Tell anyone listening (e.g. wagmi's autoConnect) that an account is live.
      emit("accountsChanged", [address])
      emit("connect", { chainId: chainIdHex })

      // Mute unused-emit warning in browsers that don't pick events up.
      void forwardingMethods
    },
    {
      address: account.address,
      chainIdHex: numberToHex(hardhat.id),
      rpcUrl,
    },
  )
}
