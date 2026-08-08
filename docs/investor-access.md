# Investor access

Investor passes are one-time, email-bound, auditable, and expire automatically. They grant metered Starter Agent access without changing Stripe state.

1. Set a strong `GHOLA_INVESTOR_PASS_ADMIN_SECRET` on `thumper-cloud`.
2. Issue a 14-day pass:

```bash
GHOLA_API_BASE=https://api.ghola.xyz \
GHOLA_ADMIN_BEARER_TOKEN=... \
GHOLA_INVESTOR_PASS_ADMIN_SECRET=... \
node scripts/issue-investor-pass.mjs investor@example.com
```

3. Send the printed `https://ghola.xyz/trade?access=...` link. The investor signs in with the bound email, then connects a withdrawal-disabled Hyperliquid API wallet.

Never place the admin secret or bearer token in a client-side environment variable.
