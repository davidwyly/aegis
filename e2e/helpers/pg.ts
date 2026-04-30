import { spawn } from "node:child_process"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { resolve } from "node:path"

import EmbeddedPostgres from "embedded-postgres"

/**
 * Boots a real postgres binary (embedded-postgres) on a fixed loopback port
 * and applies the project's drizzle schema via `drizzle-kit push`. The dev
 * server connects to it via `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/aegis_e2e`.
 *
 * The cluster is non-persistent — calling `stop()` wipes the data directory.
 * On test rerun, we destroy the data dir up front to guarantee a clean slate
 * (otherwise `initialise()` errors on a stale lock file from a crashed run).
 */
export const E2E_PG_PORT = 54329
export const E2E_PG_DATABASE = "aegis_e2e"
export const E2E_PG_USER = "postgres"
export const E2E_PG_PASSWORD = "postgres"

export const E2E_DATABASE_URL =
  `postgresql://${E2E_PG_USER}:${E2E_PG_PASSWORD}@127.0.0.1:${E2E_PG_PORT}/${E2E_PG_DATABASE}`

const DATA_DIR = resolve(process.cwd(), "e2e/.pgdata")

let instance: EmbeddedPostgres | null = null

export async function startEmbeddedPg(): Promise<{ url: string }> {
  // Stale lock from a crashed prior run blocks initdb. Safe to nuke since
  // we explicitly run as non-persistent.
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true })
  }
  mkdirSync(DATA_DIR, { recursive: true })

  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: E2E_PG_PORT,
    user: E2E_PG_USER,
    password: E2E_PG_PASSWORD,
    persistent: false,
    // Keep test logs readable — only surface errors.
    onLog: () => {},
    onError: (m) => console.error("[embedded-pg]", m),
  })

  await instance.initialise()
  await instance.start()
  await instance.createDatabase(E2E_PG_DATABASE)

  await applySchema(E2E_DATABASE_URL)

  return { url: E2E_DATABASE_URL }
}

export async function stopEmbeddedPg(): Promise<void> {
  if (!instance) return
  try {
    await instance.stop()
  } catch (err) {
    console.error("[embedded-pg] stop failed:", err)
  }
  instance = null
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true })
  }
}

/**
 * Sync schema by shelling out to drizzle-kit push. Skips the interactive
 * confirmation by piping `y\n` (`--force` was deprecated; the CLI now reads
 * the prompt response from stdin).
 */
async function applySchema(url: string): Promise<void> {
  await new Promise<void>((resolveFn, rejectFn) => {
    const child = spawn(
      "pnpm",
      ["exec", "drizzle-kit", "push", "--verbose"],
      {
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    let stderr = ""
    child.stdout.on("data", () => {})
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    // drizzle-kit push prompts to confirm if it detects schema drift; pipe
    // 'y' through stdin so it auto-accepts.
    child.stdin.end("y\n")
    child.on("error", rejectFn)
    child.on("exit", (code) => {
      if (code === 0) resolveFn()
      else rejectFn(new Error(`drizzle-kit push exited ${code}: ${stderr}`))
    })
  })
}
