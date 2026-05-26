# ghola_pay.aleo

Minimal shielded payment program for Ghola's x402 inference settlement
rail. See [`docs/security/tier-2k-shielded-payments.md`](../../../docs/security/tier-2k-shielded-payments.md)
for the full design, threat model, and rollout plan; this README covers
only the on-chain artifact and how to operate it.

## Purpose

`ghola_pay.aleo` exposes a single shielded `pay` transition that
consumes a USDC.a record owned by the caller and emits two output
records: one for the recipient (the inference provider) and one
change record back to the caller. The transaction's public surface
contains only the input nullifier, the two output commitments, the
program id, and an optional public `memo: u128`. Sender, receiver,
and amount are all shielded — this is the property Tier 2K §2.2
identifies as the only construction that actually closes the
payer→provider edge leak described in §1.1.

This program is deliberately *not* a full token contract. It does not
mint, burn, withdraw to a bridge, audit-log, or implement refund
flows. Those belong to the bridge program (USDC.a) and to higher-tier
work. The job of `ghola_pay.aleo` is exactly: "consume one record,
emit two."

## How it connects to the x402 shielded rail

Per Tier 2K §2.2 step 3, the client:

1. Locally builds a transition calling `ghola_pay.aleo/pay` with the
   caller's USDC.a record as `r_in`, the provider's Aleo address as
   `to`, and the required `amount`.
2. Broadcasts the transition to an Aleo broadcaster (Ghola-operated by
   default, user-overridable).
3. Receives back a transition id and the output record commitments.
4. Attaches an `X402AleoPayload` (defined in §4.2) to the x402 retry
   request:

   ```rust
   X402AleoPayload {
       transition_id:      "at1…",
       output_commitment:  "1234…",   // the recipient record's commitment
       program:            "ghola_pay.aleo/pay",
       network:            "aleo:mainnet",
   }
   ```

5. The merchant/provider's `thumper-cloud` instance hands the payload
   to the shielded adapter (`SHIELDED_STABLECOIN_ADAPTER_URL`). The
   adapter fetches the transition from an Aleo node, decrypts the
   recipient record with the provider's view key, and confirms
   `amount >= max_amount_required`. The adapter returns a signed
   receipt that `thumper-cloud` records as the canonical
   shielded settlement.

The program is the **on-chain** half of that flow. The adapter is the
**off-chain** trusted verifier that wraps it.

## Local development

These commands assume you have the Aleo toolchain installed. The
toolchain is *not* part of this repo's `cargo build --workspace` —
you install it separately:

```sh
# Install Leo (the high-level language compiler) and snarkOS (the node).
curl -L https://raw.githubusercontent.com/AleoNet/leo/mainnet/install.sh | sh
curl -L https://install.snarkos.org | sh

# Verify.
leo --version
snarkos --version
```

Build:

```sh
cd programs/aleo/ghola_pay
leo build
```

Run the dev-only mint (so you have a record to spend) and then `pay`:

```sh
# First, generate yourself a devnet account if you don't have one:
leo account new

# Mint a USDC.a record to yourself. The mint is a DEVNET-ONLY transition
# that lives in a SEPARATE program (ghola_pay_devnet.aleo) — it is not in
# this mainnet program, so the mainnet source tree physically cannot
# contain a mint. See ../ghola_pay_devnet/.
cd ../ghola_pay_devnet
leo run mint_for_testing aleo1yourself... 1000000u64

# Paste the resulting record into ../ghola_pay/inputs/ghola_pay.in
# (replacing the placeholder `r_in`), then run `pay` in this program:
cd ../ghola_pay
leo run pay
```

`leo run` executes the transition locally and prints the output
records + commitment + nullifier. To actually broadcast against a
devnet node:

```sh
snarkos developer execute ghola_pay.aleo pay \
  "$R_IN_RECORD" aleo1recipient... 250000u64 0u128 \
  --private-key "$ALEO_PRIVATE_KEY" \
  --query http://localhost:3030 \
  --broadcast http://localhost:3030/mainnet/transaction/broadcast
```

(Field names of the CLI may drift across snarkOS versions; check
`snarkos developer execute --help`.)

## Deployment

### Testnet

```sh
snarkos developer deploy ghola_pay.aleo \
  --private-key "$ALEO_PRIVATE_KEY" \
  --query https://api.explorer.provable.com/v1/testnet \
  --broadcast https://api.explorer.provable.com/v1/testnet/transaction/broadcast \
  --priority-fee 1000000
```

The fee comes out of the deployer account's `credits.aleo` balance.
At time of writing the deploy cost lands in the low single-digit
ACR/credits range, but the program is small and the actual figure
depends on snarkVM byte cost at the moment of deploy.

### Mainnet

