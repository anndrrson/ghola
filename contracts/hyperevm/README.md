# Ghola Hyperliquid Native Vault Scaffold

This folder is the first production integration scaffold for Hyperliquid native
vault mode. It is intentionally conservative:

- The web app can prepare, confirm, and allocate a native vault only when the
  deposit verifier and sealed agent readiness flags are set.
- The worker can carry `vault_address` into Hyperliquid account reads and order
  submission.
- This Solidity scaffold records vault, agent, and receipt commitments, but it
  does not yet call Hyperliquid CoreWriter. Wire the official HyperEVM
  CoreWriter interface before any production deployment.

## Build

```bash
cd contracts/hyperevm
forge build
```

## Production Checklist

- Deploy the controller from a hardware-controlled operator wallet.
- Record the Hyperliquid vault address and sealed Phala agent wallet.
- Enable the receipt verifier only after it checks the real Hyperliquid vault
  deposit event or an equivalent venue-issued receipt.
- Set `GHOLA_HYPERLIQUID_NATIVE_VAULT_RECEIPT_VERIFIER_ENABLED=true` only after
  the verifier is live.
- Set `GHOLA_HYPERLIQUID_NATIVE_VAULT_AGENT_READY=true` and
  `PRIVATE_AGENT_HYPERLIQUID_NATIVE_VAULT_AGENT_READY=true` only after the
  Phala worker can load the matching agent wallet.
