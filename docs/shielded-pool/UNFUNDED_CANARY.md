# Solana Shielded Pool Unfunded Canary

This runbook is the no-funds path for proving the Ghola Seeker shielded-pool
integration is wired end to end without pretending that a transaction settled.
It is intentionally fail-closed: fake proofs, malformed withdraw instructions,
missing pool accounts, and absent prover backends must fail before any public
USDC fallback or relay submission.

## Run It

```bash
scripts/canary/solana-shielded-pool-unfunded.sh
```

Optional, when testing a real mobile backend candidate:

```bash
GHOLA_SHIELDED_POOL_BACKEND=/absolute/path/libghola_shielded_pool_backend.so \
  scripts/canary/solana-shielded-pool-unfunded.sh
```

On a Seeker phone, install the produced debug APK and run:

```text
Wallet -> RUN LOCAL PROOF SELF-TEST
```

That device step derives the shielded account through Seed Vault, builds a
self-test witness, loads the packaged proof artifacts, calls the native prover
bridge, and refuses to submit anything.

## 1-12 End-To-End Checklist

1. Build the thumper cloud rail and verify the `solana_shielded_pool` code path
   compiles.
2. Verify `/health/payments` only advertises the rail as ready when program,
   mint, verifier, Merkle tree, escrow, prover, and relayer context are all
   configured.
3. Verify the cloud submit hook rejects malformed proof bundles, missing
   withdraw instruction bytes, invalid Solana account metas, and withdraw
   account lists that do not match the configured pool context.
4. Verify signed no-funds settlement fixtures accept valid adapter receipts and
   reject tampered receipts.
5. Build the Android Seeker flavor.
6. Verify Android unit tests reject malformed native prover output before submit.
7. Verify the APK packages `transaction.wasm`, `transaction.r1cs`,
   `transaction_final.zkey`, `libghola_shielded_pool.so`, and
   `libghola_shielded_pool_backend.so`.
8. If a backend candidate exists, verify it is an ARM64 Android ELF and exports
   `ghola_shielded_pool_prove_to_file`.
9. On Seeker hardware, derive the shielded recipient from Seed Vault. The app
   must reject a stored recipient that does not match the current Seed Vault
   account.
10. On Seeker hardware, run the local proof self-test. It may use the fail-closed
    backend, but it must never submit a fake payment.
11. When the real backend exists, run the same self-test with the real backend
    and require a strictly shaped proof bundle plus withdraw instruction.
12. Only after funding is available, run the funded devnet canary to prove the
    relayer and on-chain withdraw path finalize. Until then, production remains
    unavailable rather than falling back to public transfers.

## What This Proves Without Funds

- The cloud rail is configured fail-closed.
- The proof payload, withdraw instruction contract, and configured pool account
  binding are enforced on both Android and cloud.
- The Seeker APK contains the native proof bridge and circuit artifacts.
- Seed Vault can derive the local shielded account on device.
- The no-funds test surface catches tampered settlement receipts.

## What Still Requires Device Validation Or Funds

- A production Android Groth16 proof generated and timed on physical Seeker
  hardware.
- A Solana program verification result on devnet or mainnet.
- Relayer broadcast and finality.
- Real note discovery from the indexer against funded shielded deposits.

## Production Unlock Path

1. Use `crates/ghola-shielded-pool-mobile-backend` as the ABI/output contract.
   Its default build fails closed; `host-snarkjs` proves the Groth16/output
   path on a developer machine only; `mobile-arkworks` builds the non-Node
   Rust prover and cross-compiles to Android ARM64.
2. Build the Android backend:

   ```bash
   scripts/build-android-shielded-pool-backend.sh
   ```

3. Package it with:

   ```bash
   cd android
   ./gradlew :app:assembleSeekerDebug \
     -PgholaShieldedPoolBackend=/absolute/path/libghola_shielded_pool_backend.so
   ```

4. Run:

   ```bash
   scripts/security/verify-android-shielded-pool-backend.sh \
     /absolute/path/libghola_shielded_pool_backend.so
   scripts/canary/solana-shielded-pool-unfunded.sh
   ```

5. Install on Seeker and run `RUN LOCAL PROOF SELF-TEST`.
6. When funds are available, perform a minimal devnet deposit and withdraw canary
   through the relayer.

## Funded Devnet Program Canary

The on-chain program loop is guarded because it spends devnet SOL from the
configured Solana CLI keypair:

```bash
GHOLA_RUN_FUNDED_DEVNET_CANARY=1 \
  scripts/canary/solana-shielded-pool-funded-devnet.sh
```

This runs `programs/said-shielded-pool/tests/full_loop_devnet.ts`, which creates
a fresh SPL mint, initializes a fresh Merkle tree, deposits 1000 test tokens,
submits a real forester Groth16 root update, withdraws the shielded note, and
checks that the recipient token account receives the withdrawn amount while
escrow returns to zero.

The canary writes:

```text
programs/said-shielded-pool/tests/full_loop_devnet.result.json
```

This proves the deployed devnet program accepts the deposit, root-update proof,
and withdraw flow. It still does not prove the Android mobile prover backend or
the production cloud relayer, which remain separate canaries.

## Funded Devnet Relayer Canary

The relayer-path canary starts a local `said-shielded-pool-relayer` with a
temporary queue and broadcasts the withdraw through `POST /relay`:

```bash
GHOLA_RUN_FUNDED_DEVNET_CANARY=1 \
  scripts/canary/solana-shielded-pool-funded-relayer-devnet.sh
```

This proves the HTTP relayer ingress, queue/dedup layer, batcher, RPC submitter,
and on-chain withdraw path work together on devnet. It uses the configured
Solana CLI keypair as both the full-loop payer and local relayer signer, so
production deployments must still configure an explicit relayer signer and make
the client-built withdraw instruction use that signer as the Anchor `payer`.
