# Ghola Private Trading — 2-Minute Investor Demo Script

Companion to `investor-demo.md` (confidential chat). This one takes an
investor from "what is private trading" to "the operator can't see the
strategy, the venue can't see the user, and I just watched it settle"
in about two minutes. Runs on the pooled **Hyperliquid testnet** rail —
zero capital at risk, real venue, real fills.

**Route: you drive, on ghola.xyz → `/app/account` (the Private Account
Cockpit), with a pre-staged demo account.** Do not make the investor
sign up, import keys, or wait for funding — every second of friction is
a second of lost magic. They watch; you narrate visibility, not
features.

## The 2 minutes

**0:00 — 0:15 — Open `/app/account`, already signed in.**
> "This is a trading account with no exchange signup, no API keys, no
> seed phrase. The user's identity is a wallet; the trading happens
> through a pooled account Ghola operates on Hyperliquid."

**0:15 — 0:35 — Allocate from the Ghola balance into the pooled vault.**
Point at the visibility panel: *Wallet: hidden* · *venue sees: pooled
Ghola account and order*.
> "Their money just entered a pooled vault. Hyperliquid will see one
> Ghola account trading. It cannot see that this user exists. Inside,
> a double-entry ledger tracks their exact share at NAV — same
> mechanics as a fund."

**0:35 — 1:05 — Place the trade. This is the magic beat.**
While it executes, point at the *"Ghola sees"* metric.
> "Here's the part that's hard: hiding the user from the venue is
> easy if you trust the middleman — we removed the middleman from the
> loop too. The strategy and order are sealed in the browser to a
> hardware enclave. Our own servers route ciphertext and commitments.
> The decrypted order exists in exactly one place: inside an attested
> TEE whose code fingerprint is published in our repo."

Flip to the pre-opened Hyperliquid testnet explorer tab showing the
pooled account's fill.
> "And it's not a simulation — that's the fill on the venue, just now."

**1:05 — 1:25 — Click the receipt.**
> "Every action produces a signed receipt listing who it's hidden
> from. Privacy that can't prove itself is just a promise — this is
> the proof object."

**1:25 — 1:45 — Open the pool audit (`/v1/private-account/venues/hyperliquid/pool/audit`).**
> "The obvious objection: 'pooled and private sounds like FTX.' This
> is the answer. The books are double-entry; this audit recomputes
> them on demand and asks the enclave to prove the venue account
> actually holds what the ledger owes users. Status: balanced. Private
> to everyone, provably solvent to anyone."

**1:45 — 2:00 — Withdraw 100%. Balance updates live.**
> "And the user is never locked in — pro-rata exit at NAV, settled
> against the ledger instantly. That's the whole loop: allocate,
> trade unseen, audit, exit."

## Close

> "Today this runs on testnet rails with the mainnet path gated behind
> the same audits you just watched. The privacy layer, the accounting,
> and the attestation are the hard parts — and they're live."

## Pre-demo checklist (do this 1 hour before)

- [ ] Web deployed from `claude/sweet-davinci-z7m2io`, worker CVM up
      with `PRIVATE_AGENT_HYPERLIQUID_POOLED_NETWORK=testnet`
- [ ] Testnet pooled account funded from faucet
      (app.hyperliquid-testnet.xyz)
- [ ] Demo user signed in, Ghola balance pre-funded, venue eligibility
      pre-verified (do the slow parts off-camera)
- [ ] Run `node scripts/canary/pooled-withdraw-cycle.mjs` with confirm
      — full cycle green
- [ ] Pool audit returns `balanced`
- [ ] Tabs open: cockpit, Hyperliquid testnet explorer on the pooled
      account, the audit endpoint, repo (for the enclave measurement)
- [ ] Fallback if infra hiccups: the confidential-chat demo
      (`investor-demo.md`) is the warm-up act either way

## What NOT to do

- Don't demo BYO mode to investors — pasting exchange API keys reads
  as friction, not magic. BYO is for power users, not pitches.
- Don't use mainnet for the demo. A $5 testnet fill and a $5 mainnet
  fill look identical on screen; only one can go wrong with money.
- Don't claim mainnet pooled custody is live. The line that lands:
  "gated behind the audits you just watched."
