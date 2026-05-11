import "server-only"
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import * as schema from "./schema"

type Drizzle = ReturnType<typeof drizzle<typeof schema>>

let cached: Drizzle | null = null

function getDb(): Drizzle {
  if (cached) return cached
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Configure it to use database-backed features (cases, briefs, SIWE)."
    )
  }
  const client = postgres(connectionString, { prepare: false, max: 10 })
  cached = drizzle(client, { schema })
  return cached
}

export const db = new Proxy({} as Drizzle, {
  get(_target, prop, receiver) {
    const target = getDb()
    const value = Reflect.get(target, prop, receiver)
    return typeof value === "function" ? value.bind(target) : value
  },
}) as Drizzle

export { schema }
