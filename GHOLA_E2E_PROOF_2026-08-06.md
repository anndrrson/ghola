# Ghola Hyperliquid production proof

Date: 2026-08-06/07  
Status: **FULL END-TO-END PROOF COMPLETE**

## Production result

- Fresh user: `e2e+1786051407813@ghola.test`.
- Plan: Stripe live-mode **Ghola Founding Trader**, active; Ghola shows it as current and admits 1 of 10 seats.
- Connection: Hyperliquid mainnet account `0xa058…E7Ef`; scoped, withdrawal-disabled API wallet `0x5275…44da2`, authorized for two days.
- Open: authorized $11 BTC-PERP market long, 1×, 50-bps cap. Hyperliquid filled `0.00017 BTC` at `$64,234`; order `511968184711`.
- Close: exact `0.00017 BTC` reduce-only market sell, 50-bps cap. Hyperliquid filled at `$64,194`; order `511969597284`.
- Final venue state: zero positions and zero open orders.
- Trading cost: `$0.0068` realized loss plus `$0.009823` fees (about 1.7 cents total).
- The connection survived a hard reload; the reloaded account showed API-wallet access, zero positions, and zero open orders.

## Billing evidence

- Production health reports Stripe configured in **live mode**, verified webhooks configured, and the Founding Trader price configured.
- Stripe created a live customer, succeeded in saving payment method `•••• 5493`, created an active `$29/month` Founding Trader subscription, and Ghola's webhook-driven entitlement admitted the account and allowed the opening trade.
- This canary used coupon `ghola_canary_nocharge_20260806` (**100% off forever**). Its paid invoice and next invoice are `$0.00`.
- A second, separately authorized live billing canary used the same production Founding Trader product and price with a one-time `$28.50` discount. Stripe charged exactly **$0.50**.
- Invoice `in_1U1g2iErhj1YeA4TyaEjPeWk` (`8AA5IBIE-0002`) is **Paid**: `$0.50` due, `$0.50` paid, `$0.00` remaining. Payment `pi_3U1g2jErhj1YeA4T0V82ZSud` is **Succeeded**. Stripe's ledger shows `$0.50` cash and `$0.50` revenue.
- Stripe delivered the canary's live `invoice.paid` event `evt_1U1g2nErhj1YeA4ToEIzslwK` to Ghola's canonical backend at `https://thumper-cloud.onrender.com/api/billing/webhook`; the endpoint returned **200 OK / Delivered**.
- The paid canary subscription `sub_1U1g2iErhj1YeA4ThPO68pSc` was canceled immediately after payment. Stripe shows it as **Canceled**, with no renewal; the `$0.50` was not refunded and no credit note exists.
- The original no-charge canary subscription remains active, and Ghola still shows **Founding Trader — Current**, the paid private-agent entitlement active, and 9 of 10 seats remaining.
- Therefore live payment capture, signed webhook delivery, entitlement, admission, and the trading gate are proven. Normal production checkout remains `$29/month`; the one-time canary discount is not attached automatically.
- Configuration hygiene: the obsolete duplicate endpoint `https://ghola-api.onrender.com/v1/billing/webhook` was removed after verification. The canonical `thumper-cloud` destination remains active.

## Privacy and safety evidence

- The private key was generated in-browser and uploaded only inside the encrypted execution vault.
- The durable vault is `sealed`; its encrypted payload exposes only algorithm/recipient/commitment metadata plus ciphertext. It contains no plaintext master address, API-wallet address, or user email.
- The API wallet cannot withdraw. The main wallet was not sent as a signing key.
- Hyperliquid necessarily sees the venue account and submitted order. Ghola's claim is pre-submit confidentiality, not invisibility after broadcast.
- Worker policy enforced `$15/order`, `$25/day`, and `50 bps`; after the canary round trip, further opening volume was correctly blocked by the daily cap. Reduce-only exits remain allowed.

## Deployment and automated evidence

- Production: Vercel deployment `dpl_Fr74n2u9rzXvLBHuDkTWdc3ewm8F`, alias `ghola.xyz`, status Ready.
- Source: commit `a736228894bba53dd5baf93e2c423606015cf0c9` on `codex/production-e2e-proof-20260806`.
- Confidential worker image: `sha256:b0c6df660a126b8de26ce4b0ec23cb99d6b95bb377483ae9e9d69c654ba684af`; attested and ready.
- Tests: web 716 passed/1 skipped; worker 149 passed; cloud backend 136 passed.
- Production PostgreSQL recorded both execution attempts as `filled`, with `broadcast_performed=true` and `final_venue_execution_proven=true`.

## Remaining proof

None for the stated single-user production objective. This run does not claim ten separately operated live traders or guaranteed fills; the ten-seat cap and admission concurrency are covered by automated/database tests.
