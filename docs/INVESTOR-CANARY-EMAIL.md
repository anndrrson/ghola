# Investor canary email

Send only after the exact release returns GO.

**Subject:** Private Ghola Hyperliquid trading canary

Hi —

I’d like to invite you to a private, account-specific Ghola canary on Hyperliquid mainnet.

Private, single-use invitation: [paste the URL from the protected issuance artifact directly into this email]

Use that exact link. Do not copy the code or rewrite its `#access=` fragment as a `?access=` query; query tokens are rejected.

Open it with the invited email account. It expires on [date/time] and must not be forwarded.

You will first complete a one-time $11 safety round trip. You will then place and close two separate $11 HYPE trades through Ghola’s normal terminal. Entries use limit IOC, isolated 1×, and venue-native stop/take-profit protection. Exits use the terminal’s reduce-only close control. These are real trades: fees and small gains or losses are possible.

Please have:

- the eligible non-US email account tied to this invitation;
- a clean Chrome profile with Phantom installed, with both its Ethereum and Solana accounts available and unlocked;
- a dedicated, initially flat Hyperliquid account with no open orders;
- enough Hyperliquid USDC for the trades, fees, and a conservative buffer.

The Phantom Ethereum account is the funded Hyperliquid master account. The Phantom Solana account authenticates Ghola requests; it does not fund Hyperliquid and needs no SOL.

Wallet prompts occur in these stages:

1. Connect the Phantom Ethereum account and approve exactly one Hyperliquid `approveAgent` authorization. Ghola creates the trade-only agent key in memory and seals it to the attested worker; never create, paste, or reveal an API private key. The agent cannot withdraw or transfer funds.
2. Connect/select the Phantom Solana account. If direct connection cannot complete and Ghola shows **Continue with Phantom**, approve that SIWS sign-in once.
3. After **Wallet verified**, **Sign and run real $11.00 round trip** requests exactly two scoped Solana messages: the wallet-binding challenge, then the exact graduation request.
4. A normal-terminal entry asks you to review and confirm the bound entry plus its displayed venue-native take-profit and stop-loss. It does not request a Phantom message signature; the sealed trade-only agent submits it.
5. Each **Close HYPE · RO** may first request SIWS if Solana sign-in is not current, then requests exactly two scoped Solana messages: a wallet-binding challenge and the exact reduce-only close request.

You will personally perform every wallet, disclosure, review, entry, and close step. Fully reload the terminal between the two normal-terminal trades.

Never keep confirming the same prompt. If the screen does not advance to the next documented stage, the same stage repeats, the sign-in bridge is unavailable, or any wallet/account mismatch, unsafe warning, unknown outcome, unresolved claim, remaining position, or open order appears, stop and contact the sender. Do not resubmit.

This invitation is private and account-bound. It is not a public launch and should not be forwarded.

Best,

[Name]
