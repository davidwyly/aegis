import { createConfig, http } from "wagmi"
import { QueryClient } from "@tanstack/react-query"
import { injected, walletConnect, coinbaseWallet } from "wagmi/connectors"
import { base, baseSepolia, hardhat } from "wagmi/chains"
import { supportedChains } from "@/lib/chains"

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? ""

const appMetadata = {
  name: "Aegis",
  description: "Eclipse-DAO-administered arbitration court",
  url: "https://aegis.eclipsedao.app",
  icons: [],
}

const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL
const BASE_SEPOLIA_RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
const HARDHAT_RPC = process.env.NEXT_PUBLIC_HARDHAT_RPC_URL ?? "http://127.0.0.1:8545"

export const config = createConfig({
  chains: supportedChains,
  transports: {
    [base.id]: http(BASE_RPC),
    [baseSepolia.id]: http(BASE_SEPOLIA_RPC),
    [hardhat.id]: http(HARDHAT_RPC),
  },
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: appMetadata.name }),
    ...(projectId
      ? [walletConnect({ projectId, showQrModal: false, metadata: appMetadata })]
      : []),
  ],
  ssr: true,
})

export const queryClient = new QueryClient()

declare module "wagmi" {
  interface Register {
    config: typeof config
  }
}
