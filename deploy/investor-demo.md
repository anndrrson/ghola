# Ghola v2 — 90-Second Investor Demo Script

A tight walkthrough that takes a cold investor from "what is this" to
"oh, that's an on-chain anchor for confidential AI inference" in under
two minutes. Practice it. The browser tabs you need open before the
call are listed at the bottom.

## The 90 seconds

**0:00 — 0:10 — Open ghola.xyz.**
> "This is Ghola. It's a confidential AI assistant — like ChatGPT, but
> the inference runs inside a hardware-isolated enclave that the cloud
> provider can't see into, and every reply gets anchored to a public
> blockchain so you can prove the conversation happened without anyone
> seeing what was in it."

**0:10 — 0:20 — Click "Sign up". The Turnkey wallet popover appears.**
> "Wallet-first auth. Your identity is a key, not an email. Turnkey
> custodies it server-side in their HSM so users don't lose it, but we
> never see the private half."

**0:20 — 0:35 — Pick "Private" from the SovereigntyPicker.**
> "Three modes — Local, Cloud, Private. Private is the new one. Local
> stays on your machine; Cloud is regular SaaS; Private routes through
> an attested Nitro enclave."

**0:35 — 0:55 — Send a message. ("What's a sealed envelope?")**
> "Watch the badge above the response — it just turned green."
> 
> While the reply streams, point at the badge: a small lock icon with
> the text **Verified · enclave · anchored**.

**0:55 — 1:15 — Click the badge. Verify modal opens.**
> "Three things are happening here. One, the response was sealed
> end-to-end — neither our relay nor the cloud provider saw it in the
> clear. Two, the enclave proved its identity to us before we talked
> to it; the SHA-384 fingerprint here is the measurement of the
> exact code running inside. We publish those measurements in our
> open repo so you can check we didn't quietly swap in a backdoored
> build. Three, the receipt itself — every reply gets a signed
> receipt that we batch every hour and anchor to Solana."

**1:15 — 1:30 — Click "Check on-chain". Solana Explorer opens.**
> "There's the on-chain transaction. The Merkle root of this batch of
> receipts is written into a Solana memo. Anyone — investors, auditors,
> regulators, the user themselves — can re-derive the proof and verify
> their conversation was anchored, without us being able to alter
> history."

**1:30 — 1:40 — Open `/security`. Three "LIVE" badges.**
> "Sealed transport: live. Hardware attestation: live. On-chain anchor:
> live. We've shipped the full stack."

## Three things to physically point at on screen

1. **The receipt body.** When the Verify modal opens, hover over each
   field as you say it:
   - `enclave_key_id` → "this is the public half of an ephemeral key
     the enclave minted in RAM at boot"
   - `attestation_hash` → "the SHA-256 of the Nitro attestation
     document — click it for the full measurement"
   - `provider_sig` → "the enclave signed this with its own Ed25519
     key, distinct from the long-lived provider identity"
   - `merkle_root` → "the root we'll anchor next hour"

2. **The attestation hash, linked to our measurement publication.**
   The Verify modal hyperlinks the hash to
   `https://github.com/anndrrson/ghola/blob/main/deploy/nitro/measurements/<sha>.json`.
   That's the entire trust story: investors can see the exact PCR0..2
   values of the enclave, signed by the offline Ghola allowlist key.

3. **The on-chain anchor.** The Solana Explorer link is the
   trust-minimization punchline. We can't be a corrupt notary —
   anyone can re-derive the Merkle proof from their cached receipt
   and check it against what's on-chain.

## Investor objections — short answers ready

- **"Can't AWS still see everything?"** No — they see the encrypted
  bytes flowing through. The enclave's memory is encrypted with keys
  AWS doesn't hold; the attestation is signed by Nitro and we verify
  the chain against AWS's root cert. If AWS lied, the chain wouldn't
  verify; if AWS shipped a backdoor, it would change the measurement
  and the receipt would fail validation.

- **"Why Solana?"** Sub-second confirmation + tiny memo cost (~$0.0001
  per batch). Ethereum L1 was a non-starter; Solana lets us anchor
  every hour for the price of a coffee per year.

- **"Why batched receipts, not per-message?"** Cost. A Merkle batch
  of 1000 receipts costs the same single Solana memo as one receipt.
  Inclusion proof is logarithmic in batch size.

- **"What if the enclave is compromised?"** Allowlist revocation:
  ops publishes the compromised measurement to a CRL-style endpoint;
  the relay refuses to talk to that enclave forever. New deploys roll
  forward with a fresh measurement. See `deploy/runbook.md#5`.

## Pre-call setup checklist

- [ ] `ghola.xyz` in tab 1, logged out.
- [ ] Solana Explorer in tab 2 (mainnet, point at said-receipts
      program ID).
- [ ] GitHub `deploy/nitro/measurements/` open in tab 3.
- [ ] `/security` open in tab 4.
- [ ] Test the flow end-to-end in your incognito window 30 minutes
      before the call. The receipts service has a one-hour batch
      cadence in prod — don't get caught with a "pending" badge on
      camera.
- [ ] Have `tests/e2e/v2-private-flow.sh` output from this morning
      pinned somewhere, in case the live demo wobbles and you need
      to show "yes the stack actually works, here's the green run."
