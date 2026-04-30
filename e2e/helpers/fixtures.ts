import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"

import type { DeployedFixture } from "./deploy"

/**
 * On-disk handoff between Playwright `globalSetup` and individual specs.
 * `globalSetup` writes the deployed addresses + assigned arbiter; specs
 * read them back. We keep the file under e2e/.fixtures.json (gitignored)
 * so a stale snapshot from one run never poisons the next.
 */
export interface E2EFixtures {
  databaseUrl: string
  deployment: DeployedFixture
}

const FIXTURE_PATH = resolve(process.cwd(), "e2e/.fixtures.json")

export function writeFixtures(fixtures: E2EFixtures): void {
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixtures, null, 2), "utf-8")
}

export function readFixtures(): E2EFixtures {
  if (!existsSync(FIXTURE_PATH))
    throw new Error(
      `Fixtures missing at ${FIXTURE_PATH}. Did playwright globalSetup run?`,
    )
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as E2EFixtures
}
