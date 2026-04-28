import {
  pgTable,
  text,
  integer,
  bigint,
  smallint,
  boolean,
  timestamp,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core"
import { sql, type InferSelectModel, type InferInsertModel } from "drizzle-orm"

// Custom bytea type — Postgres binary blob with Buffer round-trip. Used
// for inline evidence storage (small files only; >2 MB belongs in object
// storage, not the DB).
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return "bytea"
  },
  toDriver(value) {
    return value
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value)
  },
})

// ============================================================
// Auth — SIWE single-use nonces
// ============================================================

export const siweNonces = pgTable(
  "siwe_nonces",
  {
    nonce: text("nonce").primaryKey(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => ({
    issuedAtIdx: index("siwe_nonces_issued_at_idx").on(t.issuedAt),
  }),
)
export type SiweNonce = InferSelectModel<typeof siweNonces>

// ============================================================
// Indexer cursor — last block scanned per (chain, contract).
// Lets the keeper restart from where it left off.
// ============================================================

export const indexerState = pgTable(
  "indexer_state",
  {
    chainId: integer("chain_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    eventName: text("event_name").notNull(),
    lastBlock: bigint("last_block", { mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.chainId, t.contractAddress, t.eventName],
    }),
  }),
)

// ============================================================
// Arbiters — mirror of the on-chain registry, indexed for query.
// On-chain is source of truth; this is a queryable read replica.
// ============================================================

export const arbiterStatusEnum = pgEnum("arbiter_status", ["active", "revoked"])

export const arbiters = pgTable(
  "arbiters",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    status: arbiterStatusEnum("status").notNull().default("active"),
    credentialCID: text("credential_cid"),
    stakedAmount: text("staked_amount").notNull().default("0"), // string-encoded uint256
    caseCount: integer("case_count").notNull().default(0),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chainId, t.address] }),
    statusIdx: index("arbiters_status_idx").on(t.chainId, t.status),
  }),
)

// ============================================================
// Arbiter declared conflicts — off-chain advisory list. Public.
// Pairs with the on-chain recuse() mechanism: if a panelist is drawn for
// a case where one of the parties matches a declared conflict, the UI
// surfaces a warning and the arbiter is expected to call recuse().
// ============================================================

export const arbiterConflicts = pgTable(
  "arbiter_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    arbiterAddress: text("arbiter_address").notNull(),
    partyAddress: text("party_address").notNull(),
    reason: text("reason"),
    declaredAt: timestamp("declared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqDeclared: uniqueIndex("arbiter_conflicts_uniq_idx").on(
      t.chainId,
      t.arbiterAddress,
      t.partyAddress,
    ),
    arbiterIdx: index("arbiter_conflicts_arbiter_idx").on(
      t.chainId,
      t.arbiterAddress,
    ),
    partyIdx: index("arbiter_conflicts_party_idx").on(
      t.chainId,
      t.partyAddress,
    ),
  }),
)

// ============================================================
// Cases — index of CaseOpened events on Aegis.
// On-chain is authoritative for verdicts; this gives us a queryable
// list, brief storage, and a public ledger.
// ============================================================

export const caseStatusEnum = pgEnum("case_status", [
  "awaiting_panel", // CaseRequested seen; VRF callback still pending
  "open",
  "revealing",
  "resolved",
  "default_resolved",
  "stalled",
])

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Aegis-side identification
    chainId: integer("chain_id").notNull(),
    aegisAddress: text("aegis_address").notNull(),
    caseId: text("case_id").notNull(), // 0x-hex bytes32 from Aegis

    // Underlying escrow protocol identification
    escrowAddress: text("escrow_address").notNull(),
    escrowCaseId: text("escrow_case_id").notNull(), // adapter's bytes32 caseId

    // Parties + amount as reported at openDispute time
    partyA: text("party_a").notNull(),
    partyB: text("party_b").notNull(),
    feeToken: text("fee_token").notNull(),
    amount: text("amount").notNull(), // string-encoded uint256

    // Lifecycle
    status: caseStatusEnum("status").notNull().default("awaiting_panel"),
    round: smallint("round").notNull().default(0),
    panelSize: smallint("panel_size").notNull(),
    // Nullable while the case is `awaiting_panel` — populated by the VRF
    // fulfillment when the panel is seated.
    deadlineCommit: timestamp("deadline_commit", { withTimezone: true }),
    deadlineReveal: timestamp("deadline_reveal", { withTimezone: true }),

    // Verdict (populated on resolve)
    medianPercentage: smallint("median_percentage"),
    finalDigest: text("final_digest"),
    resolutionTxHash: text("resolution_tx_hash"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqOnchain: uniqueIndex("cases_chain_aegis_caseid_idx").on(
      t.chainId,
      t.aegisAddress,
      t.caseId,
    ),
    statusIdx: index("cases_status_idx").on(t.chainId, t.status),
    partyAIdx: index("cases_party_a_idx").on(t.partyA),
    partyBIdx: index("cases_party_b_idx").on(t.partyB),
  }),
)
export type CaseRow = InferSelectModel<typeof cases>
export type CaseInsert = InferInsertModel<typeof cases>

