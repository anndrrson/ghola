# said-shielded-pool-indexer

Indexer + Merkle forester for the Ghola Solana-native shielded pool.

The crate ships **one binary** that can fill **either or both** of two roles, selected at runtime via environment variables.

## Roles

### 1. Indexer (always on)

- Subscribes to the on-chain `said-shielded-pool` program's event stream.
- Maintains an off-chain mirror of the depth-26 commitment Merkle forest in a local `sled` database.
- Serves Merkle-path / witness queries to clients over HTTP.

Anyone can run an indexer. It only reads public chain state and holds no secrets. Multiple clients can hit a single indexer, and multiple operators can run their own indexer for redundancy — every indexer with the same chain view will produce byte-identical trees.

### 2. Forester (optional)

- Watches the on-chain insertion-queue PDA.
- When queue length ≥ `FORESTER_QUEUE_THRESHOLD`, simulates the queued inserts into a snapshot of the local tree, requests a batched-update SNARK from the prover service, and submits the `update_root_via_proof` instruction signed by the configured keypair.
- The on-chain program then advances the canonical root and drains the queue; the resulting `RootUpdated` event flows back through the indexer's listener path so on-chain and off-chain state stay in lock-step.

The forester role is **permissioned in v1** — only the keypair listed as `forester_authority` on the program will succeed. Phase 41 replaces the single authority with a staked-operator authority set, at which point any operator running this binary can opt into the forester role by pointing `FORESTER_KEYPAIR_PATH` at their staked keypair.

## Configuration

Defaults target the **live devnet deployment**, so a fresh `cargo run -p said-shielded-pool-indexer` works out of the box against devnet without any env vars set.

| Env var                     | Default                                                | Notes |
|-----------------------------|--------------------------------------------------------|-------|
| `RPC_URL`                   | `https://api.devnet.solana.com`                        | Solana JSON-RPC (HTTP). Override for localnet/mainnet. |
| `WS_URL`                    | `wss://api.devnet.solana.com`                          | Solana JSON-RPC (WS). |
| `INDEXER_DB_PATH`           | `./indexer.db`                                         | sled directory. |
| `INDEXER_PORT`              | `8788`                                                 | axum port. |
| `POOL_PROGRAM_ID`           | `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A` (devnet) | base58 pubkey of the on-chain program. |
| `PROVER_URL`                | `http://127.0.0.1:8787`                                | URL of `said-shielded-pool-prover`. |
| `FORESTER_KEYPAIR_PATH`     | *(unset → forester off)*                               | solana-keygen JSON keypair file. |
| `FORESTER_QUEUE_THRESHOLD`  | `16`                                                   | trigger threshold. |
| `FORESTER_POLL_SECS`        | `10`                                                   | queue poll interval. |
| `BACKFILL_LIMIT`            | `1000`                                                 | tx signatures per backfill page. |

To run as an **indexer-only** node, leave `FORESTER_KEYPAIR_PATH` unset.
To run as a **forester** node, point it at a keypair file matching `forester_authority` on the program.

## HTTP API

| Method | Path             | Purpose |
|--------|------------------|---------|
| `GET`  | `/healthz`       | liveness + indexer height |
| `GET`  | `/tree-state`    | `{ root, next_index, depth, tree_capacity, root_history_size }` |
| `GET`  | `/witness?commitment=<hex>` | `{ commitment, leaf_index, siblings[], path_bits[], root, depth }` or `404` |
| `GET`  | `/root-history`  | last `ROOT_HISTORY_SIZE` (256) roots, oldest first |

All field elements are returned as lowercase hex (32 bytes, big-endian, no `0x` prefix).

## Database layout

Everything lives in a single sled `Tree` named `merkle`:

| Key                              | Value             |
|----------------------------------|-------------------|
| `meta/next_index`                | u64 BE            |
| `meta/root`                      | 32-byte root      |
| `meta/root_hist_seq`             | u64 BE            |
| `leaf/<idx u64 BE>`              | 32-byte leaf      |
| `commit/<32-byte commitment>`    | u64 BE leaf idx   |
| `filled/<depth u8>`              | 32-byte node      |
| `root_hist/<seq u64 BE>`         | 32-byte root      |

## Recovery procedure

If the database becomes corrupt, lags chain state, or the operator wants to re-verify from scratch:

```sh
systemctl stop said-shielded-pool-indexer
rm -rf $INDEXER_DB_PATH
systemctl start said-shielded-pool-indexer
```

On startup, the indexer sees an empty database and triggers `backfill::Backfiller::run`, which walks historical signatures of `POOL_PROGRAM_ID`, decodes every `CommitmentQueued` / `Transferred` / `RootUpdated`, and replays the commitments in chronological order. Inserts are idempotent (the tree de-dupes on `commit/<commitment>`), so re-running backfill against a partially-populated db is also safe.

For very large programs (> a few hundred-K commitments) consider raising `BACKFILL_LIMIT` and pointing `RPC_URL` at an archival node — non-archival nodes only retain the last ~2 epochs of signatures.

## Trust model

The indexer is a **public service** — every byte of state it serves is derived from the public Solana chain. There is no key material in the indexer; running one does not expose the operator to any new trust surface beyond running an ordinary RPC client.

The forester is **permissioned** (v1) but **non-custodial**: it never touches user funds and the only privileged action it can take is `update_root_via_proof`, which the on-chain program validates with a Groth16 verifier. A misbehaving forester can at worst stall the queue (refuse to batch); it cannot forge a root, drain the pool, or front-run users.

Clients SHOULD use multiple indexers for path queries and compare roots, especially when reading from indexers they did not run themselves. The `/tree-state` endpoint exists specifically to make this cheap.

## Running locally

Against the live devnet deployment (defaults pre-configured):

```sh
cd /Users/andersonobrien/Downloads/ghola
cargo run -p said-shielded-pool-indexer
```

Against a localnet validator:

```sh
cd /Users/andersonobrien/Downloads/ghola
export RPC_URL=http://127.0.0.1:8899
export WS_URL=ws://127.0.0.1:8900
export POOL_PROGRAM_ID=<your local program id>
cargo run -p said-shielded-pool-indexer
```

Tail the witness server:

```sh
curl http://127.0.0.1:8788/healthz
curl http://127.0.0.1:8788/tree-state
```

## Tests

```sh
cd /Users/andersonobrien/Downloads/ghola
cargo test -p said-shielded-pool-indexer
```

Unit tests in `tests/tree_insertion.rs` exercise the IncrementalMerkleTree against a naive recompute of the same N-leaf tree, verify that `path()` round-trips through the root, and assert idempotency of duplicate inserts.

### Devnet smoke test

```sh
cargo test -p said-shielded-pool-indexer --test devnet_backfill -- --ignored --nocapture
```

`#[ignore]` by default so CI does not hit external network. Pulls the most
recent batch of signatures for the deployed program ID, decodes every
`Program data:` log line, and asserts that none of the recognized events
panic in borsh. Logs each decoded event for inspection.

## Status

Phase 38. The crate compiles, the tree implementation is production-ready, and the HTTP witness API is wired up. The forester's on-chain tx submission step is stubbed pending the matching changes to the on-chain program (Phase 38 follow-up) and the prover service's `/prove/batched-update` endpoint.
