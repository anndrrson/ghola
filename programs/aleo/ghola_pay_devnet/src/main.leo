// ghola_pay_devnet.aleo
//
// DEVNET-ONLY companion to ghola_pay.aleo. DO NOT DEPLOY TO MAINNET.
//
// This program exists for one reason: to mint a placeholder USDCx record
// for local devnet / unit tests so `ghola_pay.aleo/pay` can be exercised
// without first standing up a Wormhole NTT bridge. It is a SEPARATE
// program id (`ghola_pay_devnet.aleo`) from the mainnet payment program
// (`ghola_pay.aleo`).
//
// Why this is a separate program, not a transition inside ghola_pay.aleo:
// a token-minting transition that takes no input record lets ANYONE
// create USDCx out of thin air. If such a transition were left in the
// mainnet artifact, the entire shielded rail would be an infinite-mint /
// total-devaluation hole. By keeping the mint in a physically separate,
// never-deployed-to-mainnet program, the mainnet source tree
// (programs/aleo/ghola_pay/) CANNOT contain a mint — the safety is
// structural, not a comment + TODO that a human must remember to honour.
//
// The mainnet-safety gate (scripts/security/check-aleo-mainnet-safe.sh)
// asserts that programs/aleo/ghola_pay/src/main.leo contains exactly one
// transition (`pay`) and no mint. This program is intentionally NOT
// covered by that gate; it is never a mainnet artifact.

program ghola_pay_devnet.aleo {

    // Mirrors the placeholder USDCx record shape in ghola_pay.aleo so the
    // record minted here can be fed into `ghola_pay.aleo/pay` on devnet.
    // Same placeholder caveat applies: this is NOT canonical bridged
    // USDC.a — it is a devnet stand-in only.
    record USDCx {
        owner: address,
        amount: u64,
        gates: u64,
    }

    // mint_for_testing
    //
    // DEVNET ONLY. Mints a USDCx record directly to `to` with the given
    // amount, bypassing any bridge. Exists so unit tests / local devnet
    // can produce a spendable record. Never deploy this program (or any
    // mint transition) to mainnet.
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