// ============================================================
// Panel members — one row per (case, arbiter)
// ============================================================

export const panelMembers = pgTable(
  "panel_members",
  {
    caseUuid: uuid("case_uuid")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    panelistAddress: text("panelist_address").notNull(),
    seat: smallint("seat").notNull(), // index in the on-chain panel array

    // Commit-reveal status mirrored from chain
    committedAt: timestamp("committed_at", { withTimezone: true }),
    commitHash: text("commit_hash"),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    partyAPercentage: smallint("party_a_percentage"),
    rationaleDigest: text("rationale_digest"),

    // Tenure on this case. `leftAt` populated when an arbiter recuses
    // (rows marked 'recused') or the panel is redrawn after a stall
    // (rows marked 'redrawn'). Active panelists have `leftAt = null`.
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    leftReason: text("left_reason"), // 'recused' | 'redrawn' | null
  },
  (t) => ({
    pk: primaryKey({ columns: [t.caseUuid, t.panelistAddress] }),
    panelistIdx: index("panel_members_panelist_idx").on(t.panelistAddress),
    activeIdx: index("panel_members_active_idx").on(t.caseUuid, t.leftAt),
  }),
)

// ============================================================
// Briefs — one per party per case. Plaintext for v1.
// Parties write; arbiters read once the case exists.
// ============================================================

export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseUuid: uuid("case_uuid")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    authorAddress: text("author_address").notNull(),
    role: text("role").notNull(), // 'partyA' | 'partyB'
    body: text("body").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqAuthor: uniqueIndex("briefs_case_author_idx").on(t.caseUuid, t.authorAddress),
  }),
)

// ============================================================
// Brief versions — every save snapshots the previous body so observers
// can see edit history post-resolution. The current body lives on
// `briefs.body`; this table is append-only history.
// ============================================================

export const briefVersions = pgTable(
  "brief_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(), // 1-indexed; 1 = first save, 2 = first edit, ...
    body: text("body").notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqVersion: uniqueIndex("brief_versions_uniq_idx").on(t.briefId, t.version),
    briefIdx: index("brief_versions_brief_idx").on(t.briefId),
  }),
)

// ============================================================
// Evidence — file attachments uploaded by parties on a case.
// Visibility mirrors briefs (party owns own; panel reads on assignment;
// post-resolution everyone reads). 2 MB cap; allowlisted MIME types.
// Stored inline as bytea; objects beyond a few MB belong elsewhere.
// ============================================================

export const evidenceFiles = pgTable(
  "evidence_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseUuid: uuid("case_uuid")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    uploaderAddress: text("uploader_address").notNull(),
    role: text("role").notNull(), // 'partyA' | 'partyB'
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(), // hex digest, lets viewers verify
    content: bytea("content").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    caseIdx: index("evidence_files_case_idx").on(t.caseUuid),
    uploaderIdx: index("evidence_files_uploader_idx").on(t.uploaderAddress),
  }),
)

// ============================================================
// Rationales — one per panelist per case, captured at reveal.
// Plaintext companion to the on-chain rationaleDigest. Kept
// separate from briefs so retention/redaction policies can differ.
// ============================================================

export const rationales = pgTable(
  "rationales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseUuid: uuid("case_uuid")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    panelistAddress: text("panelist_address").notNull(),
    body: text("body").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqPanelist: uniqueIndex("rationales_case_panelist_idx").on(
      t.caseUuid,
      t.panelistAddress,
    ),
  }),
)

// ============================================================
// Keeper failure log — when bridge step (registerCase + openDispute)
// fails, the keeper logs the dispute here. Lets ops see what's stuck
// without grepping logs and gives the keeper a place to mark
// resolved-by-someone-else cases.
// ============================================================

export const keeperFailures = pgTable(
  "keeper_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    vaultraAddress: text("vaultra_address").notNull(),
    escrowId: text("escrow_id").notNull(),
    milestoneIndex: text("milestone_index").notNull(), // uint256 as string
    noMilestone: boolean("no_milestone").notNull(),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttempted: timestamp("last_attempted", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    uniqDispute: uniqueIndex("keeper_failures_dispute_idx").on(
      t.chainId,
      t.vaultraAddress,
      t.escrowId,
      t.milestoneIndex,
      t.noMilestone,
    ),
    unresolvedIdx: index("keeper_failures_unresolved_idx").on(t.resolvedAt),
  }),
)

// ============================================================
// Defaults helper
// ============================================================

export const _now = sql`now()`
