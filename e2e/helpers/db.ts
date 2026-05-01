import postgres from "postgres"

/**
 * Wipe all e2e data — called between specs to keep tests independent.
 * Truncates everything the keeper or app would write to. Note that
 * truncating `indexer_state` is intentional: after the wipe, calling
 * the keeper rebuilds `cases` + `panel_members` by re-scanning the
 * chain logs from block 0.
 */
export async function wipeDb(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { prepare: false, max: 2 })
  try {
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
