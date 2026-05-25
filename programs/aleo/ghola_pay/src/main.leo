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
    // Consume `r_in` (a USDC.a record owned by `self.caller`) and emit:
    //   * `r_recipient`: a record owned by `to` for `amount` USDC.a
    //   * `r_change`:    a record owned by `self.caller` for the remainder
    //
    // `memo` is an optional public u128 the adapter may use to correlate
    // a transition with an off-chain x402 request id. It is *public*, so
    // the caller MUST either set it to 0u128 (the default in clients) or
    // to an unlinkable random nonce. Never put the recipient address,
    // the user identity, or the amount into the memo.
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
        // Guard: caller must own the input record. snarkVM enforces this
        // structurally (records can only be consumed by their owner's
        // private key) but we assert explicitly for readability.
        assert_eq(r_in.owner, self.caller);

        // Guard: sufficient balance.
        assert(r_in.amount >= amount);

        // Guard: refuse zero-amount payments — they leak nothing about the
        // amount itself but burn a transition slot and could be used as a
        // covert channel.
        assert(amount > 0u64);

        // Compute change.
        let change: u64 = r_in.amount - amount;

        // Memo is referenced so the compiler keeps it as a public input;
        // it intentionally does not influence record state. Using
        // assert_eq with itself is a no-op constraint that prevents
        // dead-code elimination of the public input. TODO(verify):
        // confirm Leo 2.x does not elide unreferenced public inputs;
        // if it does, this is required, if not it's harmless.
        assert_eq(memo, memo);

        // Emit recipient record. `gates` set to 0u64 — the recipient
        // pays their own fees on subsequent spends, same as every other
        // Aleo token transfer pattern.
        let r_recipient: USDCx = USDCx {
            owner: to,
            amount: amount,
            gates: 0u64,
        };

        // Emit change record back to caller.
        let r_change: USDCx = USDCx {
            owner: self.caller,
            amount: change,
            gates: 0u64,
        };

        return (r_recipient, r_change);
    }

    // ----------------------------------------------------------------
    // mint_for_testing
    //
    // DEVNET ONLY — DO NOT INCLUDE IN MAINNET DEPLOY.
    //
    // Mints a USDCx record directly to `to` with the given amount,
    // bypassing the bridge. Exists so unit tests / local devnet can
    // exercise `pay` without first standing up a Wormhole NTT bridge.
    //
    // For mainnet: delete this transition and re-deploy a fresh program
    // id. Leaving it in production would let anyone create USDC.a out
    // of thin air. The mainnet artifact MUST be built from a source
    // tree with this transition removed (or feature-gated out — Leo
    // does not yet have stable feature flags, so deletion is the
    // safer pre-deploy step).
    //
    // TODO(pre-mainnet): strip this transition; verify program hash
    // matches the audited mainnet artifact.
    transition mint_for_testing(
        to: address,
        amount: u64,
    ) -> USDCx {
        return USDCx {
            owner: to,
            amount: amount,
            gates: 0u64,
        };
    }
}
