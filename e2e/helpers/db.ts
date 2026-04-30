import postgres from "postgres"
import type { Address, Hex } from "viem"

import type { DeployedFixture } from "./deploy"

/**
 * Tiny test-only seeder. Bypasses `lib/cases/service.ts` (which imports
 * `server-only`) and writes directly via postgres-js. Mirrors what the
 * keeper would do when the indexer sees CaseOpened + ArbiterDrawn. Only
 * the columns the case-workspace UI reads are populated; defaults handle
 * the rest.
 */
export interface SeededCaseRow {
  caseUuid: string
}

export async function seedOpenedCase(
  databaseUrl: string,
  fixture: DeployedFixture,
  opts?: { commitDeadline?: Date; revealDeadline?: Date },
): Promise<SeededCaseRow> {
  const sql = postgres(databaseUrl, { prepare: false, max: 2 })
  try {
    const now = new Date()
    const commitDeadline = opts?.commitDeadline ?? new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const revealDeadline = opts?.revealDeadline ?? new Date(commitDeadline.getTime() + 24 * 60 * 60 * 1000)

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO cases (
        chain_id, aegis_address, case_id, escrow_address, escrow_case_id,
        party_a, party_b, fee_token, amount, status, panel_size,
        deadline_commit, deadline_reveal
      ) VALUES (
        ${fixture.chainId},
        ${lower(fixture.aegis)},
        ${lower(fixture.seededCase.aegisCaseId)},
        ${lower(fixture.escrow)},
        ${lower(fixture.seededCase.escrowCaseId)},
        ${lower(fixture.partyA)},
        ${lower(fixture.partyB)},
        ${lower(fixture.usdc)},
        ${fixture.seededCase.amount},
        'open',
        1,
        ${commitDeadline},
        ${revealDeadline}
      )
      RETURNING id
    `

    await sql`
      INSERT INTO panel_members (case_uuid, panelist_address, seat, phase)
      VALUES (${row.id}, ${lower(fixture.seededCase.drawnArbiter)}, 0, 'original')
    `

    return { caseUuid: row.id }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Mirror the indexer's reaction to a `Committed` event. Stamps the
 * `committedAt` + `commitHash` columns on the panel_members row for
 * the given arbiter.
 */
export async function recordCommit(
  databaseUrl: string,
  caseUuid: string,
  arbiter: Address,
  commitHash: Hex,
): Promise<void> {
  const sql = postgres(databaseUrl, { prepare: false, max: 2 })
  try {
    await sql`
      UPDATE panel_members
      SET committed_at = NOW(),
          commit_hash = ${lower(commitHash)}
      WHERE case_uuid = ${caseUuid}
        AND panelist_address = ${lower(arbiter)}
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Mirror the indexer's reaction to a `Revealed` event on the original
 * arbiter (which transitions the case to AppealableResolved). Stamps
 * panel_members.revealedAt + percentage, and flips cases.status.
 */
export async function recordOriginalReveal(
  databaseUrl: string,
  caseUuid: string,
  arbiter: Address,
  partyAPercentage: number,
  rationaleDigest: Hex,
): Promise<void> {
  const sql = postgres(databaseUrl, { prepare: false, max: 2 })
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE panel_members
        SET revealed_at = NOW(),
            party_a_percentage = ${partyAPercentage},
            rationale_digest = ${lower(rationaleDigest)}
        WHERE case_uuid = ${caseUuid}
          AND panelist_address = ${lower(arbiter)}
      `
      await tx`
        UPDATE cases
        SET status = 'appealable_resolved',
            median_percentage = ${partyAPercentage},
            updated_at = NOW()
        WHERE id = ${caseUuid}
      `
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Wipe all e2e data — called between specs to keep tests independent. */
export async function wipeDb(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { prepare: false, max: 2 })
  try {
    // Order matters: panel_members FKs cases.
    await sql`
      TRUNCATE TABLE
        panel_members, brief_versions, briefs, evidence_files, rationales,
        cases, siwe_nonces, arbiter_conflicts, arbiter_keys, arbiters,
        keeper_failures, indexer_state
      RESTART IDENTITY CASCADE
    `
  } catch (err) {
    // Tables may not all exist yet on the very first run — let it slide.
    if (!(err instanceof Error && err.message.includes("does not exist"))) throw err
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function lower<T extends Address | Hex>(value: T): string {
  return value.toLowerCase()
}
