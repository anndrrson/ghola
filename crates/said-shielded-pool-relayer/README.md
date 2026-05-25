# said-shielded-pool-relayer

Delayed/batched withdrawal relayer for the Ghola Solana-native shielded
pool. Phase 41 deliverable.

The relayer accepts encrypted withdrawal proof bundles from anonymous
clients, queues them on disk, and releases them on-chain in batches once
an anonymity threshold or a safety timeout is met. Inter-submission
delays are Poisson-jittered and optional decoy traffic adds metadata
noise so an external observer cannot easily link a given HTTP request to
a specific on-chain transaction.

---

## Running

```bash
export RPC_URL="https://api.mainnet-beta.solana.com"
export RELAYER_KEYPAIR_PATH="/etc/ghola/relayer.json"
cargo run -p said-shielded-pool-relayer
```

## Environment variables

| Variable               | Default              | Meaning                                                            |
| ---------------------- | -------------------- | ------------------------------------------------------------------ |
| `RELAYER_PORT`         | `8088`               | HTTP listen port.                                                  |
| `RPC_URL`              | *(required)*         | Solana JSON-RPC endpoint.                                          |
| `RELAYER_KEYPAIR_PATH` | *(required)*         | Path to fee-paying keypair JSON.                                   |
| `RELAYER_QUEUE_DB`     | `./relayer-queue.db` | Sled DB path. Persist across restarts.                             |
| `BATCH_SIZE`           | `8`                  | Max items released in one batch.                                   |
| `MIN_DELAY_SECS`       | `30`                 | Minimum age of oldest item before normal release.                  |
| `MAX_DELAY_SECS`       | `600`                | Maximum age of oldest item before forced release.                  |
| `ANONYMITY_THRESHOLD`  | `4`                  | Minimum queue depth for a normal release (k-anonymity).            |
| `DECOY_RATE`           | `0.0`                | Decoy txs per hour. `0` disables.                                  |
| `JITTER_LAMBDA`        | `0.5`                | Poisson rate for inter-submission jitter (lower = wider gaps).     |
| `MAX_RETRIES`          | `5`                  | Submission retry attempts before marking Failed.                   |
| `MAX_QUEUE_DEPTH`      | `10000`              | Hard cap on pending queue depth (HTTP 429 once reached).           |
| `RELAY_RATE_LIMIT_PER_MIN` | `60`             | Per-IP `POST /relay` requests per 60s window. `0` disables.        |
| `DEDUP_TTL_SECS`       | `86400`              | Max age before a dedup entry is swept (bounds index growth). `0` disables pruning. |
| `RUST_LOG`             | `info`               | Log filter. INFO emits only counts and timing; DEBUG includes ids. |

## Endpoints

- `POST /relay` — `{ proof_bundle, recipient, fee, relayer_fee }` →
  `{ id, eta_seconds }`. Shape-only proof validation; the chain is the
  arbiter of cryptographic correctness.
- `GET /status/:id` — `{ status: "pending" | "submitted" | "confirmed"
  | "failed" | "unknown" }`. Does NOT return the on-chain signature
  (intentional — see below).
- `GET /healthz` — liveness probe.
- `GET /metrics` — Prometheus-format counters and gauges.

---

## Privacy / safety knob tradeoffs

Every configurable parameter is a knob between **latency** and
**unlinkability**. Tune conservatively for production.

### `ANONYMITY_THRESHOLD` (k)

When a batch releases under the normal (non-safety) policy, *k*
withdrawals depart the relayer in the same batch. An external observer
who saw a `POST /relay` arrive must guess which of the *k* on-chain txs
it became — best-case linkage probability `1/k`.

- **Too low (1–2):** trivial linkage.
- **Too high (>50):** safety release fires often; effective k drops to
  whatever happens to be in the queue at the safety timeout.

### `MIN_DELAY_SECS` / `MAX_DELAY_SECS`

The minimum and maximum amount of time an accepted withdrawal sits in
the queue. The relayer guarantees release within `MAX_DELAY` even if
the queue never reaches `ANONYMITY_THRESHOLD`.

- A **wider** `[MIN_DELAY, MAX_DELAY]` window improves timing privacy
  (the request->tx delay distribution carries less info).