Same shape, with `--query` and `--broadcast` pointing at the mainnet
endpoints. **Before** running mainnet deploy:

1. Replace the placeholder `USDCx` record type in `src/main.leo` with
   the canonical bridged USDC.a record type (this removes the
   `INTERIM — replace with USDC.a` / `TODO(verify-before-mainnet)`
   markers). The program must NOT deploy a self-defined placeholder
   token.
2. Rebuild (`leo clean && leo build`) so the artifact in `build/`
   reflects the current source.
3. Run the machine gate in **deploy mode** — this replaces the old
   "audit the bytecode by inspection" step:

   ```sh
   ./scripts/security/check-aleo-mainnet-safe.sh --mode=deploy
   ```

   It fails the deploy if `src/main.leo` (or `build/main.aleo`)
   declares any transition/function other than `pay` (i.e. blocks any
   stray mint — the infinite-mint hole), and if the placeholder USDCx
   markers are still present. The mint helper lives only in the
   separate, never-deployed `ghola_pay_devnet.aleo`. Note: CI runs the
   same gate in `--mode=merge` on every PR (blocks any mint at merge
   time; allows the placeholder until bridge integration lands).
4. Compute and record the program id hash; the off-chain adapter
   pins this hash and refuses transitions from any other program id.
5. Deploy from an account whose `credits.aleo` balance covers the
   deploy fee plus a comfortable margin.

We **cannot** complete mainnet deploy until a funded Aleo account
exists. Treasury action item tracked separately.

## What this v1 deliberately does NOT include

- **Audit logging.** No `transition_log` or on-chain event for
  compliance. The whole point is unlinkability; selective disclosure
  is the recipient's view-key, not an on-chain log.
- **Batch pay.** A single `pay` transition routes a single payment.
  Batched inference billing (one transition settling N inference
  calls) is intentionally deferred — it would either need an array
  of recipients (Leo's record-array story isn't where we'd want it
  for v1) or a different settlement cadence than per-call x402.
- **Refund flow.** If the provider fails to render the inference, the
  refund path lives in the Ghola receipts service (call credit is
  refunded off-chain via `thumper-cloud`). No on-chain refund
  transition exists; reversing a shielded payment would require a
  separate transition consuming the recipient's record, which only
  the recipient can sign.
- **Fee splitting / royalties.** All `amount` goes to `to`. A future
  variant might route a percentage to a Ghola fee address.
- **Slippage / price guards.** Amount is set client-side; the
  provider validates `amount >= max_amount_required` off-chain.

## Known questions to verify before mainnet

These are the explicit "ask Aleo docs or the devrel team" items:

1. **USDC.a record signature.** The local `USDCx` record type here
   uses `{ owner: address, amount: u64, gates: u64 }`. Confirm the
   canonical Wormhole-NTT-bridged USDC record on Aleo mainnet uses
   exactly this shape. If `gates` is named `microcredits` or
   absent, update `src/main.leo` and `inputs/ghola_pay.in` to match.
2. **Finality assumptions.** Tier 2K §4.5 says we treat a transition
   as settled at "confirmed" — confirm what depth of confirmation
   the adapter should require before signing the receipt. Aleo's
   finality is probabilistic in the same shape as Solana; the adapter
   needs an explicit confirmation threshold.
3. **Gas-equivalent fee model.** Aleo deploys + executions consume
   `credits.aleo` priority fees. Establish the steady-state per-call
   cost and confirm it stays below the inference margin. If a single
   `pay` execution costs more than ~10% of `price_micro_usdc_shielded`,
   the rail isn't viable for sub-cent calls and we need to batch.
4. **Public memo elision.** The `assert_eq(memo, memo)` line in
   `pay` is defensive against compiler dead-code elimination of an
   unreferenced public input. Confirm with the Leo team whether this
   is still required in current Leo 2.x or if the public input is
   preserved by virtue of the function signature alone.
5. **`self.caller` vs `self.signer`.** Recent snarkVM split caller
   (the immediate program) from signer (the human who signed). For
   the input record's `owner` check and the change record's
   destination, we want the human signer — confirm `self.caller`
   resolves to that in the current Leo, or switch to `self.signer`.
6. **Bridge program id.** Once Wormhole NTT (or the chosen
   alternative) lands USDC on Aleo, its program id is what we'll
   actually import. Update `imports/` and `program.json` deps then.

## File layout

```
programs/aleo/ghola_pay/
├── README.md            (this file)
├── program.json         (Aleo program manifest)
├── src/
│   └── main.leo         (the program — `pay` + dev-only `mint_for_testing`)
├── inputs/
│   └── ghola_pay.in     (sample inputs for `leo run`)
├── imports/
│   └── .gitkeep         (USDC.a bridge program lands here at integration)
└── build/
    └── .gitkeep         (`leo build` output; gitignored content)
```
