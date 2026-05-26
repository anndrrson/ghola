// ghola_pay.aleo
//
// Minimal shielded payment routing for Ghola's x402 inference settlement.
// See docs/security/tier-2k-shielded-payments.md §2.2 step 3 and §4.2.
//
// Surface area is deliberately tiny: a single `pay` transition that takes
// a USDC.a record owned by the caller, an amount, and a recipient address;
// produces a recipient record + change record. The amount/sender/receiver
// are all shielded — the only public artefacts on chain are the input
// record nullifier, the two output record commitments, the program id,
// and an optional public `memo: u128` that the off-chain adapter can use
// to correlate without leaking party identity.
//
// TODO(verify-before-mainnet): At integration time, replace the locally
// declared `USDCx` record below with the canonical USDC.a bridge record
// type (import via `program credits.aleo;` style import in imports/, or
// whichever program id Wormhole NTT lands the bridged USDC on). The
// shape used here (owner + amount + gates) tracks the canonical Aleo
// token shape but the *exact* field names of the bridge record will
// govern at deploy time. The transition logic is independent of the
// field names; only the record type declaration needs to swap.

program ghola_pay.aleo {

    // INTERIM — replace with USDC.a bridge type at integration time.
    //
    // TODO(verify-before-mainnet): This locally declared `USDCx` record is
    // a PLACEHOLDER token type, NOT the canonical Wormhole-NTT-bridged
    // USDC.a. Deploying it to mainnet as-is would define a brand-new,
    // self-minted token that merely *calls itself* USDCx — settlement
    // would credit a worthless token while presenting as real USDCx to
    // users. Before any mainnet deploy this declaration MUST be replaced
    // with (or import) the canonical bridged USDC.a record type. The
    // mainnet-safety gate (scripts/security/check-aleo-mainnet-safe.sh)
    // REFUSES any artifact that still carries this placeholder marker, so
    // this comment cannot be silently shipped.
    //
    // Standard Aleo token record shape. `gates` is the implicit credit
    // field present on all native Aleo records (in current snarkVM this
    // is `microcredits` for credits.aleo records; bridged USDC records
    // typically expose `amount` for the bridged value and may or may not
    // carry `gates` depending on the bridge program). We keep `gates`
    // here so the record is broadcastable without an extra fee record;
    // the bridged variant may differ.
    record USDCx {
        owner: address,
        amount: u64,
        gates: u64,
    }

    // pay
    //
    // Consume `r_in` (a USDC.a record owned by `self.signer`) and emit:
    //   * `r_recipient`: a record owned by `to` for `amount` USDC.a
    //   * `r_change`:    a record owned by `self.signer` for the remainder
    //
    // `memo` is an optional public u128 the adapter may use to correlate
    // a transition with an off-chain x402 request id. It is *public*, so
    // the caller MUST either set it to 0u128 (the default in clients) or
    // to an unlinkable random nonce. Never put the recipient address,
    // the user identity, or the amount into the memo.
    //
    // SECURITY: `memo` is a NON-BINDING public correlation tag. It does
    // NOT bind the amount, recipient, or any request id on-chain — the
    // transition logic never reads it, and snarkVM keeps it as a public
    // input by virtue of the function signature. The authoritative
    // request<->transition correlation lives in the off-chain adapter,
    // not here. Do not treat `memo` as an integrity-bearing field.
    //
    // Returns the two output records. The recipient scans their owned
    // records (via view key) to detect payment; the caller retains the
    // change record for the next payment.
    transition pay(
        r_in: USDCx,
        to: address,
        amount: u64,
        public memo: u128,
    ) -> (USDCx, USDCx) {
        // Guard: the signer (the human who signed the transaction) must own
        // the input record. We deliberately use `self.signer`, NOT
        // `self.caller`: under a cross-program call `self.caller` is the
        // immediate *calling program*, so checking ownership against (and
        // routing change to) `self.caller` could send the change record to
        // the wrong address. `self.signer` always resolves to the human
        // root signer, which is the party that actually owns the record.
        assert_eq(r_in.owner, self.signer);

        // Guard: sufficient balance.
        assert(r_in.amount >= amount);

        // Guard: refuse zero-amount payments — they leak nothing about the
        // amount itself but burn a transition slot and could be used as a
        // covert channel.
        assert(amount > 0u64);

        // Compute change. The `>=` assert above prevents underflow, and
        // snarkVM arithmetic is checked regardless; value is conserved:
        // amount + change == r_in.amount.
        let change: u64 = r_in.amount - amount;

        // Emit recipient record. `gates` set to 0u64 — the recipient
        // pays their own fees on subsequent spends, same as every other
        // Aleo token transfer pattern.
        let r_recipient: USDCx = USDCx {
            owner: to,
            amount: amount,
            gates: 0u64,
        };

        // Emit change record back to the signer (see ownership note above).
        let r_change: USDCx = USDCx {
            owner: self.signer,
            amount: change,
            gates: 0u64,
        };

        return (r_recipient, r_change);
    }

    // NOTE: `mint_for_testing` does NOT live in this mainnet-bound program.
    // A token-minting transition that takes no input record would let
    // anyone create USDCx out of thin air — an infinite-mint /
    // total-devaluation hole if shipped to mainnet. It has been moved to a
    // physically separate devnet-only program so the mainnet source tree
    // CANNOT contain a mint:
    //   programs/aleo/ghola_pay_devnet/src/main.leo  (ghola_pay_devnet.aleo)
    // That program is for local devnet / unit tests only and is never
    // deployed to mainnet. The mainnet-safety gate
    // (scripts/security/check-aleo-mainnet-safe.sh) FAILS if this file
    // contains any transition/function other than `pay`.
}