- A **narrower** window improves UX.
- Setting `MIN_DELAY = MAX_DELAY` defeats the safety valve and
  collapses to a single deterministic delay — not recommended.

### `BATCH_SIZE`

Cap on items released in one batch. Larger batches improve k-anonymity
on a single decision cycle but increase burst load on the RPC and
make the relayer-keypair's on-chain activity more "spiky".

### `DECOY_RATE`

Decoy transactions per hour. The relayer keypair pays SOL for these;
they add noise to its submission cadence so an attacker cannot infer
real-withdrawal rate from on-chain frequency.

- **`0`** (default): disabled. Cheapest, weakest privacy.
- **A few per hour** during real-withdrawal lulls: strong cover, modest
  cost. Recommended for production.

The exact decoy strategy (self-transfer vs memo vs shielded-pool
no-op) is currently stubbed — see `src/submit.rs::submit_decoy`. The
strongest cover is a no-op that exactly mimics a real withdrawal's
on-chain shape; that requires a program-level entrypoint that is not
yet implemented.

### `JITTER_LAMBDA`

Poisson rate (per second) for the inter-submission gap inside a single
batch. Lower lambda → wider gaps → less correlation between in-batch
ordering and actual on-chain ordering, but slower drain.

---

## Security model

What the relayer **CAN** do:

- Refuse a withdrawal (denial of service).
- Delay a withdrawal arbitrarily.
- Observe proof bundles, recipients, and amounts on disk and in memory.
- Correlate timing between `POST /relay` requests and on-chain
  submissions it makes itself.

What the relayer **CANNOT** do:

- Steal funds. The proof binds the recipient via `ext_data_hash`;
  rewriting the recipient invalidates the proof.
- Modify the amount, fee, or relayer fee. Same reason.

**Therefore: running a single relayer is a privacy single point of
failure.** A compromised relayer (or one served with a subpoena) gives
the attacker full request->tx linkage. Production deployments need
multiple independent relayers — the Phase 41 anonymity-network
framing. Clients should round-robin or randomly pick from a relayer
set and the on-chain shape of withdrawals from different relayers must
be indistinguishable.

## Privacy invariants enforced by this crate

1. `POST /relay` does not echo the proof, recipient, or amount.
2. `GET /status/:id` returns only abstract status; never the on-chain
   signature, never the batch index, never the wall-clock submit time.
3. Logs at INFO contain only queue depth, batch sizes, and timing
   distributions. Per-withdrawal data (id, recipient, amount) lives at
   DEBUG; `tracing-subscriber`'s default `info` filter elides it.
4. The queue id is **never** carried into the on-chain transaction
   (no memo, no compute-budget comment).
5. The persistent queue stores abstract status; the on-chain signature
   is not recorded anywhere on disk.
6. Metric labels carry no per-withdrawal data — only static buckets.

## Threat model — out of scope

- **Network-level deanonymization** (Tor/VPN bypass, traffic
  correlation by a global passive adversary). Run behind Tor hidden
  service if this matters.
- **Side-channel timing** in the proof validator. We do shape-only
  validation, so the per-request CPU profile is roughly constant; the
  on-chain program is the cryptographic arbiter.
- **Relayer keypair compromise.** A leaked relayer key lets an
  attacker submit arbitrary txs (paid by you) but does NOT give them
  the ability to steal user funds. Rotate immediately on compromise.

## Operator runbook

- **Restart:** the queue is sled-backed; in-flight `Pending` items
  resume. `Submitted` items will re-submit (idempotent at the program
  level because nullifiers are unique).
- **Backup:** the sled DB at `RELAYER_QUEUE_DB` contains pending
  proofs. Treat it as sensitive: deleting it loses in-flight
  withdrawals; leaking it leaks the proof bundles + recipients + amounts
  of every queued item.
- **Drain:** before shutdown, set `MIN_DELAY_SECS=0` and stop accepting
  new requests at the load balancer; the next tick will release
  remaining items via the safety-release path. Wait for queue depth
  to reach 0 via `/metrics`.

## Tests

```bash
cargo test -p said-shielded-pool-relayer
```

Batching policy tests live in `tests/queue_batching.rs` and exercise
[`queue::decide_batch`] across the threshold/min-delay/max-delay matrix.
