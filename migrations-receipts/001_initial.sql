-- Receipts anchor service schema.
--
-- `batches` is the published-on-chain unit: a Merkle root over N
-- receipts that fall in a [period_start, period_end] window. The
-- `solana_signature` is NULL while the batch is awaiting a successful
-- RPC call (so retries can find pending rows on the next batcher tick).
--
-- `receipts` rows are append-only client-supplied JSON; we hash the
-- canonicalised body to a 32-byte digest and store that as the
-- primary lookup key (UNIQUE so duplicate submissions are coalesced).
-- `batch_id` is NULL until the batcher anchors the receipt; once set,
-- `leaf_index` is the position in the Merkle tree (needed to derive
-- the proof on read).

CREATE TABLE batches (
    id BIGSERIAL PRIMARY KEY,
    root BYTEA NOT NULL,
    count INT NOT NULL,
    period_start_unix BIGINT NOT NULL,
    period_end_unix BIGINT NOT NULL,
    published_at_unix BIGINT,
    solana_signature TEXT,
    UNIQUE (period_start_unix)
);

CREATE TABLE receipts (
    id BIGSERIAL PRIMARY KEY,
    receipt_hash BYTEA NOT NULL UNIQUE,
    body JSONB NOT NULL,
    batch_id BIGINT REFERENCES batches(id),
    leaf_index INT,
    created_at_unix BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX idx_receipts_pending ON receipts (batch_id) WHERE batch_id IS NULL;
CREATE INDEX idx_receipts_hash ON receipts (receipt_hash);
