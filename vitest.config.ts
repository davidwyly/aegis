import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "blockchain", ".next"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      // Stub Next.js's server-only marker — it throws on import outside a
      // server component, which breaks unit tests that import server-side
      // modules.
      "server-only": resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
})
